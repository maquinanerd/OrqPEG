'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

/*
 * Segurança do servidor do painel.
 *
 * Verifica as três garantias que o produto promete:
 *  1. escuta exclusivamente em loopback;
 *  2. serve apenas `public/`, nunca `data/`, `config/` ou `src/`;
 *  3. rejeita traversal, Host forjado e tipos de arquivo não previstos.
 */

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'orqpeg-srv-'));
process.env.ORQPEG_HOME = HOME;
process.env.ORQPEG_NO_FILE_LOG = '1';

// Estrutura mínima: um public/ servível e segredos que NÃO podem vazar.
fs.mkdirSync(path.join(HOME, 'public', 'assets'), { recursive: true });
fs.writeFileSync(path.join(HOME, 'public', 'index.html'), '<h1>painel</h1>', 'utf8');
fs.writeFileSync(path.join(HOME, 'public', 'assets', 'app.js'), 'console.log(1)', 'utf8');
fs.writeFileSync(path.join(HOME, 'public', 'nao-servir.exe'), 'binario', 'utf8');
fs.mkdirSync(path.join(HOME, 'config'), { recursive: true });
fs.writeFileSync(path.join(HOME, 'config', 'global.json'), '{"segredo":"nao-vazar"}', 'utf8');
fs.mkdirSync(path.join(HOME, 'data'), { recursive: true });
fs.writeFileSync(path.join(HOME, 'data', 'sensivel.json'), '{"token":"nao-vazar"}', 'utf8');

const { startPanelServer } = require('../../dist/server/http-server');
const { defaultGlobalConfig, validateGlobalConfig } = require('../../dist/config/global-config');
const { nullLogger } = require('../../dist/utils/logger');
const { ensureDataLayout } = require('../../dist/utils/paths');

ensureDataLayout();

let server = null;
let port = 0;

test('inicia o painel em porta efêmera de loopback', async () => {
  const config = defaultGlobalConfig();
  config.panel.port = 0; // porta efêmera evita colidir com um painel real
  config.panel.openBrowserOnStart = false;

  // A porta 0 é aceita pelo servidor mas não pela validação de configuração
  // persistida; o teste exercita o servidor diretamente.
  const started = await startPanelServer({ config, logger: nullLogger() });
  assert.equal(started.ok, true, started.ok ? '' : JSON.stringify(started.error));
  server = started.value;
  port = started.value.port;
  assert.match(started.value.url, /^http:\/\/127\.0\.0\.1:\d+$/);
});

function request(pathname, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: pathname,
        method: options.method ?? 'GET',
        headers: { Host: options.host ?? `127.0.0.1:${port}`, ...(options.headers ?? {}) },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

/* ------------------------------------------------------------------------ */

test('serve o painel na raiz', async () => {
  const res = await request('/');
  assert.equal(res.status, 200);
  assert.match(res.body, /painel/);
  assert.match(String(res.headers['content-type']), /text\/html/);
});

test('serve ativos legítimos', async () => {
  const res = await request('/assets/app.js');
  assert.equal(res.status, 200);
  assert.match(String(res.headers['content-type']), /javascript/);
});

test('envia cabeçalhos de segurança', async () => {
  const res = await request('/');
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.equal(res.headers['x-frame-options'], 'DENY');
  assert.ok(String(res.headers['content-security-policy']).includes("default-src 'self'"));
});

test('BLOQUEIA traversal para config/ e data/', async () => {
  const attacks = [
    '/../config/global.json',
    '/../../config/global.json',
    '/assets/../../config/global.json',
    '/%2e%2e/config/global.json',
    '/%252e%252e/config/global.json',
    '/..%2fconfig%2fglobal.json',
    '/../data/sensivel.json',
    '/....//config/global.json',
  ];

  for (const attack of attacks) {
    const res = await request(attack);
    assert.notEqual(res.status, 200, `não pode servir: ${attack}`);
    assert.equal(
      res.body.includes('nao-vazar'),
      false,
      `vazou conteúdo sensível em: ${attack}`,
    );
  }
});

test('não serve extensões fora da lista permitida', async () => {
  const res = await request('/nao-servir.exe');
  assert.equal(res.status, 403);
});

test('recusa Host forjado (defesa contra DNS rebinding)', async () => {
  const res = await request('/', { host: 'evil.example.com' });
  assert.equal(res.status, 403);
  assert.match(res.body, /Host/i);
});

test('aceita Host localhost', async () => {
  const res = await request('/', { host: `localhost:${port}` });
  assert.equal(res.status, 200);
});

/* ------------------------------------------------------------------------ */
/* CSRF                                                                      */
/* ------------------------------------------------------------------------ */

/**
 * A validação de `Host` acima cobre DNS rebinding, não CSRF: numa requisição
 * disparada por outra página o `Host` é justamente o do painel, e ela passava.
 * Como a porta padrão é fixa e documentada, qualquer site aberto enquanto o
 * painel roda alcançava criação de projeto, alteração de `merge.mode`, disparo
 * de execução e concessão de override — a resposta ficava opaca para o
 * atacante, mas o efeito acontecia.
 */

test('recusa POST de origem cruzada declarada em Origin', async () => {
  const res = await request('/api/projects', {
    method: 'POST',
    headers: { Origin: 'https://evil.example.com', 'Content-Type': 'application/json' },
    body: '{"id":"x"}',
  });
  assert.equal(res.status, 403);
  assert.match(res.body, /origem/i);
});

test('recusa POST marcado como cross-site pelo navegador', async () => {
  const res = await request('/api/projects', {
    method: 'POST',
    headers: { 'Sec-Fetch-Site': 'cross-site', 'Content-Type': 'application/json' },
    body: '{"id":"x"}',
  });
  assert.equal(res.status, 403);
});

test('recusa corpo que não seja application/json', async () => {
  /* `text/plain` faz da requisição uma "simple request": o navegador a entrega
     sem preflight. Fechar esse tipo é o que elimina a forma do ataque que não
     depende de cabeçalho nenhum. */
  const res = await request('/api/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: '{"id":"x"}',
  });
  assert.equal(res.status, 400);
  assert.match(res.body, /application\/json/);
});

test('aceita POST da própria página', async () => {
  const res = await request('/api/projects', {
    method: 'POST',
    headers: {
      Origin: `http://127.0.0.1:${port}`,
      'Sec-Fetch-Site': 'same-origin',
      'Content-Type': 'application/json',
    },
    body: '{}',
  });
  assert.notEqual(res.status, 403, 'a defesa não pode recusar a própria página do painel');
});

test('leitura de origem cruzada continua passando: GET não muda estado', async () => {
  const res = await request('/api/home', {
    headers: { Origin: 'https://evil.example.com', 'Sec-Fetch-Site': 'cross-site' },
  });
  assert.equal(res.status, 200, 'a resposta é opaca para o atacante e nada é alterado');
});

test('rota inexistente devolve 404 em JSON', async () => {
  const res = await request('/api/inexistente');
  assert.equal(res.status, 404);
  assert.match(String(res.headers['content-type']), /application\/json/);
});

test('a API responde e não expõe valores de variáveis de ambiente', async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-ant-nao-pode-vazar-no-painel';
  try {
    const res = await request('/api/home');
    assert.equal(res.status, 200);
    const payload = JSON.parse(res.body);
    assert.equal(payload.product, 'OrqPEG');
    assert.ok(Array.isArray(payload.tools));
    assert.equal(
      res.body.includes('sk-ant-nao-pode-vazar-no-painel'),
      false,
      'o painel jamais pode expor o valor de uma chave',
    );
    assert.ok(
      payload.apiGuard.presentKeys.includes('ANTHROPIC_API_KEY'),
      'o painel deve reportar a PRESENÇA da variável',
    );
  } finally {
    delete process.env.ANTHROPIC_API_KEY;
  }
});

test('método não permitido em conteúdo estático devolve 405', async () => {
  const res = await request('/', { method: 'DELETE' });
  assert.equal(res.status, 405);
});

test('a configuração persistida recusa host público', () => {
  const config = defaultGlobalConfig();
  config.panel.host = '0.0.0.0';
  assert.equal(validateGlobalConfig(config).ok, false);
});

test('startPanelServer recusa host não-loopback', async () => {
  const config = defaultGlobalConfig();
  config.panel.host = '0.0.0.0';
  const result = await startPanelServer({ config, logger: nullLogger() });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'CONFIG_INVALID');
});

/* Encerramento é teardown, não teste.
 *
 * Isto era um `test()` terminando em `assert.ok(true)` — nada ali podia
 * reprovar. É a mesma forma da asserção que, no teste de Skills, escondeu que
 * nenhuma Skill chegava ao agente. Um passo de limpeza vestido de teste não
 * mascara nada aqui, mas deixa o padrão de pé como se fosse aceitável. */
test.after(async () => {
  if (server) await server.close();
  server = null;
});
