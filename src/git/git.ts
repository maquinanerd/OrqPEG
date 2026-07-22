import { runProcess } from '../agents/process-runner';
import type {
  GitStatus,
  GitStatusEntry,
  ProcessResult,
  ProcessRunOptions,
  Result,
} from '../types';
import { fail, ok } from '../utils/errors';
import { redactText } from '../utils/redact';
import { buildToolEnv } from '../security/env-sanitizer';
import { validateAbsolutePath } from '../security/path-guard';
import { validateBranchName } from '../security/branch-name';

/**
 * Camada de acesso ao Git CLI.
 *
 * Princípios inegociáveis deste módulo:
 *
 *  1. Todo comando é executado por `spawn` com ARRAY de argumentos, via
 *     `runProcess`. Nunca há concatenação de linha de comando nem `shell: true`,
 *     o que elimina injeção de comando.
 *  2. Todo comando roda com `['-C', <dir>, ...]`, de modo que o diretório de
 *     trabalho do processo nunca é decisivo para o repositório alvo.
 *  3. OPERAÇÕES DESTRUTIVAS SÃO PROIBIDAS POR DESIGN. Este módulo NÃO oferece —
 *     e não deve passar a oferecer — `push --force`, `push --force-with-lease`,
 *     `reset --hard`, `checkout --force`, `clean`, `branch -D`, `rebase`,
 *     `filter-branch` ou qualquer variante capaz de descartar trabalho do
 *     usuário. Se um fluxo precisar de algo assim, a resposta correta é parar e
 *     pedir intervenção humana, não implementar a operação aqui.
 *  4. Nomes de branch, remotes e referências são validados ANTES de virarem
 *     argumento. Nenhum valor pode começar com `-`, o que impede que um nome
 *     seja interpretado como opção do Git.
 */

const GIT_COMMAND = 'git';

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
/** Limite generoso para diffs completos: o patch nunca pode ser truncado. */
const PATCH_MAX_OUTPUT_BYTES = 256 * 1024 * 1024;

/**
 * Configurações fixas aplicadas a toda invocação:
 *  - `core.quotePath=false` mantém caminhos com acentos legíveis (E:\Ação);
 *  - `color.ui=false` garante saída sem sequências ANSI para o parser.
 */
const BASE_CONFIG_ARGS: readonly string[] = [
  '-c',
  'core.quotePath=false',
  '-c',
  'color.ui=false',
];

const REMOTE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/@{}^~+-]*$/;

export interface GitCommandOptions {
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  input?: string;
  maxOutputBytes?: number;
  signal?: AbortSignal;
}

export interface GitRemote {
  name: string;
  fetchUrl: string;
  pushUrl: string;
}

export interface GitUserIdentity {
  name: string | null;
  email: string | null;
}

/* ------------------------------------------------------------------------- */
/* Execução                                                                   */
/* ------------------------------------------------------------------------- */

/**
 * Ambiente dos processos Git.
 *
 * `GIT_TERMINAL_PROMPT=0` impede que o Git bloqueie indefinidamente pedindo
 * usuário/senha em um terminal que o orquestrador não controla: em vez de
 * travar, o comando falha rápido com mensagem clara.
 */
function gitEnv(): NodeJS.ProcessEnv {
  return buildToolEnv({ extra: { GIT_TERMINAL_PROMPT: '0' } });
}

/**
 * Executa o Git aceitando qualquer código de saída.
 * Só falha quando o processo sequer produziu um resultado utilizável
 * (executável ausente, timeout, interrupção).
 */
export async function runGitRaw(
  dir: string,
  args: readonly string[],
  options: GitCommandOptions = {},
): Promise<Result<ProcessResult>> {
  const dirCheck = validateAbsolutePath(dir, 'diretório do repositório');
  if (!dirCheck.ok) return dirCheck;
  const cwd = dirCheck.value;

  const fullArgs = ['-C', cwd, ...BASE_CONFIG_ARGS, ...args];

  const runOptions: ProcessRunOptions = {
    cwd,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    env: options.env ?? gitEnv(),
    maxOutputBytes: options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
  };
  if (options.input !== undefined) runOptions.input = options.input;
  if (options.signal !== undefined) runOptions.signal = options.signal;

  let result: ProcessResult;
  try {
    result = await runProcess(GIT_COMMAND, fullArgs, runOptions);
  } catch (error) {
    return fail(
      'PROCESS_FAILED',
      `Não foi possível executar o Git em ${cwd}.`,
      { args: [...args] },
      error,
    );
  }

  switch (result.status) {
    case 'COMPLETED':
    case 'FAILED':
      return ok(result);
    case 'COMMAND_NOT_FOUND':
      return fail(
        'TOOL_MISSING',
        'O executável "git" não foi encontrado no PATH. Instale o Git e reabra o terminal.',
        { cwd, args: [...args] },
      );
    case 'TIMEOUT':
      return fail(
        'PROCESS_TIMEOUT',
        `O comando Git excedeu o tempo limite de ${runOptions.timeoutMs} ms.`,
        { cwd, args: [...args], durationMs: result.durationMs },
      );
    case 'INTERRUPTED':
      return fail('PROCESS_INTERRUPTED', 'O comando Git foi interrompido.', {
        cwd,
        args: [...args],
        signal: result.signal,
      });
    default:
      return fail('GIT_FAILED', 'Estado desconhecido ao executar o Git.', {
        cwd,
        args: [...args],
      });
  }
}

/** Executa o Git exigindo código de saída 0. */
export async function runGitChecked(
  dir: string,
  args: readonly string[],
  options: GitCommandOptions = {},
): Promise<Result<ProcessResult>> {
  const raw = await runGitRaw(dir, args, options);
  if (!raw.ok) return raw;
  if (raw.value.exitCode !== 0) return gitFailure(dir, args, raw.value);
  return ok(raw.value);
}

/** Constrói um erro de Git legível, já redigido contra vazamento de segredos. */
function gitFailure(
  dir: string,
  args: readonly string[],
  result: ProcessResult,
): Result<never> {
  const detail = firstMeaningfulLine(result.stderr) || firstMeaningfulLine(result.stdout);
  const suffix = detail.length > 0 ? ` ${detail}` : '';
  return fail(
    'GIT_FAILED',
    `Comando "git ${args.join(' ')}" falhou com código ${String(result.exitCode)}.${suffix}`,
    {
      cwd: dir,
      args: [...args],
      exitCode: result.exitCode,
      stderr: redactText(result.stderr).slice(0, 2000),
    },
  );
}

function firstMeaningfulLine(text: string): string {
  const lines = redactText(text).split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length > 0) return trimmed.slice(0, 400);
  }
  return '';
}

/* ------------------------------------------------------------------------- */
/* Validações de argumento                                                    */
/* ------------------------------------------------------------------------- */

function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

/**
 * Valida uma referência Git (branch, tag, SHA, `HEAD`, `origin/main`).
 * A restrição essencial é jamais aceitar algo iniciado por `-`, o que
 * transformaria a referência em opção de linha de comando.
 */
export function validateRef(ref: string, label = 'referência'): Result<string> {
  const trimmed = ref.trim();
  if (trimmed.length === 0) return fail('VALIDATION_FAILED', `${label} não pode ser vazia.`);
  if (trimmed.length > 300) {
    return fail('VALIDATION_FAILED', `${label} excede 300 caracteres.`, {
      length: trimmed.length,
    });
  }
  if (hasControlChars(trimmed)) {
    return fail('VALIDATION_FAILED', `${label} contém caracteres de controle.`);
  }
  if (!REF_PATTERN.test(trimmed)) {
    return fail(
      'VALIDATION_FAILED',
      `${label} inválida: comece por letra ou número e use apenas caracteres aceitos pelo Git.`,
      { value: trimmed },
    );
  }
  if (trimmed.includes('..')) {
    return fail('VALIDATION_FAILED', `${label} não pode conter "..".`, { value: trimmed });
  }
  return ok(trimmed);
}

export function validateRemoteName(remote: string): Result<string> {
  const trimmed = remote.trim();
  if (trimmed.length === 0) return fail('VALIDATION_FAILED', 'Nome de remote vazio.');
  if (trimmed.length > 100) {
    return fail('VALIDATION_FAILED', 'Nome de remote excede 100 caracteres.');
  }
  if (!REMOTE_NAME_PATTERN.test(trimmed)) {
    return fail(
      'VALIDATION_FAILED',
      'Nome de remote inválido: use apenas letras, números, ponto, hífen e sublinhado.',
      { value: trimmed },
    );
  }
  return ok(trimmed);
}

/** Valida um pathspec relativo entregue ao `git add`. */
function validatePathspec(value: string): Result<string> {
  const trimmed = value.trim();
  if (trimmed.length === 0) return fail('VALIDATION_FAILED', 'Caminho vazio em "git add".');
  if (hasControlChars(trimmed)) {
    return fail('VALIDATION_FAILED', 'Caminho contém caracteres de controle.', {
      value: trimmed,
    });
  }
  if (trimmed.startsWith('-')) {
    return fail('VALIDATION_FAILED', 'Caminho não pode começar com "-".', { value: trimmed });
  }
  return ok(trimmed);
}

/* ------------------------------------------------------------------------- */
/* Consultas                                                                  */
/* ------------------------------------------------------------------------- */

export async function isRepository(
  dir: string,
  options: GitCommandOptions = {},
): Promise<boolean> {
  const result = await runGitRaw(dir, ['rev-parse', '--is-inside-work-tree'], options);
  if (!result.ok) return false;
  return result.value.exitCode === 0 && result.value.stdout.trim() === 'true';
}

/** Raiz do diretório de trabalho do repositório que contém `dir`. */
export async function repositoryRoot(
  dir: string,
  options: GitCommandOptions = {},
): Promise<Result<string>> {
  const result = await runGitChecked(dir, ['rev-parse', '--show-toplevel'], options);
  if (!result.ok) return result;
  const value = result.value.stdout.trim();
  if (value.length === 0) {
    return fail('GIT_FAILED', `Não foi possível determinar a raiz do repositório em ${dir}.`);
  }
  return ok(value);
}

export async function currentBranch(
  dir: string,
  options: GitCommandOptions = {},
): Promise<Result<string>> {
  const result = await runGitChecked(dir, ['rev-parse', '--abbrev-ref', 'HEAD'], options);
  if (!result.ok) return result;
  const value = result.value.stdout.trim();
  if (value.length === 0) {
    return fail('GIT_FAILED', `Não foi possível determinar a branch atual em ${dir}.`);
  }
  if (value === 'HEAD') {
    return fail(
      'GIT_FAILED',
      `O repositório em ${dir} está com HEAD destacado: não há branch atual.`,
      { dir },
    );
  }
  return ok(value);
}

export async function headSha(
  dir: string,
  options: GitCommandOptions = {},
): Promise<Result<string>> {
  return revParse(dir, 'HEAD', options);
}

export async function revParse(
  dir: string,
  ref: string,
  options: GitCommandOptions = {},
): Promise<Result<string>> {
  const refCheck = validateRef(ref);
  if (!refCheck.ok) return refCheck;

  const result = await runGitChecked(dir, ['rev-parse', '--verify', refCheck.value], options);
  if (!result.ok) return result;

  const value = result.value.stdout.trim();
  if (!/^[0-9a-f]{7,64}$/i.test(value)) {
    return fail('GIT_FAILED', `Resposta inesperada de rev-parse para "${refCheck.value}".`, {
      dir,
      output: value.slice(0, 200),
    });
  }
  return ok(value);
}

/** Verdadeiro quando a referência existe no repositório. */
export async function hasRef(
  dir: string,
  ref: string,
  options: GitCommandOptions = {},
): Promise<boolean> {
  const refCheck = validateRef(ref);
  if (!refCheck.ok) return false;
  const result = await runGitRaw(
    dir,
    ['rev-parse', '--verify', '--quiet', refCheck.value],
    options,
  );
  return result.ok && result.value.exitCode === 0;
}

export async function mergeBase(
  dir: string,
  a: string,
  b: string,
  options: GitCommandOptions = {},
): Promise<Result<string>> {
  const first = validateRef(a, 'primeira referência');
  if (!first.ok) return first;
  const second = validateRef(b, 'segunda referência');
  if (!second.ok) return second;

  const result = await runGitChecked(
    dir,
    ['merge-base', first.value, second.value],
    options,
  );
  if (!result.ok) return result;

  const value = result.value.stdout.trim();
  if (value.length === 0) {
    return fail(
      'GIT_FAILED',
      `Não há ancestral comum entre "${first.value}" e "${second.value}".`,
      { dir },
    );
  }
  return ok(value);
}

export async function configuredUser(
  dir: string,
  options: GitCommandOptions = {},
): Promise<Result<GitUserIdentity>> {
  // `git config --get` sai com código 1 quando a chave não existe: isso não é
  // erro, é ausência de configuração.
  const nameResult = await runGitRaw(dir, ['config', '--get', 'user.name'], options);
  if (!nameResult.ok) return nameResult;
  const emailResult = await runGitRaw(dir, ['config', '--get', 'user.email'], options);
  if (!emailResult.ok) return emailResult;

  const name = nameResult.value.exitCode === 0 ? nameResult.value.stdout.trim() : '';
  const email = emailResult.value.exitCode === 0 ? emailResult.value.stdout.trim() : '';

  return ok({
    name: name.length > 0 ? name : null,
    email: email.length > 0 ? email : null,
  });
}

/* ------------------------------------------------------------------------- */
/* Status                                                                     */
/* ------------------------------------------------------------------------- */

export async function status(
  dir: string,
  options: GitCommandOptions = {},
): Promise<Result<GitStatus>> {
  const result = await runGitChecked(
    dir,
    ['status', '--porcelain=v2', '--branch', '--untracked-files=all'],
    options,
  );
  if (!result.ok) return result;

  if (result.value.stdoutTruncated) {
    return fail(
      'GIT_FAILED',
      `A saída de "git status" em ${dir} foi truncada; o estado do repositório não pode ser avaliado com segurança.`,
      { dir },
    );
  }

  return ok(parseStatusPorcelainV2(result.value.stdout));
}

/**
 * Faz o parse real de `git status --porcelain=v2 --branch`.
 *
 * Formato (git-status(1), seção "Porcelain Format Version 2"):
 *   `# branch.oid <sha>` / `# branch.head <branch>` / `# branch.ab +N -M`
 *   `1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>`                    (alterado)
 *   `2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <Xscore> <path><TAB><orig>` (renome)
 *   `u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>`          (conflito)
 *   `? <path>` (não rastreado) / `! <path>` (ignorado)
 */
export function parseStatusPorcelainV2(stdout: string): GitStatus {
  let branch: string | null = null;
  let ahead = 0;
  let behind = 0;
  const entries: GitStatusEntry[] = [];

  for (const rawLine of stdout.split('\n')) {
    const line = stripCarriageReturn(rawLine);
    if (line.length === 0) continue;

    if (line.startsWith('# ')) {
      const tokens = line.split(' ');
      const key = tokens[1];
      if (key === 'branch.head') {
        const value = tokens[2] ?? '';
        branch = value.length > 0 && value !== '(detached)' ? value : null;
      } else if (key === 'branch.ab') {
        ahead = parseSignedCount(tokens[2], '+');
        behind = parseSignedCount(tokens[3], '-');
      }
      continue;
    }

    const kind = line[0];
    if (kind === '1' || kind === '2') {
      const xy = fieldAt(line, 1);
      const rest = restAfterFields(line, kind === '1' ? 8 : 9);
      if (xy === null || rest === null) continue;
      let target = rest;
      let renamedFrom: string | null = null;
      if (kind === '2') {
        const tabIndex = rest.indexOf('\t');
        if (tabIndex >= 0) {
          target = rest.slice(0, tabIndex);
          renamedFrom = unquoteGitPath(rest.slice(tabIndex + 1));
        }
      }
      entries.push({
        path: unquoteGitPath(target),
        indexStatus: xy[0] ?? '.',
        worktreeStatus: xy[1] ?? '.',
        renamedFrom,
      });
      continue;
    }

    if (kind === 'u') {
      const xy = fieldAt(line, 1);
      const rest = restAfterFields(line, 10);
      if (xy === null || rest === null) continue;
      entries.push({
        path: unquoteGitPath(rest),
        indexStatus: xy[0] ?? 'U',
        worktreeStatus: xy[1] ?? 'U',
        renamedFrom: null,
      });
      continue;
    }

    if (kind === '?' || kind === '!') {
      const rest = restAfterFields(line, 1);
      if (rest === null) continue;
      entries.push({
        path: unquoteGitPath(rest),
        indexStatus: kind,
        worktreeStatus: kind,
        renamedFrom: null,
      });
    }
  }

  return { branch, ahead, behind, clean: entries.length === 0, entries };
}

function stripCarriageReturn(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}

function parseSignedCount(token: string | undefined, sign: '+' | '-'): number {
  if (token === undefined || !token.startsWith(sign)) return 0;
  const parsed = Number.parseInt(token.slice(1), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/** Devolve o campo de índice `position` (separado por espaço) ou `null`. */
function fieldAt(line: string, position: number): string | null {
  let start = 0;
  for (let i = 0; i < position; i += 1) {
    const next = line.indexOf(' ', start);
    if (next < 0) return null;
    start = next + 1;
  }
  const end = line.indexOf(' ', start);
  const value = end < 0 ? line.slice(start) : line.slice(start, end);
  return value.length > 0 ? value : null;
}

/** Devolve tudo o que sobra depois de `count` campos separados por espaço. */
function restAfterFields(line: string, count: number): string | null {
  let start = 0;
  for (let i = 0; i < count; i += 1) {
    const next = line.indexOf(' ', start);
    if (next < 0) return null;
    start = next + 1;
  }
  const rest = line.slice(start);
  return rest.length > 0 ? rest : null;
}

/**
 * Desfaz o escape em estilo C que o Git aplica a caminhos "difíceis".
 * Com `core.quotePath=false` isso é raro, mas caminhos com aspas, barra
 * invertida ou quebra de linha continuam sendo entregues entre aspas.
 */
export function unquoteGitPath(value: string): string {
  if (value.length < 2 || !value.startsWith('"') || !value.endsWith('"')) return value;
  const body = value.slice(1, -1);
  let output = '';
  for (let i = 0; i < body.length; i += 1) {
    const current = body[i];
    if (current === undefined) break;
    if (current !== '\\') {
      output += current;
      continue;
    }
    const next = body[i + 1];
    if (next === undefined) break;
    i += 1;
    switch (next) {
      case 'n':
        output += '\n';
        break;
      case 't':
        output += '\t';
        break;
      case 'r':
        output += '\r';
        break;
      case '"':
        output += '"';
        break;
      case '\\':
        output += '\\';
        break;
      default: {
        if (next >= '0' && next <= '7') {
          const octal = body.slice(i, i + 3);
          const code = Number.parseInt(octal, 8);
          if (Number.isFinite(code) && octal.length === 3) {
            output += String.fromCharCode(code);
            i += 2;
          } else {
            output += next;
          }
        } else {
          output += next;
        }
        break;
      }
    }
  }
  return output;
}

/* ------------------------------------------------------------------------- */
/* Diffs                                                                      */
/* ------------------------------------------------------------------------- */

/**
 * Arquivos tocados no diretório de trabalho: alterados no índice, alterados na
 * árvore, em conflito e não rastreados. Inclui o nome de origem em renomeações.
 */
export async function changedFiles(
  dir: string,
  options: GitCommandOptions = {},
): Promise<Result<string[]>> {
  const current = await status(dir, options);
  if (!current.ok) return current;

  const unique = new Set<string>();
  for (const entry of current.value.entries) {
    if (entry.indexStatus === '!' && entry.worktreeStatus === '!') continue;
    unique.add(entry.path);
    if (entry.renamedFrom !== null && entry.renamedFrom.length > 0) {
      unique.add(entry.renamedFrom);
    }
  }
  return ok([...unique].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
}

export async function diffStat(
  dir: string,
  from?: string,
  options: GitCommandOptions = {},
): Promise<Result<string>> {
  const base = from ?? 'HEAD';
  const refCheck = validateRef(base, 'referência de comparação');
  if (!refCheck.ok) return refCheck;

  const result = await runGitChecked(
    dir,
    ['diff', '--stat', '--no-color', '--no-ext-diff', refCheck.value, '--'],
    options,
  );
  if (!result.ok) return result;
  return ok(result.value.stdout);
}

/**
 * Patch completo do diretório de trabalho em relação a `from` (padrão `HEAD`).
 * O conteúdo NUNCA é truncado: se exceder o limite de captura, o comando falha
 * em vez de devolver um patch parcial que enganaria os revisores.
 */
export async function diffPatch(
  dir: string,
  from?: string,
  options: GitCommandOptions = {},
): Promise<Result<string>> {
  const base = from ?? 'HEAD';
  const refCheck = validateRef(base, 'referência de comparação');
  if (!refCheck.ok) return refCheck;

  const result = await runGitChecked(
    dir,
    ['diff', '--patch', '--no-color', '--no-ext-diff', refCheck.value, '--'],
    { ...options, maxOutputBytes: options.maxOutputBytes ?? PATCH_MAX_OUTPUT_BYTES },
  );
  if (!result.ok) return result;

  if (result.value.stdoutTruncated) {
    return fail(
      'GIT_FAILED',
      'O patch excedeu o limite de captura e seria entregue truncado. Reduza o escopo das alterações antes de revisar.',
      { dir, from: refCheck.value },
    );
  }
  return ok(result.value.stdout);
}

/* ------------------------------------------------------------------------- */
/* Remotes                                                                    */
/* ------------------------------------------------------------------------- */

export async function listRemotes(
  dir: string,
  options: GitCommandOptions = {},
): Promise<Result<GitRemote[]>> {
  const result = await runGitChecked(dir, ['remote', '--verbose'], options);
  if (!result.ok) return result;

  const byName = new Map<string, GitRemote>();
  const order: string[] = [];

  for (const rawLine of result.value.stdout.split('\n')) {
    const line = stripCarriageReturn(rawLine).trim();
    if (line.length === 0) continue;

    const tabIndex = line.indexOf('\t');
    if (tabIndex <= 0) continue;
    const name = line.slice(0, tabIndex).trim();
    const remainder = line.slice(tabIndex + 1).trim();
    if (name.length === 0 || remainder.length === 0) continue;

    // `<url> (fetch)` ou `<url> (push)`
    let url = remainder;
    let kind = '';
    const lastSpace = remainder.lastIndexOf(' ');
    if (lastSpace > 0 && remainder.endsWith(')')) {
      url = remainder.slice(0, lastSpace).trim();
      kind = remainder.slice(lastSpace + 2, remainder.length - 1).trim();
    }

    let entry = byName.get(name);
    if (entry === undefined) {
      entry = { name, fetchUrl: '', pushUrl: '' };
      byName.set(name, entry);
      order.push(name);
    }
    if (kind === 'push') entry.pushUrl = url;
    else entry.fetchUrl = url;
  }

  const remotes: GitRemote[] = [];
  for (const name of order) {
    const entry = byName.get(name);
    if (entry === undefined) continue;
    remotes.push({
      name: entry.name,
      fetchUrl: entry.fetchUrl.length > 0 ? entry.fetchUrl : entry.pushUrl,
      pushUrl: entry.pushUrl.length > 0 ? entry.pushUrl : entry.fetchUrl,
    });
  }
  return ok(remotes);
}

export async function remoteUrl(
  dir: string,
  remote: string,
  options: GitCommandOptions = {},
): Promise<Result<string>> {
  const remoteCheck = validateRemoteName(remote);
  if (!remoteCheck.ok) return remoteCheck;

  const result = await runGitRaw(
    dir,
    ['remote', 'get-url', remoteCheck.value],
    options,
  );
  if (!result.ok) return result;
  if (result.value.exitCode !== 0) {
    return fail(
      'GIT_FAILED',
      `O remote "${remoteCheck.value}" não existe no repositório ${dir}.`,
      { dir, remote: remoteCheck.value },
    );
  }

  const url = result.value.stdout.split('\n')[0]?.trim() ?? '';
  if (url.length === 0) {
    return fail('GIT_FAILED', `O remote "${remoteCheck.value}" não possui URL configurada.`, {
      dir,
    });
  }
  return ok(url);
}

/* ------------------------------------------------------------------------- */
/* Branches e commits                                                         */
/* ------------------------------------------------------------------------- */

export async function createBranch(
  dir: string,
  name: string,
  fromRef?: string,
  options: GitCommandOptions = {},
): Promise<Result<void>> {
  const nameCheck = validateBranchName(name);
  if (!nameCheck.ok) return nameCheck;

  const args = ['branch', nameCheck.value];
  if (fromRef !== undefined) {
    const refCheck = validateRef(fromRef, 'referência de origem');
    if (!refCheck.ok) return refCheck;
    args.push(refCheck.value);
  }

  const result = await runGitChecked(dir, args, options);
  if (!result.ok) return result;
  return ok(undefined);
}

/**
 * Troca de branch sem descarte de trabalho: nenhuma variante `--force` é usada,
 * de modo que o Git recusa a troca se houver alteração que seria perdida.
 */
export async function checkoutBranch(
  dir: string,
  name: string,
  options: GitCommandOptions = {},
): Promise<Result<void>> {
  const nameCheck = validateBranchName(name);
  if (!nameCheck.ok) return nameCheck;

  const result = await runGitChecked(dir, ['checkout', nameCheck.value], options);
  if (!result.ok) return result;
  return ok(undefined);
}

/**
 * Adiciona caminhos ao índice. Com a lista vazia, adiciona todas as alterações
 * do repositório (`git add --all`), o que nunca descarta conteúdo.
 */
export async function addPaths(
  dir: string,
  paths: string[],
  options: GitCommandOptions = {},
): Promise<Result<void>> {
  const args: string[] = ['add'];
  if (paths.length === 0) {
    args.push('--all', '--', '.');
  } else {
    const validated: string[] = [];
    for (const candidate of paths) {
      const check = validatePathspec(candidate);
      if (!check.ok) return check;
      validated.push(check.value);
    }
    args.push('--', ...validated);
  }

  const result = await runGitChecked(dir, args, options);
  if (!result.ok) return result;
  return ok(undefined);
}

/** Cria o commit com o conteúdo já preparado no índice e devolve o SHA. */
export async function commit(
  dir: string,
  message: string,
  options: GitCommandOptions = {},
): Promise<Result<string>> {
  const trimmed = message.trim();
  if (trimmed.length === 0) {
    return fail('VALIDATION_FAILED', 'A mensagem de commit não pode ser vazia.');
  }
  if (trimmed.indexOf('\0') >= 0) {
    return fail('VALIDATION_FAILED', 'A mensagem de commit contém byte nulo.');
  }

  const result = await runGitRaw(dir, ['commit', '--message', trimmed], options);
  if (!result.ok) return result;

  const commitProcess = result.value;
  if (commitProcess.exitCode !== 0) {
    const combined = `${commitProcess.stdout}\n${commitProcess.stderr}`;
    if (/nothing to commit|no changes added to commit|nada a submeter/i.test(combined)) {
      return fail(
        'GIT_FAILED',
        'Nada a commitar: nenhuma alteração foi preparada no índice.',
        { dir },
      );
    }
    return gitFailure(dir, ['commit'], commitProcess);
  }

  return headSha(dir, options);
}

/**
 * Envia a branch para o remote.
 *
 * PROIBIDO POR DESIGN: `--force`, `--force-with-lease`, `--delete` e `--mirror`
 * não são e não devem ser expostos. Se o push for rejeitado por divergência, a
 * resolução correta é humana.
 */
export async function push(
  dir: string,
  remote: string,
  branch: string,
  setUpstream: boolean,
  options: GitCommandOptions = {},
): Promise<Result<void>> {
  const remoteCheck = validateRemoteName(remote);
  if (!remoteCheck.ok) return remoteCheck;
  const branchCheck = validateBranchName(branch);
  if (!branchCheck.ok) return branchCheck;

  const args = ['push'];
  if (setUpstream) args.push('--set-upstream');
  args.push(remoteCheck.value, branchCheck.value);

  const result = await runGitChecked(dir, args, {
    ...options,
    timeoutMs: options.timeoutMs ?? 300_000,
  });
  if (!result.ok) return result;
  return ok(undefined);
}

export async function fetch(
  dir: string,
  remote: string,
  options: GitCommandOptions = {},
): Promise<Result<void>> {
  const remoteCheck = validateRemoteName(remote);
  if (!remoteCheck.ok) return remoteCheck;

  const result = await runGitChecked(dir, ['fetch', remoteCheck.value], {
    ...options,
    timeoutMs: options.timeoutMs ?? 300_000,
  });
  if (!result.ok) return result;
  return ok(undefined);
}

/* ------------------------------------------------------------------------- */
/* Normalização de remotes do GitHub                                          */
/* ------------------------------------------------------------------------- */

const OWNER_REPO_SEGMENT = /^[A-Za-z0-9._-]+$/;

/**
 * Converte uma URL de remote do GitHub em `owner/repo`.
 *
 * Formatos aceitos:
 *   https://github.com/owner/repo.git
 *   https://usuario@github.com/owner/repo
 *   git@github.com:owner/repo.git
 *   ssh://git@github.com/owner/repo
 *   git://github.com/owner/repo.git
 *
 * Devolve `null` quando a URL não é do GitHub ou não identifica um repositório.
 */
export function normalizeGitHubRemote(url: string): string | null {
  const trimmed = url.trim().replace(/^"+|"+$/g, '');
  if (trimmed.length === 0 || hasControlChars(trimmed)) return null;

  let host = '';
  let pathPart = '';

  const schemeMatch = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/(.+)$/.exec(trimmed);
  if (schemeMatch !== null) {
    const scheme = (schemeMatch[1] ?? '').toLowerCase();
    if (scheme !== 'https' && scheme !== 'http' && scheme !== 'ssh' && scheme !== 'git') {
      return null;
    }
    const rest = schemeMatch[2] ?? '';
    const slash = rest.indexOf('/');
    if (slash <= 0) return null;
    const authority = rest.slice(0, slash);
    pathPart = rest.slice(slash + 1);
    const at = authority.lastIndexOf('@');
    host = at >= 0 ? authority.slice(at + 1) : authority;
    const colon = host.indexOf(':');
    if (colon >= 0) host = host.slice(0, colon);
  } else {
    // Sintaxe scp: [usuario@]host:caminho
    const scpMatch = /^(?:([A-Za-z0-9._-]+)@)?([A-Za-z0-9.-]+):(?!\/\/)(.+)$/.exec(trimmed);
    if (scpMatch === null) return null;
    host = scpMatch[2] ?? '';
    pathPart = scpMatch[3] ?? '';
  }

  if (!isGitHubHost(host)) return null;
  return extractOwnerRepo(pathPart);
}

function isGitHubHost(host: string): boolean {
  let normalized = host.trim().toLowerCase();
  if (normalized.endsWith('.')) normalized = normalized.slice(0, -1);
  if (normalized.startsWith('www.')) normalized = normalized.slice(4);
  if (normalized.startsWith('ssh.')) normalized = normalized.slice(4);
  return normalized === 'github.com';
}

/** Extrai `owner/repo` de um caminho, ignorando `.git`, query e fragmento. */
function extractOwnerRepo(rawPath: string): string | null {
  let value = rawPath.trim();
  const hash = value.indexOf('#');
  if (hash >= 0) value = value.slice(0, hash);
  const query = value.indexOf('?');
  if (query >= 0) value = value.slice(0, query);

  value = value.replace(/^\/+/, '').replace(/\/+$/, '');
  if (value.toLowerCase().endsWith('.git')) value = value.slice(0, -4);
  value = value.replace(/\/+$/, '');

  const segments = value.split('/').filter((segment) => segment.length > 0);
  if (segments.length !== 2) return null;

  const owner = segments[0];
  const repo = segments[1];
  if (owner === undefined || repo === undefined) return null;
  if (!OWNER_REPO_SEGMENT.test(owner) || !OWNER_REPO_SEGMENT.test(repo)) return null;
  if (owner === '.' || owner === '..' || repo === '.' || repo === '..') return null;

  return `${owner}/${repo}`;
}

/**
 * Compara a URL de um remote com o repositório esperado (`owner/repo` ou uma
 * URL completa). A comparação é insensível a maiúsculas, como o GitHub.
 */
export function remoteMatchesRepository(remoteUrl: string, expected: string): boolean {
  const actual = normalizeGitHubRemote(remoteUrl);
  if (actual === null) return false;

  const wanted = normalizeGitHubRemote(expected) ?? extractOwnerRepo(expected);
  if (wanted === null) return false;

  return actual.toLowerCase() === wanted.toLowerCase();
}
