import { nowIso } from '../utils/time';

/**
 * Registro em memória das execuções vivas.
 *
 * Antes deste módulo, pausar e cancelar gravavam uma marca no JSON de estado
 * que a execução em curso nunca relia: o processo filho (Claude, Codex, `npm
 * test`, `git`, `gh`) continuava até o fim, e o `abortRun` do painel não tinha
 * chamador. Botão apertado, nada acontecendo.
 *
 * Aqui mora a outra metade do mecanismo: enquanto uma execução roda, ela
 * publica um CONTROLADOR — identidade, `AbortController`, etapa corrente e a
 * promessa que só resolve quando o trabalho de fato terminou. Quem pede pausa
 * ou cancelamento fala com esse controlador e recebe uma resposta honesta:
 * "aceito por este processo" ou "não há controlador vivo aqui".
 *
 * Três invariantes:
 *
 *  1. CANCELAMENTO É IRREVERSÍVEL E SOBREPÕE PAUSA. Uma vez `CANCEL`, nenhuma
 *     chamada posterior rebaixa a intenção. Pausa pode virar cancelamento; o
 *     contrário nunca.
 *  2. TODA SOLICITAÇÃO É IDEMPOTENTE. Pedir duas vezes não produz dois
 *     abortos nem dois estados finais; a segunda chamada devolve a mesma
 *     resposta da primeira.
 *  3. O REGISTRO SEMPRE É LIMPO. `release` roda em sucesso, falha,
 *     cancelamento e desligamento — no `finally` de quem registrou.
 *
 * A distinção entre `PAUSE`, `CANCEL` e `SHUTDOWN` é preservada de propósito:
 * são três paradas com significados diferentes (retomável por decisão do
 * usuário, terminal por decisão do usuário, e interrupção por queda do
 * processo hospedeiro). Colapsá-las em um booleano perderia exatamente a
 * informação que o operador precisa para saber o que fazer em seguida.
 */

/** Intenção externa aplicada a uma execução viva. */
export type RunIntent = 'NONE' | 'PAUSE' | 'CANCEL' | 'SHUTDOWN';

/** Origem da solicitação, registrada para auditoria. */
export type RunIntentSource = 'panel' | 'cli' | 'state-file' | 'shutdown' | 'external-signal';

export interface RunControlSnapshot {
  projectId: string;
  runId: string | null;
  step: string;
  intent: RunIntent;
  intentSource: RunIntentSource | null;
  intentAt: string | null;
  startedAt: string;
  aborted: boolean;
}

export interface IntentAcceptance {
  /** Verdadeiro quando um controlador vivo neste processo recebeu o pedido. */
  accepted: boolean;
  projectId: string;
  runId: string | null;
  /** Etapa que estava em curso no instante da aceitação. */
  step: string | null;
  intent: RunIntent;
  /** Verdadeiro quando a mesma intenção já valia antes desta chamada. */
  alreadyRequested: boolean;
}

/** Precedência das intenções: só se sobe, nunca se desce. */
const INTENT_RANK: Readonly<Record<RunIntent, number>> = {
  NONE: 0,
  SHUTDOWN: 1,
  PAUSE: 2,
  CANCEL: 3,
};

export class RunController {
  readonly projectId: string;
  readonly startedAt: string;

  private readonly controller = new AbortController();
  private readonly settledPromise: Promise<void>;
  private settleSettled: () => void = () => undefined;

  private runIdValue: string | null;
  private stepValue = 'iniciando';
  private intentValue: RunIntent = 'NONE';
  private intentSourceValue: RunIntentSource | null = null;
  private intentAtValue: string | null = null;
  private releasedValue = false;

  constructor(projectId: string, runId: string | null) {
    this.projectId = projectId;
    this.runIdValue = runId;
    this.startedAt = nowIso();
    let resolve: () => void = () => undefined;
    this.settledPromise = new Promise<void>((done) => {
      resolve = done;
    });
    this.settleSettled = resolve;
  }

  get runId(): string | null {
    return this.runIdValue;
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get intent(): RunIntent {
    return this.intentValue;
  }

  get intentSource(): RunIntentSource | null {
    return this.intentSourceValue;
  }

  get step(): string {
    return this.stepValue;
  }

  get released(): boolean {
    return this.releasedValue;
  }

  /** Verdadeiro quando a execução deve parar em definitivo (estado terminal). */
  get cancelRequested(): boolean {
    return this.intentValue === 'CANCEL';
  }

  /** Verdadeiro quando a execução deve parar de forma retomável. */
  get pauseRequested(): boolean {
    return this.intentValue === 'PAUSE' || this.intentValue === 'SHUTDOWN';
  }

  /**
   * Amarra o `runId` assim que ele existe.
   *
   * O controlador nasce antes do `RunRecord` — é preciso ser possível cancelar
   * uma execução que ainda está adquirindo o lock ou validando ferramentas.
   */
  bindRun(runId: string): void {
    this.runIdValue = runId;
  }

  /** Etapa corrente, exibida a quem pergunta o que está acontecendo agora. */
  setStep(step: string): void {
    this.stepValue = step;
  }

  requestPause(source: RunIntentSource): IntentAcceptance {
    return this.applyIntent('PAUSE', source);
  }

  requestCancel(source: RunIntentSource): IntentAcceptance {
    return this.applyIntent('CANCEL', source);
  }

  /** Desligamento do processo hospedeiro: interrompe sem ser decisão do usuário. */
  requestShutdown(): IntentAcceptance {
    return this.applyIntent('SHUTDOWN', 'shutdown');
  }

  /**
   * Aborta sem declarar intenção. Usado quando um `AbortSignal` externo
   * (por exemplo o do chamador da API pública) dispara: a execução para, mas
   * a causa não é atribuída ao usuário.
   */
  abortFromExternalSignal(): void {
    this.applyIntent('SHUTDOWN', 'external-signal');
  }

  /** Resolve a promessa de término. Chamado uma única vez, na liberação. */
  markSettled(): void {
    this.releasedValue = true;
    this.settleSettled();
  }

  /** Aguarda o término real do trabalho desta execução. */
  whenSettled(): Promise<void> {
    return this.settledPromise;
  }

  snapshot(): RunControlSnapshot {
    return {
      projectId: this.projectId,
      runId: this.runIdValue,
      step: this.stepValue,
      intent: this.intentValue,
      intentSource: this.intentSourceValue,
      intentAt: this.intentAtValue,
      startedAt: this.startedAt,
      aborted: this.controller.signal.aborted,
    };
  }

  private applyIntent(next: RunIntent, source: RunIntentSource): IntentAcceptance {
    const already = INTENT_RANK[this.intentValue] >= INTENT_RANK[next] && this.intentValue !== 'NONE';

    if (INTENT_RANK[next] > INTENT_RANK[this.intentValue]) {
      this.intentValue = next;
      this.intentSourceValue = source;
      this.intentAtValue = nowIso();
    }

    /*
     * O aborto acontece SEMPRE, mesmo quando a intenção não subiu de nível.
     *
     * `AbortController.abort()` é idempotente por contrato, e insistir cobre o
     * caso em que o primeiro pedido chegou antes de o processo filho existir:
     * o `runProcess` seguinte já nasce com o sinal abortado e nem chega a
     * chamar `spawn`.
     */
    this.controller.abort();

    return {
      accepted: true,
      projectId: this.projectId,
      runId: this.runIdValue,
      step: this.stepValue,
      intent: this.intentValue,
      alreadyRequested: already,
    };
  }
}

/* ------------------------------------------------------------------------- */
/* Registro                                                                   */
/* ------------------------------------------------------------------------- */

/**
 * Um controlador por projeto.
 *
 * A chave é o `projectId` porque o lock de projeto já garante que só existe
 * uma execução por projeto de cada vez; usar o `runId` como chave permitiria
 * duas entradas para o mesmo projeto e esconderia a violação em vez de
 * denunciá-la.
 */
const controllers = new Map<string, RunController>();

export interface RegisterRunInput {
  projectId: string;
  runId?: string | null;
  /** Sinal do chamador. Abortá-lo aborta a execução, sem intenção do usuário. */
  externalSignal?: AbortSignal | undefined;
}

/**
 * Publica o controlador desta execução.
 *
 * Falha quando já existe um controlador vivo para o projeto: duas execuções
 * simultâneas do mesmo projeto seriam indistinguíveis para quem pede pausa.
 */
export function registerRun(input: RegisterRunInput): RunController | null {
  if (controllers.has(input.projectId)) return null;

  const controller = new RunController(input.projectId, input.runId ?? null);
  controllers.set(input.projectId, controller);

  const external = input.externalSignal;
  if (external) {
    if (external.aborted) {
      controller.abortFromExternalSignal();
    } else {
      external.addEventListener(
        'abort',
        () => {
          controller.abortFromExternalSignal();
        },
        { once: true },
      );
    }
  }

  return controller;
}

/**
 * Remove o controlador e resolve sua promessa de término.
 *
 * A remoção é condicionada à identidade: se o mapa já contém outro controlador
 * para o mesmo projeto (execução seguinte já iniciada), o antigo não apaga o
 * novo.
 */
export function releaseRun(controller: RunController): void {
  const current = controllers.get(controller.projectId);
  if (current === controller) controllers.delete(controller.projectId);
  controller.markSettled();
}

export function getController(projectId: string): RunController | null {
  return controllers.get(projectId) ?? null;
}

export function isRunLive(projectId: string): boolean {
  return controllers.has(projectId);
}

export function liveProjectIds(): string[] {
  return [...controllers.keys()];
}

export function listControllers(): RunControlSnapshot[] {
  return [...controllers.values()].map((controller) => controller.snapshot());
}

/**
 * Pede pausa ao controlador vivo do projeto.
 * `null` significa: nenhuma execução viva NESTE processo — o pedido pode ter
 * sido persistido, mas ninguém aqui o aceitou.
 */
export function requestPauseOnLiveRun(
  projectId: string,
  source: RunIntentSource,
): IntentAcceptance | null {
  const controller = controllers.get(projectId);
  if (!controller) return null;
  return controller.requestPause(source);
}

export function requestCancelOnLiveRun(
  projectId: string,
  source: RunIntentSource,
): IntentAcceptance | null {
  const controller = controllers.get(projectId);
  if (!controller) return null;
  return controller.requestCancel(source);
}

/**
 * Desligamento do processo: interrompe todas as execuções vivas.
 * Devolve os controladores atingidos para que o chamador possa AGUARDAR o
 * término real — desligar sem esperar é como deixar processo órfão.
 */
export function shutdownAllRuns(): RunController[] {
  const affected = [...controllers.values()];
  for (const controller of affected) controller.requestShutdown();
  return affected;
}

/**
 * Aguarda o término de todas as execuções vivas, com teto de espera.
 * Devolve `true` quando todas terminaram dentro do prazo.
 */
export async function awaitAllRuns(timeoutMs: number): Promise<boolean> {
  const pending = [...controllers.values()].map((controller) => controller.whenSettled());
  if (pending.length === 0) return true;

  let timer: NodeJS.Timeout | null = null;
  const expiry = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), Math.max(0, timeoutMs));
    timer.unref?.();
  });

  try {
    const outcome = await Promise.race([Promise.all(pending).then(() => 'done' as const), expiry]);
    return outcome === 'done';
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

/** Apenas para os testes: esvazia o registro entre cenários. */
export function resetRunControlForTests(): void {
  for (const controller of controllers.values()) controller.markSettled();
  controllers.clear();
}
