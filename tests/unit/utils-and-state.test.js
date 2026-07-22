'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { naturalCompare, naturalSort, leadingNumber } = require('../../dist/utils/natural-sort');
const {
  writeJsonAtomicSync,
  readJsonSync,
  writeFileAtomicSync,
} = require('../../dist/utils/fs-atomic');
const { formatDuration, durationMsBetween, compactStamp } = require('../../dist/utils/time');
const { validateAgainstSchema } = require('../../dist/config/schema-validator');
const {
  defaultGlobalConfig,
  validateGlobalConfig,
} = require('../../dist/config/global-config');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'orqpeg-test-'));
}

/* ------------------------------------------------------------------------ */
/* Ordenação natural                                                         */
/* ------------------------------------------------------------------------ */

test('ordenação natural coloca 2 antes de 10 antes de 20', () => {
  const files = ['20-etapa.md', '2-etapa.md', '10-etapa.md'];
  assert.deepEqual(files.slice().sort(naturalCompare), [
    '2-etapa.md',
    '10-etapa.md',
    '20-etapa.md',
  ]);
});

test('ordenação natural é estável para prefixos com zero à esquerda', () => {
  const files = ['050-testes.md', '010-fundacao.md', '020-banco.md', '030-backend.md'];
  assert.deepEqual(files.slice().sort(naturalCompare), [
    '010-fundacao.md',
    '020-banco.md',
    '030-backend.md',
    '050-testes.md',
  ]);
});

test('ordenação natural lida com acentos e maiúsculas', () => {
  const items = ['Ást.md', 'anа.md', '1-a.md'];
  const sorted = items.slice().sort(naturalCompare);
  assert.equal(sorted[0], '1-a.md');
});

test('naturalSort aceita seletor de chave', () => {
  const items = [{ n: '10.md' }, { n: '9.md' }];
  assert.deepEqual(
    naturalSort(items, (i) => i.n).map((i) => i.n),
    ['9.md', '10.md'],
  );
});

test('leadingNumber extrai o prefixo numérico', () => {
  assert.equal(leadingNumber('010-fundacao.md'), 10);
  assert.equal(leadingNumber('sem-numero.md'), Number.MAX_SAFE_INTEGER);
});

/* ------------------------------------------------------------------------ */
/* Gravação atômica                                                          */
/* ------------------------------------------------------------------------ */

test('writeJsonAtomicSync grava e relê corretamente', () => {
  const dir = tempDir();
  const file = path.join(dir, 'estado.json');
  const value = { runId: 'run-1', prompts: [{ id: 'a', status: 'APPROVED' }] };

  assert.equal(writeJsonAtomicSync(file, value).ok, true);
  const read = readJsonSync(file);
  assert.equal(read.ok, true);
  assert.deepEqual(read.value, value);
});

test('writeJsonAtomicSync não deixa arquivos temporários para trás', () => {
  const dir = tempDir();
  const file = path.join(dir, 'estado.json');
  writeJsonAtomicSync(file, { a: 1 });
  const leftovers = fs.readdirSync(dir).filter((name) => name.endsWith('.tmp'));
  assert.deepEqual(leftovers, [], 'não deve restar arquivo .tmp');
});

test('writeJsonAtomicSync recusa valores não serializáveis sem corromper o destino', () => {
  const dir = tempDir();
  const file = path.join(dir, 'estado.json');
  writeJsonAtomicSync(file, { bom: true });

  const circular = {};
  circular.self = circular;
  const result = writeJsonAtomicSync(file, circular);

  assert.equal(result.ok, false);
  const read = readJsonSync(file);
  assert.equal(read.ok, true);
  assert.deepEqual(read.value, { bom: true }, 'o conteúdo anterior deve permanecer intacto');
});

test('a substituição é atômica: o arquivo nunca fica parcialmente escrito', () => {
  const dir = tempDir();
  const file = path.join(dir, 'grande.json');
  const big = { data: 'x'.repeat(500_000) };

  writeJsonAtomicSync(file, { data: 'inicial' });
  writeJsonAtomicSync(file, big);

  const read = readJsonSync(file);
  assert.equal(read.ok, true);
  assert.equal(read.value.data.length, 500_000);
});

test('readJsonSync reporta JSON corrompido como STATE_CORRUPT', () => {
  const dir = tempDir();
  const file = path.join(dir, 'ruim.json');
  writeFileAtomicSync(file, '{ isso nao e json');
  const read = readJsonSync(file);
  assert.equal(read.ok, false);
  assert.equal(read.error.code, 'STATE_CORRUPT');
});

test('readJsonSync reporta ausência como CONFIG_NOT_FOUND', () => {
  const read = readJsonSync(path.join(tempDir(), 'inexistente.json'));
  assert.equal(read.ok, false);
  assert.equal(read.error.code, 'CONFIG_NOT_FOUND');
});

test('gravação funciona em caminhos com espaços e acentos', () => {
  const dir = path.join(tempDir(), 'Meus Projetos', 'Ação Café');
  const file = path.join(dir, 'estado.json');
  assert.equal(writeJsonAtomicSync(file, { ok: true }).ok, true);
  assert.equal(readJsonSync(file).value.ok, true);
});

/* ------------------------------------------------------------------------ */
/* Tempo                                                                     */
/* ------------------------------------------------------------------------ */

test('formatDuration produz saída legível em pt-BR', () => {
  assert.equal(formatDuration(850), '850ms');
  assert.equal(formatDuration(2400), '2,4s');
  assert.match(formatDuration(65_000), /^1m 05s$/);
  assert.match(formatDuration(3_723_000), /^1h 02m 03s$/);
  assert.equal(formatDuration(-1), '—');
});

test('durationMsBetween nunca devolve valor negativo', () => {
  assert.equal(durationMsBetween('2026-07-21T10:00:10Z', '2026-07-21T10:00:00Z'), 0);
  assert.equal(durationMsBetween('2026-07-21T10:00:00Z', '2026-07-21T10:00:05Z'), 5000);
});

test('compactStamp produz um carimbo utilizável em nome de branch', () => {
  assert.match(compactStamp(new Date(2026, 6, 21, 14, 30, 5)), /^20260721-143005$/);
});

/* ------------------------------------------------------------------------ */
/* Validador de JSON Schema                                                  */
/* ------------------------------------------------------------------------ */

test('validador aceita objeto conforme o schema', () => {
  const schema = {
    type: 'object',
    properties: {
      verdict: { type: 'string', enum: ['APPROVED', 'CHANGES_REQUESTED', 'BLOCKED'] },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
      issues: { type: 'array', items: { type: 'string' } },
    },
    required: ['verdict', 'confidence'],
    additionalProperties: false,
  };

  assert.equal(
    validateAgainstSchema({ verdict: 'APPROVED', confidence: 0.95, issues: [] }, schema).valid,
    true,
  );
});

test('validador rejeita enum inválido, faixa numérica e propriedade extra', () => {
  const schema = {
    type: 'object',
    properties: {
      verdict: { type: 'string', enum: ['APPROVED'] },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
    },
    required: ['verdict', 'confidence'],
    additionalProperties: false,
  };

  assert.equal(validateAgainstSchema({ verdict: 'TALVEZ', confidence: 0.5 }, schema).valid, false);
  assert.equal(validateAgainstSchema({ verdict: 'APPROVED', confidence: 1.5 }, schema).valid, false);
  assert.equal(validateAgainstSchema({ verdict: 'APPROVED' }, schema).valid, false);
  assert.equal(
    validateAgainstSchema({ verdict: 'APPROVED', confidence: 1, extra: 1 }, schema).valid,
    false,
  );
});

test('validador aplica pattern, minLength e tipos nulos', () => {
  const schema = {
    type: 'object',
    properties: {
      sha: { type: 'string', pattern: '^[0-9a-fA-F]{7,40}$' },
      nome: { type: 'string', minLength: 1 },
      opcional: { type: ['string', 'null'] },
    },
    required: ['sha', 'nome'],
  };

  assert.equal(
    validateAgainstSchema({ sha: 'a1b2c3d', nome: 'x', opcional: null }, schema).valid,
    true,
  );
  assert.equal(validateAgainstSchema({ sha: 'zzz', nome: 'x' }, schema).valid, false);
  assert.equal(validateAgainstSchema({ sha: 'a1b2c3d', nome: '' }, schema).valid, false);
});

test('validador resolve $ref para definitions', () => {
  const schema = {
    definitions: {
      issue: {
        type: 'object',
        properties: { severity: { type: 'string', enum: ['blocking', 'minor'] } },
        required: ['severity'],
      },
    },
    type: 'object',
    properties: { issues: { type: 'array', items: { $ref: '#/definitions/issue' } } },
    required: ['issues'],
  };

  assert.equal(validateAgainstSchema({ issues: [{ severity: 'blocking' }] }, schema).valid, true);
  assert.equal(validateAgainstSchema({ issues: [{ severity: 'urgente' }] }, schema).valid, false);
});

test('validador reporta o caminho do problema', () => {
  const schema = {
    type: 'object',
    properties: { a: { type: 'object', properties: { b: { type: 'number' } } } },
  };
  const outcome = validateAgainstSchema({ a: { b: 'texto' } }, schema);
  assert.equal(outcome.valid, false);
  assert.equal(outcome.issues[0].path, '$.a.b');
});

/* ------------------------------------------------------------------------ */
/* Configuração global                                                       */
/* ------------------------------------------------------------------------ */

test('configuração padrão é válida e segura', () => {
  const config = defaultGlobalConfig();
  assert.equal(config.panel.host, '127.0.0.1');
  assert.equal(config.git.allowForcePush, false);
  assert.equal(config.security.blockWhenApiKeysPresent, true);
  assert.equal(validateGlobalConfig(config).ok, true);
});

test('validateGlobalConfig recusa escuta pública do painel', () => {
  const config = defaultGlobalConfig();
  config.panel.host = '0.0.0.0';
  const result = validateGlobalConfig(config);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'CONFIG_INVALID');
});

test('validateGlobalConfig recusa habilitar force push', () => {
  const config = defaultGlobalConfig();
  config.git.allowForcePush = true;
  assert.equal(validateGlobalConfig(config).ok, false);
});

test('validateGlobalConfig recusa porta fora da faixa', () => {
  const config = defaultGlobalConfig();
  config.panel.port = 80;
  assert.equal(validateGlobalConfig(config).ok, false);
});
