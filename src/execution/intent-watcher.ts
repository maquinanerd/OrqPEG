import { readPersistedIntent } from '../state/run-state';
import type { RunController } from './run-control';

/**
 * Ponte entre a intenção PERSISTIDA e o controlador VIVO.
 *
 * O painel executa a rodada dentro do próprio processo, então lá a rota fala
 * direto com o controlador. A CLI, não: `PAUSAR.cmd` roda em outro processo e
 * só consegue gravar a intenção no arquivo de estado. Sem esta vigília, esse
 * pedido continuaria sendo o que era antes — uma marca que ninguém lê enquanto
 * um processo filho de 60 minutos segue rodando.
 *
 * O que este módulo NÃO é: adiamento da pausa para o próximo ponto do laço.
 * Ao detectar a intenção, ele aborta o controlador imediatamente, e o aborto
 * derruba a árvore de processos da etapa em curso. A frequência da sondagem
 * define apenas a latência da detecção (sub-segundo), não o momento da parada.
 *
 * A sondagem lê o arquivo de estado e compara a REVISÃO com a da leitura
 * anterior; só uma revisão nova produz trabalho. O arquivo é pequeno e local, e
 * a alternativa (`fs.watch`) é notoriamente irregular em rede e em alguns
 * sistemas de arquivos do Windows — irregularidade que aqui significaria uma
 * pausa que não acontece.
 */

/** Intervalo padrão entre verificações. Latência percebida abaixo de 1 s. */
export const DEFAULT_INTENT_POLL_MS = 500;

export interface IntentWatcher {
  /** Verifica agora, sem esperar o próximo tique. Exposto para os testes. */
  poll(): void;
  stop(): void;
}

export interface WatchIntentInput {
  projectId: string;
  runId: string;
  controller: RunController;
  intervalMs?: number;
  /** Notificação de cada intenção adotada, para log e testes. */
  onAdopted?: (intent: 'PAUSE' | 'CANCEL') => void;
}

export function watchPersistedIntent(input: WatchIntentInput): IntentWatcher {
  const interval = Math.max(50, input.intervalMs ?? DEFAULT_INTENT_POLL_MS);
  let stopped = false;
  let lastRevision = -1;

  const poll = (): void => {
    if (stopped) return;

    const intent = readPersistedIntent(input.projectId, input.runId);
    if (intent === null) return;

    /*
     * A revisão evita reaplicar a mesma intenção a cada tique. Ela é
     * monotônica e o `saveRun` a incrementa em toda gravação, o que também
     * cobre o caso de o arquivo ser reescrito com o mesmo `mtime`.
     */
    if (intent.revision === lastRevision) return;
    lastRevision = intent.revision;

    if (intent.cancelRequested) {
      input.controller.requestCancel('state-file');
      input.onAdopted?.('CANCEL');
      // Cancelamento é terminal e não pode ser rebaixado: nada mais a vigiar.
      stop();
      return;
    }

    if (intent.pauseRequested) {
      input.controller.requestPause('state-file');
      input.onAdopted?.('PAUSE');
      // A vigília continua: uma pausa ainda pode ser elevada a cancelamento.
    }
  };

  const timer = setInterval(poll, interval);
  /* Nunca segurar o event loop por conta própria: o desligamento do painel não
     pode ficar preso esperando uma sondagem. */
  timer.unref?.();

  function stop(): void {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
  }

  return { poll, stop };
}
