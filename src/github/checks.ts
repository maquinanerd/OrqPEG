import type { CheckConclusion, CheckRun, ChecksSummary, Result } from '../types';
import { fail, ok } from '../utils/errors';
import { sleep } from '../utils/time';
import { validateBranchName } from '../security/branch-name';
import {
  asArray,
  asRecord,
  asString,
  ghExec,
  ghFailure,
  ghJson,
  ghSucceeded,
  looksLikeForbidden,
  looksLikeNotFound,
  parseGhJson,
  parseRepoSlug,
  redactGhOutput,
  validatePullRequestNumber,
} from './gh';
import type { RepoSlug } from './gh';

/**
 * Leitura e espera dos checks de CI de um pull request.
 *
 * Fonte primária: `gh pr checks --json`. Quando a versão instalada do `gh` não
 * suporta `--json`, o módulo cai para a API REST de check-runs do commit de
 * cabeça, preservando o mesmo formato de saída.
 */

const CHECK_JSON_FIELDS = 'name,state,bucket,workflow,link,startedAt,completedAt';

/** Limite de check-runs lidos pela API REST em uma única página. */
const API_CHECK_RUNS_PER_PAGE = 100;

/** Intervalo mínimo entre consultas, para não abusar da API do GitHub. */
const MIN_POLL_INTERVAL_MS = 2_000;

export interface ChecksInput {
  cwd: string;
  repo: string;
  prNumber: number;
}

export interface RequiredChecksInput {
  cwd: string;
  repo: string;
  branch: string;
}

export interface RequiredCheckNames {
  /** Contextos exigidos pela proteção da branch. */
  names: string[];
  /**
   * `false` quando a branch não tem proteção configurada OU quando a proteção
   * não pôde ser lida (falta de permissão de admin). Nesse caso o chamador
   * trata TODOS os checks como obrigatórios.
   */
  protectionConfigured: boolean;
}

export interface WaitForChecksInput extends ChecksInput {
  timeoutMs: number;
  pollIntervalMs: number;
  signal?: AbortSignal;
}

/* ------------------------------------------------------------------------- */
/* Checks obrigatórios                                                        */
/* ------------------------------------------------------------------------- */

/**
 * Lê os contextos obrigatórios da proteção da branch base.
 *
 * DECISÃO CONSERVADORA: quando a API responde 404 (branch sem proteção) ou
 * 401/403 (o token não tem permissão para ler a proteção), devolvemos
 * `protectionConfigured: false`. O chamador então considera TODOS os checks
 * como obrigatórios. É preferível exigir demais a liberar um merge ignorando um
 * check que na verdade era obrigatório.
 */
export async function getRequiredCheckNames(
  input: RequiredChecksInput,
): Promise<Result<RequiredCheckNames>> {
  const slug = parseRepoSlug(input.repo);
  if (!slug.ok) return slug;

  const branch = validateBranchName(input.branch);
  if (!branch.ok) return branch;

  const endpoint =
    `repos/${slug.value.owner}/${slug.value.name}` +
    `/branches/${branch.value}/protection/required_status_checks`;
  const args = ['api', endpoint, '-H', 'Accept: application/vnd.github+json'];

  const run = await ghExec(args, input.cwd, { timeoutMs: 60_000 });
  if (!run.ok) return run;

  const proc = run.value;
  if (!ghSucceeded(proc)) {
    const combined = redactGhOutput(`${proc.stdout}\n${proc.stderr}`);
    if (proc.status === 'COMPLETED' && (looksLikeNotFound(combined) || looksLikeForbidden(combined))) {
      return ok({ names: [], protectionConfigured: false });
    }
    return ghFailure(proc, args);
  }

  const parsed = parseGhJson<unknown>(proc.stdout, args);
  if (!parsed.ok) return parsed;

  const record = asRecord(parsed.value);
  if (record === null) {
    return ok({ names: [], protectionConfigured: false });
  }

  const names = new Set<string>();
  for (const item of asArray(record['contexts']) ?? []) {
    const context = asString(item);
    if (context !== null && context.trim().length > 0) names.add(context.trim());
  }
  for (const item of asArray(record['checks']) ?? []) {
    const check = asRecord(item);
    if (check === null) continue;
    const context = asString(check['context']);
    if (context !== null && context.trim().length > 0) names.add(context.trim());
  }

  return ok({ names: [...names], protectionConfigured: true });
}

/**
 * Marca `required` em cada check.
 *
 * Sem proteção legível, tudo é obrigatório. Com proteção, o nome do check é
 * comparado ao contexto exigido; jobs de matriz (`build (18.x)`) também são
 * aceitos como o contexto `build`, porque o GitHub agrupa esses jobs sob o
 * mesmo nome de workflow.
 */
function applyRequiredFlags(runs: CheckRun[], required: RequiredCheckNames): CheckRun[] {
  if (!required.protectionConfigured) {
    return runs.map((run) => ({ ...run, required: true }));
  }
  return runs.map((run) => ({
    ...run,
    required: required.names.some(
      (name) => run.name === name || run.name.startsWith(`${name} (`),
    ),
  }));
}

/* ------------------------------------------------------------------------- */
/* Leitura dos checks                                                         */
/* ------------------------------------------------------------------------- */

/** Lê o resumo consolidado dos checks do pull request. */
export async function getChecks(input: ChecksInput): Promise<Result<ChecksSummary>> {
  const slug = parseRepoSlug(input.repo);
  if (!slug.ok) return slug;

  const number = validatePullRequestNumber(input.prNumber);
  if (!number.ok) return number;

  const headArgs = [
    'pr',
    'view',
    String(number.value),
    '--repo',
    slug.value.slug,
    '--json',
    'headRefOid,baseRefName',
  ];
  const head = await ghJson<unknown>(headArgs, input.cwd, { timeoutMs: 60_000 });
  if (!head.ok) return head;

  const headRecord = asRecord(head.value);
  if (headRecord === null) {
    return fail('GH_FAILED', 'Resposta inesperada do gh ao ler o commit de cabeça do PR.', {
      repo: slug.value.slug,
      prNumber: number.value,
    });
  }
  const headSha = asString(headRecord['headRefOid']) ?? '';
  const baseRefName = asString(headRecord['baseRefName']) ?? '';

  let required: RequiredCheckNames = { names: [], protectionConfigured: false };
  if (baseRefName.length > 0) {
    const requiredResult = await getRequiredCheckNames({
      cwd: input.cwd,
      repo: slug.value.slug,
      branch: baseRefName,
    });
    // Falha ao consultar a proteção não impede a leitura dos checks: o padrão
    // conservador (tudo obrigatório) já está aplicado.
    if (requiredResult.ok) required = requiredResult.value;
  }

  const runs = await collectCheckRuns(input.cwd, slug.value, number.value, headSha);
  if (!runs.ok) return runs;

  return ok(summarizeChecks(headSha, applyRequiredFlags(runs.value, required)));
}

async function collectCheckRuns(
  cwd: string,
  slug: RepoSlug,
  prNumber: number,
  headSha: string,
): Promise<Result<CheckRun[]>> {
  const args = [
    'pr',
    'checks',
    String(prNumber),
    '--repo',
    slug.slug,
    '--json',
    CHECK_JSON_FIELDS,
  ];
  const run = await ghExec(args, cwd, { timeoutMs: 90_000 });
  if (!run.ok) return run;

  const proc = run.value;
  const stdout = proc.stdout.trim();

  // `gh pr checks` usa o código de saída como informação (8 = pendente,
  // 1 = algum check falhou), mas ainda imprime o JSON. Por isso a decisão é
  // tomada pelo conteúdo da saída, não pelo código.
  if (stdout.startsWith('[')) {
    const parsed = parseGhJson<unknown>(proc.stdout, args);
    if (!parsed.ok) return parsed;
    const items = asArray(parsed.value);
    if (items === null) {
      return fail('GH_FAILED', 'Resposta inesperada do gh ao listar os checks.', {
        repo: slug.slug,
        prNumber,
      });
    }
    return ok(items.map(mapCliCheck).filter((item): item is CheckRun => item !== null));
  }

  const combined = redactGhOutput(`${proc.stdout}\n${proc.stderr}`);
  if (/no checks reported/i.test(combined)) return ok([]);

  if (ghSucceeded(proc)) {
    return fail('GH_FAILED', 'O gh não devolveu a lista de checks esperada.', {
      repo: slug.slug,
      prNumber,
      output: combined.slice(0, 400),
    });
  }

  // Versões antigas do `gh` não conhecem `--json` neste subcomando; a API REST
  // de check-runs cobre o mesmo terreno.
  if (headSha.length === 0) return ghFailure(proc, args);
  return fetchCheckRunsFromApi(cwd, slug, headSha);
}

async function fetchCheckRunsFromApi(
  cwd: string,
  slug: RepoSlug,
  headSha: string,
): Promise<Result<CheckRun[]>> {
  const response = await ghJson<unknown>(
    [
      'api',
      `repos/${slug.owner}/${slug.name}/commits/${headSha}/check-runs`,
      '-H',
      'Accept: application/vnd.github+json',
      '-F',
      `per_page=${String(API_CHECK_RUNS_PER_PAGE)}`,
    ],
    cwd,
    { timeoutMs: 90_000 },
  );
  if (!response.ok) return response;

  const record = asRecord(response.value);
  const items = record ? asArray(record['check_runs']) : null;
  if (items === null) {
    return fail('GH_FAILED', 'Resposta inesperada da API de check-runs do GitHub.', {
      repo: slug.slug,
      headSha,
    });
  }
  return ok(items.map(mapApiCheck).filter((item): item is CheckRun => item !== null));
}

/* ------------------------------------------------------------------------- */
/* Normalização                                                               */
/* ------------------------------------------------------------------------- */

/** Timestamp zero do Go (`0001-01-01T00:00:00Z`) significa "sem valor". */
function normalizeTimestamp(value: unknown): string | null {
  const text = asString(value);
  if (text === null) return null;
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.startsWith('0001-01-01')) return null;
  return trimmed;
}

function conclusionFromState(state: string, bucket: string): CheckConclusion {
  switch (state.toUpperCase()) {
    case 'SUCCESS':
      return 'SUCCESS';
    case 'FAILURE':
      return 'FAILURE';
    case 'NEUTRAL':
      return 'NEUTRAL';
    case 'CANCELLED':
    case 'CANCELED':
      return 'CANCELLED';
    case 'SKIPPED':
      return 'SKIPPED';
    case 'TIMED_OUT':
      return 'TIMED_OUT';
    case 'ACTION_REQUIRED':
      return 'ACTION_REQUIRED';
    case 'STALE':
      return 'STALE';
    case 'STARTUP_FAILURE':
      return 'STARTUP_FAILURE';
    case 'PENDING':
    case 'QUEUED':
    case 'REQUESTED':
    case 'EXPECTED':
    case 'WAITING':
    case 'IN_PROGRESS':
      return 'PENDING';
    default:
      return conclusionFromBucket(bucket);
  }
}

function conclusionFromBucket(bucket: string): CheckConclusion {
  switch (bucket.toLowerCase()) {
    case 'pass':
      return 'SUCCESS';
    case 'fail':
      return 'FAILURE';
    case 'skipping':
    case 'skipped':
      return 'SKIPPED';
    case 'cancel':
      return 'CANCELLED';
    default:
      return 'PENDING';
  }
}

function statusFromState(state: string, bucket: string): CheckRun['status'] {
  switch (state.toUpperCase()) {
    case 'QUEUED':
    case 'REQUESTED':
    case 'EXPECTED':
    case 'WAITING':
      return 'QUEUED';
    case 'IN_PROGRESS':
      return 'IN_PROGRESS';
    case 'PENDING':
      return 'PENDING';
    case 'SUCCESS':
    case 'FAILURE':
    case 'NEUTRAL':
    case 'CANCELLED':
    case 'CANCELED':
    case 'SKIPPED':
    case 'TIMED_OUT':
    case 'ACTION_REQUIRED':
    case 'STALE':
    case 'STARTUP_FAILURE':
      return 'COMPLETED';
    default:
      return bucket.toLowerCase() === 'pending' ? 'PENDING' : 'UNKNOWN';
  }
}

/** Converte um item de `gh pr checks --json`. */
function mapCliCheck(value: unknown): CheckRun | null {
  const record = asRecord(value);
  if (record === null) return null;

  const name = asString(record['name']);
  if (name === null || name.trim().length === 0) return null;

  const state = asString(record['state']) ?? '';
  const bucket = asString(record['bucket']) ?? '';
  const workflow = asString(record['workflow']);
  const link = asString(record['link']);

  return {
    name: name.trim(),
    status: statusFromState(state, bucket),
    conclusion: conclusionFromState(state, bucket),
    detailsUrl: link !== null && link.length > 0 ? link : null,
    required: false,
    workflowName: workflow !== null && workflow.length > 0 ? workflow : null,
    startedAt: normalizeTimestamp(record['startedAt']),
    completedAt: normalizeTimestamp(record['completedAt']),
  };
}

/** Converte um item da API REST `.../check-runs`. */
function mapApiCheck(value: unknown): CheckRun | null {
  const record = asRecord(value);
  if (record === null) return null;

  const name = asString(record['name']);
  if (name === null || name.trim().length === 0) return null;

  const rawStatus = (asString(record['status']) ?? '').toUpperCase();
  const rawConclusion = asString(record['conclusion']);
  const detailsUrl = asString(record['details_url']);

  const status: CheckRun['status'] =
    rawStatus === 'COMPLETED'
      ? 'COMPLETED'
      : rawStatus === 'IN_PROGRESS'
        ? 'IN_PROGRESS'
        : rawStatus === 'QUEUED'
          ? 'QUEUED'
          : rawStatus === 'PENDING'
            ? 'PENDING'
            : 'UNKNOWN';

  const conclusion: CheckConclusion =
    rawConclusion === null || rawConclusion.trim().length === 0
      ? 'PENDING'
      : conclusionFromState(rawConclusion, '');

  return {
    name: name.trim(),
    status,
    conclusion,
    detailsUrl: detailsUrl !== null && detailsUrl.length > 0 ? detailsUrl : null,
    required: false,
    workflowName: null,
    startedAt: normalizeTimestamp(record['started_at']),
    completedAt: normalizeTimestamp(record['completed_at']),
  };
}

/* ------------------------------------------------------------------------- */
/* Resumo                                                                     */
/* ------------------------------------------------------------------------- */

/**
 * `NEUTRAL` é contabilizado como aprovado: a proteção de branch do GitHub
 * também trata resultado neutro como satisfatório.
 */
function isPassing(conclusion: CheckConclusion): boolean {
  return conclusion === 'SUCCESS' || conclusion === 'NEUTRAL';
}

/** Monta o resumo a partir dos checks já marcados com `required`. */
export function summarizeChecks(headSha: string, runs: CheckRun[]): ChecksSummary {
  let passed = 0;
  let failed = 0;
  let pending = 0;
  let skipped = 0;

  let anyRequiredPending = false;
  let anyRequiredFailed = false;
  let anyRequiredSkipped = false;
  let allRequiredPassed = true;

  for (const run of runs) {
    const conclusion = run.conclusion;
    if (isPassing(conclusion)) passed += 1;
    else if (conclusion === 'PENDING') pending += 1;
    else if (conclusion === 'SKIPPED') skipped += 1;
    else failed += 1;

    if (!run.required) continue;

    if (conclusion === 'PENDING') {
      anyRequiredPending = true;
      allRequiredPassed = false;
    } else if (conclusion === 'SKIPPED') {
      // Check obrigatório ignorado nunca conta como aprovado.
      anyRequiredSkipped = true;
      allRequiredPassed = false;
    } else if (!isPassing(conclusion)) {
      anyRequiredFailed = true;
      allRequiredPassed = false;
    }
  }

  return {
    headSha,
    total: runs.length,
    passed,
    failed,
    pending,
    skipped,
    allRequiredPassed,
    anyRequiredPending,
    anyRequiredFailed,
    anyRequiredSkipped,
    runs,
  };
}

/* ------------------------------------------------------------------------- */
/* Espera                                                                     */
/* ------------------------------------------------------------------------- */

/**
 * Consulta os checks em intervalos regulares até que nenhum check obrigatório
 * esteja pendente, até o cancelamento pelo `AbortSignal` ou até o timeout.
 */
export async function waitForChecks(input: WaitForChecksInput): Promise<Result<ChecksSummary>> {
  const deadline = Date.now() + Math.max(0, input.timeoutMs);
  const interval = Math.max(MIN_POLL_INTERVAL_MS, input.pollIntervalMs);

  let lastPending = 0;
  let lastTotal = 0;

  for (;;) {
    if (input.signal?.aborted === true) {
      return fail('CANCELLED', 'Espera pelos checks cancelada.', { prNumber: input.prNumber });
    }

    const current = await getChecks(input);
    if (!current.ok) return current;

    const summary = current.value;
    if (!summary.anyRequiredPending) return ok(summary);

    lastPending = summary.pending;
    lastTotal = summary.total;

    const remaining = deadline - Date.now();
    if (remaining <= 0) break;

    try {
      await sleep(Math.min(interval, remaining), input.signal);
    } catch {
      return fail('CANCELLED', 'Espera pelos checks cancelada.', { prNumber: input.prNumber });
    }
  }

  return fail(
    'PROCESS_TIMEOUT',
    'Tempo esgotado aguardando a conclusão dos checks obrigatórios do pull request.',
    {
      prNumber: input.prNumber,
      timeoutMs: input.timeoutMs,
      pendingChecks: lastPending,
      totalChecks: lastTotal,
    },
  );
}
