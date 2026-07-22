import * as path from 'node:path';

import type {
  AgentInvocation,
  AgentRunOptions,
  AgentRunResult,
  GlobalConfig,
  ProcessResult,
  Result,
} from '../types';
import { fail, ok } from '../utils/errors';
import { writeArtifactSync } from '../utils/fs-atomic';
import { ensureDir } from '../utils/paths';
import { BLOCKING_API_ENV_VARS, assertChildEnvIsClean } from '../security/api-guard';
import { buildSanitizedEnv } from '../security/env-sanitizer';
import { commandExists, runProcess } from './process-runner';

/**
 * Adaptador do Codex CLI.
 *
 * Papel no OrqPEG: revisor de prompt e segundo auditor de merge. O Codex é
 * SEMPRE somente leitura — ele nunca edita o repositório, nem quando o chamador
 * pede o contrário. Toda escrita é responsabilidade exclusiva do Claude, sob as
 * restrições do orquestrador.
 *
 * O Codex CLI pode não estar instalado na máquina. Esse é um caminho de
 * primeira classe: quando ele falta, devolvemos `TOOL_MISSING` com remediação.
 * Nunca simulamos uma revisão e nunca aprovamos por padrão — sem o segundo
 * auditor, a auditoria dupla fica bloqueada, e é assim que deve ser.
 *
 * As flags exatas da versão instalada não puderam ser confirmadas (o binário
 * está ausente nesta máquina), então o conjunto de argumentos é o mínimo
 * conservador: `codex exec`, opcionalmente `--model` e `--sandbox read-only`.
 * Se a versão instalada rejeitar alguma flag, o erro é REPORTADO ao usuário
 * (com instrução para ajustar `config.agents`) em vez de ser ignorado.
 */

export type CodexRunOptions = AgentRunOptions & {
  role: AgentInvocation['role'];
  config: GlobalConfig;
};

const INSTRUCTION_FILE = 'codex-instruction.md';
const STDOUT_FILE = 'codex-output.log';
const STDERR_FILE = 'codex-stderr.log';

/** Marcadores de esgotamento de cota. Verificados sem diferenciar maiúsculas. */
const USAGE_LIMIT_MARKERS: readonly string[] = [
  'usage limit',
  'rate limit',
  'quota exceeded',
  'limit reached',
];

/** Marcadores de falta de autenticação. Verificados sem diferenciar maiúsculas. */
const AUTH_REQUIRED_MARKERS: readonly string[] = [
  'not logged in',
  'please log in',
  'authentication',
  'unauthorized',
  '/login',
  'codex login',
];

/** Marcadores de flag desconhecida: indicam incompatibilidade de versão. */
const UNKNOWN_OPTION_MARKERS: readonly string[] = [
  'unknown option',
  'unrecognized option',
  'unrecognized subcommand',
  'unexpected argument',
  'invalid value for',
  'unknown argument',
];

export async function runCodex(options: CodexRunOptions): Promise<Result<AgentRunResult>> {
  const command = options.config.agents.codexCommand;
  const artifactDir = options.artifactDir;

  try {
    ensureDir(artifactDir);
  } catch (error) {
    return fail(
      'IO_FAILED',
      `Não foi possível criar o diretório de artefatos do Codex: ${artifactDir}`,
      { artifactDir },
      error,
    );
  }

  const instructionPath = path.join(artifactDir, INSTRUCTION_FILE);
  const stdoutPath = path.join(artifactDir, STDOUT_FILE);
  const stderrPath = path.join(artifactDir, STDERR_FILE);

  const instructionWrite = writeArtifactSync(instructionPath, options.instruction);
  if (!instructionWrite.ok) return instructionWrite;

  const missingDetails: Record<string, unknown> = {
    agent: 'codex',
    role: options.role,
    command,
    instructionPath,
  };

  // Caminho de primeira classe: ausência do Codex CLI.
  const exists = await commandExists(command);
  if (!exists) {
    return fail('TOOL_MISSING', codexMissingMessage(command), missingDetails);
  }

  // Ambiente sempre sanitizado antes do spawn.
  const stripNames =
    options.config.security.strippedEnvVars.length > 0
      ? options.config.security.strippedEnvVars
      : [...BLOCKING_API_ENV_VARS];
  const sanitized = buildSanitizedEnv({ strip: stripNames });

  const envCheck = assertChildEnvIsClean(sanitized.env, stripNames);
  if (!envCheck.clean) {
    return fail(
      'API_KEY_PRESENT',
      'Variáveis de API sobreviveram à sanitização do ambiente: execução do Codex abortada ' +
        'para não gerar cobrança por token.',
      { leaked: envCheck.leaked, agent: 'codex' },
    );
  }

  const model = resolveModel(options);
  const timeoutMs = resolveTimeoutMs(options);
  const args = buildArgs(model);

  const processResult: ProcessResult = await runProcess(command, args, {
    cwd: options.cwd,
    timeoutMs,
    env: sanitized.env,
    // Instrução por STDIN: evita o limite de 8191 caracteres da linha de
    // comando do Windows para prompts e diffs longos.
    input: options.instruction,
    signal: options.signal,
  });

  const stdoutWrite = writeArtifactSync(stdoutPath, processResult.stdout);
  if (!stdoutWrite.ok) return stdoutWrite;
  const stderrWrite = writeArtifactSync(stderrPath, processResult.stderr);
  if (!stderrWrite.ok) return stderrWrite;

  const output = processResult.stdout;
  const failed = processResult.status !== 'COMPLETED' || processResult.exitCode !== 0;

  // Só varremos a saída principal quando houve falha: assim o texto da própria
  // revisão (que pode citar "rate limit" ou "authentication") não gera engano.
  const scanText = [processResult.stderr, failed ? output : ''].join('\n').toLowerCase();

  const usageLimitReached = containsAny(scanText, USAGE_LIMIT_MARKERS);
  const authRequired = !usageLimitReached && containsAny(scanText, AUTH_REQUIRED_MARKERS);

  const invocation: AgentInvocation = {
    agent: 'codex',
    role: options.role,
    instructionPath,
    cwd: options.cwd,
    model,
    startedAt: processResult.startedAt,
    finishedAt: processResult.finishedAt,
    durationMs: processResult.durationMs,
    status: processResult.status,
    exitCode: processResult.exitCode,
    sessionId: extractSessionId(processResult.stdout),
    stdoutPath,
    stderrPath,
    usageLimitReached,
    authRequired,
  };

  // A invocação completa acompanha o erro para que o orquestrador consiga
  // registrar a tentativa mesmo quando ela falha.
  const details: Record<string, unknown> = {
    agent: 'codex',
    role: options.role,
    status: processResult.status,
    exitCode: processResult.exitCode,
    instructionPath,
    stdoutPath,
    stderrPath,
    durationMs: processResult.durationMs,
    args,
    invocation,
  };

  if (processResult.status === 'COMMAND_NOT_FOUND') {
    return fail('TOOL_MISSING', codexMissingMessage(command), details);
  }

  if (failed && containsAny(processResult.stderr.toLowerCase(), UNKNOWN_OPTION_MARKERS)) {
    return fail(
      'TOOL_MISSING',
      `A versão instalada do Codex CLI rejeitou os argumentos usados (${args.join(' ')}). ` +
        'O OrqPEG não ignora isso silenciosamente. Verifique "codex exec --help" e ajuste ' +
        '"agents.codexCommand" / "agents.defaultCodexModel" em config/global.json para uma ' +
        'invocação compatível.',
      details,
    );
  }

  if (usageLimitReached) {
    return fail(
      'USAGE_LIMIT_REACHED',
      'O Codex CLI informou que o limite de uso da assinatura foi atingido. ' +
        'A auditoria foi interrompida; retome quando a cota for renovada.',
      details,
    );
  }

  if (authRequired) {
    return fail(
      'AUTH_REQUIRED',
      'O Codex CLI exigiu autenticação. Rode "codex login" e escolha "Sign in with ChatGPT" ' +
        '(assinatura ChatGPT Plus). O OrqPEG nunca usa chave de API.',
      details,
    );
  }

  if (processResult.status === 'TIMEOUT') {
    return fail(
      'PROCESS_TIMEOUT',
      `O Codex CLI excedeu o tempo limite de ${Math.round(timeoutMs / 1000)}s e foi encerrado.`,
      details,
    );
  }

  if (processResult.status === 'INTERRUPTED') {
    return fail('PROCESS_INTERRUPTED', 'A execução do Codex CLI foi cancelada.', details);
  }

  if (processResult.status === 'FAILED') {
    return fail(
      'PROCESS_FAILED',
      `O Codex CLI terminou com código ${String(processResult.exitCode)}. ` +
        `Consulte ${stderrPath} para o detalhamento.`,
      details,
    );
  }

  const result: AgentRunResult = { invocation, output, process: processResult };
  return ok(result);
}

/* ------------------------------------------------------------------------- */
/* Montagem de argumentos                                                     */
/* ------------------------------------------------------------------------- */

/**
 * Conjunto mínimo e conservador de argumentos.
 *
 * `exec` é a execução não interativa. `--sandbox read-only` é o modo somente
 * leitura: o Codex pode ler o repositório e raciocinar, mas não escreve nada.
 * O OrqPEG usa o Codex exclusivamente como revisor/auditor, então o modo
 * somente leitura é aplicado SEMPRE, independentemente de `options.readOnly`.
 */
function buildArgs(model: string | null): string[] {
  const args: string[] = ['exec'];
  if (model !== null) args.push('--model', model);
  args.push('--sandbox', 'read-only');
  return args;
}

function resolveModel(options: CodexRunOptions): string | null {
  const explicit = options.model;
  if (typeof explicit === 'string' && explicit.trim().length > 0) return explicit.trim();
  const fallback = options.config.agents.defaultCodexModel;
  if (typeof fallback === 'string' && fallback.trim().length > 0) return fallback.trim();
  return null;
}

function resolveTimeoutMs(options: CodexRunOptions): number {
  if (Number.isFinite(options.timeoutMs) && options.timeoutMs > 0) return options.timeoutMs;
  return Math.max(1, options.config.agents.codexTimeoutSeconds) * 1000;
}

function codexMissingMessage(command: string): string {
  return (
    `O Codex CLI ("${command}") não foi encontrado no PATH. ` +
    'A revisão de prompt e a auditoria dupla de merge ficam BLOQUEADAS até que ele seja ' +
    'instalado e autenticado — o OrqPEG nunca aprova por padrão nem simula uma segunda opinião. ' +
    'Remediação: instale o Codex CLI, rode "codex login" e escolha "Sign in with ChatGPT"; ' +
    'se o executável tiver outro nome ou caminho, ajuste "agents.codexCommand" em config/global.json.'
  );
}

/**
 * Extrai um identificador de sessão da saída quando o Codex o imprime em JSON.
 * Ausência de sessão é normal e devolve `null`.
 */
function extractSessionId(stdout: string): string | null {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return null;

  try {
    const parsed: unknown = JSON.parse(trimmed);
    const record = isRecord(parsed) ? parsed : null;
    if (record !== null) {
      for (const key of ['session_id', 'sessionId', 'conversation_id', 'thread_id']) {
        const value = record[key];
        if (typeof value === 'string' && value.length > 0) return value;
      }
    }
  } catch {
    /* saída não é JSON: seguimos para a busca textual */
  }

  const match = /"(?:session_id|sessionId|conversation_id|thread_id)"\s*:\s*"([^"]{4,120})"/.exec(
    trimmed,
  );
  const captured = match?.[1];
  return captured === undefined ? null : captured;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function containsAny(loweredText: string, markers: readonly string[]): boolean {
  return markers.some((marker) => loweredText.includes(marker));
}
