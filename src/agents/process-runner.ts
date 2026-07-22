import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import * as path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

import type { ProcessResult, ProcessRunOptions, ProcessStatus } from '../types';
import { buildSanitizedEnv } from '../security/env-sanitizer';
import { redactText } from '../utils/redact';
import { durationMsBetween, nowIso } from '../utils/time';

/**
 * Camada única de execução de processos externos do OrqPEG.
 *
 * Regras invioláveis deste módulo:
 *  - `spawn` sempre com ARRAY de argumentos e `shell: false`. Nenhuma linha de
 *    comando é montada por concatenação de strings, o que elimina a classe
 *    inteira de injeção de comando;
 *  - nenhum erro esperado vira exceção: o retorno é sempre um `ProcessResult`
 *    preenchido, inclusive quando o executável não existe;
 *  - toda saída passa por `redactText` antes de sair daqui, de modo que nenhum
 *    token acidentalmente impresso por uma ferramenta chegue a disco ou painel.
 */

/** Limite padrão de captura por fluxo (20 MiB). */
export const DEFAULT_MAX_OUTPUT_BYTES = 20 * 1024 * 1024;

/** Timeout curto usado apenas pela sondagem `commandExists`. */
const COMMAND_EXISTS_TIMEOUT_MS = 20_000;

/** Código que o cmd.exe devolve quando o comando não é reconhecido. */
const CMD_COMMAND_NOT_FOUND_EXIT_CODE = 9009;

/**
 * Mensagens do cmd.exe para "comando não reconhecido". O texto muda conforme o
 * idioma do Windows, por isso verificamos as variantes mais comuns (en/pt/es).
 */
const CMD_NOT_RECOGNIZED_MARKERS: readonly string[] = [
  'is not recognized as an internal or external command',
  'não é reconhecido como um comando interno',
  'nao e reconhecido como um comando interno',
  'no se reconoce como un comando interno',
  'cannot find the path specified',
  'o sistema não pode encontrar o caminho especificado',
];

interface LaunchPlan {
  /** Executável realmente entregue ao `spawn`. */
  file: string;
  /** Vetor de argumentos realmente entregue ao `spawn`. */
  argv: string[];
  /** Ambiente realmente entregue ao `spawn`. */
  env: NodeJS.ProcessEnv;
  /** Verdadeiro quando a chamada foi encaminhada pelo cmd.exe. */
  viaCmd: boolean;
}

interface Accumulator {
  parts: string[];
  bytes: number;
  limit: number;
  truncated: boolean;
  decoder: StringDecoder;
}

/**
 * Executa um processo externo e devolve o resultado completo.
 *
 * Nunca lança: falhas de spawn, timeout e cancelamento viram `status`.
 */
export async function runProcess(
  command: string,
  args: string[],
  options: ProcessRunOptions,
): Promise<ProcessResult> {
  const startedAt = nowIso();
  const limit =
    typeof options.maxOutputBytes === 'number' && options.maxOutputBytes > 0
      ? options.maxOutputBytes
      : DEFAULT_MAX_OUTPUT_BYTES;
  const env = options.env ?? buildSanitizedEnv().env;
  const plan = resolveLaunchPlan(command, args, env);

  const stdoutAcc = createAccumulator(limit);
  const stderrAcc = createAccumulator(limit);

  // Cancelamento anterior ao spawn: nem chegamos a criar o processo.
  if (options.signal?.aborted === true) {
    return buildResult({
      command,
      args,
      options,
      status: 'INTERRUPTED',
      exitCode: null,
      signal: null,
      stdout: '',
      stderr: 'Execução cancelada antes de iniciar o processo.',
      startedAt,
      timedOut: false,
      stdoutTruncated: false,
      stderrTruncated: false,
    });
  }

  const spawned = trySpawn(plan, options);
  if (spawned instanceof Error) {
    return buildResult({
      command,
      args,
      options,
      status: 'COMMAND_NOT_FOUND',
      exitCode: null,
      signal: null,
      stdout: '',
      stderr: `Falha ao iniciar "${command}": ${spawned.message}`,
      startedAt,
      timedOut: false,
      stdoutTruncated: false,
      stderrTruncated: false,
    });
  }

  const child = spawned;

  return new Promise<ProcessResult>((resolve) => {
    let settled = false;
    let timedOut = false;
    let interrupted = false;
    let commandNotFound = false;
    let spawnErrorMessage: string | null = null;
    let timer: NodeJS.Timeout | null = null;

    const onAbort = (): void => {
      interrupted = true;
      killProcessTree(child);
    };

    const cleanup = (): void => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      options.signal?.removeEventListener('abort', onAbort);
    };

    const finish = (
      status: ProcessStatus,
      exitCode: number | null,
      signalName: string | null,
    ): void => {
      if (settled) return;
      settled = true;
      cleanup();

      let stderrText = collect(stderrAcc);
      if (spawnErrorMessage !== null) {
        stderrText = stderrText.length > 0
          ? `${stderrText}\n${spawnErrorMessage}`
          : spawnErrorMessage;
      }

      resolve(
        buildResult({
          command,
          args,
          options,
          status,
          exitCode,
          signal: signalName,
          stdout: collect(stdoutAcc),
          stderr: stderrText,
          startedAt,
          timedOut,
          stdoutTruncated: stdoutAcc.truncated,
          stderrTruncated: stderrAcc.truncated,
        }),
      );
    };

    if (options.signal) {
      options.signal.addEventListener('abort', onAbort, { once: true });
    }

    if (Number.isFinite(options.timeoutMs) && options.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        killProcessTree(child);
      }, options.timeoutMs);
      // O timer não deve, sozinho, segurar o event loop aberto.
      timer.unref();
    }

    child.stdout.on('data', (chunk: Buffer) => {
      const text = pushChunk(stdoutAcc, chunk);
      if (text.length > 0 && options.onStdout) options.onStdout(text);
    });

    child.stderr.on('data', (chunk: Buffer) => {
      const text = pushChunk(stderrAcc, chunk);
      if (text.length > 0 && options.onStderr) options.onStderr(text);
    });

    child.stdout.on('error', () => {
      /* fluxo encerrado abruptamente: o status vem de 'close' */
    });
    child.stderr.on('error', () => {
      /* idem */
    });

    child.stdin.on('error', () => {
      // EPIPE acontece quando a ferramenta encerra sem consumir a entrada.
      // Não é fatal: o resultado real vem do código de saída.
    });

    // A instrução do agente entra por stdin; encerrar a entrada é obrigatório
    // para que a ferramenta saiba que não haverá mais dados.
    try {
      if (typeof options.input === 'string' && options.input.length > 0) {
        child.stdin.write(options.input, 'utf8');
      }
      child.stdin.end();
    } catch {
      /* processo já encerrado: o status real virá de 'close' */
    }

    child.on('error', (error: Error) => {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') commandNotFound = true;
      spawnErrorMessage = `Erro do processo "${command}": ${error.message}`;
      // Quando o processo sequer nasceu não haverá 'close' útil: finaliza aqui.
      if (child.pid === undefined) {
        finish(commandNotFound ? 'COMMAND_NOT_FOUND' : 'FAILED', null, null);
      }
    });

    child.on('close', (code: number | null, signalName: NodeJS.Signals | null) => {
      const stderrPreview = peek(stderrAcc);
      const status = resolveStatus({
        interrupted,
        timedOut,
        commandNotFound,
        viaCmd: plan.viaCmd,
        exitCode: code,
        stderrText: stderrPreview,
      });
      finish(status, code, signalName);
    });
  });
}

/**
 * Sondagem barata de disponibilidade: roda `<comando> --version`.
 *
 * Um código de saída diferente de zero ainda indica que o executável existe;
 * apenas `COMMAND_NOT_FOUND` significa ausência.
 */
export async function commandExists(command: string): Promise<boolean> {
  const result = await runProcess(command, ['--version'], {
    cwd: process.cwd(),
    timeoutMs: COMMAND_EXISTS_TIMEOUT_MS,
    maxOutputBytes: 64 * 1024,
  });
  return result.status !== 'COMMAND_NOT_FOUND';
}

/* ------------------------------------------------------------------------- */
/* Plano de lançamento                                                        */
/* ------------------------------------------------------------------------- */

/**
 * Decide como o executável será invocado.
 *
 * No Windows, ferramentas instaladas por npm (`claude`, `codex`, `npm`, `gh`)
 * são arquivos `.cmd`/`.ps1`, e não executáveis PE. O `CreateProcess` do
 * Windows não sabe executá-los diretamente, então encaminhamos por
 * `cmd.exe /d /s /c <comando> <args...>`.
 *
 * Isso NÃO é `shell: true`: continuamos passando um VETOR de argumentos, o
 * interpretador não recebe uma linha montada por concatenação e o `cmd.exe`
 * apenas resolve o executável e repassa os argumentos. Como o cmd.exe ainda
 * interpreta metacaracteres (`& | < > ( ) ^`) que apareçam FORA de aspas, os
 * argumentos que o Node não colocaria entre aspas são escapados com `^`, o que
 * o próprio cmd.exe desfaz antes de entregar o argumento ao programa alvo.
 */
function resolveLaunchPlan(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): LaunchPlan {
  if (process.platform !== 'win32' || /\.exe$/i.test(command)) {
    return { file: command, argv: [...args], env, viaCmd: false };
  }

  const comspec = process.env['ComSpec'];
  const shellPath = comspec && comspec.trim().length > 0 ? comspec : 'cmd.exe';

  let effectiveCommand = command;
  let effectiveEnv = env;

  /*
   * Caminho absoluto com espaço (ex.: "E:\Meus Programas\cli\claude.cmd").
   *
   * O `cmd.exe /s` remove a PRIMEIRA e a ÚLTIMA aspas da linha restante. Se a
   * linha começasse com o executável entre aspas, o caminho com espaço seria
   * quebrado. Em vez de montar a linha manualmente (o que exigiria
   * `windowsVerbatimArguments`), colocamos o diretório do executável no PATH da
   * cópia de ambiente do filho e passamos apenas o nome do arquivo — assim a
   * linha nunca começa com aspas e os argumentos seguem vetorizados.
   */
  if (needsQuoting(command) && path.isAbsolute(command)) {
    const baseName = path.basename(command);
    if (!needsQuoting(baseName)) {
      effectiveCommand = baseName;
      effectiveEnv = withPathPrefix(env, path.dirname(command));
    }
  }

  return {
    file: shellPath,
    argv: ['/d', '/s', '/c', escapeForCmd(effectiveCommand), ...args.map(escapeForCmd)],
    env: effectiveEnv,
    viaCmd: true,
  };
}

function needsQuoting(value: string): boolean {
  return value.includes(' ') || value.includes('\t') || value.includes('"');
}

/** Copia o ambiente colocando `dir` à frente do PATH (chave achada sem case). */
function withPathPrefix(env: NodeJS.ProcessEnv, dir: string): NodeJS.ProcessEnv {
  const copy: NodeJS.ProcessEnv = { ...env };
  let pathKey = 'PATH';
  for (const key of Object.keys(copy)) {
    if (key.toLowerCase() === 'path') {
      pathKey = key;
      break;
    }
  }
  const current = copy[pathKey];
  copy[pathKey] =
    current === undefined || current.length === 0 ? dir : `${dir}${path.delimiter}${current}`;
  return copy;
}

/** Metacaracteres interpretados pelo cmd.exe quando não estão entre aspas. */
const CMD_METACHARS = new Set(['^', '&', '|', '<', '>', '(', ')']);

/**
 * O Node envolve em aspas qualquer argumento que contenha espaço, tabulação ou
 * aspas; dentro das aspas o cmd.exe não interpreta metacaracteres. Para os
 * demais argumentos aplicamos o escape `^` manualmente.
 */
function escapeForCmd(value: string): string {
  if (value.length === 0) return value;
  if (needsQuoting(value)) return value;
  let escaped = '';
  for (const character of value) {
    escaped += CMD_METACHARS.has(character) ? `^${character}` : character;
  }
  return escaped;
}

function trySpawn(
  plan: LaunchPlan,
  options: ProcessRunOptions,
): ChildProcessWithoutNullStreams | Error {
  try {
    return spawn(plan.file, plan.argv, {
      cwd: options.cwd,
      env: plan.env,
      shell: false,
      windowsHide: true,
      windowsVerbatimArguments: false,
    });
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

/* ------------------------------------------------------------------------- */
/* Encerramento da árvore de processos                                        */
/* ------------------------------------------------------------------------- */

/**
 * Mata o processo e seus descendentes.
 *
 * No Windows, `child.kill()` encerraria apenas o `cmd.exe` intermediário e
 * deixaria a ferramenta real órfã; por isso usamos `taskkill /T /F`, que
 * percorre a árvore. Em sistemas POSIX tentamos o grupo de processos e caímos
 * para o PID direto.
 */
function killProcessTree(child: ChildProcessWithoutNullStreams): void {
  const pid = child.pid;
  if (pid === undefined) return;

  if (process.platform === 'win32') {
    try {
      const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
        shell: false,
        windowsHide: true,
        stdio: 'ignore',
      });
      killer.on('error', () => {
        safeKill(child);
      });
      killer.unref();
      return;
    } catch {
      safeKill(child);
      return;
    }
  }

  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    safeKill(child);
  }
}

function safeKill(child: ChildProcessWithoutNullStreams): void {
  try {
    child.kill('SIGKILL');
  } catch {
    /* processo já encerrado */
  }
}

/* ------------------------------------------------------------------------- */
/* Acumulação de saída                                                        */
/* ------------------------------------------------------------------------- */

function createAccumulator(limit: number): Accumulator {
  return {
    parts: [],
    bytes: 0,
    limit,
    truncated: false,
    decoder: new StringDecoder('utf8'),
  };
}

/**
 * Decodifica o pedaço recebido e acumula até o limite.
 *
 * Ao exceder o limite paramos de acumular e marcamos truncamento, mas NÃO
 * matamos o processo: uma ferramenta verbosa ainda pode terminar com sucesso.
 * O texto decodificado continua sendo devolvido para os callbacks de streaming.
 */
function pushChunk(acc: Accumulator, chunk: Buffer): string {
  const text = acc.decoder.write(chunk);
  if (acc.truncated) return text;

  if (acc.bytes + chunk.length > acc.limit) {
    const remaining = acc.limit - acc.bytes;
    if (remaining > 0 && text.length > 0) {
      acc.parts.push(text.slice(0, remaining));
    }
    acc.parts.push('\n[saída truncada pelo OrqPEG: limite de captura atingido]');
    acc.bytes = acc.limit;
    acc.truncated = true;
    return text;
  }

  acc.bytes += chunk.length;
  if (text.length > 0) acc.parts.push(text);
  return text;
}

/** Texto acumulado até o momento, sem encerrar o decodificador. */
function peek(acc: Accumulator): string {
  return acc.parts.join('');
}

/** Encerra o decodificador (liberando bytes pendentes) e devolve o texto. */
function collect(acc: Accumulator): string {
  const tail = acc.decoder.end();
  if (tail.length > 0 && !acc.truncated) acc.parts.push(tail);
  return acc.parts.join('');
}

/* ------------------------------------------------------------------------- */
/* Classificação do resultado                                                 */
/* ------------------------------------------------------------------------- */

interface StatusInput {
  interrupted: boolean;
  timedOut: boolean;
  commandNotFound: boolean;
  viaCmd: boolean;
  exitCode: number | null;
  stderrText: string;
}

function resolveStatus(input: StatusInput): ProcessStatus {
  if (input.interrupted) return 'INTERRUPTED';
  if (input.timedOut) return 'TIMEOUT';
  if (input.commandNotFound) return 'COMMAND_NOT_FOUND';
  // Encaminhado pelo cmd.exe: o ENOENT vira código 9009 e uma mensagem própria.
  if (input.viaCmd && isCmdCommandNotFound(input.exitCode, input.stderrText)) {
    return 'COMMAND_NOT_FOUND';
  }
  return input.exitCode === 0 ? 'COMPLETED' : 'FAILED';
}

function isCmdCommandNotFound(exitCode: number | null, stderrText: string): boolean {
  if (exitCode === CMD_COMMAND_NOT_FOUND_EXIT_CODE) return true;
  if (exitCode === null || exitCode === 0) return false;
  const lowered = stderrText.toLowerCase();
  return CMD_NOT_RECOGNIZED_MARKERS.some((marker) => lowered.includes(marker));
}

interface ResultInput {
  command: string;
  args: string[];
  options: ProcessRunOptions;
  status: ProcessStatus;
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  startedAt: string;
  timedOut: boolean;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

function buildResult(input: ResultInput): ProcessResult {
  const finishedAt = nowIso();
  return {
    // `command`/`args` refletem a intenção do chamador, não o invólucro cmd.exe.
    command: input.command,
    args: [...input.args],
    cwd: input.options.cwd,
    status: input.status,
    exitCode: input.exitCode,
    signal: input.signal,
    stdout: redactText(input.stdout),
    stderr: redactText(input.stderr),
    startedAt: input.startedAt,
    finishedAt,
    durationMs: durationMsBetween(input.startedAt, finishedAt),
    timedOut: input.timedOut,
    stdoutTruncated: input.stdoutTruncated,
    stderrTruncated: input.stderrTruncated,
  };
}
