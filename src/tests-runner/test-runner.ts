import type {
  ProcessResult,
  ProcessRunOptions,
  ProcessStatus,
  TestCommandResult,
  TestStatus,
  TestSuiteResult,
} from '../types';
import { runProcess } from '../agents/process-runner';
import { BLOCKING_API_ENV_VARS } from '../security/api-guard';
import { buildToolEnv } from '../security/env-sanitizer';
import { redactKnownValues, redactText } from '../utils/redact';
import { durationMsBetween, formatDuration, nowIso } from '../utils/time';

/**
 * Executor oficial de testes do OrqPEG.
 *
 * O OrqPEG é a AUTORIDADE sobre o resultado dos testes: nenhuma IA decide se um
 * teste passou. O veredito vem exclusivamente do código de saída dos processos
 * executados aqui, e cada comando fica registrado com início, fim, duração,
 * saída padrão, saída de erro e status.
 *
 * Nenhum comando passa por shell: a string é tokenizada localmente e entregue ao
 * `spawn` como executável + vetor de argumentos, o que elimina injeção de
 * comando por metacaracteres.
 */

/** Limite defensivo de tamanho para o texto guardado por fluxo de saída. */
const MAX_STREAM_CHARS = 400_000;

export interface RunTestSuiteInput {
  /** Comandos como o usuário escreveu, ex.: `npm run lint`. */
  commands: string[];
  /** Diretório de execução (worktree ou repositório). */
  cwd: string;
  /** Tempo máximo por comando, em segundos. */
  timeoutSeconds: number;
  /** Padrão `false`: roda todos os comandos e agrega o resultado. */
  stopOnFirstFailure?: boolean;
  signal?: AbortSignal;
  onCommandStart?: (command: string) => void;
  onCommandEnd?: (result: TestCommandResult) => void;
}

/**
 * Divide uma linha de comando em executável + argumentos, respeitando aspas
 * duplas e simples.
 *
 * A barra invertida NÃO é tratada como escape porque no Windows ela é separador
 * de caminho: `node C:\meus projetos\app.js` continuaria quebrado. Para incluir
 * espaços, use aspas: `node "C:\Meus Projetos\app.js"`.
 */
export function tokenizeCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let started = false;
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < command.length; i += 1) {
    const char = command.charAt(i);

    if (quote !== null) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      started = true;
      continue;
    }

    if (isSeparator(char)) {
      if (started) {
        tokens.push(current);
        current = '';
        started = false;
      }
      continue;
    }

    current += char;
    started = true;
  }

  if (started) tokens.push(current);
  return tokens;
}

/**
 * Executa a suíte de testes do projeto e devolve o resultado agregado.
 * Nunca lança: qualquer falha vira status no `TestSuiteResult`.
 */
export async function runTestSuite(input: RunTestSuiteInput): Promise<TestSuiteResult> {
  const startedAt = nowIso();
  const stopOnFirstFailure = input.stopOnFirstFailure ?? false;
  const timeoutMs = resolveTimeoutMs(input.timeoutSeconds);
  const env = buildToolEnv();

  const commands = input.commands
    .map((command) => command.trim())
    .filter((command) => command.length > 0);

  const results: TestCommandResult[] = [];
  let stopped = false;

  for (const command of commands) {
    if (stopped) {
      const skipped = makeSyntheticResult(
        command,
        input.cwd,
        'NOT_RUN',
        'Comando não executado: a suíte foi encerrada antes de chegar a ele.',
      );
      results.push(skipped);
      input.onCommandEnd?.(skipped);
      continue;
    }

    if (input.signal?.aborted) {
      // O comando não chegou a iniciar porque a execução foi cancelada.
      // Marcamos INTERRUPTED para que o status agregado reflita o cancelamento;
      // os comandos seguintes ficam NOT_RUN.
      const cancelled = makeSyntheticResult(
        command,
        input.cwd,
        'INTERRUPTED',
        'Execução cancelada antes de iniciar este comando.',
      );
      results.push(cancelled);
      input.onCommandEnd?.(cancelled);
      stopped = true;
      continue;
    }

    input.onCommandStart?.(command);
    const result = await runSingleCommand(command, input.cwd, timeoutMs, env, input.signal);
    results.push(result);
    input.onCommandEnd?.(result);

    if (result.status === 'INTERRUPTED') {
      stopped = true;
      continue;
    }
    if (stopOnFirstFailure && result.status !== 'PASSED') {
      stopped = true;
    }
  }

  const finishedAt = nowIso();
  const status = aggregateStatus(results);

  return {
    status,
    passed: status === 'PASSED',
    startedAt,
    finishedAt,
    durationMs: durationMsBetween(startedAt, finishedAt),
    commands: results,
    failedCommands: results
      .filter((item) => item.status !== 'PASSED' && item.status !== 'NOT_RUN')
      .map((item) => item.command),
  };
}

/** Resumo legível em português, para o painel, os relatórios e o CLI. */
export function summarizeTestSuite(result: TestSuiteResult): string {
  if (result.commands.length === 0) {
    return 'Testes: nenhum comando de teste configurado para este projeto.';
  }

  const counts = countByStatus(result.commands);
  const lines: string[] = [];

  lines.push(
    `Testes: ${describeSuiteStatus(result.status)} — ` +
      `${String(result.commands.length)} comando(s) em ${formatDuration(result.durationMs)}.`,
  );
  lines.push(
    `Passaram: ${String(counts.passed)} | Falharam: ${String(counts.failed)} | ` +
      `Timeout: ${String(counts.timeout)} | Interrompidos: ${String(counts.interrupted)} | ` +
      `Comando ausente: ${String(counts.notFound)} | Não executados: ${String(counts.notRun)}.`,
  );

  for (const item of result.commands) {
    const exit = item.exitCode === null ? 'sem código' : `código ${String(item.exitCode)}`;
    lines.push(
      `  [${describeCommandStatus(item.status)}] ${item.command} — ${exit}, ` +
        `${formatDuration(item.durationMs)}`,
    );
  }

  if (result.failedCommands.length > 0) {
    lines.push(`Comandos que não passaram: ${result.failedCommands.join(', ')}.`);
  }

  return lines.join('\n');
}

/* ------------------------------------------------------------------------- */
/* Execução de um comando                                                     */
/* ------------------------------------------------------------------------- */

async function runSingleCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal | undefined,
): Promise<TestCommandResult> {
  const tokens = tokenizeCommand(command);
  const executable = tokens[0];

  if (executable === undefined || executable.length === 0) {
    return makeSyntheticResult(
      command,
      cwd,
      'FAILED',
      'Comando inválido: não foi possível identificar o executável.',
    );
  }

  const args = tokens.slice(1);
  const options: ProcessRunOptions = {
    cwd,
    timeoutMs,
    env,
    signal,
  };

  const startedAt = nowIso();
  let executed: ProcessResult;
  try {
    executed = await runProcess(executable, args, options);
  } catch (error) {
    // `runProcess` não lança; esta guarda existe para que uma rejeição
    // inesperada vire um teste reprovado em vez de derrubar a execução.
    return makeSyntheticResult(
      command,
      cwd,
      'FAILED',
      `Falha inesperada ao executar o comando: ${describeUnknown(error)}`,
      startedAt,
    );
  }

  return {
    command,
    cwd: executed.cwd,
    status: mapProcessStatus(executed.status, executed.exitCode),
    exitCode: executed.exitCode,
    startedAt: executed.startedAt,
    finishedAt: executed.finishedAt,
    durationMs: executed.durationMs,
    stdout: sanitizeStream(executed.stdout, executed.stdoutTruncated),
    stderr: sanitizeStream(executed.stderr, executed.stderrTruncated),
  };
}

function mapProcessStatus(status: ProcessStatus, exitCode: number | null): TestStatus {
  switch (status) {
    case 'COMPLETED':
      return exitCode === 0 ? 'PASSED' : 'FAILED';
    case 'FAILED':
      return 'FAILED';
    case 'TIMEOUT':
      return 'TIMEOUT';
    case 'INTERRUPTED':
      return 'INTERRUPTED';
    case 'COMMAND_NOT_FOUND':
      return 'COMMAND_NOT_FOUND';
    default:
      return 'FAILED';
  }
}

/* ------------------------------------------------------------------------- */
/* Agregação                                                                  */
/* ------------------------------------------------------------------------- */

function aggregateStatus(results: readonly TestCommandResult[]): TestStatus {
  if (results.length === 0) return 'PASSED';
  if (results.every((item) => item.status === 'PASSED')) return 'PASSED';
  if (results.some((item) => item.status === 'TIMEOUT')) return 'TIMEOUT';
  if (results.some((item) => item.status === 'INTERRUPTED')) return 'INTERRUPTED';
  if (results.some((item) => item.status === 'COMMAND_NOT_FOUND')) return 'COMMAND_NOT_FOUND';
  return 'FAILED';
}

interface StatusCounts {
  passed: number;
  failed: number;
  timeout: number;
  interrupted: number;
  notFound: number;
  notRun: number;
}

function countByStatus(results: readonly TestCommandResult[]): StatusCounts {
  const counts: StatusCounts = {
    passed: 0,
    failed: 0,
    timeout: 0,
    interrupted: 0,
    notFound: 0,
    notRun: 0,
  };
  for (const item of results) {
    switch (item.status) {
      case 'PASSED':
        counts.passed += 1;
        break;
      case 'FAILED':
        counts.failed += 1;
        break;
      case 'TIMEOUT':
        counts.timeout += 1;
        break;
      case 'INTERRUPTED':
        counts.interrupted += 1;
        break;
      case 'COMMAND_NOT_FOUND':
        counts.notFound += 1;
        break;
      case 'NOT_RUN':
        counts.notRun += 1;
        break;
      default:
        break;
    }
  }
  return counts;
}

function describeSuiteStatus(status: TestStatus): string {
  switch (status) {
    case 'PASSED':
      return 'PASSARAM';
    case 'FAILED':
      return 'FALHARAM';
    case 'TIMEOUT':
      return 'TEMPO ESGOTADO';
    case 'INTERRUPTED':
      return 'INTERROMPIDOS';
    case 'COMMAND_NOT_FOUND':
      return 'COMANDO NÃO ENCONTRADO';
    case 'NOT_RUN':
      return 'NÃO EXECUTADOS';
    default:
      return 'DESCONHECIDO';
  }
}

function describeCommandStatus(status: TestStatus): string {
  switch (status) {
    case 'PASSED':
      return 'OK';
    case 'FAILED':
      return 'FALHOU';
    case 'TIMEOUT':
      return 'TIMEOUT';
    case 'INTERRUPTED':
      return 'INTERROMPIDO';
    case 'COMMAND_NOT_FOUND':
      return 'NÃO ENCONTRADO';
    case 'NOT_RUN':
      return 'NÃO EXECUTADO';
    default:
      return 'DESCONHECIDO';
  }
}

/* ------------------------------------------------------------------------- */
/* Apoio                                                                      */
/* ------------------------------------------------------------------------- */

function makeSyntheticResult(
  command: string,
  cwd: string,
  status: TestStatus,
  message: string,
  startedAt: string = nowIso(),
): TestCommandResult {
  const finishedAt = nowIso();
  return {
    command,
    cwd,
    status,
    exitCode: null,
    startedAt,
    finishedAt,
    durationMs: durationMsBetween(startedAt, finishedAt),
    stdout: '',
    stderr: message,
  };
}

/**
 * Toda saída capturada é redigida antes de ser guardada: ela vai para artefatos,
 * relatórios, painel e para o pacote entregue às IAs revisoras.
 */
function sanitizeStream(value: string, truncatedByRunner: boolean): string {
  const source = typeof value === 'string' ? value : '';
  let text = source;
  let trimmedHere = false;

  if (text.length > MAX_STREAM_CHARS) {
    text = text.slice(text.length - MAX_STREAM_CHARS);
    trimmedHere = true;
  }

  let output = redactText(redactKnownValues(text, BLOCKING_API_ENV_VARS));

  if (trimmedHere) {
    output =
      `[AVISO: saída cortada pelo OrqPEG. Tamanho original: ${String(source.length)} caracteres; ` +
      `mantidos os últimos ${String(MAX_STREAM_CHARS)}.]\n${output}`;
  }
  if (truncatedByRunner) {
    output = `[AVISO: saída truncada pelo executor de processos por limite de bytes.]\n${output}`;
  }
  return output;
}

function resolveTimeoutMs(timeoutSeconds: number): number {
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) return 600_000;
  return Math.round(timeoutSeconds * 1000);
}

function isSeparator(char: string): boolean {
  const code = char.charCodeAt(0);
  // espaço, tabulação, nova linha, retorno de carro e avanço de página.
  return code === 32 || code === 9 || code === 10 || code === 13 || code === 12;
}

function describeUnknown(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === 'string') return value;
  if (value === undefined) return 'motivo não informado';
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
