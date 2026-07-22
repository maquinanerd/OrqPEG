import type {
  ChecksSummary,
  GateId,
  GateResult,
  GateStatus,
  MergeGateReport,
  MergeReviewRecord,
  ProjectConfig,
  PromptProgress,
  PullRequestInfo,
  RunRecord,
  TestSuiteResult,
} from '../types';
import { nowIso } from '../utils/time';

/**
 * Gates de merge do OrqPEG.
 *
 * Os 20 gates abaixo são a única porta de entrada para o merge automático. A
 * avaliação é *fail-closed*: qualquer dado ausente, desconhecido ou desatualizado
 * reprova o gate. Um gate jamais é aprovado "por falta de informação" — se não é
 * possível PROVAR que a condição é verdadeira, o gate reprova.
 *
 * Todos os 20 gates são sempre avaliados, mesmo depois da primeira reprovação:
 * o relatório precisa mostrar o quadro completo ao usuário, e não apenas o
 * primeiro problema encontrado.
 */

export interface GateDefinition {
  id: GateId;
  index: number;
  title: string;
}

/** Definição canônica dos 20 gates, na ordem exata de avaliação e exibição. */
export const GATE_DEFINITIONS: ReadonlyArray<GateDefinition> = [
  { id: 'ALL_PROMPTS_APPROVED', index: 1, title: 'Todos os prompts foram aprovados' },
  { id: 'ALL_COMMITS_CREATED', index: 2, title: 'Todos os commits foram criados' },
  {
    id: 'BRANCH_PUSHED_TO_CORRECT_REMOTE',
    index: 3,
    title: 'A branch foi enviada ao remoto correto',
  },
  { id: 'PR_OPEN', index: 4, title: 'A PR esta aberta' },
  { id: 'PR_BASE_CORRECT', index: 5, title: 'A base da PR esta correta' },
  { id: 'NO_CONFLICTS', index: 6, title: 'Nao existe conflito' },
  { id: 'LOCAL_TESTS_PASSED', index: 7, title: 'Testes locais passaram' },
  {
    id: 'REQUIRED_CHECKS_PASSED',
    index: 8,
    title: 'Todos os checks obrigatorios passaram',
  },
  {
    id: 'NO_PENDING_REQUIRED_CHECKS',
    index: 9,
    title: 'Nenhum check obrigatorio esta pendente',
  },
  {
    id: 'NO_SKIPPED_REQUIRED_CHECKS',
    index: 10,
    title: 'Nenhum check obrigatorio foi ignorado',
  },
  { id: 'NO_UNRESOLVED_THREADS', index: 11, title: 'Nao existem threads nao resolvidas' },
  {
    id: 'NO_HUMAN_CHANGES_REQUESTED',
    index: 12,
    title: 'Nao existe revisao humana solicitando mudancas',
  },
  { id: 'CLAUDE_MERGE_APPROVED', index: 13, title: 'Claude Merge Auditor aprovou' },
  { id: 'CODEX_MERGE_APPROVED', index: 14, title: 'Codex Merge Auditor aprovou' },
  { id: 'AUDITORS_SAME_HEAD_SHA', index: 15, title: 'Ambos revisaram o mesmo head SHA' },
  { id: 'MINIMUM_CONFIDENCE_MET', index: 16, title: 'Ambos atingiram a confianca minima' },
  { id: 'NO_BLOCKING_ISSUES', index: 17, title: 'Nenhum registrou problema bloqueador' },
  { id: 'HEAD_SHA_UNCHANGED', index: 18, title: 'O head SHA nao mudou' },
  { id: 'BASE_NOT_INVALIDATED', index: 19, title: 'A base nao mudou de forma invalidante' },
  {
    id: 'PROJECT_ALLOWS_DUAL_AI_CONSENSUS',
    index: 20,
    title: 'O projeto permite dual_ai_consensus',
  },
];

export interface GateEvaluationInput {
  project: ProjectConfig;
  run: RunRecord;
  pr: PullRequestInfo | null;
  checks: ChecksSummary | null;
  finalTests: TestSuiteResult | null;
  currentHeadSha: string;
  currentBaseSha: string | null;
  claudeReview: MergeReviewRecord | null;
  codexReview: MergeReviewRecord | null;
}

interface GateOutcome {
  status: GateStatus;
  reason: string;
  evidence?: Record<string, unknown>;
}

/** Valor de `unresolvedThreadCount` que significa DESCONHECIDO. */
const UNRESOLVED_UNKNOWN = -1;

/** Estados de merge do GitHub que indicam conflito com a base. */
const DIRTY_MERGE_STATE = 'DIRTY';

/** Estado de merge do GitHub que indica base à frente da branch. */
const BEHIND_MERGE_STATE = 'BEHIND';

/* ------------------------------------------------------------------------- */
/* Avaliação                                                                  */
/* ------------------------------------------------------------------------- */

/**
 * Avalia os 20 gates e devolve o relatório completo.
 *
 * Nenhum gate fica como `NOT_EVALUATED`: a tabela de resultados é construída a
 * partir de `GATE_DEFINITIONS`, o que garante cobertura total. `allPassed` só é
 * verdadeiro quando não há nenhum gate reprovado e todos foram efetivamente
 * avaliados.
 */
export function evaluateGates(input: GateEvaluationInput): MergeGateReport {
  const outcomes: Record<GateId, GateOutcome> = {
    ALL_PROMPTS_APPROVED: gateAllPromptsApproved(input),
    ALL_COMMITS_CREATED: gateAllCommitsCreated(input),
    BRANCH_PUSHED_TO_CORRECT_REMOTE: gateBranchPushed(input),
    PR_OPEN: gatePrOpen(input),
    PR_BASE_CORRECT: gatePrBaseCorrect(input),
    NO_CONFLICTS: gateNoConflicts(input),
    LOCAL_TESTS_PASSED: gateLocalTestsPassed(input),
    REQUIRED_CHECKS_PASSED: gateRequiredChecksPassed(input),
    NO_PENDING_REQUIRED_CHECKS: gateNoPendingRequiredChecks(input),
    NO_SKIPPED_REQUIRED_CHECKS: gateNoSkippedRequiredChecks(input),
    NO_UNRESOLVED_THREADS: gateNoUnresolvedThreads(input),
    NO_HUMAN_CHANGES_REQUESTED: gateNoHumanChangesRequested(input),
    CLAUDE_MERGE_APPROVED: gateAuditorApproved(
      input.claudeReview,
      input.project.merge.requireClaudeApproval,
      'Claude',
      input.currentHeadSha,
    ),
    CODEX_MERGE_APPROVED: gateAuditorApproved(
      input.codexReview,
      input.project.merge.requireCodexApproval,
      'Codex',
      input.currentHeadSha,
    ),
    AUDITORS_SAME_HEAD_SHA: gateAuditorsSameHeadSha(input),
    MINIMUM_CONFIDENCE_MET: gateMinimumConfidenceMet(input),
    NO_BLOCKING_ISSUES: gateNoBlockingIssues(input),
    HEAD_SHA_UNCHANGED: gateHeadShaUnchanged(input),
    BASE_NOT_INVALIDATED: gateBaseNotInvalidated(input),
    PROJECT_ALLOWS_DUAL_AI_CONSENSUS: gateProjectAllowsDualAiConsensus(input),
  };

  const gates: GateResult[] = GATE_DEFINITIONS.map((definition) => {
    const outcome = outcomes[definition.id];
    const result: GateResult = {
      id: definition.id,
      index: definition.index,
      title: definition.title,
      status: outcome.status,
      reason: outcome.reason,
      ...(outcome.evidence ? { evidence: outcome.evidence } : {}),
    };
    return result;
  });

  const failedGates = gates.filter((gate) => gate.status === 'FAILED').map((gate) => gate.id);

  // `SKIPPED` não reprova, mas `NOT_EVALUATED` também não aprova: exigimos que
  // todos os gates tenham sido efetivamente avaliados.
  const allEvaluated =
    gates.length === GATE_DEFINITIONS.length &&
    gates.every((gate) => gate.status === 'PASSED' || gate.status === 'SKIPPED');

  return {
    evaluatedAt: nowIso(),
    headSha: input.currentHeadSha,
    baseSha: input.currentBaseSha ?? '',
    allPassed: failedGates.length === 0 && allEvaluated,
    gates,
    failedGates,
  };
}

/* ------------------------------------------------------------------------- */
/* Gate 1 — prompts aprovados                                                 */
/* ------------------------------------------------------------------------- */

function gateAllPromptsApproved(input: GateEvaluationInput): GateOutcome {
  const prompts = input.run.prompts;
  if (prompts.length === 0) {
    return {
      status: 'FAILED',
      reason:
        'A execução não registrou nenhum prompt. Não há trabalho aprovado que justifique um merge.',
      evidence: { promptCount: 0 },
    };
  }

  const pending = prompts.filter((prompt) => prompt.status !== 'APPROVED');
  if (pending.length > 0) {
    return {
      status: 'FAILED',
      reason: `${pending.length} de ${prompts.length} prompt(s) não estão com status APPROVED: ${describePrompts(pending)}.`,
      evidence: {
        promptCount: prompts.length,
        approvedCount: prompts.length - pending.length,
        pending: pending.map((prompt) => ({ promptId: prompt.promptId, status: prompt.status })),
      },
    };
  }

  return {
    status: 'PASSED',
    reason: `Os ${prompts.length} prompt(s) da execução foram aprovados pelo revisor.`,
    evidence: { promptCount: prompts.length, approvedCount: prompts.length },
  };
}

/* ------------------------------------------------------------------------- */
/* Gate 2 — commits criados                                                   */
/* ------------------------------------------------------------------------- */

function gateAllCommitsCreated(input: GateEvaluationInput): GateOutcome {
  const { run } = input;

  if (run.prompts.length === 0) {
    return {
      status: 'FAILED',
      reason: 'Sem prompts registrados não é possível confirmar que os commits foram criados.',
      evidence: { promptCount: 0, commitCount: run.commits.length },
    };
  }

  if (run.commits.length === 0) {
    return {
      status: 'FAILED',
      reason: 'Nenhum commit foi registrado nesta execução.',
      evidence: { promptCount: run.prompts.length, commitCount: 0 },
    };
  }

  const promptIdsWithCommit = new Set(
    run.commits.filter((commit) => commit.sha.trim().length > 0).map((commit) => commit.promptId),
  );

  const approved = run.prompts.filter((prompt) => prompt.status === 'APPROVED');
  const missing = approved.filter(
    (prompt) =>
      prompt.commitSha === null ||
      prompt.commitSha.trim().length === 0 ||
      !promptIdsWithCommit.has(prompt.promptId),
  );

  if (missing.length > 0) {
    return {
      status: 'FAILED',
      reason: `${missing.length} prompt(s) aprovados estão sem commit registrado: ${describePrompts(missing)}.`,
      evidence: {
        commitCount: run.commits.length,
        missing: missing.map((prompt) => prompt.promptId),
      },
    };
  }

  return {
    status: 'PASSED',
    reason: `${run.commits.length} commit(s) registrados cobrem todos os prompts aprovados.`,
    evidence: {
      commitCount: run.commits.length,
      commits: run.commits.map((commit) => ({
        promptId: commit.promptId,
        sha: shortSha(commit.sha),
      })),
    },
  };
}

/* ------------------------------------------------------------------------- */
/* Gate 3 — push no remoto correto                                            */
/* ------------------------------------------------------------------------- */

function gateBranchPushed(input: GateEvaluationInput): GateOutcome {
  const { run, project, pr } = input;

  const branch = run.branchName;
  if (branch === null || branch.trim().length === 0) {
    return {
      status: 'FAILED',
      reason: 'A execução não registrou o nome da branch de trabalho.',
      evidence: { expectedRemote: project.remote },
    };
  }

  if (run.pushedAt === null || run.pushedAt.trim().length === 0) {
    return {
      status: 'FAILED',
      reason: `A branch "${branch}" não foi enviada ao remoto.`,
      evidence: { branch, expectedRemote: project.remote, pushedAt: run.pushedAt },
    };
  }

  if (run.pushedRemote !== project.remote) {
    return {
      status: 'FAILED',
      reason: `A branch foi enviada ao remoto "${String(run.pushedRemote)}", mas o projeto exige "${project.remote}".`,
      evidence: {
        branch,
        expectedRemote: project.remote,
        actualRemote: run.pushedRemote,
      },
    };
  }

  if (pr !== null && pr.headRefName !== branch) {
    return {
      status: 'FAILED',
      reason: `A PR #${String(pr.number)} aponta para a branch "${pr.headRefName}", diferente da branch enviada "${branch}".`,
      evidence: { branch, prHeadRefName: pr.headRefName, prNumber: pr.number },
    };
  }

  return {
    status: 'PASSED',
    reason: `A branch "${branch}" foi enviada ao remoto "${project.remote}" em ${run.pushedAt}.`,
    evidence: { branch, remote: project.remote, pushedAt: run.pushedAt },
  };
}

/* ------------------------------------------------------------------------- */
/* Gate 4 — PR aberta                                                         */
/* ------------------------------------------------------------------------- */

function gatePrOpen(input: GateEvaluationInput): GateOutcome {
  const { pr } = input;
  if (pr === null) {
    return {
      status: 'FAILED',
      reason: 'Nenhum pull request conhecido para esta execução; estado desconhecido reprova.',
      evidence: { pullRequest: null },
    };
  }

  if (pr.merged || pr.state === 'MERGED') {
    return {
      status: 'FAILED',
      reason: `A PR #${String(pr.number)} já está mergeada; não há merge a autorizar.`,
      evidence: { prNumber: pr.number, state: pr.state, merged: pr.merged },
    };
  }

  if (pr.state !== 'OPEN') {
    return {
      status: 'FAILED',
      reason: `A PR #${String(pr.number)} está com estado ${pr.state}, e não OPEN.`,
      evidence: { prNumber: pr.number, state: pr.state },
    };
  }

  if (pr.isDraft) {
    return {
      status: 'FAILED',
      reason: `A PR #${String(pr.number)} ainda está em rascunho e não pode ser mergeada.`,
      evidence: { prNumber: pr.number, isDraft: true },
    };
  }

  return {
    status: 'PASSED',
    reason: `A PR #${String(pr.number)} está aberta e pronta para revisão.`,
    evidence: { prNumber: pr.number, state: pr.state, url: pr.url },
  };
}

/* ------------------------------------------------------------------------- */
/* Gate 5 — base da PR                                                        */
/* ------------------------------------------------------------------------- */

function gatePrBaseCorrect(input: GateEvaluationInput): GateOutcome {
  const { pr, project } = input;
  if (pr === null) {
    return {
      status: 'FAILED',
      reason: 'Sem pull request não é possível confirmar a branch base.',
      evidence: { expectedBase: project.baseBranch },
    };
  }

  if (pr.baseRefName !== project.baseBranch) {
    return {
      status: 'FAILED',
      reason: `A PR aponta para a base "${pr.baseRefName}", mas o projeto exige "${project.baseBranch}".`,
      evidence: {
        prNumber: pr.number,
        expectedBase: project.baseBranch,
        actualBase: pr.baseRefName,
      },
    };
  }

  return {
    status: 'PASSED',
    reason: `A base da PR é "${pr.baseRefName}", conforme configurado no projeto.`,
    evidence: { prNumber: pr.number, base: pr.baseRefName },
  };
}

/* ------------------------------------------------------------------------- */
/* Gate 6 — conflitos                                                         */
/* ------------------------------------------------------------------------- */

function gateNoConflicts(input: GateEvaluationInput): GateOutcome {
  const { pr, project } = input;
  if (pr === null) {
    return {
      status: 'FAILED',
      reason: 'Sem pull request não é possível afirmar que a branch está livre de conflitos.',
      evidence: { requireNoConflicts: project.merge.requireNoConflicts },
    };
  }

  const evidence: Record<string, unknown> = {
    prNumber: pr.number,
    mergeable: pr.mergeable,
    mergeStateStatus: pr.mergeStateStatus,
    requireNoConflicts: project.merge.requireNoConflicts,
  };

  if (pr.mergeable === 'UNKNOWN') {
    return {
      status: 'FAILED',
      reason:
        'O GitHub ainda não calculou a mesclabilidade da PR (mergeable = UNKNOWN). Estado desconhecido reprova.',
      evidence,
    };
  }

  if (pr.mergeable === 'CONFLICTING') {
    return {
      status: 'FAILED',
      reason: 'A PR possui conflitos com a branch base.',
      evidence,
    };
  }

  const state = (pr.mergeStateStatus ?? '').toUpperCase();
  if (state === DIRTY_MERGE_STATE) {
    return {
      status: 'FAILED',
      reason: 'O estado de merge informado pelo GitHub é DIRTY, o que indica conflito.',
      evidence,
    };
  }

  return {
    status: 'PASSED',
    reason: 'A PR está marcada como MERGEABLE pelo GitHub.',
    evidence,
  };
}

/* ------------------------------------------------------------------------- */
/* Gate 7 — testes locais                                                     */
/* ------------------------------------------------------------------------- */

function gateLocalTestsPassed(input: GateEvaluationInput): GateOutcome {
  const { finalTests, project } = input;
  if (finalTests === null) {
    return {
      status: 'FAILED',
      reason:
        'A suíte de testes local final não foi executada; sem resultado não é possível aprovar.',
      evidence: { requireLocalTests: project.merge.requireLocalTests, finalTests: null },
    };
  }

  const evidence: Record<string, unknown> = {
    status: finalTests.status,
    passed: finalTests.passed,
    commandCount: finalTests.commands.length,
    failedCommands: finalTests.failedCommands,
    requireLocalTests: project.merge.requireLocalTests,
  };

  if (finalTests.status !== 'PASSED' || finalTests.passed !== true) {
    return {
      status: 'FAILED',
      reason:
        finalTests.failedCommands.length > 0
          ? `Os testes locais terminaram com status ${finalTests.status}. Comandos com falha: ${finalTests.failedCommands.join(', ')}.`
          : `Os testes locais terminaram com status ${finalTests.status}.`,
      evidence,
    };
  }

  if (finalTests.commands.length === 0) {
    return {
      status: 'FAILED',
      reason:
        'A suíte de testes local não executou nenhum comando; não há evidência de que o código foi testado.',
      evidence,
    };
  }

  return {
    status: 'PASSED',
    reason: `Os ${finalTests.commands.length} comando(s) de teste local passaram.`,
    evidence,
  };
}

/* ------------------------------------------------------------------------- */
/* Gates 8, 9 e 10 — checks obrigatórios                                      */
/* ------------------------------------------------------------------------- */

/**
 * Verifica se o resumo de checks é utilizável para o head SHA atual.
 * Devolve a reprovação pronta quando os dados estão ausentes ou defasados.
 */
function checksUnusableReason(input: GateEvaluationInput): GateOutcome | null {
  const { checks, currentHeadSha, project } = input;
  if (checks === null) {
    return {
      status: 'FAILED',
      reason: 'O resumo de checks do GitHub não está disponível; estado desconhecido reprova.',
      evidence: { checks: null, requireCiSuccess: project.merge.requireCiSuccess },
    };
  }
  if (checks.headSha.trim().length === 0) {
    return {
      status: 'FAILED',
      reason: 'O resumo de checks não informa a qual commit se refere; estado desconhecido reprova.',
      evidence: { checksHeadSha: checks.headSha, currentHeadSha },
    };
  }
  if (checks.headSha !== currentHeadSha) {
    return {
      status: 'FAILED',
      reason: `Os checks conhecidos referem-se ao commit ${shortSha(checks.headSha)}, mas o head atual é ${shortSha(currentHeadSha)}.`,
      evidence: { checksHeadSha: checks.headSha, currentHeadSha },
    };
  }
  return null;
}

function checksEvidence(checks: ChecksSummary, project: ProjectConfig): Record<string, unknown> {
  return {
    headSha: checks.headSha,
    total: checks.total,
    passed: checks.passed,
    failed: checks.failed,
    pending: checks.pending,
    skipped: checks.skipped,
    allRequiredPassed: checks.allRequiredPassed,
    anyRequiredPending: checks.anyRequiredPending,
    anyRequiredFailed: checks.anyRequiredFailed,
    anyRequiredSkipped: checks.anyRequiredSkipped,
    requireCiSuccess: project.merge.requireCiSuccess,
  };
}

function gateRequiredChecksPassed(input: GateEvaluationInput): GateOutcome {
  const unusable = checksUnusableReason(input);
  if (unusable !== null) return unusable;

  const checks = input.checks;
  if (checks === null) {
    return {
      status: 'FAILED',
      reason: 'O resumo de checks do GitHub não está disponível.',
      evidence: { checks: null },
    };
  }

  const evidence = checksEvidence(checks, input.project);

  if (checks.anyRequiredFailed) {
    return {
      status: 'FAILED',
      reason: `Há check(s) obrigatório(s) com falha: ${describeChecks(checks, 'failed')}.`,
      evidence,
    };
  }

  if (!checks.allRequiredPassed) {
    return {
      status: 'FAILED',
      reason: 'Nem todos os checks obrigatórios foram concluídos com sucesso.',
      evidence,
    };
  }

  return {
    status: 'PASSED',
    reason: `Todos os checks obrigatórios passaram (${checks.passed} de ${checks.total} concluídos com sucesso).`,
    evidence,
  };
}

function gateNoPendingRequiredChecks(input: GateEvaluationInput): GateOutcome {
  const unusable = checksUnusableReason(input);
  if (unusable !== null) return unusable;

  const checks = input.checks;
  if (checks === null) {
    return {
      status: 'FAILED',
      reason: 'O resumo de checks do GitHub não está disponível.',
      evidence: { checks: null },
    };
  }

  const evidence = checksEvidence(checks, input.project);

  if (checks.anyRequiredPending) {
    return {
      status: 'FAILED',
      reason: `Há check(s) obrigatório(s) ainda em execução: ${describeChecks(checks, 'pending')}.`,
      evidence,
    };
  }

  return {
    status: 'PASSED',
    reason: 'Nenhum check obrigatório está pendente.',
    evidence,
  };
}

function gateNoSkippedRequiredChecks(input: GateEvaluationInput): GateOutcome {
  const unusable = checksUnusableReason(input);
  if (unusable !== null) return unusable;

  const checks = input.checks;
  if (checks === null) {
    return {
      status: 'FAILED',
      reason: 'O resumo de checks do GitHub não está disponível.',
      evidence: { checks: null },
    };
  }

  const evidence = checksEvidence(checks, input.project);

  if (checks.anyRequiredSkipped) {
    return {
      status: 'FAILED',
      reason: `Há check(s) obrigatório(s) ignorado(s): ${describeChecks(checks, 'skipped')}.`,
      evidence,
    };
  }

  return {
    status: 'PASSED',
    reason: 'Nenhum check obrigatório foi ignorado.',
    evidence,
  };
}

/* ------------------------------------------------------------------------- */
/* Gate 11 — conversas não resolvidas                                         */
/* ------------------------------------------------------------------------- */

function gateNoUnresolvedThreads(input: GateEvaluationInput): GateOutcome {
  const { pr, project } = input;
  if (pr === null) {
    return {
      status: 'FAILED',
      reason: 'Sem pull request não é possível afirmar que não há conversas pendentes.',
      evidence: { requireNoUnresolvedThreads: project.merge.requireNoUnresolvedThreads },
    };
  }

  const count = pr.unresolvedThreadCount;
  const evidence: Record<string, unknown> = {
    prNumber: pr.number,
    unresolvedThreadCount: count,
    requireNoUnresolvedThreads: project.merge.requireNoUnresolvedThreads,
  };

  if (count === UNRESOLVED_UNKNOWN || count < 0 || !Number.isFinite(count)) {
    return {
      status: 'FAILED',
      reason:
        'Não foi possível contar as conversas de revisão não resolvidas (valor desconhecido). Estado desconhecido reprova.',
      evidence,
    };
  }

  if (count > 0) {
    return {
      status: 'FAILED',
      reason: `Existem ${count} conversa(s) de revisão não resolvida(s) na PR.`,
      evidence,
    };
  }

  return {
    status: 'PASSED',
    reason: 'Todas as conversas de revisão da PR estão resolvidas.',
    evidence,
  };
}

/* ------------------------------------------------------------------------- */
/* Gate 12 — revisão humana                                                   */
/* ------------------------------------------------------------------------- */

function gateNoHumanChangesRequested(input: GateEvaluationInput): GateOutcome {
  const { pr } = input;
  if (pr === null) {
    return {
      status: 'FAILED',
      reason: 'Sem pull request não é possível afirmar que nenhum humano solicitou mudanças.',
      evidence: { pullRequest: null },
    };
  }

  const evidence: Record<string, unknown> = {
    prNumber: pr.number,
    reviewDecision: pr.reviewDecision,
  };

  if (pr.reviewDecision === 'CHANGES_REQUESTED') {
    return {
      status: 'FAILED',
      reason: 'Uma revisão humana solicitou mudanças na PR.',
      evidence,
    };
  }

  if (pr.reviewDecision === 'REVIEW_REQUIRED') {
    return {
      status: 'PASSED',
      reason:
        'Nenhuma revisão humana solicitou mudanças. Atenção: o repositório ainda exige uma aprovação humana (REVIEW_REQUIRED).',
      evidence,
    };
  }

  return {
    status: 'PASSED',
    reason: 'Nenhuma revisão humana solicitou mudanças.',
    evidence,
  };
}

/* ------------------------------------------------------------------------- */
/* Gates 13 e 14 — auditorias de merge                                        */
/* ------------------------------------------------------------------------- */

function gateAuditorApproved(
  record: MergeReviewRecord | null,
  required: boolean,
  label: string,
  currentHeadSha: string,
): GateOutcome {
  if (!required) {
    return {
      status: 'SKIPPED',
      reason: `O projeto não exige a aprovação do auditor ${label} para o merge.`,
      evidence: { required: false, auditor: label },
    };
  }

  if (record === null) {
    return {
      status: 'FAILED',
      reason: `A auditoria de merge do ${label} não está disponível.`,
      evidence: { required: true, auditor: label, available: false },
    };
  }

  const evidence: Record<string, unknown> = {
    required: true,
    auditor: label,
    verdict: record.review.verdict,
    confidence: record.review.confidence,
    reviewedHeadSha: record.review.reviewedHeadSha,
    observedHeadSha: record.observedHeadSha,
    invalidated: record.invalidated,
    producedAt: record.producedAt,
  };

  if (record.invalidated) {
    return {
      status: 'FAILED',
      reason: `A auditoria do ${label} foi invalidada: ${record.invalidationReason ?? 'motivo não informado'}.`,
      evidence,
    };
  }

  if (record.review.verdict !== 'APPROVED_FOR_MERGE') {
    return {
      status: 'FAILED',
      reason: `O auditor ${label} devolveu o veredito ${record.review.verdict}, e não APPROVED_FOR_MERGE.`,
      evidence,
    };
  }

  if (currentHeadSha.trim().length === 0 || record.review.reviewedHeadSha !== currentHeadSha) {
    return {
      status: 'FAILED',
      reason: `O auditor ${label} aprovou o commit ${shortSha(record.review.reviewedHeadSha)}, diferente do head atual ${shortSha(currentHeadSha)}.`,
      evidence: { ...evidence, currentHeadSha },
    };
  }

  return {
    status: 'PASSED',
    reason: `O auditor ${label} aprovou o merge do commit ${shortSha(currentHeadSha)} com confiança ${formatConfidence(record.review.confidence)}.`,
    evidence,
  };
}

/* ------------------------------------------------------------------------- */
/* Gate 15 — mesmo head SHA                                                   */
/* ------------------------------------------------------------------------- */

function gateAuditorsSameHeadSha(input: GateEvaluationInput): GateOutcome {
  const { claudeReview, codexReview, currentHeadSha } = input;

  const evidence: Record<string, unknown> = {
    currentHeadSha,
    claudeReviewedHeadSha: claudeReview?.review.reviewedHeadSha ?? null,
    codexReviewedHeadSha: codexReview?.review.reviewedHeadSha ?? null,
  };

  if (currentHeadSha.trim().length === 0) {
    return {
      status: 'FAILED',
      reason: 'O head SHA atual é desconhecido; não é possível comparar as auditorias.',
      evidence,
    };
  }

  if (claudeReview === null || codexReview === null) {
    const missing: string[] = [];
    if (claudeReview === null) missing.push('Claude');
    if (codexReview === null) missing.push('Codex');
    return {
      status: 'FAILED',
      reason: `Auditoria ausente (${missing.join(' e ')}); não é possível confirmar que ambos revisaram o mesmo commit.`,
      evidence,
    };
  }

  const claudeSha = claudeReview.review.reviewedHeadSha;
  const codexSha = codexReview.review.reviewedHeadSha;

  if (claudeSha !== codexSha) {
    return {
      status: 'FAILED',
      reason: `Os auditores revisaram commits diferentes: Claude em ${shortSha(claudeSha)} e Codex em ${shortSha(codexSha)}.`,
      evidence,
    };
  }

  if (claudeSha !== currentHeadSha) {
    return {
      status: 'FAILED',
      reason: `Ambos revisaram ${shortSha(claudeSha)}, mas o head atual da PR é ${shortSha(currentHeadSha)}.`,
      evidence,
    };
  }

  return {
    status: 'PASSED',
    reason: `Claude e Codex revisaram o mesmo commit ${shortSha(currentHeadSha)}.`,
    evidence,
  };
}

/* ------------------------------------------------------------------------- */
/* Gate 16 — confiança mínima                                                 */
/* ------------------------------------------------------------------------- */

function gateMinimumConfidenceMet(input: GateEvaluationInput): GateOutcome {
  const minimum = input.project.merge.minimumConfidence;
  const claudeReview = input.claudeReview;
  const codexReview = input.codexReview;
  const evidence: Record<string, unknown> = {
    minimumConfidence: minimum,
    claudeConfidence: claudeReview?.review.confidence ?? null,
    codexConfidence: codexReview?.review.confidence ?? null,
  };

  if (!Number.isFinite(minimum)) {
    return {
      status: 'FAILED',
      reason: 'A confiança mínima configurada no projeto é inválida.',
      evidence,
    };
  }

  if (claudeReview === null || codexReview === null) {
    return {
      status: 'FAILED',
      reason:
        'Falta pelo menos uma auditoria; não é possível confirmar que a confiança mínima foi atingida.',
      evidence,
    };
  }

  const below: string[] = [];
  for (const entry of [
    { label: 'Claude', value: claudeReview.review.confidence },
    { label: 'Codex', value: codexReview.review.confidence },
  ]) {
    if (!Number.isFinite(entry.value)) {
      below.push(`${entry.label} (confiança inválida)`);
      continue;
    }
    if (entry.value < minimum) {
      below.push(`${entry.label} (${formatConfidence(entry.value)})`);
    }
  }

  if (below.length > 0) {
    return {
      status: 'FAILED',
      reason: `Confiança abaixo do mínimo de ${formatConfidence(minimum)}: ${below.join(', ')}.`,
      evidence,
    };
  }

  return {
    status: 'PASSED',
    reason: `Ambos os auditores atingiram a confiança mínima de ${formatConfidence(minimum)}.`,
    evidence,
  };
}

/* ------------------------------------------------------------------------- */
/* Gate 17 — problemas bloqueadores                                           */
/* ------------------------------------------------------------------------- */

function gateNoBlockingIssues(input: GateEvaluationInput): GateOutcome {
  const { claudeReview, codexReview } = input;

  const evidence: Record<string, unknown> = {
    claudeBlockingIssues: countBlockingIssues(claudeReview),
    codexBlockingIssues: countBlockingIssues(codexReview),
  };

  if (claudeReview === null || codexReview === null) {
    return {
      status: 'FAILED',
      reason:
        'Falta pelo menos uma auditoria; não é possível afirmar que nenhum problema bloqueador foi registrado.',
      evidence,
    };
  }

  const offenders: string[] = [];
  for (const entry of [
    { label: 'Claude', record: claudeReview },
    { label: 'Codex', record: codexReview },
  ]) {
    const count = countBlockingIssues(entry.record);
    if (count > 0) offenders.push(`${entry.label} (${count})`);
  }

  if (offenders.length > 0) {
    return {
      status: 'FAILED',
      reason: `Problemas bloqueadores registrados por: ${offenders.join(', ')}.`,
      evidence: {
        ...evidence,
        titles: [
          ...blockingTitles(claudeReview, 'Claude'),
          ...blockingTitles(codexReview, 'Codex'),
        ],
      },
    };
  }

  return {
    status: 'PASSED',
    reason: 'Nenhum auditor registrou problema bloqueador.',
    evidence,
  };
}

function countBlockingIssues(record: MergeReviewRecord | null): number {
  if (record === null) return 0;
  const blocking = record.review.blockingIssues.length;
  const misfiled = record.review.nonBlockingIssues.filter(
    (issue) => issue.severity === 'blocking',
  ).length;
  return blocking + misfiled;
}

function blockingTitles(record: MergeReviewRecord | null, label: string): string[] {
  if (record === null) return [];
  const issues = [
    ...record.review.blockingIssues,
    ...record.review.nonBlockingIssues.filter((issue) => issue.severity === 'blocking'),
  ];
  return issues.slice(0, 10).map((issue) => `${label}: ${issue.title}`);
}

/* ------------------------------------------------------------------------- */
/* Gate 18 — head SHA inalterado                                              */
/* ------------------------------------------------------------------------- */

function gateHeadShaUnchanged(input: GateEvaluationInput): GateOutcome {
  const { pr, currentHeadSha, run, claudeReview, codexReview } = input;

  const evidence: Record<string, unknown> = {
    currentHeadSha,
    prHeadSha: pr?.headSha ?? null,
    invalidateApprovalOnHeadChange: input.project.merge.invalidateApprovalOnHeadChange,
  };

  if (currentHeadSha.trim().length === 0) {
    return {
      status: 'FAILED',
      reason: 'O head SHA atual é desconhecido.',
      evidence,
    };
  }

  if (pr === null) {
    return {
      status: 'FAILED',
      reason: 'Sem pull request não é possível confirmar que o head SHA permanece o mesmo.',
      evidence,
    };
  }

  if (pr.headSha !== currentHeadSha) {
    return {
      status: 'FAILED',
      reason: `O head da PR é ${shortSha(pr.headSha)}, diferente do SHA validado ${shortSha(currentHeadSha)}.`,
      evidence,
    };
  }

  const records: MergeReviewRecord[] = [...run.mergeReviews];
  for (const extra of [claudeReview, codexReview]) {
    if (extra !== null && !records.includes(extra)) records.push(extra);
  }

  const invalidated = records.filter((record) => record.invalidated);
  if (invalidated.length > 0) {
    return {
      status: 'FAILED',
      reason: `Auditoria(s) invalidada(s): ${invalidated
        .map((record) => `${record.auditor} (${record.invalidationReason ?? 'motivo não informado'})`)
        .join('; ')}.`,
      evidence: { ...evidence, invalidatedAuditors: invalidated.map((r) => r.auditor) },
    };
  }

  const stale = records.filter(
    (record) =>
      record.review.reviewedHeadSha !== currentHeadSha ||
      record.observedHeadSha !== currentHeadSha,
  );
  if (stale.length > 0) {
    return {
      status: 'FAILED',
      reason: `Auditoria(s) referentes a outro commit: ${stale
        .map((record) => `${record.auditor} (${shortSha(record.review.reviewedHeadSha)})`)
        .join('; ')}.`,
      evidence: { ...evidence, staleAuditors: stale.map((r) => r.auditor) },
    };
  }

  return {
    status: 'PASSED',
    reason: `O head SHA permanece ${shortSha(currentHeadSha)} desde a auditoria.`,
    evidence,
  };
}

/* ------------------------------------------------------------------------- */
/* Gate 19 — base não invalidada                                              */
/* ------------------------------------------------------------------------- */

function gateBaseNotInvalidated(input: GateEvaluationInput): GateOutcome {
  const { pr, currentBaseSha, project } = input;

  const evidence: Record<string, unknown> = {
    currentBaseSha,
    prBaseSha: pr?.baseSha ?? null,
    prBaseRefName: pr?.baseRefName ?? null,
    expectedBase: project.baseBranch,
    mergeStateStatus: pr?.mergeStateStatus ?? null,
  };

  if (pr === null) {
    return {
      status: 'FAILED',
      reason: 'Sem pull request não é possível avaliar mudanças na branch base.',
      evidence,
    };
  }

  if (currentBaseSha === null || currentBaseSha.trim().length === 0) {
    return {
      status: 'FAILED',
      reason: 'O SHA atual da branch base é desconhecido; estado desconhecido reprova.',
      evidence,
    };
  }

  if (pr.baseRefName !== project.baseBranch) {
    return {
      status: 'FAILED',
      reason: `A branch base da PR mudou para "${pr.baseRefName}", diferente de "${project.baseBranch}".`,
      evidence,
    };
  }

  if (pr.baseSha !== null && pr.baseSha !== currentBaseSha) {
    return {
      status: 'FAILED',
      reason: `A base avançou durante a validação: PR em ${shortSha(pr.baseSha)}, base atual em ${shortSha(currentBaseSha)}.`,
      evidence,
    };
  }

  const state = (pr.mergeStateStatus ?? '').toUpperCase();
  if (state === BEHIND_MERGE_STATE) {
    return {
      status: 'FAILED',
      reason:
        'O GitHub informa que a branch está atrás da base (BEHIND); a auditoria não vale para o novo estado da base.',
      evidence,
    };
  }

  return {
    status: 'PASSED',
    reason: `A base "${pr.baseRefName}" continua em ${shortSha(currentBaseSha)}, sem mudança invalidante.`,
    evidence,
  };
}

/* ------------------------------------------------------------------------- */
/* Gate 20 — política do projeto                                              */
/* ------------------------------------------------------------------------- */

function gateProjectAllowsDualAiConsensus(input: GateEvaluationInput): GateOutcome {
  const merge = input.project.merge;
  const evidence: Record<string, unknown> = {
    enabled: merge.enabled,
    mode: merge.mode,
    strategy: merge.strategy,
    deleteBranchAfterMerge: merge.deleteBranchAfterMerge,
  };

  if (merge.enabled !== true) {
    return {
      status: 'FAILED',
      reason: 'O merge automático está desabilitado na configuração do projeto.',
      evidence,
    };
  }

  if (merge.mode !== 'dual_ai_consensus') {
    return {
      status: 'FAILED',
      reason: `O modo de merge do projeto é "${merge.mode}"; o merge automático exige "dual_ai_consensus".`,
      evidence,
    };
  }

  return {
    status: 'PASSED',
    reason: 'O projeto autoriza o merge por consenso das duas IAs (dual_ai_consensus).',
    evidence,
  };
}

/* ------------------------------------------------------------------------- */
/* Relatório legível                                                          */
/* ------------------------------------------------------------------------- */

/** Texto do relatório de gates: uma linha por gate, em português. */
export function describeGateReport(report: MergeGateReport): string {
  const lines: string[] = [];
  lines.push(
    `Gates de merge avaliados em ${report.evaluatedAt} — head ${shortSha(report.headSha)}, base ${shortSha(report.baseSha)}`,
  );

  for (const gate of report.gates) {
    const index = String(gate.index).padStart(2, '0');
    lines.push(`${index}. [${statusLabel(gate.status)}] ${gate.title}: ${gate.reason}`);
  }

  if (report.allPassed) {
    lines.push('Resultado: todos os gates foram satisfeitos. Merge autorizado pelos gates.');
  } else if (report.failedGates.length > 0) {
    lines.push(`Resultado: MERGE BLOQUEADO. Gates reprovados: ${report.failedGates.join(', ')}.`);
  } else {
    lines.push('Resultado: MERGE BLOQUEADO. Nem todos os gates puderam ser avaliados.');
  }

  return lines.join('\n');
}

function statusLabel(status: GateStatus): string {
  switch (status) {
    case 'PASSED':
      return 'APROVADO';
    case 'FAILED':
      return 'REPROVADO';
    case 'SKIPPED':
      return 'DISPENSADO';
    case 'NOT_EVALUATED':
      return 'NAO AVALIADO';
    default:
      return 'DESCONHECIDO';
  }
}

/* ------------------------------------------------------------------------- */
/* Auxiliares                                                                 */
/* ------------------------------------------------------------------------- */

function describePrompts(prompts: readonly PromptProgress[]): string {
  const visible = prompts.slice(0, 8).map((prompt) => `${prompt.promptId} [${prompt.status}]`);
  const rest = prompts.length - visible.length;
  return rest > 0 ? `${visible.join(', ')} e mais ${rest}` : visible.join(', ');
}

function describeChecks(checks: ChecksSummary, kind: 'failed' | 'pending' | 'skipped'): string {
  const names = checks.runs
    .filter((run) => run.required && matchesCheckKind(run.status, run.conclusion, kind))
    .map((run) => run.name);
  if (names.length === 0) return 'nomes indisponíveis';
  const visible = names.slice(0, 8);
  const rest = names.length - visible.length;
  return rest > 0 ? `${visible.join(', ')} e mais ${rest}` : visible.join(', ');
}

function matchesCheckKind(
  status: string,
  conclusion: string,
  kind: 'failed' | 'pending' | 'skipped',
): boolean {
  if (kind === 'pending') {
    return status === 'QUEUED' || status === 'IN_PROGRESS' || status === 'PENDING' || conclusion === 'PENDING';
  }
  if (kind === 'skipped') {
    return conclusion === 'SKIPPED';
  }
  return (
    conclusion === 'FAILURE' ||
    conclusion === 'TIMED_OUT' ||
    conclusion === 'CANCELLED' ||
    conclusion === 'ACTION_REQUIRED' ||
    conclusion === 'STARTUP_FAILURE' ||
    conclusion === 'STALE'
  );
}

function shortSha(sha: string): string {
  const trimmed = sha.trim();
  if (trimmed.length === 0) return '(desconhecido)';
  return trimmed.length > 12 ? trimmed.slice(0, 12) : trimmed;
}

function formatConfidence(value: number): string {
  if (!Number.isFinite(value)) return '(inválida)';
  return value.toFixed(2).replace('.', ',');
}
