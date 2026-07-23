'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

/*
 * Superfície do dashboard.
 *
 * O dashboard acrescentou uma página e três arquivos estáticos ao painel. Esta
 * suíte prende as garantias que essa adição não pode afrouxar:
 *
 *  1. os arquivos novos são servidos e nada mais passou a ser servido junto;
 *  2. a página respeita a CSP do painel (default-src 'self'), sem estilo nem
 *     script inline e sem nenhuma origem externa;
 *  3. o dashboard não injeta HTML a partir de dado do servidor;
 *  4. o campo do console NÃO é um canal de prompt arbitrário;
 *  5. identificador vindo da URL continua sendo validado antes de virar caminho
 *     ou argumento.
 */

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const PUBLIC_DIR = path.join(REPO_ROOT, 'public');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'orqpeg-dash-'));
process.env.ORQPEG_HOME = HOME;
process.env.ORQPEG_NO_FILE_LOG = '1';

// O painel serve `public/` da raiz do OrqPEG: copiamos a de verdade.
fs.cpSync(PUBLIC_DIR, path.join(HOME, 'public'), { recursive: true });

// Segredos que precisam continuar invisíveis.
fs.mkdirSync(path.join(HOME, 'config'), { recursive: true });
fs.writeFileSync(path.join(HOME, 'config', 'global.json'), '{"segredo":"nao-vazar"}', 'utf8');

const { startPanelServer } = require('../../dist/server/http-server');
const { defaultGlobalConfig } = require('../../dist/config/global-config');
const { nullLogger } = require('../../dist/utils/logger');
const { ensureDataLayout } = require('../../dist/utils/paths');

ensureDataLayout();

let server = null;
let port = 0;

function request(pathname, options = {}) {
  return new Promise((resolve, reject) => {
    const body = options.body === undefined ? null : JSON.stringify(options.body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: pathname,
        method: options.method ?? 'GET',
        headers: Object.assign(
          body === null ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
          options.headers ?? {},
        ),
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (text += chunk));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: text }));
      },
    );
    req.on('error', reject);
    if (body !== null) req.write(body);
    req.end();
  });
}

const read = (relative) => fs.readFileSync(path.join(PUBLIC_DIR, relative), 'utf8');

/**
 * Remove comentários antes de procurar por referência a recurso.
 *
 * Uma URL citada em comentário é procedência, não requisição: `tokens.css`
 * documenta o arquivo do Figma de onde cada valor veio, e isso precisa
 * continuar podendo ser dito. O que não pode existir é a URL no CSS ou no
 * markup como recurso de verdade.
 */
function stripComments(source, kind) {
  let out = source.replace(/\/\*[\s\S]*?\*\//g, ' ');
  if (kind === 'js') out = out.replace(/^\s*\/\/.*$/gm, ' ');
  if (kind === 'html') out = out.replace(/<!--[\s\S]*?-->/g, ' ');
  return out;
}

test('painel sobe em porta efêmera', async () => {
  const config = defaultGlobalConfig();
  config.panel.port = 0;
  config.panel.openBrowserOnStart = false;

  const started = await startPanelServer({ config, logger: nullLogger() });
  assert.equal(started.ok, true, started.ok ? '' : JSON.stringify(started.error));
  server = started.value;
  port = started.value.port;
});

test('os arquivos do dashboard são servidos com o tipo correto', async () => {
  const expected = [
    ['/index.html', /text\/html/],
    ['/assets/tokens.css', /text\/css/],
    ['/assets/dashboard.css', /text\/css/],
    ['/assets/dashboard.js', /text\/javascript/],
    ['/assets/event-stream.js', /text\/javascript/],
  ];

  for (const [pathname, contentType] of expected) {
    const res = await request(pathname);
    assert.equal(res.status, 200, `${pathname} devolveu ${res.status}`);
    assert.match(res.headers['content-type'], contentType, pathname);
  }
});

test('o painel clássico continua servido: virou rota própria, não sumiu', async () => {
  for (const pathname of ['/painel-classico.html', '/project.html', '/run.html', '/prompt.html', '/settings.html']) {
    const res = await request(pathname);
    assert.equal(res.status, 200, `${pathname} devolveu ${res.status}`);
  }
});

test('a raiz do painel serve o dashboard, não a home anterior', async () => {
  const raiz = await request('/');
  assert.equal(raiz.status, 200);

  // Marcas estruturais do Master Canvas, ausentes na home anterior.
  assert.match(raiz.body, /class="rail"/, 'a raiz precisa servir o shell do dashboard');
  assert.match(raiz.body, /id="stat-grid"/);
  assert.match(raiz.body, /data-page="dashboard"/);

  // E precisa ser byte a byte o mesmo que /index.html.
  const index = await request('/index.html');
  assert.equal(raiz.body, index.body);
});

test('a home nova não perdeu o cadastro de projeto da home anterior', () => {
  const html = read('index.html');

  // Sem estes campos, a página inicial deixaria de ter como registrar projeto,
  // que era a ação primária da home substituída.
  for (const id of [
    'np-id',
    'np-name',
    'np-repository-path',
    'np-github',
    'np-remote',
    'np-base-branch',
    'np-editor',
  ]) {
    assert.match(html, new RegExp(`id="${id}"`), `campo ausente no cadastro: ${id}`);
  }
  assert.match(html, /id="project-dialog"/);
  assert.match(html, /aria-modal="true"/);
});

test('a home nova cobre o que era exclusivo da home anterior', () => {
  const html = read('index.html');
  // Guarda de API, merges recentes e diagnóstico não pertencem a um projeto só
  // e viviam apenas na home antiga.
  for (const id of ['api-guard-list', 'merge-list', 'btn-run-diagnostics', 'system-status']) {
    assert.match(html, new RegExp(`id="${id}"`), `bloco ausente: ${id}`);
  }
});

test('o dashboard não abre caminho novo para fora de public/', async () => {
  const attempts = [
    '/assets/../../config/global.json',
    '/assets/..%2f..%2fconfig%2fglobal.json',
    '/index.html/../../config/global.json',
    '/../config/global.json',
  ];

  for (const attempt of attempts) {
    const res = await request(attempt);
    assert.notEqual(res.status, 200, `${attempt} não podia ter sido servido`);
    assert.equal(res.body.includes('nao-vazar'), false, `${attempt} vazou configuração`);
  }
});

test('a resposta traz a CSP que a página promete respeitar', async () => {
  const res = await request('/index.html');
  const csp = res.headers['content-security-policy'];
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /script-src 'self'/);
  assert.match(csp, /style-src 'self'/);
  assert.equal(/unsafe-inline/.test(csp), false, 'a CSP do painel não pode abrir exceção para inline');
});

test('a página do dashboard não usa estilo nem script inline', () => {
  const html = read('index.html');

  assert.equal(/\sstyle\s*=\s*"/.test(html), false, 'atributo style inline é barrado pela CSP');
  assert.equal(/<style[\s>]/i.test(html), false, 'bloco <style> é barrado pela CSP');

  // <script> só é permitido com src; script com corpo seria bloqueado.
  const scripts = html.match(/<script\b[^>]*>([\s\S]*?)<\/script>/gi) ?? [];
  for (const tag of scripts) {
    assert.match(tag, /\ssrc=/i, `script sem src tem corpo inline: ${tag.slice(0, 80)}`);
    assert.match(tag, /<script[^>]*><\/script>/i, `script com corpo: ${tag.slice(0, 80)}`);
  }

  // Manipulador inline (onclick=…) também é script inline.
  assert.equal(/\son[a-z]+\s*=\s*"/i.test(html), false, 'manipulador de evento inline no markup');
});

test('nenhum recurso externo: o painel é offline por construção', () => {
  const files = [
    ['index.html', 'html'],
    ['assets/dashboard.css', 'css'],
    ['assets/tokens.css', 'css'],
    ['assets/styles.css', 'css'],
    ['assets/dashboard.js', 'js'],
    ['assets/event-stream.js', 'js'],
  ];

  for (const [file, kind] of files) {
    const source = stripComments(read(file), kind);
    // www.w3.org aparece como namespace de SVG, que não é requisição de rede.
    const external = source.match(/https?:\/\/(?!www\.w3\.org)[^\s"')]+/g) ?? [];
    assert.deepEqual(
      external,
      [],
      `${file} referencia origem externa: ${external.join(', ')} — a CSP bloquearia e o painel é local`,
    );
    assert.equal(/@import\s+url\(/.test(source), false, `${file} usa @import`);
  }
});

test('o dashboard nunca injeta HTML a partir de dado do servidor', () => {
  const source = read('assets/dashboard.js');

  // Uso real, não menção: o cabeçalho do arquivo cita innerHTML para dizer que
  // não o usa, e um teste que casasse com a palavra proibiria o comentário.
  const forbidden = [
    [/\.innerHTML\s*=/, '.innerHTML ='],
    [/\.outerHTML\s*=/, '.outerHTML ='],
    [/\.insertAdjacentHTML\s*\(/, 'insertAdjacentHTML()'],
    [/document\s*\.\s*write\s*\(/, 'document.write()'],
    [/[^.\w]eval\s*\(/, 'eval()'],
    [/new\s+Function\s*\(/, 'new Function()'],
  ];

  for (const [pattern, label] of forbidden) {
    assert.equal(
      pattern.test(source),
      false,
      `dashboard.js usa ${label}: nome de projeto ou mensagem de erro viraria HTML`,
    );
  }

  // O caminho seguro precisa estar presente, não só o inseguro ausente.
  assert.match(source, /textContent/);
  assert.match(source, /createTextNode/);
});

test('o campo do console não é um canal de prompt arbitrário', () => {
  const source = read('assets/dashboard.js');

  // Os quatro modos de governança precisam existir por nome.
  for (const mode of ['blocked', 'readonly', 'limited', 'authorized']) {
    assert.match(source, new RegExp(`\\b${mode}\\b`), `modo de governança ausente: ${mode}`);
  }

  // O envio do console só pode desembocar no fluxo governado de autorização.
  assert.match(source, /requestDecision\('approve'\)/);

  // Nenhum endpoint de prompt livre é chamado.
  for (const forbidden of ['/api/prompt-livre', '/api/chat', '/api/agent/send', '/api/instruction']) {
    assert.equal(source.includes(forbidden), false, `dashboard.js chama canal livre ${forbidden}`);
  }
});

test('toda ação sensível passa por confirmação antes do POST', () => {
  const source = read('assets/dashboard.js');
  for (const guarded of ['cancel', 'override', 'audit']) {
    assert.match(source, new RegExp(guarded), `ação ${guarded} sumiu do dashboard`);
  }
  assert.match(source, /function confirmAction\(/);
  // A autorização exige justificativa com tamanho mínimo antes de sair do cliente.
  assert.match(source, /justificativa é obrigatória/);
});

test('identificador da URL é validado antes de virar caminho ou argumento', async () => {
  const hostis = [
    '..%2f..%2fetc%2fpasswd',
    'projeto%00nulo',
    'projeto%2F..%2F..%2Fconfig',
  ];

  for (const id of hostis) {
    const res = await request(`/api/projects/${id}`);
    assert.equal(res.status >= 400, true, `projeto ${id} devolveu ${res.status}`);
    assert.equal(res.body.includes('nao-vazar'), false, `projeto ${id} vazou configuração`);
  }
});

test('promptId hostil é recusado antes de qualquer acesso a disco', async () => {
  // A validação do promptId acontece ANTES da carga do projeto: um id hostil
  // devolve 400 (formato), não 404 (projeto inexistente). Se a ordem inverter,
  // este teste quebra — e é exatamente isso que ele existe para travar.
  const hostis = [
    '../../etc/passwd',
    'prompt; rm -rf /',
    '$(whoami)',
    '`id`',
    'prompt && curl evil.example',
    'prompt\u0000nulo',
  ];

  for (const promptId of hostis) {
    const res = await request('/api/projects/projeto/runs/execucao/override', {
      method: 'POST',
      body: { promptId, justification: 'justificativa suficiente', authorizedBy: 'teste' },
    });

    assert.equal(
      res.status,
      400,
      `promptId ${JSON.stringify(promptId)} devolveu ${res.status}: a validação de formato precisa vir primeiro`,
    );
    assert.equal(res.body.includes('nao-vazar'), false);
  }
});

test('promptId bem formado com projeto inexistente para em 404, não em erro interno', async () => {
  const res = await request('/api/projects/projeto-que-nao-existe/runs/execucao/override', {
    method: 'POST',
    body: { promptId: 'prompt-01', justification: 'justificativa suficiente', authorizedBy: 'teste' },
  });
  assert.equal(res.status, 404);
});

test('a API do painel não devolve segredo nem variável de ambiente', async () => {
  const res = await request('/api/home');
  assert.equal(res.status, 200);
  assert.equal(res.body.includes('nao-vazar'), false);

  const home = JSON.parse(res.body);
  // O guarda de API relata NOMES de variáveis, nunca valores.
  assert.equal(Object.prototype.hasOwnProperty.call(home, 'apiGuard'), true);
  assert.equal(JSON.stringify(home.apiGuard).includes('sk-'), false);
});

/*
 * Camada de tokens única.
 *
 * O painel já teve duas identidades ao mesmo tempo: a folha do dashboard
 * carregava uma paleta própria (prefixo `--fig-`) e styles.css carregava
 * outra. Trocar de página trocava de produto. Agora existe uma camada só,
 * assets/tokens.css, e as três asserções abaixo prendem isso:
 *
 *   1. a identidade anterior não voltou por nenhuma porta;
 *   2. styles.css não redeclara valor de cor — só aponta para o token;
 *   3. quem usa styles.css carrega tokens.css antes, senão cada `var(--op-*)`
 *      resolve para nada e a página abre sem cor nenhuma.
 */
test('a identidade anterior não sobreviveu em nenhuma folha', () => {
  for (const file of ['assets/tokens.css', 'assets/dashboard.css', 'assets/styles.css']) {
    assert.equal(
      read(file).includes('--fig-'),
      false,
      `${file} ainda carrega token da identidade removida`,
    );
  }
  assert.equal(read('assets/dashboard.js').includes('--fig-'), false);
});

test('styles.css consome os tokens do sistema em vez de declarar os próprios', () => {
  const legacy = read('assets/styles.css');
  const root = legacy.slice(legacy.indexOf(':root {'), legacy.indexOf('\n}', legacy.indexOf(':root {')));

  // Nenhum literal de cor no bloco de tokens: cada nome é apelido de um --op-*.
  const literais = root.match(/:\s*(#[0-9a-fA-F]{3,8}|rgba?\([^)]*\))/g) ?? [];
  assert.deepEqual(
    literais,
    [],
    `styles.css volta a declarar cor própria: ${literais.join(', ')} — isso recria a segunda paleta`,
  );
  assert.match(root, /var\(--op-/, 'o bloco :root precisa apontar para a camada de tokens');
});

test('o painel é claro em toda página, sem inversão pelo tema do sistema', () => {
  const tokens = read('assets/tokens.css');

  // Um console de operação que muda de fundo conforme a configuração do
  // sistema operacional é um console que ninguém reconhece de relance.
  assert.equal(
    /prefers-color-scheme\s*:\s*dark/.test(stripComments(tokens, 'css')),
    false,
    'tokens.css voltou a definir tema escuro',
  );
  assert.match(tokens, /color-scheme:\s*light/, 'tokens.css precisa fixar o esquema claro');

  for (const page of ['index.html', 'painel-classico.html', 'project.html', 'run.html', 'prompt.html', 'settings.html']) {
    assert.match(
      read(page),
      /<meta name="color-scheme" content="light">/,
      `${page} não fixa o esquema claro: o navegador desenharia campo e seletor escuros`,
    );
  }
});

/*
 * Altura do documento.
 *
 * O console é uma janela de altura fixa e cada coluna rola no próprio eixo.
 * `overflow-y: auto` recorta o desenho mas não impede que a altura de layout
 * do conteúdo suba pela árvore: sem contenção, o documento reportava
 * scrollHeight de 2534 com viewport de 950 e a página ganhava mil e
 * quinhentos pixels de vazio abaixo do aplicativo.
 */
test('as colunas que rolam por dentro são contidas, senão a página ganha vazio', () => {
  const css = read('assets/dashboard.css');
  const regra = css.match(/\.sidebar,\s*\.workspace,\s*\.context\s*\{[^}]*\}/);

  assert.notEqual(regra, null, 'a regra de contenção das colunas sumiu');
  assert.match(regra[0], /contain:\s*paint/, 'as colunas precisam de contain: paint');

  // E a faixa estreita precisa devolver a rolagem: empilhado, a página inteira
  // rola e conter as colunas esconderia o conteúdo abaixo da dobra.
  assert.match(
    css,
    /contain:\s*none/,
    'o empilhamento estreito precisa desfazer a contenção, senão o conteúdo fica inalcançável',
  );
});

test('o console expõe os controles do cadastro do projeto', () => {
  const html = read('index.html');
  const js = read('assets/dashboard.js');

  // Sem estes, o painel mostra projeto mas não deixa administrar nenhum.
  for (const id of ['btn-edit-project', 'btn-remove-project', 'btn-dry-run', 'link-project']) {
    assert.match(html, new RegExp(`id="${id}"`), `controle de projeto ausente: ${id}`);
  }

  // E os controles precisam chegar nas rotas que existem de verdade.
  assert.match(js, /putJson\('\/api\/projects\/'/, 'a edição não chama PUT /api/projects/:id');
  assert.match(js, /method:\s*'DELETE'/, 'a remoção não chama DELETE /api/projects/:id');
  assert.match(js, /\/dry-run'/, 'o ensaio não chama GET /api/projects/:id/dry-run');

  // Remover cadastro é destrutivo: passa pelo fluxo com justificativa.
  assert.match(
    js,
    /function removeCurrentProject\(\)[\s\S]{0,900}confirmAction\([\s\S]{0,400}?true,/,
    'a remoção precisa exigir confirmação com justificativa',
  );
});

test('prompt, execução anterior e merge levam à página que os descreve', () => {
  const js = read('assets/dashboard.js');

  // Fileira que nomeia um destino sem levar a ele é beco sem saída — era o
  // estado anterior das três listas.
  assert.match(js, /function linkRow\(/);
  assert.match(js, /'prompt\.html\?id='/, 'prompt não leva a prompt.html');
  assert.match(js, /'run\.html\?id='/, 'execução anterior não leva a run.html');
  assert.match(js, /'project\.html\?id='/, 'o projeto não leva a project.html');

  // <a href> de verdade: clique do meio, nova aba e teclado precisam funcionar.
  assert.match(js, /link\.href\s*=\s*href/);

  // Todo identificador que entra numa URL é escapado.
  for (const fn of ['promptHref', 'runHref']) {
    const corpo = js.slice(js.indexOf('function ' + fn), js.indexOf('function ' + fn) + 320);
    assert.match(corpo, /encodeURIComponent/, `${fn} monta URL sem escapar o identificador`);
  }
});

test('toda página que usa styles.css carrega tokens.css antes', () => {
  const pages = ['painel-classico.html', 'project.html', 'run.html', 'prompt.html', 'settings.html'];

  for (const page of pages) {
    const html = read(page);
    if (!html.includes('assets/styles.css')) continue;

    const tokens = html.indexOf('assets/tokens.css');
    const styles = html.indexOf('assets/styles.css');

    assert.notEqual(tokens, -1, `${page} usa styles.css sem carregar tokens.css: abriria sem cor`);
    assert.equal(tokens < styles, true, `${page} carrega tokens.css depois de styles.css`);
  }
});

test('encerra o painel', async () => {
  await server.close();
  server = null;
});
