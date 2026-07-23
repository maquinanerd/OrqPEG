import type { GlobalConfig, Logger, Result, RunRecord } from '../types';
import { fail, ok } from '../utils/errors';
import { runProject } from '../execution/orchestrator';
import type { RoundPolicyOverrides } from '../execution/effective-policy';
import { createDefaultPorts } from '../execution/default-ports';
import {
  awaitAllRuns,
  isRunLive,
  liveProjectIds,
  listControllers,
  requestCancelOnLiveRun,
  requestPauseOnLiveRun,
  shutdownAllRuns,
} from '../execution/run-control';
import type { IntentAcceptance, RunControlSnapshot } from '../execution/run-control';
import type { EventHub } from './events';

/**
 * Gerência das execuções disparadas pelo painel.
 *
 * O painel responde imediatamente (202) e a execução prossegue em segundo plano
 * no mesmo processo, publicando cada transição de estado no barramento SSE.
 *
 * O registro de execuções vivas NÃO mora mais aqui: ele mora em
 * `execution/run-control`, publicado pelo próprio orquestrador. A diferença
 * importa. Antes, só execuções iniciadas pelo painel apareciam neste mapa, e o
 * `AbortController` criado aqui nunca chegava a nada além das chamadas de IA —
 * `abortRun` sequer tinha chamador. Agora qualquer execução, venha do painel ou
 * da CLI, publica um controlador, e pausa/cancelamento falam com ele.
 *
 * O que sobra deste módulo é o que ele de fato é: a ponte entre o servidor HTTP
 * e o orquestrador — disparar em segundo plano, publicar eventos e encerrar
 * com segurança.
 */

/** Teto de espera pelo término das execuções no desligamento do painel. */
export const SHUTDOWN_GRACE_MS = 30_000;

export interface StartRunInput {
  projectId: string;
  dryRun: boolean;
  resumeRunId: string | null;
  /** Camada de rodada já validada. Ausente é o mesmo que `null`: sem rodada. */
  roundConfig?: RoundPolicyOverrides | null;
  config: GlobalConfig;
  logger: Logger;
  events: EventHub;
}

export function startRunInBackground(input: StartRunInput): Result<{ started: true }> {
  if (isRunLive(input.projectId)) {
    return fail(
      'LOCK_HELD',
      `Já existe uma execução em andamento para o projeto "${input.projectId}".`,
    );
  }

  const logger = input.logger.child(`run:${input.projectId}`);

  /*
   * `runProject` publica o controlador de forma SÍNCRONA, antes do primeiro
   * `await`. Quando esta função retorna, portanto, já existe alguém para
   * atender um pedido de pausa — não há janela em que o painel responda
   * "execução iniciada" e um cancelamento imediato não encontre ninguém.
   */
  void runProject({
    projectId: input.projectId,
    dryRun: input.dryRun,
    resumeRunId: input.resumeRunId,
    roundConfig: input.roundConfig ?? null,
    config: input.config,
    logger,
    ports: createDefaultPorts(),
    onUpdate: (run: RunRecord) => {
      input.events.publishRun(run);
    },
  })
    .then((result) => {
      if (result.ok) {
        logger.info(`Execução finalizada no estado ${result.value.state}.`);
        input.events.publishRun(result.value, 'Execução finalizada.');
      } else {
        logger.error(`Execução falhou: ${result.error.message}`);
        input.events.publish({
          type: 'log',
          projectId: input.projectId,
          runId: null,
          state: null,
          message: `Execução falhou: ${result.error.message}`,
          at: new Date().toISOString(),
        });
      }
    })
    .catch((error: unknown) => {
      logger.error('Execução terminou com exceção não tratada.', {
        message: error instanceof Error ? error.message : String(error),
      });
    });

  return ok({ started: true });
}

/**
 * Pede PAUSA ao controlador vivo.
 *
 * `null` significa que nenhuma execução viva deste projeto existe NESTE
 * processo — o que não é o mesmo que "não há execução": ela pode estar rodando
 * na CLI, em outro processo, e nesse caso quem a interrompe é a intenção
 * persistida lida pela vigília do orquestrador. Quem chama precisa distinguir
 * os dois casos para não responder sucesso pelo que não fez.
 */
export function pauseRun(projectId: string): IntentAcceptance | null {
  return requestPauseOnLiveRun(projectId, 'panel');
}

/** Pede CANCELAMENTO ao controlador vivo. Idempotente. */
export function cancelRun(projectId: string): IntentAcceptance | null {
  return requestCancelOnLiveRun(projectId, 'panel');
}

export function isRunning(projectId: string): boolean {
  return isRunLive(projectId);
}

export function listRunningProjects(): string[] {
  return liveProjectIds();
}

/**
 * Identidade, etapa corrente e intenção de cada execução viva.
 * É o que o painel e o diagnóstico usam para dizer o que está acontecendo agora.
 */
export function describeRunningRuns(): RunControlSnapshot[] {
  return listControllers();
}

/**
 * Desligamento do painel (Ctrl+C): interrompe tudo e AGUARDA o término.
 *
 * Apenas sinalizar deixaria o processo do painel morrer com filhos ainda vivos
 * — exatamente o processo órfão que o produto promete não deixar. A espera tem
 * teto para que um filho travado não impeça o painel de fechar; o retorno diz
 * a verdade sobre o que aconteceu.
 */
export async function shutdownRuns(graceMs: number = SHUTDOWN_GRACE_MS): Promise<boolean> {
  const affected = shutdownAllRuns();
  if (affected.length === 0) return true;
  return awaitAllRuns(graceMs);
}
