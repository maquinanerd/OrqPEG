import type { PullRequestInfo, Result } from '../types';
import { fail, ok } from '../utils/errors';
import { validateBranchName } from '../security/branch-name';
import {
  asArray,
  asBoolean,
  asNumber,
  asRecord,
  asString,
  ghExec,
  ghFailure,
  ghJson,
  ghSucceeded,
  ghText,
  parseRepoSlug,
  redactGhOutput,
  validateOptionValue,
  validatePullRequestNumber,
} from './gh';
import type { RepoSlug } from './gh';

/**
 * Operações de pull request via GitHub CLI.
 *
 * Todo corpo de PR é enviado pelo STDIN (`--body-file -`), nunca como argumento
 * de linha de comando: corpos longos estouram o limite de 32 KiB do Windows e
 * um corpo colado pelo usuário jamais deve virar parte da linha de comando.
 */

/** Campos pedidos ao `gh pr view`. */
const PR_JSON_FIELDS =
  'number,url,title,state,isDraft,baseRefName,headRefName,headRefOid,' +
  'mergeable,mergeStateStatus,mergedAt,mergeCommit,reviewDecision,reviews,latestReviews';

/**
 * `unresolvedThreadCount = -1` significa DESCONHECIDO.
 *
 * O gate de merge DEVE tratar desconhecido como reprovado: não é possível
 * afirmar que não há conversas pendentes quando a consulta falhou.
 */
export const UNRESOLVED_THREADS_UNKNOWN = -1;

/** Consulta GraphQL em linha única (argumentos não podem conter quebras de linha). */
const REVIEW_THREADS_QUERY =
  'query($owner: String!, $repo: String!, $number: Int!, $cursor: String) { ' +
  'repository(owner: $owner, name: $repo) { ' +
  'pullRequest(number: $number) { ' +
  'reviewThreads(first: 100, after: $cursor) { ' +
  'pageInfo { hasNextPage endCursor } nodes { isResolved } } } } }';

const MAX_THREAD_PAGES = 20;

export interface CreatePullRequestInput {
  cwd: string;
  repo: string;
  base: string;
  head: string;
  title: string;
  body: string;
  /** Padrão: `true`. O PR nasce em rascunho durante a execução. */
  draft?: boolean;
}

export interface GetPullRequestInput {
  cwd: string;
  repo: string;
  prNumber?: number;
  head?: string;
}

export interface UpdatePullRequestBodyInput {
  cwd: string;
  repo: string;
  prNumber: number;
  body: string;
}

export interface MarkReadyInput {
  cwd: string;
  repo: string;
  prNumber: number;
}

export interface FindPullRequestInput {
  cwd: string;
  repo: string;
  head: string;
}

export interface UnresolvedThreadsInput {
  cwd: string;
  repo: string;
  prNumber: number;
}

/* ------------------------------------------------------------------------- */
/* Criação                                                                    */
/* ------------------------------------------------------------------------- */

/**
 * Cria o pull request (por padrão em rascunho) e devolve o estado completo.
 *
 * Idempotente na prática: quando o `gh` informa que já existe um PR para a
 * branch, o PR existente é localizado e devolvido em vez de propagar erro.
 */
export async function createDraftPullRequest(
  input: CreatePullRequestInput,
): Promise<Result<PullRequestInfo>> {
  const slug = parseRepoSlug(input.repo);
  if (!slug.ok) return slug;

  const base = validateBranchName(input.base);
  if (!base.ok) return base;

  const head = validateBranchName(input.head);
  if (!head.ok) return head;

  const title = validateOptionValue(input.title, 'Título do pull request');
  if (!title.ok) return title;

  if (typeof input.body !== 'string') {
    return fail('VALIDATION_FAILED', 'Corpo do pull request inválido.');
  }

  const args = [
    'pr',
    'create',
    '--repo',
    slug.value.slug,
    '--base',
    base.value,
    '--head',
    head.value,
    '--title',
    title.value,
    '--body-file',
    '-',
  ];
  if (input.draft !== false) args.push('--draft');

  const run = await ghExec(args, input.cwd, { input: input.body, timeoutMs: 180_000 });
  if (!run.ok) return run;

  const proc = run.value;
  if (!ghSucceeded(proc)) {
    const combined = redactGhOutput(`${proc.stdout}\n${proc.stderr}`);
    if (/already exists/i.test(combined)) {
      const existing = await findPullRequestForBranch({
        cwd: input.cwd,
        repo: input.repo,
        head: head.value,
      });
      if (existing.ok && existing.value !== null) return ok(existing.value);
    }
    return ghFailure(proc, args);
  }

  const created = extractPullRequestNumber(redactGhOutput(proc.stdout));
  if (created !== null) {
    return getPullRequest({ cwd: input.cwd, repo: input.repo, prNumber: created });
  }

  const found = await findPullRequestForBranch({
    cwd: input.cwd,
    repo: input.repo,
    head: head.value,
  });
  if (!found.ok) return found;
  if (found.value === null) {
    return fail(
      'GH_FAILED',
      'O pull request foi criado, mas não foi possível localizá-lo para leitura do estado.',
      { repo: slug.value.slug, head: head.value },
    );
  }
  return ok(found.value);
}

/** Extrai o número do PR da URL devolvida pelo `gh pr create`. */
function extractPullRequestNumber(output: string): number | null {
  const match = /\/pull\/(\d+)/.exec(output);
  const raw = match?.[1];
  if (raw === undefined) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

/* ------------------------------------------------------------------------- */
/* Leitura                                                                    */
/* ------------------------------------------------------------------------- */

/** Lê o estado completo de um pull request, por número ou por branch de origem. */
export async function getPullRequest(
  input: GetPullRequestInput,
): Promise<Result<PullRequestInfo>> {
  const slug = parseRepoSlug(input.repo);
  if (!slug.ok) return slug;

  const selector = resolveSelector(input);
  if (!selector.ok) return selector;

  const args = [
    'pr',
    'view',
    selector.value,
    '--repo',
    slug.value.slug,
    '--json',
    PR_JSON_FIELDS,
  ];
  const response = await ghJson<unknown>(args, input.cwd, { timeoutMs: 90_000 });
  if (!response.ok) return response;

  const mapped = mapPullRequest(response.value, slug.value.slug);
  if (!mapped.ok) return mapped;

  const info = mapped.value;
  const baseSha = await fetchRefSha(input.cwd, slug.value, info.baseRefName);
  const unresolved = await countUnresolvedThreads({
    cwd: input.cwd,
    repo: slug.value.slug,
    prNumber: info.number,
  });

  return ok({ ...info, baseSha, unresolvedThreadCount: unresolved });
}

function resolveSelector(input: GetPullRequestInput): Result<string> {
  if (typeof input.prNumber === 'number') {
    const number = validatePullRequestNumber(input.prNumber);
    if (!number.ok) return number;
    return ok(String(number.value));
  }
  if (typeof input.head === 'string' && input.head.trim().length > 0) {
    const branch = validateBranchName(input.head);
    if (!branch.ok) return branch;
    return ok(branch.value);
  }
  return fail(
    'VALIDATION_FAILED',
    'Informe o número do pull request ou a branch de origem para consultá-lo.',
  );
}

/**
 * Converte a resposta do `gh pr view` em `PullRequestInfo`.
 * `baseSha` e `unresolvedThreadCount` são preenchidos depois, por consultas
 * dedicadas.
 */
function mapPullRequest(value: unknown, repoSlug: string): Result<PullRequestInfo> {
  const record = asRecord(value);
  if (record === null) {
    return fail('GH_FAILED', 'Resposta inesperada do gh ao ler o pull request.', {
      repo: repoSlug,
    });
  }

  const number = asNumber(record['number']);
  if (number === null) {
    return fail('GH_FAILED', 'A resposta do gh não contém o número do pull request.', {
      repo: repoSlug,
    });
  }

  const mergedAt = asString(record['mergedAt']);
  const rawState = (asString(record['state']) ?? '').toUpperCase();
  const merged = rawState === 'MERGED' || (mergedAt !== null && mergedAt.length > 0);
  const state: PullRequestInfo['state'] = merged
    ? 'MERGED'
    : rawState === 'CLOSED'
      ? 'CLOSED'
      : 'OPEN';

  const rawMergeable = (asString(record['mergeable']) ?? '').toUpperCase();
  const mergeable: PullRequestInfo['mergeable'] =
    rawMergeable === 'MERGEABLE'
      ? 'MERGEABLE'
      : rawMergeable === 'CONFLICTING'
        ? 'CONFLICTING'
        : 'UNKNOWN';

  const mergeCommit = asRecord(record['mergeCommit']);
  const mergeStateStatus = asString(record['mergeStateStatus']);

  return ok({
    number,
    url: asString(record['url']) ?? '',
    title: asString(record['title']) ?? '',
    state,
    isDraft: asBoolean(record['isDraft']) ?? false,
    baseRefName: asString(record['baseRefName']) ?? '',
    headRefName: asString(record['headRefName']) ?? '',
    headSha: asString(record['headRefOid']) ?? '',
    baseSha: null,
    mergeable,
    mergeStateStatus:
      mergeStateStatus !== null && mergeStateStatus.length > 0 ? mergeStateStatus : null,
    merged,
    mergeCommitSha: mergeCommit ? asString(mergeCommit['oid']) : null,
    reviewDecision: resolveReviewDecision(record),
    unresolvedThreadCount: UNRESOLVED_THREADS_UNKNOWN,
  });
}

/**
 * Decisão de revisão humana.
 *
 * O `reviewDecision` vem vazio em repositórios sem revisão obrigatória; nesse
 * caso ele é deduzido das últimas revisões, para que uma solicitação humana de
 * alterações nunca passe despercebida pelo gate.
 */
function resolveReviewDecision(record: Record<string, unknown>): PullRequestInfo['reviewDecision'] {
  const raw = (asString(record['reviewDecision']) ?? '').toUpperCase();
  if (raw === 'APPROVED' || raw === 'CHANGES_REQUESTED' || raw === 'REVIEW_REQUIRED') {
    return raw;
  }

  const states = collectReviewStates(record['latestReviews']);
  if (states.length === 0) {
    states.push(...collectReviewStates(record['reviews']));
  }
  if (states.includes('CHANGES_REQUESTED')) return 'CHANGES_REQUESTED';
  if (states.includes('APPROVED')) return 'APPROVED';
  return null;
}

function collectReviewStates(value: unknown): string[] {
  const container = asArray(value) ?? asArray(asRecord(value)?.['nodes']);
  if (container === null) return [];
  const states: string[] = [];
  for (const item of container) {
    const review = asRecord(item);
    if (review === null) continue;
    const state = asString(review['state']);
    if (state !== null) states.push(state.toUpperCase());
  }
  return states;
}

/** Lê o SHA apontado por uma branch (usado para o `baseSha` do PR). */
async function fetchRefSha(
  cwd: string,
  slug: RepoSlug,
  branch: string,
): Promise<string | null> {
  const valid = validateBranchName(branch);
  if (!valid.ok) return null;

  const response = await ghJson<unknown>(
    ['api', `repos/${slug.owner}/${slug.name}/git/ref/heads/${valid.value}`],
    cwd,
    { timeoutMs: 60_000 },
  );
  if (!response.ok) return null;

  const record = asRecord(response.value);
  const object = record ? asRecord(record['object']) : null;
  return object ? asString(object['sha']) : null;
}

/* ------------------------------------------------------------------------- */
/* Conversas não resolvidas                                                   */
/* ------------------------------------------------------------------------- */

/**
 * Conta as conversas de revisão não resolvidas do PR via GraphQL.
 *
 * Devolve `UNRESOLVED_THREADS_UNKNOWN` (-1) quando a consulta falha — o valor
 * significa DESCONHECIDO, e o gate de merge deve tratá-lo como reprovação.
 */
export async function countUnresolvedThreads(input: UnresolvedThreadsInput): Promise<number> {
  const slug = parseRepoSlug(input.repo);
  if (!slug.ok) return UNRESOLVED_THREADS_UNKNOWN;

  const number = validatePullRequestNumber(input.prNumber);
  if (!number.ok) return UNRESOLVED_THREADS_UNKNOWN;

  let unresolved = 0;
  let cursor: string | null = null;

  for (let page = 0; page < MAX_THREAD_PAGES; page += 1) {
    const args = [
      'api',
      'graphql',
      '-f',
      `query=${REVIEW_THREADS_QUERY}`,
      '-F',
      `owner=${slug.value.owner}`,
      '-F',
      `repo=${slug.value.name}`,
      '-F',
      `number=${String(number.value)}`,
    ];
    if (cursor !== null && cursor.length > 0) {
      args.push('-F', `cursor=${cursor}`);
    }

    const response: Result<unknown> = await ghJson<unknown>(args, input.cwd, {
      timeoutMs: 60_000,
    });
    if (!response.ok) return UNRESOLVED_THREADS_UNKNOWN;

    const threads = readReviewThreads(response.value);
    if (threads === null) return UNRESOLVED_THREADS_UNKNOWN;

    for (const node of threads.nodes) {
      const record = asRecord(node);
      if (record === null) continue;
      if (asBoolean(record['isResolved']) !== true) unresolved += 1;
    }

    if (!threads.hasNextPage || threads.endCursor === null) return unresolved;
    cursor = threads.endCursor;
  }

  // Excedeu o limite de páginas: não é possível afirmar o total com segurança.
  return UNRESOLVED_THREADS_UNKNOWN;
}

interface ReviewThreadsPage {
  nodes: unknown[];
  hasNextPage: boolean;
  endCursor: string | null;
}

function readReviewThreads(value: unknown): ReviewThreadsPage | null {
  const root = asRecord(value);
  const data = root ? asRecord(root['data']) : null;
  const repository = data ? asRecord(data['repository']) : null;
  const pullRequest = repository ? asRecord(repository['pullRequest']) : null;
  const reviewThreads = pullRequest ? asRecord(pullRequest['reviewThreads']) : null;
  if (reviewThreads === null) return null;

  const nodes = asArray(reviewThreads['nodes']) ?? [];
  const pageInfo = asRecord(reviewThreads['pageInfo']);
  return {
    nodes,
    hasNextPage: pageInfo ? (asBoolean(pageInfo['hasNextPage']) ?? false) : false,
    endCursor: pageInfo ? asString(pageInfo['endCursor']) : null,
  };
}

/* ------------------------------------------------------------------------- */
/* Alterações                                                                 */
/* ------------------------------------------------------------------------- */

/** Substitui o corpo do pull request (enviado pelo STDIN). */
export async function updatePullRequestBody(
  input: UpdatePullRequestBodyInput,
): Promise<Result<void>> {
  const slug = parseRepoSlug(input.repo);
  if (!slug.ok) return slug;

  const number = validatePullRequestNumber(input.prNumber);
  if (!number.ok) return number;

  if (typeof input.body !== 'string') {
    return fail('VALIDATION_FAILED', 'Corpo do pull request inválido.');
  }

  const result = await ghText(
    ['pr', 'edit', String(number.value), '--repo', slug.value.slug, '--body-file', '-'],
    input.cwd,
    { input: input.body, timeoutMs: 120_000 },
  );
  if (!result.ok) return result;
  return ok(undefined);
}

/**
 * Tira o pull request do modo rascunho.
 * Já estar pronto para revisão é tratado como sucesso (operação idempotente).
 */
export async function markReadyForReview(input: MarkReadyInput): Promise<Result<void>> {
  const slug = parseRepoSlug(input.repo);
  if (!slug.ok) return slug;

  const number = validatePullRequestNumber(input.prNumber);
  if (!number.ok) return number;

  const args = ['pr', 'ready', String(number.value), '--repo', slug.value.slug];
  const run = await ghExec(args, input.cwd, { timeoutMs: 60_000 });
  if (!run.ok) return run;

  const proc = run.value;
  if (ghSucceeded(proc)) return ok(undefined);

  const combined = redactGhOutput(`${proc.stdout}\n${proc.stderr}`);
  if (/already .*ready for review/i.test(combined) || /not a draft/i.test(combined)) {
    return ok(undefined);
  }
  return ghFailure(proc, args);
}

/* ------------------------------------------------------------------------- */
/* Busca                                                                      */
/* ------------------------------------------------------------------------- */

/**
 * Localiza o pull request associado a uma branch de origem.
 * Prefere um PR aberto; se não houver, devolve o mais recente (maior número).
 */
export async function findPullRequestForBranch(
  input: FindPullRequestInput,
): Promise<Result<PullRequestInfo | null>> {
  const slug = parseRepoSlug(input.repo);
  if (!slug.ok) return slug;

  const head = validateBranchName(input.head);
  if (!head.ok) return head;

  const response = await ghJson<unknown>(
    [
      'pr',
      'list',
      '--repo',
      slug.value.slug,
      '--head',
      head.value,
      '--state',
      'all',
      '--limit',
      '30',
      '--json',
      'number,state',
    ],
    input.cwd,
    { timeoutMs: 90_000 },
  );
  if (!response.ok) return response;

  const items = asArray(response.value);
  if (items === null) {
    return fail('GH_FAILED', 'Resposta inesperada do gh ao listar pull requests.', {
      repo: slug.value.slug,
      head: head.value,
    });
  }

  let openNumber: number | null = null;
  let latestNumber: number | null = null;

  for (const item of items) {
    const record = asRecord(item);
    if (record === null) continue;
    const number = asNumber(record['number']);
    if (number === null) continue;
    const state = (asString(record['state']) ?? '').toUpperCase();
    if (state === 'OPEN' && (openNumber === null || number > openNumber)) openNumber = number;
    if (latestNumber === null || number > latestNumber) latestNumber = number;
  }

  const chosen = openNumber ?? latestNumber;
  if (chosen === null) return ok(null);

  return getPullRequest({ cwd: input.cwd, repo: slug.value.slug, prNumber: chosen });
}
