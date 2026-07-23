import type { GlobalConfig, Logger, Result, RunRecord } from '../types';
import { fail, ok } from '../utils/errors';
import { runProject } from '../execution/orchestrator';
import type { RoundPolicyOverrides } from '../execution/effective-policy';
import { createDefaultPorts } from '../execution/default-ports';
import type { EventHub } from './events';

/**
 * Gerência das execuções disparadas pelo painel.
 *
 * O painel responde imediatamente (202) e a execução prossegue em segundo plano
 * no mesmo processo, publicando cada transição de estado no barramento SSE.
 * Um mapa de execuções em curso impede que o mesmo projeto seja iniciado duas
 * vezes — o lock de arquivo cobre o caso entre processos, este mapa cobre o
 * caso dentro do processo do painel.
 */

interface ActiveRun {
  projectId: string;
  controller: AbortController;
  startedAt: number;
}

const active = new Map<string, ActiveRun>();

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
  if (active.has(input.projectId)) {
    return fail(
      'LOCK_HELD',
      `Já existe uma execução em andamento para o projeto "${input.projectId}".`,
    );
  }

  const controller = new AbortController();
  active.set(input.projectId, {
    projectId: input.projectId,
    controller,
    startedAt: Date.now(),
  });

  const logger = input.logger.child(`run:${input.projectId}`);

  void runProject({
    projectId: input.projectId,
    dryRun: input.dryRun,
    resumeRunId: input.resumeRunId,
    roundConfig: input.roundConfig ?? null,
    config: input.config,
    logger,
    ports: createDefaultPorts(),
    signal: controller.signal,
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
    })
    .finally(() => {
      active.delete(input.projectId);
    });

  return ok({ started: true });
}

/** Solicita o encerramento cooperativo da execução em curso. */
export function abortRun(projectId: string): boolean {
  const running = active.get(projectId);
  if (!running) return false;
  running.controller.abort();
  return true;
}

export function isRunning(projectId: string): boolean {
  return active.has(projectId);
}

export function listRunningProjects(): string[] {
  return [...active.keys()];
}

/** Aborta tudo — usado no desligamento do painel (Ctrl+C). */
export function abortAll(): void {
  for (const running of active.values()) {
    running.controller.abort();
  }
}
