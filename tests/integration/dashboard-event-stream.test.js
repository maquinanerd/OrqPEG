'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

/*
 * Transporte de eventos do painel.
 *
 * O defeito que estes testes travam era mudo: o servidor SEMPRE nomeia o evento
 * (`event: run-update`), e o cliente escutava apenas `source.onmessage`, que só
 * dispara para quadros anônimos. Nenhum evento de dado chegava ao navegador; o
 * painel dizia "Tempo real" e vivia inteiramente do polling de 5 s.
 *
 * A correção tem duas metades e as duas precisam ficar presas:
 *  - o quadro precisa continuar NOMEADO e passar a ser IDENTIFICADO (`id:`);
 *  - a retomada por `Last-Event-ID` precisa reemitir exatamente o buraco, nem
 *    um evento a mais (duplicata) nem um a menos (perda silenciosa).
 */

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'orqpeg-sse-'));
process.env.ORQPEG_HOME = HOME;
process.env.ORQPEG_NO_FILE_LOG = '1';

fs.mkdirSync(path.join(HOME, 'public'), { recursive: true });
fs.writeFileSync(path.join(HOME, 'public', 'index.html'), '<h1>painel</h1>', 'utf8');

const { startPanelServer } = require('../../dist/server/http-server');
const { createEventHub } = require('../../dist/server/events');
const { defaultGlobalConfig } = require('../../dist/config/global-config');
const { nullLogger } = require('../../dist/utils/logger');
const { ensureDataLayout } = require('../../dist/utils/paths');

ensureDataLayout();

let server = null;
let port = 0;
let hub = null;

function event(overrides) {
  return Object.assign(
    {
      type: 'run-update',
      projectId: 'projeto',
      runId: 'execucao',
      state: 'RUNNING_CLAUDE',
      message: 'mensagem',
      at: new Date().toISOString(),
    },
    overrides,
  );
}

/** Abre o fluxo, coleta o que chegar durante `ms` e encerra. */
function collect(options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: options.path ?? '/api/events',
        method: 'GET',
        headers: options.headers ?? {},
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
        });
        setTimeout(() => {
          req.destroy();
          resolve({ status: res.statusCode, headers: res.headers, body });
        }, options.ms ?? 250);
      },
    );
    req.on('error', (error) => {
      if (error.code !== 'ECONNRESET') reject(error);
    });
    req.end();
  });
}

/** Identificadores emitidos, na ordem em que apareceram no fluxo. */
function idsOf(body) {
  return (body.match(/^id: (\d+)$/gm) ?? []).map((line) => Number(line.slice(4)));
}

/** Mensagens entregues no `data:` de cada quadro. */
function messagesOf(body) {
  return (body.match(/^data: (.*)$/gm) ?? [])
    .map((line) => {
      try {
        return JSON.parse(line.slice(6));
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .map((payload) => payload.message);
}

test('painel sobe em porta efêmera de loopback', async () => {
  const config = defaultGlobalConfig();
  config.panel.port = 0;
  config.panel.openBrowserOnStart = false;

  const started = await startPanelServer({ config, logger: nullLogger() });
  assert.equal(started.ok, true, started.ok ? '' : JSON.stringify(started.error));
  server = started.value;
  port = started.value.port;
  hub = started.value.events;
});

test('o fluxo abre com retry e comentário de conexão', async () => {
  const stream = await collect();
  assert.equal(stream.status, 200);
  assert.match(stream.headers['content-type'], /text\/event-stream/);
  assert.match(stream.body, /^retry: \d+$/m, 'sem "retry:" o navegador usa o padrão de 3 s do agente');
  assert.match(stream.body, /: conectado ao OrqPEG/);
});

test('todo evento de conteúdo é nomeado E identificado', async () => {
  const pending = collect({ ms: 300 });
  await new Promise((resolve) => setTimeout(resolve, 60));

  hub.publish(event({ message: 'primeiro' }));
  hub.publish(event({ type: 'log', message: 'segundo' }));

  const stream = await pending;

  // Nomeado: é isso que exige listener por tipo no cliente.
  assert.match(stream.body, /^event: run-update$/m);
  assert.match(stream.body, /^event: log$/m);

  // Identificado: é isso que torna a retomada possível.
  assert.deepEqual(idsOf(stream.body), [1, 2]);

  // O id também viaja no JSON, para o cliente deduplicar sem depender do campo.
  assert.match(stream.body, /"id":1/);
  assert.match(stream.body, /"id":2/);
});

test('Last-Event-ID reemite exatamente o buraco', async () => {
  hub.publish(event({ message: 'terceiro' }));

  const stream = await collect({ headers: { 'Last-Event-ID': '2' } });
  const messages = messagesOf(stream.body);

  assert.deepEqual(
    messages.filter((m) => m !== 'ok'),
    ['terceiro'],
    'a retomada precisa entregar o que faltou e só isso',
  );
});

test('a retomada por query cobre a reabertura manual do cliente', async () => {
  // O navegador só repõe Last-Event-ID na reconexão que ele mesmo faz. Quando o
  // cliente fecha e reabre o EventSource, o cursor precisa ir na URL.
  const stream = await collect({ path: '/api/events?lastEventId=1' });
  const messages = messagesOf(stream.body).filter((m) => m !== 'ok');

  assert.deepEqual(messages, ['segundo', 'terceiro']);
  assert.equal(messages.includes('primeiro'), false, 'evento já entregue não pode voltar');
});

test('cursor no futuro não reemite nada: nunca há duplicata', async () => {
  const stream = await collect({ headers: { 'Last-Event-ID': String(hub.lastEventId()) } });
  assert.deepEqual(messagesOf(stream.body).filter((m) => m !== 'ok'), []);
});

test('cliente novo não recebe backlog', async () => {
  const stream = await collect();
  assert.deepEqual(
    messagesOf(stream.body).filter((m) => m !== 'ok'),
    [],
    'quem chega sem cursor quer o estado atual pela API, não o histórico do fluxo',
  );
});

test('cursor ilegível é tratado como ausente, não como erro', async () => {
  for (const raw of ['abc', '-5', '', '9e9x']) {
    const stream = await collect({ headers: { 'Last-Event-ID': raw } });
    assert.equal(stream.status, 200, `cursor ${JSON.stringify(raw)} derrubou o fluxo`);
  }
});

test('heartbeat é anônimo: não consome id nem entra no backlog', () => {
  const local = createEventHub();
  local.publish(event({ message: 'real' }));

  const before = { id: local.lastEventId(), size: local.backlogSize() };
  local.publish(event({ type: 'heartbeat', message: 'ok' }));

  assert.equal(local.lastEventId(), before.id, 'heartbeat numerado faria o cursor avançar sobre nada');
  assert.equal(local.backlogSize(), before.size);
  local.closeAll();
});

test('o backlog é limitado e o truncamento é declarado, não silencioso', async () => {
  const local = createEventHub();
  for (let i = 0; i < 620; i += 1) local.publish(event({ message: `e${i}` }));

  assert.equal(local.backlogSize(), 500, 'o backlog precisa ter teto para não virar vazamento');
  assert.equal(local.lastEventId(), 620);
  local.closeAll();

  // No servidor real: um cliente muito atrasado é avisado para recarregar.
  for (let i = 0; i < 620; i += 1) hub.publish(event({ message: `x${i}` }));
  const stream = await collect({ headers: { 'Last-Event-ID': '1' }, ms: 350 });
  assert.match(
    stream.body,
    /backlog-truncated/,
    'sem o aviso, o cliente seguiria com um buraco que ele não tem como perceber',
  );
});

test('o hub não quebra quando um cliente morre no meio da escrita', () => {
  const local = createEventHub();
  const morto = {
    write() {
      throw new Error('socket fechado');
    },
    end() {},
    on() {},
  };
  local.subscribe({ headers: {}, url: '/api/events', on() {} }, {
    writeHead() {},
    write() {},
    end() {},
    on() {},
  });
  // Injeta um cliente que falha: o barramento precisa descartá-lo e seguir.
  local.subscribe({ headers: {}, url: '/api/events', on() {} }, Object.assign({ writeHead() {} }, morto));
  assert.doesNotThrow(() => local.publish(event({ message: 'apos-falha' })));
  local.closeAll();
});

test('encerra o painel', async () => {
  await server.close();
  server = null;
});
