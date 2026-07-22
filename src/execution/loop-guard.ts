import type {
  ErrorCode,
  LoopGuardConfig,
  LoopGuardDecision,
  LoopGuardNextAction,
  LoopGuardSeverity,
  LoopGuardTrigger,
  PromptBudget,
  PromptReview,
} from '../types';
import { detectOscillation, trailingRepeatCount } from './fingerprints';

/**
 * Loop Guard — autoridade única sobre "pode haver mais uma tentativa?".
 *
 * Contar tentativas não protege ninguém. Um ciclo pode devolver o mesmo diff,
 * receber a mesma revisão e falhar no mesmo teste três vezes seguidas sem que
 * nada estoure: o contador avança, o orçamento da assinatura vai embora e
 * nenhum progresso acontece. Este módulo existe para que toda repetição tenha
 * teto e toda parada tenha motivo nomeado.
 *
 * Duas regras estruturais:
 *
 *  1. FAIL-CLOSED. Ausência de motivo explícito para parar NÃO é autorização
 *     para continuar. Dado faltando, configuração ausente ou estado ambíguo
 *     resultam em recusa. O padrão é não gastar mais assinatura.
 *
 *  2. AUTORIDADE ÚNICA. A decisão não pode se espalhar em condicionais pelo
 *     orquestrador. Quem quiser chamar uma IA de novo passa por aqui.
 */

/** Gatilhos que nenhum botão de "continuar" dispensa. */
const HARD_STOP_TRIGGERS: ReadonlySet<LoopGuardTrigger> = new Set<LoopGuardTrigger>([
  'AUTH_REQUIRED',
  'USAGE_LIMIT_REACHED',
  'TOOL_MISSING',
  'FORBIDDEN_AREA_CHANGED',
  'PROMPT_CHANGED_DURING_RUN',
  'PROJECT_CONTEXT_CHANGED',
  'INCOMPLETE_REVIEW_EVIDENCE',
  'SCOPE_VIOLATION',
  'DIFF_BUDGET_EXCEEDED',
  'USER_PAUSED',
  'USER_CANCELLED',
  'INVALID_CHANGES_REQUEST',
  'REVIEW_FORMAT_RETRIES_EXHAUSTED',
]);

/** Gatilhos que admitem, no máximo, uma tentativa extra autorizada por pessoa. */
const SOFT_STOP_TRIGGERS: ReadonlySet<LoopGuardTrigger> = new Set<LoopGuardTrigger>([
  'MAX_ATTEMPTS_REACHED',
  'NO_PROGRESS',
  'REPEATED_REVIEW_ISSUES',
  'REPEATED_TEST_FAILURE',
  'OSCILLATION_DETECTED',
  'REVIEW_OSCILLATION_DETECTED',
  'PROMPT_TIME_BUDGET_EXHAUSTED',
  'CLAUDE_CALL_BUDGET_EXHAUSTED',
  'CODEX_CALL_BUDGET_EXHAUSTED',
  'AGENT_CALL_BUDGET_EXHAUSTED',
  'PROCESS_TIMEOUT',
  'REPEATED_CI_FAILURE',
  'CI_WAIT_TIMEOUT',
  'MERGE_CORRECTION_BUDGET_EXHAUSTED',
  'RUN_TIME_BUDGET_EXHAUSTED',
]);

export function severityOf(trigger: LoopGuardTrigger): LoopGuardSeverity {
  if (HARD_STOP_TRIGGERS.has(trigger)) return 'hard_stop';
  if (SOFT_STOP_TRIGGERS.has(trigger)) return 'soft_stop';
  // Gatilho desconhecido é tratado como hard stop: fail-closed também aqui.
  return 'hard_stop';
}

export function isHardStop(trigger: LoopGuardTrigger): boolean {
  return severityOf(trigger) === 'hard_stop';
}

/* ------------------------------------------------------------------------- */
/* Entrada                                                                    */
/* ------------------------------------------------------------------------- */

export interface LoopGuardInput {
  config: LoopGuardConfig;
  budget: PromptBudget;
  maxAttemptsPerPrompt: number;

  /** Tentativa que está prestes a começar (1 = implementação inicial). */
  nextAttempt: number;
  nowMs: number;
  runStartedAtMs: number;

  /* Sinais de interrupção. */
  pauseRequested: boolean;
  cancelRequested: boolean;
  aborted: boolean;

  /* Erro do último agente, quando houve. */
  lastAgentErrorCode: ErrorCode | null;

  /* Integridade do alvo. */
  promptHashNow: string;
  promptHashSnapshot: string;
  contextHashNow: string;
  contextHashSnapshot: string;
  configHashNow: string;
  configHashSnapshot: string;

  /* Evidência da tentativa anterior. `null` quando ainda não houve nenhuma. */
  previousDiffFingerprint: string | null;
  currentDiffFingerprint: string | null;
  reviewFingerprint: string | null;
  testFailureFingerprint: string | null;
  lastReview: PromptReview | null;

  /* Escopo e tamanho. */
  scopeViolations: readonly string[];
  forbiddenViolations: readonly string[];
  changedFileCount: number;
  changedLineCount: number;

  /* Integridade do pacote enviado ao revisor. */
  reviewEvidenceComplete: boolean;

  /** Override humano disponível e ainda não consumido. */
  overrideAvailable: boolean;
}

/* ------------------------------------------------------------------------- */
/* Avaliação                                                                  */
/* ------------------------------------------------------------------------- */

interface Finding {
  trigger: LoopGuardTrigger;
  reason: string;
  evidence: Record<string, unknown>;
}

/**
 * Decide se uma nova chamada de IA pode acontecer.
 *
 * A ordem de avaliação não é arbitrária: primeiro o que independe do código
 * (interrupção, autenticação, cota, ferramenta), depois o que invalida a
 * própria execução (prompt ou contexto alterados), depois violação de escopo,
 * depois orçamento, e por último repetição. Assim o motivo relatado é sempre a
 * causa mais próxima da raiz, e não um sintoma tardio.
 */
export function evaluateLoopGuard(input: LoopGuardInput): LoopGuardDecision {
  const config = input.config;

  // Guarda desativada ainda respeita interrupção humana e os limites duros de
  // tentativa: desligar a detecção fina nunca libera laço infinito.
  const finding =
    firstInterruptFinding(input) ??
    firstAgentErrorFinding(input) ??
    (config.enabled ? firstMutationFinding(input) : null) ??
    (config.enabled ? firstScopeFinding(input) : null) ??
    (config.enabled ? firstEvidenceFinding(input) : null) ??
    firstBudgetFinding(input) ??
    (config.enabled ? firstRepetitionFinding(input) : null);

  if (finding === null) {
    return {
      allowed: true,
      severity: 'none',
      trigger: null,
      reason: 'Nenhum gatilho acionado: há orçamento e progresso para continuar.',
      evidence: budgetSnapshot(input),
      nextActions: [],
    };
  }

  const severity = severityOf(finding.trigger);

  /*
   * Override concedido: libera EXATAMENTE esta tentativa.
   *
   * Vale apenas para parada branda. Uma parada dura permanece bloqueada mesmo
   * com autorização pendente — a causa está fora do laço e insistir não a
   * corrige. O consumo é responsabilidade do orquestrador, feito no instante
   * em que a passagem é concedida.
   */
  if (severity === 'soft_stop' && input.overrideAvailable) {
    return {
      allowed: true,
      severity: 'none',
      trigger: null,
      reason:
        `Tentativa adicional liberada por autorização manual, apesar de ${finding.trigger}. ` +
        'A autorização vale para esta tentativa e será consumida agora.',
      evidence: {
        ...budgetSnapshot(input),
        ...finding.evidence,
        overrideApplied: true,
        suppressedTrigger: finding.trigger,
      },
      nextActions: [],
    };
  }

  const overrideUsable =
    severity === 'soft_stop' &&
    input.budget.manualOverridesUsed < Math.max(0, config.maxManualOverridesPerPrompt);

  return {
    allowed: false,
    severity,
    trigger: finding.trigger,
    reason: finding.reason,
    evidence: { ...budgetSnapshot(input), ...finding.evidence },
    nextActions: nextActionsFor(finding.trigger, overrideUsable),
  };
}

/** A decisão passou por causa de uma autorização manual? */
export function wasOverrideApplied(decision: LoopGuardDecision): boolean {
  return decision.allowed === true && decision.evidence['overrideApplied'] === true;
}

/* --- 1. Interrupção humana --------------------------------------------- */

function firstInterruptFinding(input: LoopGuardInput): Finding | null {
  if (input.cancelRequested) {
    return {
      trigger: 'USER_CANCELLED',
      reason: 'Cancelamento solicitado. Nada será iniciado; o trabalho fica preservado.',
      evidence: { cancelRequested: true },
    };
  }
  if (input.pauseRequested || input.aborted) {
    return {
      trigger: 'USER_PAUSED',
      reason: 'Pausa solicitada. A próxima etapa não será iniciada.',
      evidence: { pauseRequested: input.pauseRequested, aborted: input.aborted },
    };
  }
  return null;
}

/* --- 2. Erro do agente: nunca vira retentativa automática ---------------- */

function firstAgentErrorFinding(input: LoopGuardInput): Finding | null {
  switch (input.lastAgentErrorCode) {
    case 'AUTH_REQUIRED':
      return {
        trigger: 'AUTH_REQUIRED',
        reason:
          'O CLI de IA exigiu autenticação. Repetir a chamada não resolve: é preciso refazer o login.',
        evidence: { lastAgentErrorCode: input.lastAgentErrorCode },
      };
    case 'USAGE_LIMIT_REACHED':
      return {
        trigger: 'USAGE_LIMIT_REACHED',
        reason:
          'O limite da assinatura foi atingido. O OrqPEG não troca para API e não repete em laço; retome quando a cota renovar.',
        evidence: { lastAgentErrorCode: input.lastAgentErrorCode },
      };
    case 'TOOL_MISSING':
      return {
        trigger: 'TOOL_MISSING',
        reason:
          'Uma ferramenta obrigatória não está disponível. Nova verificação só ocorre por ação explícita.',
        evidence: { lastAgentErrorCode: input.lastAgentErrorCode },
      };
    case 'PROCESS_TIMEOUT':
      return {
        trigger: 'PROCESS_TIMEOUT',
        reason:
          'A chamada estourou o tempo limite. Repetir a mesma instrução automaticamente tende a estourar de novo.',
        evidence: { lastAgentErrorCode: input.lastAgentErrorCode },
      };
    default:
      return null;
  }
}

/* --- 3. Alvo alterado durante a execução -------------------------------- */

function firstMutationFinding(input: LoopGuardInput): Finding | null {
  if (
    input.config.stopOnPromptMutation &&
    input.promptHashSnapshot !== '' &&
    input.promptHashNow !== input.promptHashSnapshot
  ) {
    return {
      trigger: 'PROMPT_CHANGED_DURING_RUN',
      reason:
        'O prompt foi editado depois do início da execução. Misturar requisitos novos com tentativas antigas produziria um resultado que não corresponde a nenhum dos dois.',
      evidence: {
        promptHashSnapshot: input.promptHashSnapshot,
        promptHashNow: input.promptHashNow,
      },
    };
  }

  if (input.config.stopOnContextMutation) {
    if (input.contextHashSnapshot !== '' && input.contextHashNow !== input.contextHashSnapshot) {
      return {
        trigger: 'PROJECT_CONTEXT_CHANGED',
        reason:
          'O contexto do projeto mudou durante a execução. As tentativas anteriores foram feitas sob outras regras.',
        evidence: {
          contextHashSnapshot: input.contextHashSnapshot,
          contextHashNow: input.contextHashNow,
        },
      };
    }
    if (input.configHashSnapshot !== '' && input.configHashNow !== input.configHashSnapshot) {
      return {
        trigger: 'PROJECT_CONTEXT_CHANGED',
        reason:
          'A configuração do projeto mudou durante a execução (desconsiderados os campos de data).',
        evidence: {
          configHashSnapshot: input.configHashSnapshot,
          configHashNow: input.configHashNow,
        },
      };
    }
  }
  return null;
}

/* --- 4. Escopo ---------------------------------------------------------- */

function firstScopeFinding(input: LoopGuardInput): Finding | null {
  if (input.forbiddenViolations.length > 0) {
    return {
      trigger: 'FORBIDDEN_AREA_CHANGED',
      reason: `Arquivo em área proibida pelo prompt foi alterado: ${input.forbiddenViolations
        .slice(0, 5)
        .join(', ')}.`,
      evidence: { forbiddenViolations: [...input.forbiddenViolations] },
    };
  }
  if (input.config.stopOnScopeViolation && input.scopeViolations.length > 0) {
    return {
      trigger: 'SCOPE_VIOLATION',
      reason: `Arquivo fora das áreas permitidas foi alterado: ${input.scopeViolations
        .slice(0, 5)
        .join(', ')}. Pedir automaticamente mais alterações ampliaria o desvio.`,
      evidence: { scopeViolations: [...input.scopeViolations] },
    };
  }

  const maxFiles = input.config.maxChangedFilesPerPrompt;
  if (maxFiles !== null && input.changedFileCount > maxFiles) {
    return {
      trigger: 'DIFF_BUDGET_EXCEEDED',
      reason: `A alteração tocou ${String(input.changedFileCount)} arquivos, acima do limite de ${String(maxFiles)}. Um pacote desse tamanho não pode ser auditado com honestidade.`,
      evidence: { changedFileCount: input.changedFileCount, maxChangedFilesPerPrompt: maxFiles },
    };
  }
  const maxLines = input.config.maxChangedLinesPerPrompt;
  if (maxLines !== null && input.changedLineCount > maxLines) {
    return {
      trigger: 'DIFF_BUDGET_EXCEEDED',
      reason: `A alteração tocou ${String(input.changedLineCount)} linhas, acima do limite de ${String(maxLines)}. Divida o prompt em etapas menores.`,
      evidence: { changedLineCount: input.changedLineCount, maxChangedLinesPerPrompt: maxLines },
    };
  }
  return null;
}

/* --- 5. Qualidade da evidência ------------------------------------------ */

function firstEvidenceFinding(input: LoopGuardInput): Finding | null {
  if (!input.reviewEvidenceComplete) {
    return {
      trigger: 'INCOMPLETE_REVIEW_EVIDENCE',
      reason:
        'O pacote de revisão está incompleto. Revisar material truncado produziria um parecer sobre código que ninguém viu.',
      evidence: { reviewEvidenceComplete: false },
    };
  }

  if (input.budget.reviewFormatRetries > Math.max(0, input.config.maxReviewFormatRetries)) {
    return {
      trigger: 'REVIEW_FORMAT_RETRIES_EXHAUSTED',
      reason:
        'O revisor não devolveu JSON válido dentro do limite de tentativas de formato. Erro de formatação não pode consumir tentativas de implementação.',
      evidence: {
        reviewFormatRetries: input.budget.reviewFormatRetries,
        maxReviewFormatRetries: input.config.maxReviewFormatRetries,
      },
    };
  }

  // Pedido de mudança sem ação concreta não é acionável.
  const review = input.lastReview;
  if (review && review.verdict === 'CHANGES_REQUESTED') {
    const hasActions = Array.isArray(review.requiredActions) && review.requiredActions.length > 0;
    const hasBlocking = Array.isArray(review.blockingIssues) && review.blockingIssues.length > 0;
    const hasNonBlocking =
      Array.isArray(review.nonBlockingIssues) && review.nonBlockingIssues.length > 0;
    const hasScope =
      review.scopeAssessment &&
      Array.isArray(review.scopeAssessment.unexpectedChanges) &&
      review.scopeAssessment.unexpectedChanges.length > 0;

    if (!hasActions && !hasBlocking && !hasNonBlocking && !hasScope) {
      return {
        trigger: 'INVALID_CHANGES_REQUEST',
        reason:
          'O revisor pediu mudanças sem indicar ação obrigatória, problema bloqueador ou desvio de escopo. Encaminhar isso ao executor produziria uma correção às cegas.',
        evidence: { verdict: review.verdict },
      };
    }
  }
  return null;
}

/* --- 6. Orçamento ------------------------------------------------------- */

function firstBudgetFinding(input: LoopGuardInput): Finding | null {
  const { budget, config } = input;

  if (input.nextAttempt > Math.max(1, input.maxAttemptsPerPrompt)) {
    return {
      trigger: 'MAX_ATTEMPTS_REACHED',
      reason: `O limite de ${String(input.maxAttemptsPerPrompt)} tentativa(s) por prompt foi atingido.`,
      evidence: { nextAttempt: input.nextAttempt, maxAttempts: input.maxAttemptsPerPrompt },
    };
  }

  if (!config.enabled) return null;

  if (budget.claudeCalls >= Math.max(1, config.maxClaudeCallsPerPrompt)) {
    return {
      trigger: 'CLAUDE_CALL_BUDGET_EXHAUSTED',
      reason: `O orçamento de ${String(config.maxClaudeCallsPerPrompt)} chamada(s) do Claude neste prompt acabou.`,
      evidence: { claudeCalls: budget.claudeCalls, limit: config.maxClaudeCallsPerPrompt },
    };
  }

  if (budget.codexCalls >= Math.max(1, config.maxCodexCallsPerPrompt)) {
    return {
      trigger: 'CODEX_CALL_BUDGET_EXHAUSTED',
      reason: `O orçamento de ${String(config.maxCodexCallsPerPrompt)} chamada(s) do Codex neste prompt acabou.`,
      evidence: { codexCalls: budget.codexCalls, limit: config.maxCodexCallsPerPrompt },
    };
  }

  const total = budget.claudeCalls + budget.codexCalls;
  if (total >= Math.max(1, config.maxTotalAgentCallsPerPrompt)) {
    return {
      trigger: 'AGENT_CALL_BUDGET_EXHAUSTED',
      reason: `O orçamento total de ${String(config.maxTotalAgentCallsPerPrompt)} chamada(s) de IA neste prompt acabou.`,
      evidence: { totalAgentCalls: total, limit: config.maxTotalAgentCallsPerPrompt },
    };
  }

  const promptMs = elapsedPromptMs(input);
  const promptLimitMs = Math.max(1, config.maxPromptDurationMinutes) * 60_000;
  if (promptMs >= promptLimitMs) {
    return {
      trigger: 'PROMPT_TIME_BUDGET_EXHAUSTED',
      reason: `O prompt consumiu ${String(Math.round(promptMs / 60_000))} min, acima do limite de ${String(config.maxPromptDurationMinutes)} min.`,
      evidence: { elapsedPromptMs: promptMs, limitMs: promptLimitMs },
    };
  }

  const runMs = Math.max(0, input.nowMs - input.runStartedAtMs);
  const runLimitMs = Math.max(1, config.maxRunDurationMinutes) * 60_000;
  if (runMs >= runLimitMs) {
    return {
      trigger: 'RUN_TIME_BUDGET_EXHAUSTED',
      reason: `A execução consumiu ${String(Math.round(runMs / 60_000))} min, acima do limite de ${String(config.maxRunDurationMinutes)} min.`,
      evidence: { elapsedRunMs: runMs, limitMs: runLimitMs },
    };
  }

  return null;
}

/* --- 7. Repetição e oscilação ------------------------------------------- */

function firstRepetitionFinding(input: LoopGuardInput): Finding | null {
  const { budget, config } = input;

  // Sem progresso: o executor devolveu exatamente o mesmo diff depois de uma
  // revisão que pediu mudanças. Justificativa textual não conta como progresso.
  if (
    input.previousDiffFingerprint !== null &&
    input.currentDiffFingerprint !== null &&
    input.previousDiffFingerprint === input.currentDiffFingerprint
  ) {
    const limit = Math.max(1, config.maxConsecutiveNoProgress);
    const count = trailingRepeatCount(budget.diffFingerprints);
    if (count >= limit + 1 || limit === 1) {
      return {
        trigger: 'NO_PROGRESS',
        reason:
          'A correção não alterou o código: o diff é idêntico ao da tentativa anterior. Gastar outra revisão sobre o mesmo material não produziria informação nova.',
        evidence: {
          diffFingerprint: input.currentDiffFingerprint,
          consecutiveIdenticalDiffs: count,
          limit,
        },
      };
    }
  }

  if (config.detectDiffOscillation && detectOscillation(budget.diffFingerprints)) {
    return {
      trigger: 'OSCILLATION_DETECTED',
      reason:
        'O código está oscilando entre duas soluções (padrão A → B → A). Executor e revisor não estão convergindo.',
      evidence: { diffFingerprints: [...budget.diffFingerprints] },
    };
  }

  const reviewRepeat = trailingRepeatCount(budget.reviewFingerprints);
  if (reviewRepeat >= Math.max(2, config.maxRepeatedReviewFingerprints)) {
    return {
      trigger: 'REPEATED_REVIEW_ISSUES',
      reason: `O revisor apontou exatamente o mesmo conjunto de problemas ${String(reviewRepeat)} vezes seguidas. As correções não estão resolvendo os bloqueadores.`,
      evidence: {
        repeatCount: reviewRepeat,
        limit: config.maxRepeatedReviewFingerprints,
        reviewFingerprints: [...budget.reviewFingerprints],
      },
    };
  }

  if (config.detectReviewOscillation && detectOscillation(budget.reviewFingerprints)) {
    return {
      trigger: 'REVIEW_OSCILLATION_DETECTED',
      reason:
        'O conjunto de problemas apontados está oscilando (padrão A → B → A): corrigir um grupo reintroduz o outro.',
      evidence: { reviewFingerprints: [...budget.reviewFingerprints] },
    };
  }

  const testRepeat = trailingRepeatCount(budget.testFailureFingerprints);
  if (testRepeat >= Math.max(2, config.maxRepeatedTestFailureFingerprints)) {
    return {
      trigger: 'REPEATED_TEST_FAILURE',
      reason: `A mesma falha de teste ocorreu ${String(testRepeat)} vezes seguidas. Outra tentativa automática tende a repetir o resultado.`,
      evidence: {
        repeatCount: testRepeat,
        limit: config.maxRepeatedTestFailureFingerprints,
        testFailureFingerprints: [...budget.testFailureFingerprints],
      },
    };
  }

  return null;
}

/* ------------------------------------------------------------------------- */
/* Auxiliares                                                                 */
/* ------------------------------------------------------------------------- */

function elapsedPromptMs(input: LoopGuardInput): number {
  const started = input.budget.startedAt ? Date.parse(input.budget.startedAt) : NaN;
  const live = Number.isFinite(started) ? Math.max(0, input.nowMs - started) : 0;
  return input.budget.consumedMs + live;
}

function budgetSnapshot(input: LoopGuardInput): Record<string, unknown> {
  return {
    promptId: input.budget.promptId,
    attempt: input.nextAttempt,
    maxAttempts: input.maxAttemptsPerPrompt,
    claudeCalls: input.budget.claudeCalls,
    maxClaudeCalls: input.config.maxClaudeCallsPerPrompt,
    codexCalls: input.budget.codexCalls,
    maxCodexCalls: input.config.maxCodexCallsPerPrompt,
    totalAgentCalls: input.budget.claudeCalls + input.budget.codexCalls,
    maxTotalAgentCalls: input.config.maxTotalAgentCallsPerPrompt,
    elapsedPromptMs: elapsedPromptMs(input),
    elapsedRunMs: Math.max(0, input.nowMs - input.runStartedAtMs),
    manualOverridesUsed: input.budget.manualOverridesUsed,
  };
}

function nextActionsFor(
  trigger: LoopGuardTrigger,
  overrideUsable: boolean,
): LoopGuardNextAction[] {
  const base: LoopGuardNextAction[] = ['OPEN_REPORT'];

  switch (trigger) {
    case 'AUTH_REQUIRED':
      return [...base, 'FIX_AUTH'];
    case 'USAGE_LIMIT_REACHED':
      return [...base, 'WAIT_QUOTA'];
    case 'TOOL_MISSING':
      return [...base, 'INSTALL_TOOL'];
    case 'PROMPT_CHANGED_DURING_RUN':
      return [...base, 'START_NEW_RUN'];
    case 'PROJECT_CONTEXT_CHANGED':
      return [...base, 'START_NEW_RUN'];
    case 'SCOPE_VIOLATION':
    case 'FORBIDDEN_AREA_CHANGED':
      return [...base, 'OPEN_DIFF', 'EDIT_PROMPT', 'MARK_FOR_MANUAL_REVIEW'];
    case 'DIFF_BUDGET_EXCEEDED':
      return [...base, 'OPEN_DIFF', 'SPLIT_PROMPT'];
    case 'INCOMPLETE_REVIEW_EVIDENCE':
      return [...base, 'SPLIT_PROMPT', 'MARK_FOR_MANUAL_REVIEW'];
    case 'REPEATED_TEST_FAILURE':
      return withOverride([...base, 'OPEN_TESTS', 'EDIT_PROMPT'], overrideUsable);
    case 'REPEATED_REVIEW_ISSUES':
    case 'REVIEW_OSCILLATION_DETECTED':
    case 'INVALID_CHANGES_REQUEST':
      return withOverride([...base, 'OPEN_REVIEW', 'EDIT_PROMPT'], overrideUsable);
    case 'NO_PROGRESS':
    case 'OSCILLATION_DETECTED':
      return withOverride([...base, 'OPEN_DIFF', 'OPEN_REVIEW', 'EDIT_PROMPT'], overrideUsable);
    case 'USER_PAUSED':
    case 'USER_CANCELLED':
      return base;
    default:
      return withOverride([...base, 'EDIT_PROMPT', 'MARK_FOR_MANUAL_REVIEW'], overrideUsable);
  }
}

function withOverride(
  actions: LoopGuardNextAction[],
  overrideUsable: boolean,
): LoopGuardNextAction[] {
  const withSkip: LoopGuardNextAction[] = [...actions, 'SKIP_PROMPT', 'CANCEL_RUN'];
  return overrideUsable ? ['AUTHORIZE_EXTRA_ATTEMPT', ...withSkip] : withSkip;
}

/* ------------------------------------------------------------------------- */
/* Invariante                                                                 */
/* ------------------------------------------------------------------------- */

/**
 * Barreira final antes de gastar assinatura.
 *
 * O orquestrador chama isto imediatamente antes de invocar uma IA. Uma decisão
 * ausente, malformada ou negada impede a chamada. Nunca se prossegue por não
 * ter encontrado motivo para parar — só se prossegue com autorização explícita.
 */
export function assertRunCanContinue(decision: LoopGuardDecision | null | undefined): {
  canContinue: boolean;
  reason: string;
} {
  if (!decision || typeof decision !== 'object') {
    return {
      canContinue: false,
      reason:
        'Decisão do Loop Guard ausente. Por segurança o OrqPEG não continua sem autorização explícita.',
    };
  }
  if (decision.allowed !== true) {
    return {
      canContinue: false,
      reason: decision.reason || 'Loop Guard negou a continuação.',
    };
  }
  if (decision.trigger !== null) {
    return {
      canContinue: false,
      reason: `Decisão inconsistente: marcada como permitida mas com gatilho ${decision.trigger}.`,
    };
  }
  return { canContinue: true, reason: decision.reason };
}

/* ------------------------------------------------------------------------- */
/* Orçamento                                                                  */
/* ------------------------------------------------------------------------- */

export function createPromptBudget(promptId: string): PromptBudget {
  return {
    promptId,
    attempts: 0,
    claudeCalls: 0,
    codexCalls: 0,
    reviewFormatRetries: 0,
    startedAt: null,
    consumedMs: 0,
    manualOverridesUsed: 0,
    diffFingerprints: [],
    reviewFingerprints: [],
    testFailureFingerprints: [],
    lastTrigger: null,
    lastDecisionAt: null,
  };
}

/** Texto curto para log e painel. */
export function describeDecision(decision: LoopGuardDecision): string {
  if (decision.allowed) return 'Loop Guard: continuação autorizada.';
  return `Loop Guard: ${decision.trigger ?? 'DESCONHECIDO'} (${decision.severity}) — ${decision.reason}`;
}
