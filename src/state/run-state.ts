import * as crypto from 'node:crypto';
import * as path from 'node:path';
import type {
  EffectiveExecutionPolicySnapshot,
  PromptFile,
  PromptProgress,
  Result,
  RunEvent,
  RunRecord,
  RunSourceSnapshots,
  RunState,
} from '../types';
import { fail, ok } from '../utils/errors';
import { fileExists, listFilesSync, readJsonSync, writeJsonAtomicSync } from '../utils/fs-atomic';
import { naturalCompare } from '../utils/natural-sort';
import { createPromptBudget } from '../execution/loop-guard';
import { ensureDir, projectStateDir, runStatePath } from '../utils/paths';
import { compactStamp, nowIso } from '../utils/time';
import { validateIdentifier } from '../security/path-guard';

/**
 * Estado persistente de execução (RunRecord).
 *
 * Todo o histórico de uma execução vive em
 * `data/projects/<projectId>/state/<runId>.json`, gravado de forma atômica.
 * O arquivo é a fonte de verdade para retomada após interrupção: o orquestrador
 * nunca guarda estado apenas em memória.
 *
 * As funções deste módulo devolvem uma NOVA cópia do `RunRecord` em vez de mutar
 * o original, com a única exceção de `saveRun`, que precisa carimbar `updatedAt`
 * no registro entregue pelo chamador antes de persistir.
 */

/** Máximo de eventos mantidos no registro. Os mais antigos são descartados. */
const MAX_EVENTS = 500;

/* ------------------------------------------------------------------------- */
/* Máquina de estados                                                         */
/* ------------------------------------------------------------------------- */

/**
 * Transições normais do fluxo, estado a estado.
 *
 * O tipo `Record<RunState, ...>` obriga o compilador a exigir uma entrada para
 * cada estado declarado em `src/types.ts`: se um estado novo for adicionado ao
 * contrato, este mapa deixa de compilar até ser atualizado.
 *
 * Transições de exceção e de retomada NÃO ficam aqui — são aplicadas por
 * `canTransition` sobre este mapa base.
 */
const BASE_TRANSITIONS: Readonly<Record<RunState, readonly RunState[]>> = {
  IDLE: ['VALIDATING'],
  VALIDATING: ['PREPARING_WORKTREE', 'RUNNING_CLAUDE', 'COMPLETED'],
  // `COMPLETED` é alcançável daqui porque o dry-run valida tudo, monta o plano
  // e encerra logo após a preparação, sem nunca chamar uma IA.
  PREPARING_WORKTREE: ['RUNNING_CLAUDE', 'COMPLETED'],
  RUNNING_CLAUDE: ['RUNNING_TESTS', 'BUILDING_REVIEW_PACKAGE'],
  /*
   * `RUNNING_TESTS` é usado em DOIS momentos distintos do fluxo:
   *   1. após cada tentativa de prompt  -> segue para BUILDING_REVIEW_PACKAGE;
   *   2. na suíte COMPLETA antes do push -> segue para PUSHING / CREATING_PR,
   *      ou para COMPLETED quando o projeto não publica.
   * Só o primeiro caso estava mapeado, o que prendia a execução aqui. Falha em
   * teste leva a BLOCKED, que é alcançável de qualquer estado ativo.
   */
  RUNNING_TESTS: [
    'BUILDING_REVIEW_PACKAGE',
    'CHANGES_REQUESTED',
    'PUSHING',
    'CREATING_PR',
    'COMPLETED',
  ],
  BUILDING_REVIEW_PACKAGE: ['RUNNING_CODEX'],
  RUNNING_CODEX: ['CHANGES_REQUESTED', 'PROMPT_APPROVED'],
  CHANGES_REQUESTED: ['RUNNING_CLAUDE', 'RUNNING_TESTS'],
  PROMPT_APPROVED: [
    'COMMITTING',
    'RUNNING_CLAUDE',
    'RUNNING_TESTS',
    'PUSHING',
    'CREATING_PR',
    'COMPLETED',
  ],
  // `RUNNING_TESTS` é alcançável daqui porque, depois do último commit, o
  // orquestrador executa a suíte COMPLETA antes de publicar a branch.
  COMMITTING: ['RUNNING_CLAUDE', 'RUNNING_TESTS', 'PUSHING', 'CREATING_PR', 'COMPLETED'],
  PUSHING: [
    'CREATING_PR',
    'WAITING_CI',
    'RUNNING_CLAUDE_MERGE_AUDIT',
    'RUNNING_CLAUDE',
    'COMPLETED',
  ],
  CREATING_PR: ['WAITING_CI', 'RUNNING_CLAUDE_MERGE_AUDIT', 'COMPLETED'],
  WAITING_CI: ['CI_FAILED', 'RUNNING_CLAUDE_MERGE_AUDIT', 'COMPLETED'],
  CI_FAILED: ['RUNNING_CLAUDE', 'WAITING_CI', 'COMPLETED'],
  RUNNING_CLAUDE_MERGE_AUDIT: ['RUNNING_CODEX_MERGE_AUDIT', 'MERGE_CONSENSUS_PENDING'],
  RUNNING_CODEX_MERGE_AUDIT: ['MERGE_CONSENSUS_PENDING'],
  MERGE_CONSENSUS_PENDING: [
    'MERGE_APPROVED',
    'CHANGES_REQUESTED',
    'RUNNING_CLAUDE',
    'RUNNING_CLAUDE_MERGE_AUDIT',
    'WAITING_CI',
    'COMPLETED',
  ],
  MERGE_APPROVED: [
    'MERGING',
    'MERGE_CONSENSUS_PENDING',
    'RUNNING_CLAUDE_MERGE_AUDIT',
    'COMPLETED',
  ],
  MERGING: ['MERGED', 'MERGE_CONSENSUS_PENDING', 'COMPLETED'],
  MERGED: ['COMPLETED'],
  BLOCKED: [],
  AUTH_REQUIRED: [],
  USAGE_LIMIT_REACHED: [],
  INTERRUPTED: [],
  FAILED: [],
  /* Parada consciente do Loop Guard. Sai dela por decisão humana: retomar o
     fluxo, pular o prompt ou encerrar. Nunca automaticamente. */
  LOOP_GUARD_TRIGGERED: [
    'RUNNING_CLAUDE',
    'RUNNING_TESTS',
    'BLOCKED',
    'COMPLETED',
    'CANCELLED',
  ],
  COMPLETED: [],
  CANCELLED: [],
};

/** Estados finais: nenhuma transição sai deles (exceto `MERGED -> COMPLETED`). */
export const TERMINAL_STATES: ReadonlySet<RunState> = new Set<RunState>([
  'MERGED',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
]);

/**
 * Estados de exceção: alcançáveis a partir de QUALQUER estado não terminal,
 * porque uma falha, um bloqueio ou um Ctrl+C podem acontecer a qualquer momento.
 */
const EXCEPTION_STATES: ReadonlySet<RunState> = new Set<RunState>([
  'BLOCKED',
  'AUTH_REQUIRED',
  'USAGE_LIMIT_REACHED',
  'INTERRUPTED',
  'FAILED',
  'CANCELLED',
  /*
   * O Loop Guard interrompe a partir de qualquer ponto do fluxo — inclusive de
   * CHANGES_REQUESTED, que é o caso mais comum. Sem estar aqui, a transição era
   * rejeitada e a parada deliberada caía para BLOCKED genérico, perdendo o
   * gatilho na linha do tempo. Encontrado em execução real, não pelos dublês.
   */
  'LOOP_GUARD_TRIGGERED',
]);

/**
 * Estados dos quais a execução pode ser retomada de volta ao fluxo normal
 * (o usuário resolve o bloqueio, reautentica, espera a cota voltar ou corrige a CI).
 */
const RESUMABLE_STATES: ReadonlySet<RunState> = new Set<RunState>([
  'INTERRUPTED',
  'BLOCKED',
  'AUTH_REQUIRED',
  'USAGE_LIMIT_REACHED',
  'CI_FAILED',
  // Retomável apenas por ação humana explícita: o Loop Guard parou de
  // propósito, e a retomada preserva o orçamento já consumido.
  'LOOP_GUARD_TRIGGERED',
]);

/** Estados do fluxo normal (nem terminais, nem de exceção). */
const FLOW_STATES: ReadonlySet<RunState> = new Set<RunState>([
  'IDLE',
  'VALIDATING',
  'PREPARING_WORKTREE',
  'RUNNING_CLAUDE',
  'RUNNING_TESTS',
  'BUILDING_REVIEW_PACKAGE',
  'RUNNING_CODEX',
  'CHANGES_REQUESTED',
  'PROMPT_APPROVED',
  'COMMITTING',
  'PUSHING',
  'CREATING_PR',
  'WAITING_CI',
  'CI_FAILED',
  'RUNNING_CLAUDE_MERGE_AUDIT',
  'RUNNING_CODEX_MERGE_AUDIT',
  'MERGE_CONSENSUS_PENDING',
  'MERGE_APPROVED',
  'MERGING',
]);

/**
 * Estados em que uma pausa solicitada pelo usuário faz sentido.
 * `MERGING` fica de fora de propósito: um merge em andamento não é interrompido
 * pela metade.
 */
export const PAUSABLE_STATES: ReadonlySet<RunState> = new Set<RunState>([
  'VALIDATING',
  'PREPARING_WORKTREE',
  'RUNNING_CLAUDE',
  'RUNNING_TESTS',
  'BUILDING_REVIEW_PACKAGE',
  'RUNNING_CODEX',
  'CHANGES_REQUESTED',
  'PROMPT_APPROVED',
  'COMMITTING',
  'PUSHING',
  'CREATING_PR',
  'WAITING_CI',
  'CI_FAILED',
  'RUNNING_CLAUDE_MERGE_AUDIT',
  'RUNNING_CODEX_MERGE_AUDIT',
  'MERGE_CONSENSUS_PENDING',
  'MERGE_APPROVED',
]);

const ALL_RUN_STATE_NAMES: ReadonlySet<string> = new Set(Object.keys(BASE_TRANSITIONS));

export function isRunState(value: unknown): value is RunState {
  return typeof value === 'string' && ALL_RUN_STATE_NAMES.has(value);
}

export function isTerminal(state: RunState): boolean {
  return TERMINAL_STATES.has(state);
}

/**
 * Verdadeiro para estados que exigem intervenção externa antes de continuar:
 * BLOCKED, AUTH_REQUIRED, USAGE_LIMIT_REACHED, INTERRUPTED e CI_FAILED.
 */
export function isBlockedLike(state: RunState): boolean {
  return RESUMABLE_STATES.has(state);
}

/**
 * Regras da máquina de estados:
 *  1. nenhum estado terminal permite saída, exceto `MERGED -> COMPLETED`;
 *  2. repetir o mesmo estado é permitido fora dos terminais (ex.: iniciar o
 *     próximo prompt volta a `RUNNING_CLAUDE`);
 *  3. as transições normais estão em `BASE_TRANSITIONS`;
 *  4. estados de exceção são alcançáveis de qualquer estado não terminal;
 *  5. estados retomáveis voltam a qualquer estado do fluxo (ou a `COMPLETED`).
 */
export function canTransition(from: RunState, to: RunState): boolean {
  if (isTerminal(from)) {
    const terminalAllowed: readonly RunState[] = BASE_TRANSITIONS[from];
    return terminalAllowed.includes(to);
  }

  if (from === to) return true;

  const allowed: readonly RunState[] = BASE_TRANSITIONS[from];
  if (allowed.includes(to)) return true;

  if (EXCEPTION_STATES.has(to)) return true;

  if (RESUMABLE_STATES.has(from) && (FLOW_STATES.has(to) || to === 'COMPLETED')) return true;

  return false;
}

/* ------------------------------------------------------------------------- */
/* Criação e identificação                                                    */
/* ------------------------------------------------------------------------- */

/** Identificador de execução: `run-<AAAAMMDD-HHMMSS>-<4 hex>`. */
export function newRunId(): string {
  const suffix = crypto.randomBytes(2).toString('hex');
  return `run-${compactStamp()}-${suffix}`;
}

export interface CreateRunInput {
  projectId: string;
  dryRun: boolean;
  prompts: PromptFile[];
  /**
   * Política já resolvida pelo chamador.
   *
   * Obrigatória, e resolvida ANTES desta chamada de propósito: se `createRun`
   * pudesse compor a política a partir do projeto, haveria dois lugares
   * capazes de decidir limites, e o segundo acabaria divergindo do primeiro.
   */
  effectivePolicy: EffectiveExecutionPolicySnapshot;
  sourceSnapshots: RunSourceSnapshots;
}

/** Monta um `RunRecord` completo, com todos os prompts em `PENDING`. */
export function createRun(input: CreateRunInput): RunRecord {
  const at = nowIso();
  const ordered = [...input.prompts].sort((a, b) => {
    if (a.order !== b.order) return a.order - b.order;
    return naturalCompare(a.fileName, b.fileName);
  });

  const prompts: PromptProgress[] = ordered.map((prompt) => ({
    promptId: prompt.id,
    status: 'PENDING',
    attempts: 0,
    lastAttemptAt: null,
    approvedAt: null,
    commitSha: null,
    lastVerdict: null,
    blockingIssueCount: 0,
  }));

  const initialEvent: RunEvent = {
    at,
    state: 'IDLE',
    message: input.dryRun
      ? 'Execução criada em modo simulação (dry-run).'
      : 'Execução criada.',
    data: { promptCount: prompts.length },
  };

  return {
    schemaVersion: 1,
    runId: newRunId(),
    projectId: input.projectId,
    state: 'IDLE',
    previousState: null,
    createdAt: at,
    updatedAt: at,
    finishedAt: null,
    dryRun: input.dryRun,

    baseCommitSha: null,
    branchName: null,
    worktreePath: null,
    workingDirectory: null,

    prompts,
    currentPromptId: null,
    currentAttempt: 0,

    commits: [],

    pushedAt: null,
    pushedRemote: null,

    pullRequest: null,
    checks: null,

    finalTests: null,

    mergeReviews: [],
    consensus: null,
    gateReport: null,
    mergeOutcome: null,

    // Um orçamento por prompt, criado já na abertura da execução: retomar
    // depois nunca recria contadores zerados.
    budgets: prompts.map((prompt) => createPromptBudget(prompt.promptId)),
    overrides: [],
    lastLoopGuard: null,
    ciRepairCycles: 0,
    mergeCorrectionCycles: 0,

    effectivePolicy: input.effectivePolicy,
    sourceSnapshots: input.sourceSnapshots,
    /* Espelhados para que execuções gravadas agora continuem legíveis por uma
       versão anterior do painel. A escrita nova é `sourceSnapshots`. */
    projectContextHash: input.sourceSnapshots.projectContextHash,
    projectConfigHash: input.sourceSnapshots.projectConfigHash,

    events: [initialEvent],
    lastError: null,
    pauseRequested: false,
    cancelRequested: false,
  };
}

/* ------------------------------------------------------------------------- */
/* Persistência                                                               */
/* ------------------------------------------------------------------------- */

/**
 * Grava o registro de forma atômica. `updatedAt` é carimbado no próprio objeto
 * recebido para que o chamador continue com o registro coerente com o disco.
 */
export function saveRun(run: RunRecord): Result<void> {
  const projectCheck = validateIdentifier(run.projectId, 'id do projeto');
  if (!projectCheck.ok) return projectCheck;
  const runCheck = validateIdentifier(run.runId, 'id da execução');
  if (!runCheck.ok) return runCheck;

  try {
    ensureDir(projectStateDir(projectCheck.value));
  } catch (error) {
    return fail(
      'IO_FAILED',
      `Falha ao criar o diretório de estado do projeto ${projectCheck.value}.`,
      { projectId: projectCheck.value },
      error,
    );
  }

  run.updatedAt = nowIso();
  return writeJsonAtomicSync(runStatePath(projectCheck.value, runCheck.value), run);
}

export function loadRun(projectId: string, runId: string): Result<RunRecord> {
  const projectCheck = validateIdentifier(projectId, 'id do projeto');
  if (!projectCheck.ok) return projectCheck;
  const runCheck = validateIdentifier(runId, 'id da execução');
  if (!runCheck.ok) return runCheck;

  const filePath = runStatePath(projectCheck.value, runCheck.value);
  if (!fileExists(filePath)) {
    return fail(
      'CONFIG_NOT_FOUND',
      `Execução ${runCheck.value} não encontrada no projeto ${projectCheck.value}.`,
      { projectId: projectCheck.value, runId: runCheck.value, filePath },
    );
  }

  const read = readJsonSync<unknown>(filePath);
  if (!read.ok) return read;
  return validateRunRecord(read.value, filePath, {
    projectId: projectCheck.value,
    runId: runCheck.value,
  });
}

/**
 * Lista as execuções do projeto, da mais recente para a mais antiga.
 * Arquivos ilegíveis ou de outro schema são ignorados: um registro corrompido
 * não pode impedir a visualização dos demais.
 */
export function listRuns(projectId: string): Result<RunRecord[]> {
  const projectCheck = validateIdentifier(projectId, 'id do projeto');
  if (!projectCheck.ok) return projectCheck;

  const dir = projectStateDir(projectCheck.value);
  const records: RunRecord[] = [];

  for (const fileName of listFilesSync(dir)) {
    if (!fileName.toLowerCase().endsWith('.json')) continue;
    const read = readJsonSync<unknown>(path.join(dir, fileName));
    if (!read.ok) continue;
    const validated = validateRunRecord(read.value, fileName, {
      projectId: projectCheck.value,
      runId: fileName.replace(/\.json$/i, ''),
    });
    if (!validated.ok) continue;
    records.push(validated.value);
  }

  records.sort((a, b) => {
    const left = Date.parse(a.createdAt);
    const right = Date.parse(b.createdAt);
    const leftMs = Number.isNaN(left) ? 0 : left;
    const rightMs = Number.isNaN(right) ? 0 : right;
    if (leftMs !== rightMs) return rightMs - leftMs;
    return naturalCompare(b.runId, a.runId);
  });

  return ok(records);
}

/** Execução ainda em andamento (estado não terminal), a mais recente delas. */
export function findActiveRun(projectId: string): Result<RunRecord | null> {
  const listed = listRuns(projectId);
  if (!listed.ok) return listed;
  for (const run of listed.value) {
    if (!isTerminal(run.state)) return ok(run);
  }
  return ok(null);
}

export function latestRun(projectId: string): Result<RunRecord | null> {
  const listed = listRuns(projectId);
  if (!listed.ok) return listed;
  const first = listed.value[0];
  return ok(first === undefined ? null : first);
}

/* ------------------------------------------------------------------------- */
/* Transições                                                                 */
/* ------------------------------------------------------------------------- */

/**
 * Aplica uma transição de estado e registra o `RunEvent` correspondente.
 *
 * Quando a transição é proibida pela máquina de estados, o estado NÃO muda: um
 * evento de rejeição é anexado para deixar a tentativa registrada na auditoria.
 * Nada é lançado — o chamador pode comparar `resultado.state` com `next` para
 * saber se a transição foi aceita.
 */
export function transition(
  run: RunRecord,
  next: RunState,
  message: string,
  data?: Record<string, unknown>,
): RunRecord {
  const at = nowIso();

  if (!canTransition(run.state, next)) {
    return appendEvent(run, {
      at,
      state: run.state,
      message: `Transição rejeitada (${run.state} para ${next}): ${message}`,
      data: { ...(data ?? {}), rejectedTarget: next, currentState: run.state },
    });
  }

  const updated = appendEvent(run, {
    at,
    state: next,
    message,
    ...(data ? { data } : {}),
  });

  updated.previousState = run.state;
  updated.state = next;
  updated.updatedAt = at;
  if (isTerminal(next)) {
    updated.finishedAt = at;
  }
  return updated;
}

/* ------------------------------------------------------------------------- */
/* Prompts                                                                    */
/* ------------------------------------------------------------------------- */

/**
 * Atualiza o progresso de um prompt. Campos ausentes no `patch` são preservados
 * e `promptId` nunca é alterado (a identidade do prompt é imutável).
 * Se o prompt não existir, o registro volta inalterado.
 */
export function updatePromptProgress(
  run: RunRecord,
  promptId: string,
  patch: Partial<PromptProgress>,
): RunRecord {
  const index = run.prompts.findIndex((item) => item.promptId === promptId);
  if (index < 0) return run;

  const current = run.prompts[index];
  if (current === undefined) return run;

  const merged: PromptProgress = { ...current };
  if (patch.status !== undefined) merged.status = patch.status;
  if (patch.attempts !== undefined) merged.attempts = patch.attempts;
  if (patch.lastAttemptAt !== undefined) merged.lastAttemptAt = patch.lastAttemptAt;
  if (patch.approvedAt !== undefined) merged.approvedAt = patch.approvedAt;
  if (patch.commitSha !== undefined) merged.commitSha = patch.commitSha;
  if (patch.lastVerdict !== undefined) merged.lastVerdict = patch.lastVerdict;
  if (patch.blockingIssueCount !== undefined) {
    merged.blockingIssueCount = patch.blockingIssueCount;
  }

  const prompts = [...run.prompts];
  prompts[index] = merged;

  return { ...run, prompts, updatedAt: nowIso() };
}

/** Primeiro prompt ainda não executado, na ordem do plano. */
export function nextPendingPrompt(run: RunRecord): PromptProgress | null {
  for (const prompt of run.prompts) {
    if (prompt.status === 'PENDING') return prompt;
  }
  return null;
}

/**
 * Verdadeiro quando há prompts e todos foram concluídos com sucesso.
 * Prompts marcados como `SKIPPED` (pulados deliberadamente pelo usuário) não
 * impedem o merge; `PENDING`, `RUNNING`, `CHANGES_REQUESTED`, `BLOCKED` e
 * `FAILED` impedem.
 */
export function allPromptsApproved(run: RunRecord): boolean {
  if (run.prompts.length === 0) return false;
  return run.prompts.every(
    (prompt) => prompt.status === 'APPROVED' || prompt.status === 'SKIPPED',
  );
}

/* ------------------------------------------------------------------------- */
/* Invalidação de aprovações                                                  */
/* ------------------------------------------------------------------------- */

/**
 * Invalida TODAS as auditorias de merge já produzidas e zera consenso e
 * relatório de gates.
 *
 * Regra inviolável: uma aprovação emitida para um SHA antigo NUNCA é
 * reaproveitada. Se o head da branch mudou (novo commit, rebase, merge da base)
 * ou se um gate reprovou depois da aprovação, as auditorias de Claude e Codex
 * precisam ser refeitas sobre o SHA atual. Sem isso, o merge poderia entregar
 * código que nenhum auditor chegou a ver.
 */
export function invalidateMergeApprovals(run: RunRecord, reason: string): RunRecord {
  const at = nowIso();
  const mergeReviews = run.mergeReviews.map((record) => ({
    ...record,
    invalidated: true,
    invalidationReason: reason,
  }));

  const updated = appendEvent(run, {
    at,
    state: run.state,
    message: `Aprovações de merge invalidadas: ${reason}`,
    data: { invalidatedReviews: mergeReviews.length },
  });

  updated.mergeReviews = mergeReviews;
  updated.consensus = null;
  updated.gateReport = null;
  updated.updatedAt = at;
  return updated;
}

/* ------------------------------------------------------------------------- */
/* Pausa e cancelamento                                                       */
/* ------------------------------------------------------------------------- */

/**
 * Marca o pedido de pausa. O orquestrador honra a marcação no próximo ponto
 * seguro do ciclo; nenhum processo em andamento é morto por aqui.
 */
export function requestPause(run: RunRecord): RunRecord {
  const at = nowIso();
  const pausable = PAUSABLE_STATES.has(run.state);
  const updated = appendEvent(run, {
    at,
    state: run.state,
    message: pausable
      ? 'Pausa solicitada. A execução para no próximo ponto seguro.'
      : `Pausa solicitada, mas o estado ${run.state} não é pausável. A marcação fica registrada.`,
    data: { pausable },
  });
  updated.pauseRequested = true;
  updated.updatedAt = at;
  return updated;
}

/** Marca o pedido de cancelamento, honrado no próximo ponto seguro do ciclo. */
export function requestCancel(run: RunRecord): RunRecord {
  const at = nowIso();
  const updated = appendEvent(run, {
    at,
    state: run.state,
    message: 'Cancelamento solicitado. A execução encerra no próximo ponto seguro.',
  });
  updated.cancelRequested = true;
  updated.updatedAt = at;
  return updated;
}

/* ------------------------------------------------------------------------- */
/* Auxiliares internos                                                        */
/* ------------------------------------------------------------------------- */

function appendEvent(run: RunRecord, event: RunEvent): RunRecord {
  const events = [...run.events, event];
  const trimmed =
    events.length > MAX_EVENTS ? events.slice(events.length - MAX_EVENTS) : events;
  return { ...run, events: trimmed, updatedAt: event.at };
}

function validateRunRecord(
  value: unknown,
  source: string,
  expected: { projectId: string; runId: string },
): Result<RunRecord> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return fail('STATE_CORRUPT', `Registro de execução inválido em ${source}.`, { source });
  }
  const raw = value as Record<string, unknown>;

  const schemaVersion = raw['schemaVersion'];
  const runId = raw['runId'];
  const projectId = raw['projectId'];
  const state = raw['state'];
  const previousState = raw['previousState'];
  const createdAt = raw['createdAt'];
  const updatedAt = raw['updatedAt'];

  if (schemaVersion !== 1) {
    return fail(
      'STATE_CORRUPT',
      `Versão de schema não suportada no registro de execução (${source}).`,
      { source, schemaVersion },
    );
  }
  if (typeof runId !== 'string' || runId.length === 0) {
    return fail('STATE_CORRUPT', `Registro sem runId válido (${source}).`, { source });
  }
  if (typeof projectId !== 'string' || projectId.length === 0) {
    return fail('STATE_CORRUPT', `Registro sem projectId válido (${source}).`, { source });
  }
  if (!isRunState(state)) {
    return fail('STATE_CORRUPT', `Estado desconhecido no registro (${source}).`, {
      source,
      state,
    });
  }
  if (previousState !== null && !isRunState(previousState)) {
    return fail('STATE_CORRUPT', `Estado anterior desconhecido no registro (${source}).`, {
      source,
      previousState,
    });
  }
  if (typeof createdAt !== 'string' || typeof updatedAt !== 'string') {
    return fail('STATE_CORRUPT', `Registro sem carimbos de tempo válidos (${source}).`, {
      source,
    });
  }
  if (!Array.isArray(raw['prompts'])) {
    return fail('STATE_CORRUPT', `Registro sem lista de prompts (${source}).`, { source });
  }
  if (!Array.isArray(raw['events'])) {
    return fail('STATE_CORRUPT', `Registro sem lista de eventos (${source}).`, { source });
  }
  if (!Array.isArray(raw['commits'])) {
    return fail('STATE_CORRUPT', `Registro sem lista de commits (${source}).`, { source });
  }
  if (!Array.isArray(raw['mergeReviews'])) {
    return fail('STATE_CORRUPT', `Registro sem lista de auditorias de merge (${source}).`, {
      source,
    });
  }

  /*
   * Amarração de identidade.
   *
   * O caminho `.../<projectId>/state/<runId>.json` era a única prova de que o
   * registro pertencia a quem o pediu. Um arquivo copiado entre projetos, ou
   * com `runId` interno divergente do nome, produziria nomes de branch e
   * caminhos de worktree derivados do projeto errado.
   */
  if (raw['projectId'] !== expected.projectId || raw['runId'] !== expected.runId) {
    return fail(
      'STATE_CORRUPT',
      `O registro em ${source} identifica-se como ${String(raw['projectId'])}/${String(raw['runId'])}, ` +
        `mas foi carregado como ${expected.projectId}/${expected.runId}.`,
      { source, expected, found: { projectId: raw['projectId'], runId: raw['runId'] } },
    );
  }

  /*
   * Execuções gravadas antes do congelamento de política.
   *
   * A ausência é normalizada para `null` explícito e NÃO é preenchida a partir
   * do cadastro atual: inventar o snapshot aqui seria exatamente a reescrita
   * retroativa que este campo existe para impedir. Quem precisa de limites
   * chama `requireEffectivePolicy` e recebe `POLICY_SNAPSHOT_MISSING`.
   */
  const record = value as RunRecord;
  if (record.effectivePolicy === undefined) record.effectivePolicy = null;
  if (record.sourceSnapshots === undefined) record.sourceSnapshots = null;

  return ok(record);
}
