'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'orqpeg-inj-'));
process.env.ORQPEG_HOME = HOME;
process.env.ORQPEG_NO_FILE_LOG = '1';

const { tokenizeCommand } = require('../../dist/tests-runner/test-runner');
const { runProcess, commandExists } = require('../../dist/agents/process-runner');
const { extractJsonBlock } = require('../../dist/review/review-parser');
const { normalizeGitHubRemote, remoteMatchesRepository } = require('../../dist/git/git');

/* ------------------------------------------------------------------------ */
/* Tokenização de comandos — sem shell, sem injeção                          */
/* ------------------------------------------------------------------------ */

test('tokenizeCommand separa executável e argumentos', () => {
  assert.deepEqual(tokenizeCommand('npm run lint'), ['npm', 'run', 'lint']);
  assert.deepEqual(tokenizeCommand('npm test'), ['npm', 'test']);
});

test('tokenizeCommand respeita aspas duplas e simples', () => {
  assert.deepEqual(tokenizeCommand('node -e "console.log(1)"'), [
    'node',
    '-e',
    'console.log(1)',
  ]);
  assert.deepEqual(tokenizeCommand("node -e 'a b'"), ['node', '-e', 'a b']);
});

test('tokenizeCommand preserva caminhos com espaços entre aspas', () => {
  assert.deepEqual(tokenizeCommand('node "C:\\Meus Projetos\\app.js"'), [
    'node',
    'C:\\Meus Projetos\\app.js',
  ]);
});

test('metacaracteres de shell viram argumentos literais, nunca operadores', () => {
  // Como não há shell, "&&", "|" e ";" são apenas texto: não encadeiam comandos.
  const tokens = tokenizeCommand('npm test && calc.exe');
  assert.equal(tokens[0], 'npm');
  assert.ok(tokens.includes('&&'), 'o "&&" deve permanecer um argumento literal');
  assert.ok(tokens.includes('calc.exe'));
});

test('tokenizeCommand ignora espaços extras e string vazia', () => {
  assert.deepEqual(tokenizeCommand('   npm    test   '), ['npm', 'test']);
  assert.deepEqual(tokenizeCommand('   '), []);
});

/* ------------------------------------------------------------------------ */
/* Runner de processos                                                       */
/* ------------------------------------------------------------------------ */

test('runProcess executa e captura a saída', async () => {
  const result = await runProcess(process.execPath, ['-e', 'process.stdout.write("ola")'], {
    cwd: HOME,
    timeoutMs: 30_000,
  });
  assert.equal(result.status, 'COMPLETED');
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /ola/);
  assert.ok(result.durationMs >= 0);
  assert.equal(result.timedOut, false);
});

test('runProcess reporta código de saída diferente de zero como FAILED', async () => {
  const result = await runProcess(process.execPath, ['-e', 'process.exit(3)'], {
    cwd: HOME,
    timeoutMs: 30_000,
  });
  assert.equal(result.status, 'FAILED');
  assert.equal(result.exitCode, 3);
});

test('runProcess devolve COMMAND_NOT_FOUND sem lançar exceção', async () => {
  const result = await runProcess('comando-que-nao-existe-orqpeg-xyz', [], {
    cwd: HOME,
    timeoutMs: 15_000,
  });
  assert.equal(result.status, 'COMMAND_NOT_FOUND');
});

test('runProcess honra o timeout e marca TIMEOUT', async () => {
  const result = await runProcess(
    process.execPath,
    ['-e', 'setTimeout(() => {}, 60000)'],
    { cwd: HOME, timeoutMs: 1500 },
  );
  assert.equal(result.status, 'TIMEOUT');
  assert.equal(result.timedOut, true);
});

test('runProcess honra AbortSignal e marca INTERRUPTED', async () => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 300);
  const result = await runProcess(
    process.execPath,
    ['-e', 'setTimeout(() => {}, 60000)'],
    { cwd: HOME, timeoutMs: 60_000, signal: controller.signal },
  );
  assert.equal(result.status, 'INTERRUPTED');
});

test('argumentos com metacaracteres chegam literalmente ao processo', async () => {
  const payload = 'a && b | c ; d $(e) `f`';
  const result = await runProcess(
    process.execPath,
    ['-e', 'process.stdout.write(process.argv[1])', payload],
    { cwd: HOME, timeoutMs: 30_000 },
  );
  assert.equal(result.status, 'COMPLETED');
  assert.equal(
    result.stdout.trim(),
    payload,
    'o argumento não pode ser reinterpretado por um shell',
  );
});

test('o ambiente do filho não recebe chaves de API', async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-ant-valor-de-teste-para-vazamento';
  try {
    const result = await runProcess(
      process.execPath,
      ['-e', 'process.stdout.write(String(process.env.ANTHROPIC_API_KEY))'],
      { cwd: HOME, timeoutMs: 30_000 },
    );
    assert.equal(result.status, 'COMPLETED');
    assert.equal(
      result.stdout.trim(),
      'undefined',
      'a chave de API não pode chegar ao processo filho',
    );
  } finally {
    delete process.env.ANTHROPIC_API_KEY;
  }
});

test('o processo filho recebe o marcador ORQPEG_MANAGED', async () => {
  const result = await runProcess(
    process.execPath,
    ['-e', 'process.stdout.write(String(process.env.ORQPEG_MANAGED))'],
    { cwd: HOME, timeoutMs: 30_000 },
  );
  assert.equal(result.stdout.trim(), '1');
});

test('commandExists reconhece o Node e recusa um comando inexistente', async () => {
  assert.equal(await commandExists(process.execPath), true);
  assert.equal(await commandExists('comando-que-nao-existe-orqpeg-xyz'), false);
});

/* ------------------------------------------------------------------------ */
/* Extração de JSON das respostas de IA                                      */
/* ------------------------------------------------------------------------ */

test('extractJsonBlock lê JSON puro', () => {
  const result = extractJsonBlock('{"verdict":"APPROVED"}');
  assert.equal(result.ok, true);
  assert.equal(result.value.verdict, 'APPROVED');
});

test('extractJsonBlock lê JSON dentro de cerca de código', () => {
  const raw = ['Aqui está a revisão:', '```json', '{"verdict":"BLOCKED"}', '```'].join('\n');
  const result = extractJsonBlock(raw);
  assert.equal(result.ok, true);
  assert.equal(result.value.verdict, 'BLOCKED');
});

test('extractJsonBlock lê JSON cercado por texto explicativo', () => {
  const raw = 'Analisei tudo.\n{"verdict":"CHANGES_REQUESTED","confidence":0.4}\nEspero ter ajudado.';
  const result = extractJsonBlock(raw);
  assert.equal(result.ok, true);
  assert.equal(result.value.verdict, 'CHANGES_REQUESTED');
});

test('extractJsonBlock respeita chaves dentro de strings', () => {
  const raw = '{"summary":"usa { e } no texto","verdict":"APPROVED"}';
  const result = extractJsonBlock(raw);
  assert.equal(result.ok, true);
  assert.equal(result.value.verdict, 'APPROVED');
  assert.equal(result.value.summary, 'usa { e } no texto');
});

test('extractJsonBlock respeita aspas escapadas', () => {
  const raw = '{"summary":"ele disse \\"ok\\" e saiu","verdict":"APPROVED"}';
  const result = extractJsonBlock(raw);
  assert.equal(result.ok, true);
  assert.equal(result.value.verdict, 'APPROVED');
});

test('extractJsonBlock falha de forma explícita quando não há JSON', () => {
  const result = extractJsonBlock('Desculpe, não consegui completar a revisão.');
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'REVIEW_INVALID_JSON');
});

/* ------------------------------------------------------------------------ */
/* Verificação do remoto                                                     */
/* ------------------------------------------------------------------------ */

test('normalizeGitHubRemote entende todas as formas de URL', () => {
  const expected = 'maquinanerd/OrqPEG';
  for (const url of [
    'https://github.com/maquinanerd/OrqPEG.git',
    'https://github.com/maquinanerd/OrqPEG',
    'git@github.com:maquinanerd/OrqPEG.git',
    'ssh://git@github.com/maquinanerd/OrqPEG.git',
  ]) {
    assert.equal(normalizeGitHubRemote(url), expected, `falhou para ${url}`);
  }
});

test('normalizeGitHubRemote devolve null para remoto não-GitHub', () => {
  assert.equal(normalizeGitHubRemote('https://gitlab.com/a/b.git'), null);
});

test('remoteMatchesRepository é case-insensitive e recusa repositório errado', () => {
  assert.equal(
    remoteMatchesRepository('https://github.com/maquinanerd/OrqPEG.git', 'maquinanerd/orqpeg'),
    true,
  );
  assert.equal(
    remoteMatchesRepository('https://github.com/maquinanerd/OrqPEG.git', 'maquinanerd/OrqPEGe'),
    false,
    'OrqPEGe NÃO é OrqPEG',
  );
  assert.equal(
    remoteMatchesRepository('https://github.com/outro/OrqPEG.git', 'maquinanerd/OrqPEG'),
    false,
    'outro dono não pode ser aceito',
  );
});
