import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import type { GlobalConfig, Logger, Result } from '../types';
import { fail, ok } from '../utils/errors';
import { ORQPEG_DIRS } from '../utils/paths';
import { resolveWithinRoot } from '../security/path-guard';
import { createApiRouter } from './routes';
import type { EventHub } from './events';
import { createEventHub } from './events';

/**
 * Servidor local do painel.
 *
 * Restrições de segurança, todas verificadas por teste:
 *  - escuta EXCLUSIVAMENTE em 127.0.0.1; nunca em 0.0.0.0;
 *  - serve arquivos apenas de `public/`, com resolução protegida contra
 *    traversal; qualquer caminho que escape da raiz é rejeitado com 403;
 *  - não expõe `data/`, `config/`, `src/` nem qualquer outro diretório;
 *  - rejeita requisições cujo cabeçalho Host não seja loopback (defesa contra
 *    DNS rebinding).
 */

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

const ALLOWED_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

export interface PanelServer {
  readonly url: string;
  readonly port: number;
  readonly events: EventHub;
  close(): Promise<void>;
}

export interface StartServerOptions {
  config: GlobalConfig;
  logger: Logger;
}

export async function startPanelServer(
  options: StartServerOptions,
): Promise<Result<PanelServer>> {
  const { config, logger } = options;
  const host = config.panel.host;

  if (host !== '127.0.0.1' && host !== 'localhost') {
    return fail(
      'CONFIG_INVALID',
      `Recusando iniciar: o painel só pode escutar em 127.0.0.1 (configurado: ${host}).`,
    );
  }

  const events = createEventHub();
  const api = createApiRouter({ config, logger, events });
  const publicRoot = ORQPEG_DIRS.publicDir();

  const server = http.createServer((req, res) => {
    void handleRequest(req, res, { api, publicRoot, events, logger }).catch((error: unknown) => {
      logger.error('Falha ao tratar requisição.', {
        message: error instanceof Error ? error.message : String(error),
      });
      if (!res.headersSent) {
        sendJson(res, 500, { error: 'Erro interno do servidor.' });
      }
    });
  });

  return new Promise<Result<PanelServer>>((resolve) => {
    server.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') {
        resolve(
          fail(
            'IO_FAILED',
            `A porta ${config.panel.port} já está em uso. Use PARAR-PAINEL.cmd ou altere panel.port em config/global.json.`,
            { port: config.panel.port },
          ),
        );
        return;
      }
      resolve(fail('IO_FAILED', 'Falha ao iniciar o servidor do painel.', {}, error));
    });

    server.listen(config.panel.port, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : config.panel.port;
      const url = `http://127.0.0.1:${port}`;
      logger.info(`Painel disponível em ${url}`);

      resolve(
        ok({
          url,
          port,
          events,
          close: () =>
            new Promise<void>((done) => {
              events.closeAll();
              server.close(() => done());
            }),
        }),
      );
    });
  });
}

/* ------------------------------------------------------------------------- */

interface HandlerDeps {
  api: ReturnType<typeof createApiRouter>;
  publicRoot: string;
  events: EventHub;
  logger: Logger;
}

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: HandlerDeps,
): Promise<void> {
  // Defesa contra DNS rebinding: só aceitamos Host de loopback.
  const hostHeader = (req.headers.host ?? '').split(':')[0] ?? '';
  if (!ALLOWED_HOSTS.has(hostHeader)) {
    sendJson(res, 403, { error: 'Host não permitido. O painel só aceita acesso local.' });
    return;
  }

  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const pathname = decodeSafe(url.pathname);
  if (pathname === null) {
    sendJson(res, 400, { error: 'URL inválida.' });
    return;
  }

  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
  );

  if (pathname === '/api/events') {
    deps.events.subscribe(req, res);
    return;
  }

  if (pathname.startsWith('/api/')) {
    await deps.api.handle(req, res, url);
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendJson(res, 405, { error: 'Método não permitido para conteúdo estático.' });
    return;
  }

  serveStatic(res, deps.publicRoot, pathname);
}

function serveStatic(res: http.ServerResponse, publicRoot: string, pathname: string): void {
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');

  const resolved = resolveWithinRoot(publicRoot, relative);
  if (!resolved.ok) {
    sendJson(res, 403, { error: 'Caminho não permitido.' });
    return;
  }

  let filePath = resolved.value;
  try {
    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) {
      const indexPath = path.join(filePath, 'index.html');
      if (!fs.existsSync(indexPath)) {
        sendJson(res, 404, { error: 'Recurso não encontrado.' });
        return;
      }
      filePath = indexPath;
    }
  } catch {
    sendJson(res, 404, { error: 'Recurso não encontrado.' });
    return;
  }

  const extension = path.extname(filePath).toLowerCase();
  const contentType = MIME[extension];
  if (!contentType) {
    // Extensão não reconhecida não é servida: evita exposição acidental.
    sendJson(res, 403, { error: 'Tipo de arquivo não servido pelo painel.' });
    return;
  }

  let contents: Buffer;
  try {
    contents = fs.readFileSync(filePath);
  } catch {
    sendJson(res, 404, { error: 'Recurso não encontrado.' });
    return;
  }

  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': contents.length,
    'Cache-Control': 'no-store',
  });
  res.end(contents);
}

export function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function decodeSafe(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}
