import type {
  Err,
  OrqError,
  ProcessResult,
  ProcessRunOptions,
  Result,
} from '../types';
import { fail, ok } from '../utils/errors';
import {
  REDACTION_PLACEHOLDER,
  redactKnownValues,
  redactObject,
  redactText,
} from '../utils/redact';
import { buildToolEnv } from '../security/env-sanitizer';
import { runProcess } from '../agents/process-runner';

/**
 * Camada base de acesso ao GitHub pelo executável local `gh` (GitHub CLI).
 *
 * Regras deste módulo:
 *  - nenhuma requisição HTTP é feita diretamente: tudo passa pelo `gh`, que já
 *    carrega a autenticação do usuário (`gh auth login`);
 *  - todo processo é criado com vetor de argumentos (`spawn`), jamais com shell,
 *    o que elimina injeção de comando;
 *  - todo texto devolvido ao restante do sistema passa por redação de segredos,
 *    porque a saída do `gh` pode conter tokens (`Token: gho_****`);
 *  - o ambiente entregue ao `gh` é o ambiente sanitizado (`buildToolEnv`), sem
 *    variáveis de API de IA.
 */

/** Nome do executável do GitHub CLI. */
export const GH_COMMAND = 'gh';

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_BYTES = 8_000_000;

/**
 * Variáveis cujo valor, se presente no ambiente, é apagado da saída antes de
 * qualquer log ou relatório. O valor em si nunca é retornado.
 */
const TOKEN_ENV_VARS: readonly string[] = [
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GH_ENTERPRISE_TOKEN',
  'GITHUB_ENTERPRISE_TOKEN',
];

export interface GhOptions {
  /** Tempo máximo de execução. Padrão: 120 s. */
  timeoutMs?: number;
  /** Conteúdo enviado ao STDIN do `gh` (usado por `--body-file -`). */
  input?: string;
  /** Limite de bytes capturados de stdout/stderr. */
  maxOutputBytes?: number;
  signal?: AbortSignal;
}

export interface RepoSlug {
  owner: string;
  name: string;
  /** Forma canônica `owner/repo`, já validada. */
  slug: string;
}

export interface GhAuthStatus {
  authenticated: boolean;
  account: string | null;
  scopes: string[];
}

export interface GhRepoInfo {
  defaultBranch: string;
  isPrivate: boolean;
  url: string;
  isEmpty: boolean;
}

/* ------------------------------------------------------------------------- */
/* Validação de entrada                                                       */
/* ------------------------------------------------------------------------- */

/**
 * Caracteres de controle verificados por código, e não por expressão regular,
 * para não gravar literais de controle no fonte.
 */
function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

/**
 * Formato aceito de repositório: `owner/repo`.
 *
 * O primeiro caractere de cada parte é obrigatoriamente alfanumérico, o que
 * impede que um valor como `--token=x` seja interpretado como opção pelo `gh`.
 */
const REPO_SLUG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/** Valida e decompõe um identificador `owner/repo`. */
export function parseRepoSlug(repo: string): Result<RepoSlug> {
  const trimmed = repo.trim();
  if (trimmed.length === 0) {
    return fail('VALIDATION_FAILED', 'Repositório do GitHub não informado (use "owner/repo").');
  }
  if (hasControlChars(trimmed)) {
    return fail('VALIDATION_FAILED', 'Repositório do GitHub contém caracteres de controle.');
  }
  if (trimmed.startsWith('-')) {
    return fail('VALIDATION_FAILED', 'Repositório do GitHub não pode começar com "-".', {
      repo: trimmed,
    });
  }
  if (trimmed.includes('..')) {
    return fail('VALIDATION_FAILED', 'Repositório do GitHub não pode conter "..".', {
      repo: trimmed,
    });
  }
  if (!REPO_SLUG_PATTERN.test(trimmed)) {
    return fail(
      'VALIDATION_FAILED',
      `Repositório do GitHub inválido: "${trimmed}". Use o formato "owner/repo".`,
      { repo: trimmed },
    );
  }
  const parts = trimmed.split('/');
  const owner = parts[0];
  const name = parts[1];
  if (owner === undefined || name === undefined) {
    return fail('VALIDATION_FAILED', `Repositório do GitHub inválido: "${trimmed}".`);
  }
  return ok({ owner, name, slug: `${owner}/${name}` });
}

/** Valida o número de um pull request (inteiro positivo). */
export function validatePullRequestNumber(value: number): Result<number> {
  if (!Number.isInteger(value) || value <= 0 || value > 1_000_000_000) {
    return fail('VALIDATION_FAILED', `Número de pull request inválido: ${String(value)}.`, {
      prNumber: value,
    });
  }
  return ok(value);
}

/**
 * Valida um valor livre que será passado como VALOR de uma opção do `gh`
 * (título, por exemplo). Recusa caracteres de controle e valores iniciados por
 * "-", que o analisador de opções do `gh` interpretaria como outra flag.
 */
export function validateOptionValue(value: string, label: string): Result<string> {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return fail('VALIDATION_FAILED', `${label} não pode ser vazio.`);
  }
  if (hasControlChars(trimmed)) {
    return fail('VALIDATION_FAILED', `${label} não pode conter quebras de linha ou caracteres de controle.`);
  }
  if (trimmed.startsWith('-')) {
    return fail('VALIDATION_FAILED', `${label} não pode começar com "-".`, { value: trimmed });
  }
  return ok(trimmed);
}

function ensureSafeArgs(args: readonly string[]): Result<string[]> {
  if (args.length === 0) {
    return fail('VALIDATION_FAILED', 'Nenhum argumento informado para o gh.');
  }
  const safe: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (typeof arg !== 'string') {
      return fail('VALIDATION_FAILED', `Argumento ${String(i)} do gh não é uma string.`);
    }
    if (hasControlChars(arg)) {
      return fail(
        'VALIDATION_FAILED',
        `Argumento ${String(i)} do gh contém caracteres de controle.`,
      );
    }
    safe.push(arg);
  }
  return ok(safe);
}

/* ------------------------------------------------------------------------- */
/* Redação                                                                    */
/* ------------------------------------------------------------------------- */

/**
 * Redige a saída do `gh`. Aplica os padrões conhecidos de segredo e, além
 * disso, apaga o valor literal de tokens presentes no ambiente — sem nunca
 * devolver esse valor.
 */
export function redactGhOutput(text: string): string {
  if (!text) return text;
  return redactKnownValues(redactText(text), TOKEN_ENV_VARS);
}

/* ------------------------------------------------------------------------- */
/* Execução                                                                   */
/* ------------------------------------------------------------------------- */

/**
 * Executa o `gh` e devolve o resultado bruto do processo, inclusive quando o
 * código de saída é diferente de zero.
 *
 * Alguns subcomandos usam o código de saída como informação legítima
 * (`gh pr checks` devolve 8 quando há checks pendentes), por isso a decisão de
 * tratar como erro fica com quem chama, via `ghSucceeded`/`ghFailure`.
 */
export async function ghExec(
  args: readonly string[],
  cwd: string,
  options: GhOptions = {},
): Promise<Result<ProcessResult>> {
  const safeArgs = ensureSafeArgs(args);
  if (!safeArgs.ok) return safeArgs;

  const workingDir = cwd.trim();
  if (workingDir.length === 0) {
    return fail('VALIDATION_FAILED', 'Diretório de trabalho do gh não informado.');
  }

  const runOptions: ProcessRunOptions = {
    cwd: workingDir,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    env: buildToolEnv(),
    maxOutputBytes: options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
    input: options.input,
    signal: options.signal,
  };

  let outcome: unknown;
  try {
    outcome = await runProcess(GH_COMMAND, safeArgs.value, runOptions);
  } catch (error) {
    return fail(
      'PROCESS_FAILED',
      'Falha ao iniciar o GitHub CLI (gh).',
      { args: redactArgs(safeArgs.value) },
      error,
    );
  }
  return normalizeProcessOutcome(outcome, safeArgs.value);
}

/**
 * Normaliza o retorno do executor de processos.
 *
 * Aceita tanto `Result<ProcessResult>` quanto um `ProcessResult` puro, o que
 * mantém esta camada desacoplada da forma exata escolhida pelo runner.
 */
function normalizeProcessOutcome(
  outcome: unknown,
  args: readonly string[],
): Result<ProcessResult> {
  if (outcome === null || typeof outcome !== 'object') {
    return fail('PROCESS_FAILED', 'Retorno inesperado do executor de processos.', {
      args: redactArgs(args),
    });
  }
  if ('ok' in outcome) {
    const wrapped = outcome as { ok: unknown; value?: unknown; error?: unknown };
    if (wrapped.ok === true) {
      const value = wrapped.value;
      if (value === null || typeof value !== 'object') {
        return fail('PROCESS_FAILED', 'Executor de processos devolveu um resultado vazio.', {
          args: redactArgs(args),
        });
      }
      return ok(value as ProcessResult);
    }
    const error = asRecord(wrapped.error);
    const code = error ? asString(error['code']) : null;
    const message = error ? asString(error['message']) : null;
    if (code !== null && message !== null) {
      return { ok: false, error: wrapped.error as OrqError };
    }
    return fail('PROCESS_FAILED', 'Falha ao executar o GitHub CLI (gh).', {
      args: redactArgs(args),
    });
  }
  return ok(outcome as ProcessResult);
}

/** Verdadeiro quando o `gh` terminou normalmente com código 0. */
export function ghSucceeded(proc: ProcessResult): boolean {
  return proc.status === 'COMPLETED' && proc.exitCode === 0;
}

function redactArgs(args: readonly string[]): string[] {
  return args.map((arg) => redactText(arg));
}

/** Mensagens que indicam que o `gh` não está autenticado. */
function looksLikeAuthFailure(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    lower.includes('gh auth login') ||
    lower.includes('not logged in') ||
    lower.includes('not logged into') ||
    lower.includes('authentication required') ||
    lower.includes('requires authentication') ||
    lower.includes('bad credentials') ||
    lower.includes('http 401')
  );
}

/** Mensagens que indicam recurso inexistente (404). */
export function looksLikeNotFound(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    lower.includes('could not resolve to a repository') ||
    lower.includes('could not resolve to a pullrequest') ||
    lower.includes('http 404') ||
    lower.includes('not found') ||
    lower.includes('no such') ||
    lower.includes('branch not protected')
  );
}

/** Mensagens que indicam falta de permissão para ler o recurso (401/403). */
export function looksLikeForbidden(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    lower.includes('http 403') ||
    lower.includes('http 401') ||
    lower.includes('must have admin rights') ||
    lower.includes('resource not accessible')
  );
}

/** Converte a saída de um `gh` malsucedido em erro tipado do OrqPEG. */
export function ghFailure(proc: ProcessResult, args: readonly string[]): Err<OrqError> {
  const combined = redactGhOutput(`${proc.stdout}\n${proc.stderr}`).trim();
  const commandLine = `gh ${redactArgs(args).join(' ')}`;
  const details: Record<string, unknown> = {
    args: redactArgs(args),
    status: proc.status,
    exitCode: proc.exitCode,
    output: combined.slice(0, 800),
  };

  if (proc.status === 'COMMAND_NOT_FOUND') {
    return fail(
      'TOOL_MISSING',
      'GitHub CLI (gh) não encontrado no PATH. Instale a partir de https://cli.github.com e execute "gh auth login".',
      details,
    );
  }
  if (proc.status === 'TIMEOUT') {
    return fail('PROCESS_TIMEOUT', `Tempo esgotado ao executar: ${commandLine}`, details);
  }
  if (proc.status === 'INTERRUPTED') {
    return fail('PROCESS_INTERRUPTED', `Execução interrompida: ${commandLine}`, details);
  }
  if (looksLikeAuthFailure(combined)) {
    return fail(
      'AUTH_REQUIRED',
      'O GitHub CLI não está autenticado. Execute "gh auth login" e tente novamente.',
      details,
    );
  }
  return fail('GH_FAILED', `Comando do GitHub CLI falhou: ${commandLine}`, details);
}

/* ------------------------------------------------------------------------- */
/* Leitura de valores desconhecidos                                           */
/* ------------------------------------------------------------------------- */

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

export function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function asBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

export function asArray(value: unknown): unknown[] | null {
  return Array.isArray(value) ? (value as unknown[]) : null;
}

/* ------------------------------------------------------------------------- */
/* Saídas de alto nível                                                       */
/* ------------------------------------------------------------------------- */

/** Executa o `gh` e devolve a saída padrão já redigida. */
export async function ghText(
  args: readonly string[],
  cwd: string,
  options: GhOptions = {},
): Promise<Result<string>> {
  const run = await ghExec(args, cwd, options);
  if (!run.ok) return run;
  if (!ghSucceeded(run.value)) return ghFailure(run.value, args);
  return ok(redactGhOutput(run.value.stdout));
}

/**
 * Converte uma saída de texto em JSON.
 *
 * A redação é aplicada sobre o valor JÁ desserializado (`redactObject`), e não
 * sobre o texto: redigir o texto bruto poderia quebrar a estrutura do JSON.
 */
export function parseGhJson<T>(stdout: string, args: readonly string[]): Result<T> {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) {
    return fail('GH_FAILED', 'O GitHub CLI não devolveu conteúdo JSON.', {
      args: redactArgs(args),
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    return fail(
      'GH_FAILED',
      'A resposta do GitHub CLI não é um JSON válido.',
      { args: redactArgs(args), preview: redactGhOutput(trimmed).slice(0, 300) },
      error,
    );
  }
  return ok(redactObject(parsed) as T);
}

/** Executa o `gh` e desserializa a saída JSON. */
export async function ghJson<T>(
  args: readonly string[],
  cwd: string,
  options: GhOptions = {},
): Promise<Result<T>> {
  const run = await ghExec(args, cwd, options);
  if (!run.ok) return run;
  if (!ghSucceeded(run.value)) return ghFailure(run.value, args);
  return parseGhJson<T>(run.value.stdout, args);
}

/* ------------------------------------------------------------------------- */
/* Comandos                                                                   */
/* ------------------------------------------------------------------------- */

/**
 * Lê o estado de autenticação do `gh`.
 *
 * A saída de `gh auth status` contém a linha `Token: gho_****`; ela passa por
 * `redactGhOutput` antes de qualquer análise, e o token nunca é capturado,
 * devolvido ou registrado. Não estar autenticado NÃO é erro: devolve
 * `authenticated: false` para que a camada superior decida o que fazer.
 */
export async function authStatus(cwd: string): Promise<Result<GhAuthStatus>> {
  const args = ['auth', 'status'];
  const run = await ghExec(args, cwd, { timeoutMs: 30_000 });
  if (!run.ok) return run;

  const proc = run.value;
  if (proc.status !== 'COMPLETED') return ghFailure(proc, args);

  const combined = redactGhOutput(`${proc.stdout}\n${proc.stderr}`);
  const loggedIn = /logged in to/i.test(combined);

  const accountMatch = /logged in to\s+\S+\s+(?:account\s+|as\s+)([A-Za-z0-9][A-Za-z0-9-]{0,38})/i.exec(
    combined,
  );
  const account = accountMatch?.[1] ?? null;

  const scopesMatch = /token scopes:\s*([^\r\n]*)/i.exec(combined);
  const scopesRaw = scopesMatch?.[1] ?? '';
  const scopes = scopesRaw
    .split(',')
    .map((scope) => scope.trim().replace(/^['"]|['"]$/g, ''))
    .filter((scope) => scope.length > 0 && scope !== REDACTION_PLACEHOLDER);

  return ok({
    authenticated: ghSucceeded(proc) && loggedIn,
    account,
    scopes,
  });
}

/** Verifica se o repositório existe e é visível para a conta autenticada. */
export async function repoExists(repo: string, cwd: string): Promise<Result<boolean>> {
  const parsed = parseRepoSlug(repo);
  if (!parsed.ok) return parsed;

  const args = ['repo', 'view', parsed.value.slug, '--json', 'name'];
  const run = await ghExec(args, cwd, { timeoutMs: 60_000 });
  if (!run.ok) return run;

  const proc = run.value;
  if (ghSucceeded(proc)) return ok(true);

  const combined = redactGhOutput(`${proc.stdout}\n${proc.stderr}`);
  if (proc.status === 'COMPLETED' && looksLikeNotFound(combined)) return ok(false);
  return ghFailure(proc, args);
}

/** Lê os metadados essenciais do repositório. */
export async function repoInfo(repo: string, cwd: string): Promise<Result<GhRepoInfo>> {
  const parsed = parseRepoSlug(repo);
  if (!parsed.ok) return parsed;

  const args = [
    'repo',
    'view',
    parsed.value.slug,
    '--json',
    'defaultBranchRef,isPrivate,url,isEmpty',
  ];
  const response = await ghJson<unknown>(args, cwd, { timeoutMs: 60_000 });
  if (!response.ok) return response;

  const record = asRecord(response.value);
  if (record === null) {
    return fail('GH_FAILED', 'Resposta inesperada do gh ao ler o repositório.', {
      repo: parsed.value.slug,
    });
  }

  const branchRef = asRecord(record['defaultBranchRef']);
  // Repositório vazio não tem branch padrão; devolvemos string vazia com
  // `isEmpty: true` para que a camada superior exija o primeiro push.
  const defaultBranch = branchRef ? asString(branchRef['name']) ?? '' : '';

  return ok({
    defaultBranch,
    isPrivate: asBoolean(record['isPrivate']) ?? true,
    url: asString(record['url']) ?? `https://github.com/${parsed.value.slug}`,
    isEmpty: asBoolean(record['isEmpty']) ?? (defaultBranch.length === 0),
  });
}
