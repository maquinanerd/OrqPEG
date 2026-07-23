'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildSanitizedEnv,
  buildToolEnv,
} = require('../../dist/security/env-sanitizer');
const {
  inspectApiEnvironment,
  assertChildEnvIsClean,
  BLOCKING_API_ENV_VARS,
} = require('../../dist/security/api-guard');
const {
  validateIdentifier,
  resolveWithinRoot,
  validateAbsolutePath,
} = require('../../dist/security/path-guard');
const { validateBranchName, slugifyForBranch } = require('../../dist/security/branch-name');
const { redactText, redactObject } = require('../../dist/utils/redact');

/* ------------------------------------------------------------------------ */
/* Zero API: sanitização do ambiente                                         */
/* ------------------------------------------------------------------------ */

test('buildSanitizedEnv remove todas as variáveis de API do ambiente filho', () => {
  const source = {
    PATH: 'C:\\Windows',
    ANTHROPIC_API_KEY: 'sk-ant-valor-secreto-que-nunca-deve-vazar',
    OPENAI_API_KEY: 'sk-proj-outro-valor-secreto',
    CODEX_API_KEY: 'codex-secreto',
    HOME: 'C:\\Users\\pablo',
  };

  const { env, removed } = buildSanitizedEnv({ source });

  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.CODEX_API_KEY, undefined);
  assert.equal(env.PATH, 'C:\\Windows');
  assert.equal(env.HOME, 'C:\\Users\\pablo');
  assert.equal(env.ORQPEG_MANAGED, '1');

  assert.ok(removed.includes('ANTHROPIC_API_KEY'));
  assert.ok(removed.includes('OPENAI_API_KEY'));
  assert.ok(removed.includes('CODEX_API_KEY'));
});

test('a remoção é case-insensitive, como o ambiente do Windows', () => {
  const { env } = buildSanitizedEnv({
    source: { anthropic_api_key: 'sk-ant-minusculo', Openai_Api_Key: 'sk-misto' },
  });
  assert.equal(Object.keys(env).some((k) => k.toLowerCase() === 'anthropic_api_key'), false);
  assert.equal(Object.keys(env).some((k) => k.toLowerCase() === 'openai_api_key'), false);
});

test('o ambiente do processo pai NUNCA é modificado', () => {
  const sentinel = 'sk-ant-sentinela-do-teste';
  process.env.ANTHROPIC_API_KEY = sentinel;
  try {
    buildSanitizedEnv();
    buildToolEnv();
    assert.equal(
      process.env.ANTHROPIC_API_KEY,
      sentinel,
      'a sanitização não pode alterar o ambiente do processo pai',
    );
  } finally {
    delete process.env.ANTHROPIC_API_KEY;
  }
});

test('buildToolEnv também limpa as chaves para ferramentas não-IA', () => {
  const env = buildToolEnv({ source: { OPENAI_API_KEY: 'sk-proj-x', PATH: 'p' } });
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.PATH, 'p');
});

test('assertChildEnvIsClean detecta vazamento antes do spawn', () => {
  const dirty = { ANTHROPIC_API_KEY: 'sk-ant-vazou' };
  const result = assertChildEnvIsClean(dirty, BLOCKING_API_ENV_VARS);
  assert.equal(result.clean, false);
  assert.deepEqual(result.leaked, ['ANTHROPIC_API_KEY']);

  const clean = assertChildEnvIsClean({ PATH: 'x' }, BLOCKING_API_ENV_VARS);
  assert.equal(clean.clean, true);
  assert.deepEqual(clean.leaked, []);
});

test('inspectApiEnvironment reporta apenas nomes, jamais valores', () => {
  const report = inspectApiEnvironment({
    env: { ANTHROPIC_API_KEY: 'sk-ant-nunca-exposto', ANTHROPIC_BASE_URL: 'https://gw.local' },
  });

  assert.deepEqual(report.presentKeys, ['ANTHROPIC_API_KEY']);
  assert.ok(report.warnKeys.includes('ANTHROPIC_BASE_URL'));
  assert.equal(report.blocked, true);

  const serialized = JSON.stringify(report);
  assert.equal(
    serialized.includes('sk-ant-nunca-exposto'),
    false,
    'o valor da chave não pode aparecer no relatório',
  );
  assert.equal(serialized.includes('gw.local'), false);
});

test('variável vazia não conta como presente', () => {
  const report = inspectApiEnvironment({ env: { ANTHROPIC_API_KEY: '   ' } });
  assert.deepEqual(report.presentKeys, []);
  assert.equal(report.blocked, false);
});

/* ------------------------------------------------------------------------ */
/* Redação de segredos                                                       */
/* ------------------------------------------------------------------------ */

test('redactText remove padrões de segredo conhecidos', () => {
  const input = [
    'chave anthropic sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAA',
    'token github ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    'pat github_pat_AAAAAAAAAAAAAAAAAAAAAAA',
  ].join('\n');

  const output = redactText(input);
  assert.equal(output.includes('sk-ant-api03'), false);
  assert.equal(output.includes('ghp_AAAA'), false);
  assert.equal(output.includes('github_pat_AAA'), false);
  assert.ok(output.includes('«REDACTED»'));
});

test('redactObject mascara campos com nome sensível', () => {
  const output = redactObject({
    ok: 'visivel',
    api_key: 'segredo',
    nested: { authorization: 'Bearer abc', keep: 'mantido' },
  });
  assert.equal(output.ok, 'visivel');
  assert.equal(output.api_key, '«REDACTED»');
  assert.equal(output.nested.authorization, '«REDACTED»');
  assert.equal(output.nested.keep, 'mantido');
});

/* ------------------------------------------------------------------------ */
/* Path traversal                                                            */
/* ------------------------------------------------------------------------ */

const ROOT = process.platform === 'win32' ? 'C:\\OrqPEG\\public' : '/srv/orqpeg/public';

test('resolveWithinRoot aceita caminhos legítimos', () => {
  for (const relative of ['index.html', 'assets/app.js', 'assets/styles.css']) {
    const result = resolveWithinRoot(ROOT, relative);
    assert.equal(result.ok, true, `deveria aceitar ${relative}`);
  }
});

test('resolveWithinRoot bloqueia todas as formas de traversal', () => {
  const attacks = [
    '../secret.txt',
    '../../Windows/System32/config/SAM',
    '..\\..\\config\\global.json',
    'assets/../../../etc/passwd',
    '%2e%2e/secret',
    '%252e%252e/secret',
    '/etc/passwd',
    'C:\\Windows\\win.ini',
    '....//secret',
  ];
  for (const attack of attacks) {
    const result = resolveWithinRoot(ROOT, attack);
    assert.equal(result.ok, false, `deveria bloquear: ${attack}`);
    assert.equal(result.error.code, 'PATH_UNSAFE');
  }
});

test('resolveWithinRoot bloqueia bytes nulos e caracteres de controle', () => {
  const withNull = `index.html${String.fromCharCode(0)}.png`;
  assert.equal(resolveWithinRoot(ROOT, withNull).ok, false);
  const withControl = `assets/${String.fromCharCode(10)}app.js`;
  assert.equal(resolveWithinRoot(ROOT, withControl).ok, false);
});

/* ------------------------------------------------------------------------ */
/* Identificadores                                                           */
/* ------------------------------------------------------------------------ */

test('validateIdentifier aceita slugs válidos', () => {
  for (const value of ['screen', 'meu-projeto', 'app_2', 'run-20260721-001']) {
    assert.equal(validateIdentifier(value).ok, true, `deveria aceitar ${value}`);
  }
});

test('validateIdentifier rejeita separadores, traversal e nomes reservados', () => {
  const invalid = ['..', '../x', 'a/b', 'a\\b', 'CON', 'nul', 'con.txt', '', '  ', '-inicio', 'fim.'];
  for (const value of invalid) {
    assert.equal(validateIdentifier(value).ok, false, `deveria rejeitar "${value}"`);
  }
});

test('validateAbsolutePath exige caminho absoluto', () => {
  assert.equal(validateAbsolutePath('relativo/caminho').ok, false);
  const absolute = process.platform === 'win32' ? 'C:\\Projetos\\App' : '/projetos/app';
  assert.equal(validateAbsolutePath(absolute).ok, true);
});

test('validateAbsolutePath aceita caminhos com espaços e acentos', () => {
  const value = process.platform === 'win32' ? 'E:\\Meus Projetos\\Ação' : '/meus projetos/ação';
  const result = validateAbsolutePath(value);
  assert.equal(result.ok, true);
});

/* ------------------------------------------------------------------------ */
/* Nomes de branch — proteção contra injeção de flag                         */
/* ------------------------------------------------------------------------ */

test('validateBranchName aceita nomes canônicos do OrqPEG', () => {
  assert.equal(validateBranchName('orqpeg/screen/run-20260721-001').ok, true);
  assert.equal(validateBranchName('main').ok, true);
  assert.equal(validateBranchName('feat/orqpeg-initial-platform').ok, true);
});

test('validateBranchName rejeita injeção de opção e metacaracteres de shell', () => {
  const attacks = [
    '--upload-pack=calc.exe',
    '-f',
    'branch; rm -rf /',
    'branch && whoami',
    'branch | more',
    'branch$(id)',
    'branch`id`',
    'a..b',
    'a//b',
    'refs/heads/x.lock',
    'trailing/',
    '@',
    'has@{reflog}',
    'espaço no nome',
  ];
  for (const attack of attacks) {
    assert.equal(validateBranchName(attack).ok, false, `deveria rejeitar: ${attack}`);
  }
});

test('slugifyForBranch normaliza acentos e produz nome seguro', () => {
  assert.equal(slugifyForBranch('Ação Café 01'), 'acao-cafe-01');
  assert.equal(validateBranchName(`orqpeg/${slugifyForBranch('Projeto Ímpar!')}/run-1`).ok, true);
});
