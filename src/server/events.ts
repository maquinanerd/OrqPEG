import type * as http from 'node:http';
import type { RunRecord, RunState } from '../types';
import { nowIso } from '../utils/time';

/**
 * Barramento de eventos do painel via Server-Sent Events.
 *
 * Escolhido em vez de WebSocket por não exigir dependência externa e por
 * reconectar sozinho no navegador.
 *
 * O fluxo é RETOMÁVEL. Cada evento de conteúdo recebe um identificador
 * monotônico emitido no campo `id:`, e o servidor mantém um backlog limitado em
 * memória. Quando o navegador reconecta, ele reenvia o último identificador
 * recebido em `Last-Event-ID` e o servidor reemite exatamente o que faltou.
 *
 * Sem isso, toda reconexão abria um buraco silencioso: os eventos publicados
 * enquanto a conexão estava caída sumiam, e o painel só voltava a ficar correto
 * na próxima varredura de polling — que existe como rede de segurança, não como
 * transporte principal.
 *
 * Heartbeats são deliberadamente ANÔNIMOS: não consomem identificador e não
 * entram no backlog. Eles existem para atravessar proxies e detectar conexões
 * mortas; numerá-los faria o cursor do cliente avançar sobre nada e a retomada
 * passaria a "pular" eventos reais publicados no mesmo intervalo.
 */

export type PanelEventType = 'run-update' | 'log' | 'heartbeat';

/** O que os produtores publicam. O identificador é atribuído pelo barramento. */
export interface PanelEventInput {
  type: PanelEventType;
  projectId: string | null;
  runId: string | null;
  state: RunState | null;
  message: string;
  at: string;
}

/** O que os assinantes recebem. */
export interface PanelEvent extends PanelEventInput {
  id: number;
}

export interface EventHub {
  subscribe(req: http.IncomingMessage, res: http.ServerResponse): void;
  publish(event: PanelEventInput): void;
  publishRun(run: RunRecord, message?: string): void;
  clientCount(): number;
  /** Último identificador emitido. Zero significa "nada publicado ainda". */
  lastEventId(): number;
  /** Quantidade de eventos retidos para retomada. */
  backlogSize(): number;
  closeAll(): void;
}

const HEARTBEAT_MS = 25_000;

/**
 * Reconexão sugerida ao navegador. Menor que o intervalo de polling (5 s) para
 * que o fluxo volte antes de a rede de segurança precisar agir.
 */
const RETRY_MS = 3_000;

/**
 * Teto do backlog. Limita memória e é o ponto em que a retomada deixa de ser
 * possível: um cliente que ficou fora por mais de BACKLOG_MAX eventos recebe um
 * aviso de truncamento e recarrega tudo, em vez de continuar com estado furado.
 */
const BACKLOG_MAX = 500;

export function createEventHub(): EventHub {
  const clients = new Set<http.ServerResponse>();
  const backlog: PanelEvent[] = [];
  let sequence = 0;

  const heartbeat = setInterval(() => {
    writeToAll(
      frame(
        {
          type: 'heartbeat',
          projectId: null,
          runId: null,
          state: null,
          message: 'ok',
          at: nowIso(),
        },
        null,
      ),
    );
  }, HEARTBEAT_MS);
  // Não impede o processo de encerrar.
  heartbeat.unref?.();

  /**
   * Monta um quadro SSE. `id` nulo produz quadro anônimo (heartbeat): sem
   * campo `id:`, o cursor do cliente não avança.
   */
  function frame(event: PanelEventInput, id: number | null): string {
    const payload: PanelEventInput | PanelEvent = id === null ? event : { ...event, id };
    const idLine = id === null ? '' : `id: ${id}\n`;
    return `${idLine}event: ${event.type}\ndata: ${JSON.stringify(payload)}\n\n`;
  }

  function writeToAll(payload: string): void {
    for (const client of [...clients]) {
      try {
        client.write(payload);
      } catch {
        clients.delete(client);
      }
    }
  }

  function broadcast(input: PanelEventInput): void {
    if (input.type === 'heartbeat') {
      writeToAll(frame(input, null));
      return;
    }

    sequence += 1;
    const event: PanelEvent = { ...input, id: sequence };

    backlog.push(event);
    if (backlog.length > BACKLOG_MAX) backlog.splice(0, backlog.length - BACKLOG_MAX);

    writeToAll(frame(input, sequence));
  }

  /**
   * Lê o cursor do cliente. O cabeçalho `Last-Event-ID` é o mecanismo nativo do
   * EventSource; a query serve para reconexão manual, quando o cliente fecha e
   * reabre o fluxo por conta própria e o navegador não repõe o cabeçalho.
   */
  function readCursor(req: http.IncomingMessage): number {
    const header = req.headers['last-event-id'];
    const fromHeader = Array.isArray(header) ? header[0] : header;

    let raw = fromHeader ?? '';
    if (raw === '') {
      try {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        raw = url.searchParams.get('lastEventId') ?? '';
      } catch {
        raw = '';
      }
    }

    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed < 0) return 0;
    return parsed;
  }

  return {
    subscribe(req, res) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });

      res.write(`retry: ${RETRY_MS}\n\n`);
      res.write(': conectado ao OrqPEG\n\n');

      const cursor = readCursor(req);
      if (cursor > 0) {
        const oldest = backlog.length > 0 ? (backlog[0] as PanelEvent).id : sequence + 1;

        if (cursor < oldest - 1) {
          /*
           * O cliente ficou fora tempo demais: o que ele perdeu já saiu do
           * backlog. Reemitir só o que sobrou entregaria um estado com buraco
           * silencioso, então o servidor é explícito e o cliente recarrega.
           */
          res.write(
            frame(
              {
                type: 'log',
                projectId: null,
                runId: null,
                state: null,
                message: 'backlog-truncated',
                at: nowIso(),
              },
              null,
            ),
          );
        }

        for (const event of backlog) {
          if (event.id > cursor) res.write(frame(event, event.id));
        }
      }

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

    lastEventId() {
      return sequence;
    },

    backlogSize() {
      return backlog.length;
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
