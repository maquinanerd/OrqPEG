import type {
  ChecksSummary,
  CiWaitState,
  EffectiveCiPolicy,
  LoopGuardTrigger,
  RunRecord,
} from '../types';
import { ciFailureFingerprint } from './fingerprints';
import type { CiFailureSignal } from './fingerprints';

/**
 * Orçamento do CI.
 *
 * O CI é um laço como qualquer outro e recebe o mesmo tratamento do Loop
 * Guard: toda espera tem teto, toda repetição tem limite, e nenhuma parada é
 * genérica. As três formas de laço infinito que este módulo fecha:
 *
 *  1. Esperar para sempre por um check que nunca conclui.
 *  2. Corrigir indefinidamente uma falha que não converge.
 *  3. Reiniciar o painel e renovar a espera, de novo e de novo.
 *
 * O item 3 é o que exige estado persistido: um relógio em memória zera junto
 * com o processo, e um teto que zera não é teto.
 */

/** Decisão sobre o que fazer diante do estado atual dos checks. */
export type CiDecision =
  | { action: 'PROCEED' }
  | { action: 'WAIT'; waitSeconds: number; reason: string }
  | { action: 'REPAIR'; cycle: number; fingerprint: string; failedChecks: string[] }
  | { action: 'STOP'; trigger: LoopGuardTrigger; reason: string; evidence: Record<string, unknown> };

export interface CiDecisionInput {
  run: RunRecord;
  policy: EffectiveCiPolicy;
  checks: ChecksSummary;
  /** Sinais extraídos dos checks que falharam, para a assinatura. */
  failureSignals: readonly CiFailureSignal[];
  nowMs: number;
}

/** Estado inicial da espera, ancorado no head SHA que está sendo verificado. */
export function startCiWait(headSha: string, policy: EffectiveCiPolicy, at: string): CiWaitState {
  return {
    startedAt: at,
    headSha,
    lastPolledAt: null,
    pollCount: 0,
    nextIntervalSeconds: Math.max(1, policy.pollingInitialSeconds),
  };
}

/**
 * Avança o estado da espera aplicando backoff limitado.
 *
 * O backoff dobra até o teto: um CI que demora dez minutos não merece trinta
 * consultas, e um que responde em vinte segundos não deve esperar um minuto.
 */
export function advanceCiWait(
  state: CiWaitState,
  policy: EffectiveCiPolicy,
  at: string,
): CiWaitState {
  const doubled = state.nextIntervalSeconds * 2;
  const capped = Math.min(doubled, Math.max(1, policy.pollingMaxSeconds));
  return {
    ...state,
    lastPolledAt: at,
    pollCount: state.pollCount + 1,
    nextIntervalSeconds: Math.max(1, capped),
  };
}

/**
 * Reancora a espera quando o head SHA muda.
 *
 * Um novo commit é um novo CI: manter o relógio antigo faria a primeira espera
 * do commit novo já nascer estourada. O contador de reparos NÃO é reancorado —
 * ele conta o laço inteiro, que é justamente o que se quer limitar.
 */
export function rebaseCiWaitOnHead(
  state: CiWaitState | null,
  headSha: string,
  policy: EffectiveCiPolicy,
  at: string,
): CiWaitState {
  if (state && state.headSha === headSha) return state;
  return startCiWait(headSha, policy, at);
}

/** Quanto tempo já se esperou por este head, contando desde a primeira espera. */
export function elapsedWaitMs(state: CiWaitState, nowMs: number): number {
  const started = Date.parse(state.startedAt);
  if (Number.isNaN(started)) return 0;
  return Math.max(0, nowMs - started);
}

export function waitTimedOut(
  state: CiWaitState,
  policy: EffectiveCiPolicy,
  nowMs: number,
): boolean {
  return elapsedWaitMs(state, nowMs) >= Math.max(1, policy.waitTimeoutMinutes) * 60_000;
}

/**
 * Decide o próximo passo diante dos checks.
 *
 * Fail-closed como o resto do produto: ausência de motivo explícito para
 * seguir não autoriza seguir. Um resultado que não se encaixa em nenhum caso
 * conhecido vira parada nomeada, nunca "continua porque não sei o que é".
 */
export function decideCi(input: CiDecisionInput): CiDecision {
  const { run, policy, checks, nowMs } = input;

  /* Nenhum check existe. Ou o workflow não está configurado, ou o push não o
     disparou. Em ambos os casos, esperar não resolve e seguir sem CI seria
     tratar ausência de evidência como aprovação. */
  if (checks.total === 0) {
    const state = run.ciWait;
    /* Antes do timeout, ainda pode ser o GitHub não ter registrado os checks;
       depois dele, é configuração. */
    if (state && waitTimedOut(state, policy, nowMs)) {
      return {
        action: 'STOP',
        trigger: 'CI_CONFIGURATION_ERROR',
        reason:
          'Nenhum check foi reportado para este commit dentro do tempo de espera. Verifique se o workflow existe, se está habilitado e se é disparado por este evento.',
        evidence: { headSha: checks.headSha, waitedMs: elapsedWaitMs(state, nowMs) },
      };
    }
    return {
      action: 'WAIT',
      waitSeconds: state ? state.nextIntervalSeconds : policy.pollingInitialSeconds,
      reason: 'Aguardando o GitHub registrar os checks deste commit.',
    };
  }

  /* Checks obrigatórios que sumiram: a proteção da branch exige um contexto
     que não foi reportado. Aprovar aqui contornaria a própria proteção. */
  if (checks.anyRequiredSkipped && !checks.anyRequiredPending) {
    return {
      action: 'STOP',
      trigger: 'CI_REQUIRED_CHECK_MISSING',
      reason:
        'Um check obrigatório foi pulado ou não reportou resultado. A proteção da branch exige esse contexto e o OrqPEG não segue sem ele.',
      evidence: {
        headSha: checks.headSha,
        skipped: checks.runs.filter((r) => r.required && r.conclusion === 'SKIPPED').map((r) => r.name),
      },
    };
  }

  if (checks.anyRequiredPending) {
    const state = run.ciWait;
    if (state && waitTimedOut(state, policy, nowMs)) {
      return {
        action: 'STOP',
        trigger: 'CI_WAIT_TIMEOUT',
        reason: `O CI não concluiu dentro de ${String(policy.waitTimeoutMinutes)} minutos. A execução parou para não esperar indefinidamente; a branch, a PR e o worktree foram preservados.`,
        evidence: {
          headSha: checks.headSha,
          waitedMs: elapsedWaitMs(state, nowMs),
          pollCount: state.pollCount,
          pending: checks.pending,
          pendingChecks: checks.runs
            .filter((r) => r.required && (r.status === 'QUEUED' || r.status === 'IN_PROGRESS' || r.status === 'PENDING'))
            .map((r) => r.name),
        },
      };
    }
    return {
      action: 'WAIT',
      waitSeconds: state ? state.nextIntervalSeconds : policy.pollingInitialSeconds,
      reason: `${String(checks.pending)} check(s) obrigatório(s) ainda em andamento.`,
    };
  }

  if (checks.allRequiredPassed) return { action: 'PROCEED' };

  /* --- Daqui para baixo: o CI falhou de verdade --------------------------- */

  const fingerprint = ciFailureFingerprint(input.failureSignals);
  const failedChecks = checks.runs
    .filter((r) => r.required && r.conclusion === 'FAILURE')
    .map((r) => r.name);

  /*
   * Falha idêntica à do ciclo anterior.
   *
   * Verificado ANTES do orçamento porque a mensagem importa: "a mesma falha
   * voltou" diz ao operador que a correção não atacou a causa, enquanto
   * "acabou o orçamento" sugere que faltou tentativa.
   */
  if (policy.stopOnRepeatedFailure && fingerprint !== null) {
    const previous = run.ciFailureFingerprints;
    if (previous.length > 0 && previous[previous.length - 1] === fingerprint) {
      return {
        action: 'STOP',
        trigger: 'REPEATED_CI_FAILURE',
        reason:
          'O CI falhou com exatamente a mesma assinatura depois de uma correção. Repetir o ciclo produziria o mesmo resultado: a causa está fora do que o executor consegue alcançar.',
        evidence: { headSha: checks.headSha, fingerprint, failedChecks, cycles: run.ciRepairCycles },
      };
    }
  }

  if (run.ciRepairCycles >= Math.max(0, policy.maxRepairCycles)) {
    return {
      action: 'STOP',
      trigger: 'CI_REPAIR_BUDGET_EXHAUSTED',
      reason: `O orçamento de ${String(policy.maxRepairCycles)} ciclo(s) de reparo de CI foi consumido e os checks continuam reprovados.`,
      evidence: {
        headSha: checks.headSha,
        cycles: run.ciRepairCycles,
        limit: policy.maxRepairCycles,
        failedChecks,
      },
    };
  }

  return {
    action: 'REPAIR',
    cycle: run.ciRepairCycles + 1,
    fingerprint: fingerprint ?? 'sem-assinatura',
    failedChecks,
  };
}

/**
 * Extrai da sumarização dos checks os sinais que compõem a assinatura.
 *
 * Só os checks obrigatórios que falharam entram: um job opcional vermelho não
 * define a falha, e incluí-lo faria a assinatura mudar quando ele mudasse.
 */
export function failureSignalsFrom(checks: ChecksSummary): CiFailureSignal[] {
  return checks.runs
    .filter((run) => run.required && run.conclusion === 'FAILURE')
    .map((run) => ({
      workflow: run.workflowName,
      job: run.name,
      conclusion: run.conclusion,
    }));
}
