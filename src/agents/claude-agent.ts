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
import { runProcess } from './process-runner';
import { buildFailureScanText } from './failure-scan';

/**
 * Adaptador do Claude Code.
 *
 * O OrqPEG conversa exclusivamente com o executável local `claude`, autenticado
 * pela assinatura Claude Max. Nenhuma chave de API é lida e nenhuma requisição
 * HTTP é feita por este processo.
 *
 * As flags usadas aqui são as confirmadas na versão instalada (claude 2.1.207):
 *   -p, --output-format, --model, --add-dir, --permission-mode,
 *   --allowedTools, --disallowedTools, --append-system-prompt,
 *   --session-id, --settings, --max-budget-usd.
 *
 * `--dangerously-skip-permissions` e `--allow-dangerously-skip-permissions` são
 * PROIBIDAS pelo produto e nunca aparecem neste arquivo.
 */

export type ClaudeRunOptions = AgentRunOptions & {
  role: AgentInvocation['role'];
  config: GlobalConfig;
};

const INSTRUCTION_FILE = 'claude-instruction.md';
const STDOUT_FILE = 'claude-output.log';
const STDERR_FILE = 'claude-stderr.log';

/**
 * Ferramentas bloqueadas no modo somente leitura (auditor de merge).
 *
 * O auditor apenas lê o repositório e emite um parecer: qualquer forma de
 * escrita ou execução de comando é negada, além do `--permission-mode plan`.
 */
const READ_ONLY_DISALLOWED_TOOLS: readonly string[] = [
  'Edit',
  'Write',
  'NotebookEdit',
  'Bash',
];

/**
 * Ferramentas bloqueadas no modo de edição (executor/corretor).
 *
 * O agente pode editar arquivos e rodar comandos de leitura, mas NUNCA pode
 * criar histórico, publicar ou trocar de contexto de branch: commit, push,
 * merge, checkout/switch, rebase, reset, clean e operações de PR pertencem
 * exclusivamente ao orquestrador, que aplica os gates antes de agir.
 */
const EDIT_MODE_DISALLOWED_TOOLS: readonly string[] = [
  'Bash(git commit:*)',
  'Bash(git push:*)',
  'Bash(git merge:*)',
  'Bash(git checkout:*)',
  'Bash(git switch:*)',
  'Bash(git rebase:*)',
  'Bash(git reset:*)',
  'Bash(git clean:*)',
  'Bash(gh pr merge:*)',
  'Bash(gh pr create:*)',
];

/** Reforço curto de política enviado como prompt de sistema adicional. */
const READ_ONLY_SYSTEM_PROMPT =
  'Você está sob orquestração do OrqPEG como auditor SOMENTE LEITURA. ' +
  'Não edite, crie ou apague arquivos e não execute comandos que alterem o repositório. ' +
  'Responda apenas com o JSON pedido na instrução.';

const EDIT_MODE_SYSTEM_PROMPT =
  'Você está sob orquestração do OrqPEG. Implemente apenas o prompt atual. ' +
  'É proibido: git commit, git push, git merge, git checkout, git switch, git rebase, ' +
  'git reset, git clean, gh pr create, gh pr merge, deploy e avançar para o próximo prompt. ' +
  'Ao concluir, pare e relate o que foi feito.';

/** Marcadores de esgotamento de cota. Verificados sem diferenciar maiúsculas. */
const USAGE_LIMIT_MARKERS: readonly string[] = [
  'usage limit',
  'rate limit',
  'quota exceeded',
  'limit reached',
];

/**
 * Marcadores de falta de autenticação. Verificados sem diferenciar maiúsculas.
 *
 * A sessão OAuth do Claude Max expira periodicamente e o CLI responde
 * "Failed to authenticate: OAuth session expired and could not be refreshed".
 * O radical "authenticat" cobre authenticate/authentication/authenticating de
 * uma vez; sem ele, essa falha era classificada como erro genérico de processo
 * e o usuário não recebia a orientação de refazer o login.
 */
const AUTH_REQUIRED_MARKERS: readonly string[] = [
  'not logged in',
  'please log in',
  'authenticat',
  'oauth',
  'session expired',
  'unauthorized',
  'invalid api key',
  'credentials',
  '/login',
];

export { USAGE_LIMIT_MARKERS, AUTH_REQUIRED_MARKERS };

/**
 * Classifica o motivo de uma falha do Claude a partir do texto de saída.
 *
 * O limite de uso tem precedência sobre a autenticação: quando a assinatura
 * esgota a cota, pedir um novo login não resolveria nada, e tratar o caso como
 * `AUTH_REQUIRED` mandaria o usuário para o caminho errado.
 */
export function classifyClaudeFailure(text: string): {
  usageLimitReached: boolean;
  authRequired: boolean;
} {
  const lowered = text.toLowerCase();
  const usageLimitReached = containsAny(lowered, USAGE_LIMIT_MARKERS);
  return {
    usageLimitReached,
    authRequired: !usageLimitReached && containsAny(lowered, AUTH_REQUIRED_MARKERS),
  };
}

export async function runClaude(options: ClaudeRunOptions): Promise<Result<AgentRunResult>> {
  const artifactDir = options.artifactDir;
  try {
    ensureDir(artifactDir);
  } catch (error) {
    return fail(
      'IO_FAILED',
      `Não foi possível criar o diretório de artefatos do Claude: ${artifactDir}`,
      { artifactDir },
      error,
    );
  }

  const instructionPath = path.join(artifactDir, INSTRUCTION_FILE);
  const stdoutPath = path.join(artifactDir, STDOUT_FILE);
  const stderrPath = path.join(artifactDir, STDERR_FILE);

  const instructionWrite = writeArtifactSync(instructionPath, options.instruction);
  if (!instructionWrite.ok) return instructionWrite;

  // Ambiente sempre sanitizado: as variáveis de API são removidas da cópia
  // entregue ao filho (o ambiente do Windows do usuário não é alterado).
  const stripNames =
    options.config.security.strippedEnvVars.length > 0
      ? options.config.security.strippedEnvVars
      : [...BLOCKING_API_ENV_VARS];
  const sanitized = buildSanitizedEnv({ strip: stripNames });

  const envCheck = assertChildEnvIsClean(sanitized.env, stripNames);
  if (!envCheck.clean) {
    return fail(
      'API_KEY_PRESENT',
      'Variáveis de API sobreviveram à sanitização do ambiente: execução do Claude abortada ' +
        'para não gerar cobrança por token.',
      { leaked: envCheck.leaked, agent: 'claude' },
    );
  }

  const model = resolveModel(options);
  const timeoutMs = resolveTimeoutMs(options);
  const args = buildArgs(options, model);

  const processResult: ProcessResult = await runProcess(
    options.config.agents.claudeCommand,
    args,
    {
      cwd: options.cwd,
      timeoutMs,
      env: sanitized.env,
      // A instrução vai por STDIN: no Windows a linha de comando é limitada a
      // 8191 caracteres e um prompt longo estouraria esse limite.
      input: options.instruction,
      signal: options.signal,
    },
  );

  const stdoutWrite = writeArtifactSync(stdoutPath, processResult.stdout);
  if (!stdoutWrite.ok) return stdoutWrite;
  const stderrWrite = writeArtifactSync(stderrPath, processResult.stderr);
  if (!stderrWrite.ok) return stderrWrite;

  const payload = parseClaudeJson(processResult.stdout);
  const output = payload.output ?? processResult.stdout;

  // A varredura por limite/autenticação usa a stderr sempre e a saída principal
  // apenas quando houve falha. Isso evita falso positivo quando o próprio
  // trabalho do agente menciona termos como "authentication" ou "rate limit".
  const failed = processResult.status !== 'COMPLETED' || processResult.exitCode !== 0;
  // O eco da instrução é removido antes da varredura: o pacote de auditoria
  // contém o próprio código-fonte do OrqPEG, que traz estes marcadores como
  // literais e contaminaria a classificação.
  const scanText = buildFailureScanText({
    stderr: processResult.stderr,
    output,
    instruction: options.instruction,
    includeOutput: failed || payload.isError,
  });

  // Só classificamos o motivo quando o processo de fato falhou: uma execução
  // bem-sucedida não vira "sem autenticação" só porque a palavra apareceu no
  // texto ecoado. Ver a justificativa detalhada no adaptador do Codex.
  const classified = classifyClaudeFailure(scanText);
  const processFailed = failed || payload.isError;
  const usageLimitReached = processFailed && classified.usageLimitReached;
  const authRequired = processFailed && classified.authRequired;

  const invocation: AgentInvocation = {
    agent: 'claude',
    role: options.role,
    instructionPath,
    cwd: options.cwd,
    model,
    startedAt: processResult.startedAt,
    finishedAt: processResult.finishedAt,
    durationMs: processResult.durationMs,
    status: processResult.status,
    exitCode: processResult.exitCode,
    sessionId: payload.sessionId,
    stdoutPath,
    stderrPath,
    usageLimitReached,
    authRequired,
  };

  // A invocação completa acompanha o erro para que o orquestrador consiga
  // registrar a tentativa mesmo quando ela falha.
  const details: Record<string, unknown> = {
    agent: 'claude',
    role: options.role,
    status: processResult.status,
    exitCode: processResult.exitCode,
    instructionPath,
    stdoutPath,
    stderrPath,
    durationMs: processResult.durationMs,
    invocation,
  };

  if (processResult.status === 'COMMAND_NOT_FOUND') {
    return fail(
      'TOOL_MISSING',
      `O executável "${options.config.agents.claudeCommand}" não foi encontrado. ` +
        'Instale o Claude Code e faça login com a assinatura Claude Max antes de executar prompts.',
      details,
    );
  }

  if (usageLimitReached) {
    return fail(
      'USAGE_LIMIT_REACHED',
      'O Claude Code informou que o limite de uso da assinatura foi atingido. ' +
        'A execução foi interrompida; retome quando a cota for renovada.',
      details,
    );
  }

  if (authRequired) {
    return fail(
      'AUTH_REQUIRED',
      'O Claude Code exigiu autenticação. Abra o CLI "claude", rode "/login" e entre com a ' +
        'assinatura Claude Max. O OrqPEG nunca usa chave de API.',
      details,
    );
  }

  if (processResult.status === 'TIMEOUT') {
    return fail(
      'PROCESS_TIMEOUT',
      `O Claude Code excedeu o tempo limite de ${Math.round(timeoutMs / 1000)}s e foi encerrado.`,
      details,
    );
  }

  if (processResult.status === 'INTERRUPTED') {
    return fail('PROCESS_INTERRUPTED', 'A execução do Claude Code foi cancelada.', details);
  }

  if (processResult.status === 'FAILED') {
    return fail(
      'PROCESS_FAILED',
      `O Claude Code terminou com código ${String(processResult.exitCode)}. ` +
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

function buildArgs(options: ClaudeRunOptions, model: string | null): string[] {
  const args: string[] = ['-p', '--output-format', 'json'];

  if (model !== null) args.push('--model', model);

  // Garante acesso explícito ao diretório de trabalho da execução.
  args.push('--add-dir', options.cwd);

  args.push(
    '--append-system-prompt',
    options.readOnly ? READ_ONLY_SYSTEM_PROMPT : EDIT_MODE_SYSTEM_PROMPT,
  );

  // Auditor: modo "plan" nunca aplica alteração no disco.
  // Executor/corretor: "acceptEdits" aceita edições de arquivo, mas as regras de
  // --disallowedTools continuam bloqueando git destrutivo e publicação.
  args.push('--permission-mode', options.readOnly ? 'plan' : 'acceptEdits');

  const disallowed = options.readOnly
    ? READ_ONLY_DISALLOWED_TOOLS
    : EDIT_MODE_DISALLOWED_TOOLS;

  // Lista em um único argumento separado por vírgula: a opção é variádica no
  // CLI, e manter um único token evita que ela consuma argumentos seguintes.
  // Por isso ela é sempre a ÚLTIMA opção da linha.
  args.push('--disallowedTools', disallowed.join(','));

  return args;
}

function resolveModel(options: ClaudeRunOptions): string | null {
  const explicit = options.model;
  if (typeof explicit === 'string' && explicit.trim().length > 0) return explicit.trim();
  const fallback = options.config.agents.defaultClaudeModel;
  if (typeof fallback === 'string' && fallback.trim().length > 0) return fallback.trim();
  return null;
}

function resolveTimeoutMs(options: ClaudeRunOptions): number {
  if (Number.isFinite(options.timeoutMs) && options.timeoutMs > 0) return options.timeoutMs;
  return Math.max(1, options.config.agents.claudeTimeoutSeconds) * 1000;
}

/* ------------------------------------------------------------------------- */
/* Leitura da saída JSON                                                      */
/* ------------------------------------------------------------------------- */

interface ClaudePayload {
  output: string | null;
  sessionId: string | null;
  isError: boolean;
}

/**
 * Interpreta a saída de `--output-format json`.
 *
 * Aceita tanto um objeto único quanto um array de eventos (formatos usados por
 * versões diferentes do CLI). Se o parse falhar, devolve `output: null` e o
 * chamador usa a stdout crua — nunca perdemos o trabalho do agente.
 */
function parseClaudeJson(stdout: string): ClaudePayload {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return { output: null, sessionId: null, isError: false };

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { output: null, sessionId: null, isError: false };
  }

  const record = selectPayload(parsed);
  if (record === null) return { output: null, sessionId: null, isError: false };

  const rawResult = record['result'];
  const rawSession = record['session_id'];
  const rawSubtype = record['subtype'];

  const isError =
    record['is_error'] === true ||
    (typeof rawSubtype === 'string' && rawSubtype.length > 0 && rawSubtype !== 'success');

  return {
    output: typeof rawResult === 'string' ? rawResult : null,
    sessionId: typeof rawSession === 'string' && rawSession.length > 0 ? rawSession : null,
    isError,
  };
}

function selectPayload(parsed: unknown): Record<string, unknown> | null {
  if (Array.isArray(parsed)) {
    for (let index = parsed.length - 1; index >= 0; index -= 1) {
      const candidate = parsed[index];
      if (isRecord(candidate) && ('result' in candidate || 'session_id' in candidate)) {
        return candidate;
      }
    }
    return null;
  }
  return isRecord(parsed) ? parsed : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function containsAny(loweredText: string, markers: readonly string[]): boolean {
  return markers.some((marker) => loweredText.includes(marker));
}
