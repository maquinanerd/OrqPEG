import type {
  EffectiveLoopGuardPolicy,
  LoopGuardTrigger,
  ManualOverride,
  PromptBudget,
  Result,
  RunRecord,
} from '../types';
import { fail, ok } from '../utils/errors';
import { nowIso } from '../utils/time';
import { isHardStop } from './loop-guard';

/**
 * Override manual — autorização humana, pontual e não reutilizável, de uma
 * única tentativa adicional.
 *
 * Três princípios, todos aplicados AQUI e não na interface:
 *
 *  1. A interface esconde o botão; o backend recusa a requisição. Um POST
 *     forjado para um gatilho não-autorizável falha do mesmo jeito.
 *  2. Só parada branda admite override. Parada dura significa que a causa está
 *     fora do laço — insistir não corrige nada e pode piorar.
 *  3. O override vale para UMA tentativa e é consumido ao ser usado. Ele não
 *     altera os limites configurados e não pode ser reaproveitado.
 */

/**
 * Gatilhos que NUNCA admitem override, independentemente de configuração.
 *
 * Não é uma questão de política do projeto: em todos estes casos, autorizar
 * outra tentativa produziria dano ou desperdício garantido. Escopo violado e
 * área proibida significam que o executor saiu do combinado — repetir amplia o
 * desvio. Prompt ou contexto alterados invalidam a própria execução. Falta de
 * autenticação, cota esgotada e ferramenta ausente não se resolvem tentando de
 * novo. Evidência incompleta faria o revisor julgar o que não viu.
 */
export const NEVER_OVERRIDABLE: ReadonlySet<LoopGuardTrigger> = new Set<LoopGuardTrigger>([
  'FORBIDDEN_AREA_CHANGED',
  'SCOPE_VIOLATION',
  'PROMPT_CHANGED_DURING_RUN',
  /* Mesma razão do prompt alterado: as tentativas anteriores rodaram sob outro
     conjunto de regras, e autorizar mais uma não desfaz isso. */
  'SKILL_CHANGED_DURING_RUN',
  'PROJECT_CONTEXT_CHANGED',
  'AUTH_REQUIRED',
  'USAGE_LIMIT_REACHED',
  'TOOL_MISSING',
  'INCOMPLETE_REVIEW_EVIDENCE',
  'USER_CANCELLED',
  'USER_PAUSED',
]);

/** Comprimento mínimo da justificativa: uma palavra solta não é justificativa. */
export const MIN_JUSTIFICATION_LENGTH = 20;
export const MAX_JUSTIFICATION_LENGTH = 2000;

export function isOverridable(trigger: LoopGuardTrigger): boolean {
  if (NEVER_OVERRIDABLE.has(trigger)) return false;
  // Qualquer parada dura também está fora, mesmo que não esteja na lista acima.
  return !isHardStop(trigger);
}

export interface GrantOverrideInput {
  run: RunRecord;
  promptId: string;
  justification: string;
  authorizedBy: string;
  /** Política CONGELADA da execução. Nunca o cadastro atual do projeto. */
  policy: EffectiveLoopGuardPolicy;
}

export interface GrantOverrideOutput {
  run: RunRecord;
  override: ManualOverride;
}

/**
 * Concede um override, se e somente se todas as condições forem satisfeitas.
 * Devolve o `RunRecord` atualizado; a persistência é responsabilidade do
 * chamador, que já controla a gravação atômica.
 */
export function grantManualOverride(input: GrantOverrideInput): Result<GrantOverrideOutput> {
  const { run, promptId, policy } = input;

  const decision = run.lastLoopGuard;
  if (!decision || decision.trigger === null) {
    return fail(
      'VALIDATION_FAILED',
      'Não há parada registrada nesta execução: não existe nada para autorizar.',
    );
  }

  if (run.state !== 'LOOP_GUARD_TRIGGERED') {
    return fail(
      'VALIDATION_FAILED',
      `A execução está em ${run.state}. Só é possível autorizar uma tentativa adicional quando ela parou pela proteção contra looping.`,
      { state: run.state },
    );
  }

  const trigger = decision.trigger;
  if (!isOverridable(trigger)) {
    return fail(
      'VALIDATION_FAILED',
      `O gatilho ${trigger} não admite tentativa adicional. A causa precisa ser corrigida fora do laço antes de uma nova execução.`,
      { trigger, severity: decision.severity },
    );
  }

  const justification = (input.justification ?? '').trim();
  if (justification.length < MIN_JUSTIFICATION_LENGTH) {
    return fail(
      'VALIDATION_FAILED',
      `A justificativa precisa ter ao menos ${String(MIN_JUSTIFICATION_LENGTH)} caracteres e explicar por que outra tentativa deve resolver o que as anteriores não resolveram.`,
      { length: justification.length },
    );
  }
  if (justification.length > MAX_JUSTIFICATION_LENGTH) {
    return fail(
      'VALIDATION_FAILED',
      `A justificativa excede ${String(MAX_JUSTIFICATION_LENGTH)} caracteres.`,
      { length: justification.length },
    );
  }

  const budget = run.budgets.find((entry) => entry.promptId === promptId);
  if (!budget) {
    return fail('VALIDATION_FAILED', `Prompt "${promptId}" não pertence a esta execução.`, {
      promptId,
    });
  }

  const limit = Math.max(0, policy.maxManualOverridesPerPrompt);
  if (limit === 0) {
    return fail(
      'VALIDATION_FAILED',
      'Este projeto não permite override manual (maxManualOverridesPerPrompt é zero).',
    );
  }

  /* A pendência é verificada ANTES do limite: dizer "o limite já foi usado"
     seria impreciso quando a autorização existe mas ainda não foi exercida. */
  if (hasPendingOverride(run, promptId)) {
    return fail(
      'VALIDATION_FAILED',
      'Já existe uma autorização pendente para este prompt, ainda não consumida. Retome a execução para exercê-la.',
    );
  }

  const usedForPrompt = run.overrides.filter((entry) => entry.promptId === promptId).length;
  if (usedForPrompt >= limit) {
    return fail(
      'VALIDATION_FAILED',
      `O limite de ${String(limit)} override(s) manual(is) para o prompt "${promptId}" já foi usado. Um segundo override não é permitido.`,
      { usedForPrompt, limit },
    );
  }

  const override: ManualOverride = {
    promptId,
    trigger,
    authorizedAt: nowIso(),
    authorizedBy: (input.authorizedBy ?? '').trim() || 'operador local',
    justification,
    consumed: false,
  };

  return ok({
    run: { ...run, overrides: [...run.overrides, override] },
    override,
  });
}

/** Existe autorização concedida e ainda não usada para este prompt? */
export function hasPendingOverride(run: RunRecord, promptId: string): boolean {
  return run.overrides.some(
    (entry) => entry.promptId === promptId && entry.consumed === false,
  );
}

/** Quantas tentativas extras foram concedidas e ainda não consumidas. */
export function pendingOverrideCount(run: RunRecord, promptId: string): number {
  return run.overrides.filter(
    (entry) => entry.promptId === promptId && entry.consumed === false,
  ).length;
}

/**
 * Marca a autorização como usada.
 *
 * Chamado no exato momento em que a tentativa extra é liberada, e não quando
 * ela termina: se o processo cair no meio, o override não volta a valer.
 */
export function consumeOverride(run: RunRecord, promptId: string): RunRecord {
  let consumed = false;
  const overrides = run.overrides.map((entry) => {
    if (consumed || entry.promptId !== promptId || entry.consumed) return entry;
    consumed = true;
    return { ...entry, consumed: true };
  });
  if (!consumed) return run;

  const budgets = run.budgets.map((budget) =>
    budget.promptId === promptId
      ? { ...budget, manualOverridesUsed: budget.manualOverridesUsed + 1 }
      : budget,
  );

  return { ...run, overrides, budgets };
}

/** Descrição da situação de override, para painel e relatório. */
export function describeOverrides(
  run: RunRecord,
  promptId: string,
  budget: PromptBudget | undefined,
  policy: EffectiveLoopGuardPolicy,
): {
  limit: number;
  used: number;
  pending: number;
  overridable: boolean;
  reason: string;
} {
  const trigger = run.lastLoopGuard?.trigger ?? null;
  const limit = Math.max(0, policy.maxManualOverridesPerPrompt);
  const used = budget ? budget.manualOverridesUsed : 0;
  const pending = pendingOverrideCount(run, promptId);

  if (trigger === null) {
    return { limit, used, pending, overridable: false, reason: 'Não há parada registrada.' };
  }
  if (!isOverridable(trigger)) {
    return {
      limit,
      used,
      pending,
      overridable: false,
      reason: `O gatilho ${trigger} é uma parada dura e não admite tentativa adicional.`,
    };
  }
  if (limit === 0) {
    return {
      limit,
      used,
      pending,
      overridable: false,
      reason: 'O projeto não permite override manual.',
    };
  }
  if (run.overrides.filter((entry) => entry.promptId === promptId).length >= limit) {
    return {
      limit,
      used,
      pending,
      overridable: false,
      reason: 'O limite de overrides deste prompt já foi usado.',
    };
  }
  if (pending > 0) {
    return {
      limit,
      used,
      pending,
      overridable: false,
      reason: 'Já existe uma autorização pendente, ainda não consumida.',
    };
  }
  return {
    limit,
    used,
    pending,
    overridable: true,
    reason: 'Uma tentativa adicional pode ser autorizada com justificativa.',
  };
}
