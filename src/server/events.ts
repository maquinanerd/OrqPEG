import type * as http from 'node:http';
import type { RunRecord, RunState } from '../types';
import { nowIso } from '../utils/time';

/**
 * Barramento de eventos do painel via Server-Sent Events.
 *
 * Escolhido em vez de WebSocket por não exigir dependência externa e por
 * reconectar sozinho no navegador. Cada cliente recebe um heartbeat periódico
 * para atravessar proxies e detectar conexões mortas.
 */

export interface PanelEvent {
  type: 'run-update' | 'log' | 'heartbeat';
  projectId: string | null;
  runId: string | null;
  state: RunState | null;
  message: string;
  at: string;
}

export interface EventHub {
  subscribe(req: http.IncomingMessage, res: http.ServerResponse): void;
  publish(event: PanelEvent): void;
  publishRun(run: RunRecord, message?: string): void;
  clientCount(): number;
  closeAll(): void;
}

const HEARTBEAT_MS = 25_000;

export function createEventHub(): EventHub {
  const clients = new Set<http.ServerResponse>();

  const heartbeat = setInterval(() => {
    broadcast({
      type: 'heartbeat',
      projectId: null,
      runId: null,
      state: null,
      message: 'ok',
      at: nowIso(),
    });
  }, HEARTBEAT_MS);
  // Não impede o processo de encerrar.
  heartbeat.unref?.();

  function broadcast(event: PanelEvent): void {
    const payload = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
    for (const client of [...clients]) {
      try {
        client.write(payload);
      } catch {
        clients.delete(client);
      }
    }
  }

  return {
    subscribe(req, res) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write(': conectado ao OrqPEG\n\n');
      clients.add(res);

      const remove = (): void => {
        clients.delete(res);
      };
      req.on('close', remove);
      req.on('error', remove);
      res.on('error', remove);
    },

    publish(event) {
      broadcast(event);
    },

    publishRun(run, message) {
      broadcast({
        type: 'run-update',
        projectId: run.projectId,
        runId: run.runId,
        state: run.state,
        message: message ?? run.events[run.events.length - 1]?.message ?? run.state,
        at: nowIso(),
      });
    },

    clientCount() {
      return clients.size;
    },

    closeAll() {
      clearInterval(heartbeat);
      for (const client of [...clients]) {
        try {
          client.end();
        } catch {
          /* cliente já desconectado */
        }
      }
      clients.clear();
    },
  };
}
