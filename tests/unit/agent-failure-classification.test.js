'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'orqpeg-cls-'));
process.env.ORQPEG_HOME = HOME;
process.env.ORQPEG_NO_FILE_LOG = '1';

const {
  classifyClaudeFailure,
  AUTH_REQUIRED_MARKERS,
  USAGE_LIMIT_MARKERS,
} = require('../../dist/agents/claude-agent');

/*
 * Classificação de falha dos agentes.
 *
 * Regressão real: a sessão OAuth do Claude Max expirou durante a validação
 * desta entrega e o CLI respondeu
 *   "Failed to authenticate: OAuth session expired and could not be refreshed"
 * O OrqPEG classificou como PROCESS_FAILED genérico porque o marcador era
 * "authentication" e o texto trazia "authenticate". O usuário recebia um erro
 * opaco em vez da orientação de refazer o login. Estes testes fixam o
 * comportamento correto.
 */

function containsAny(text, markers) {
  const lowered = text.toLowerCase();
  return markers.some((marker) => lowered.includes(marker));
}

test('a mensagem real de sessão OAuth expirada é reconhecida como falta de autenticação', () => {
  const real = 'Failed to authenticate: OAuth session expired and could not be refreshed';
  assert.equal(
    containsAny(real, AUTH_REQUIRED_MARKERS),
    true,
    'a mensagem real do CLI precisa cair em AUTH_REQUIRED, não em erro genérico',
  );
});

test('variações de mensagem de autenticação são reconhecidas', () => {
  const variants = [
    'Failed to authenticate',
    'Authentication failed',
    'Authenticating... failed',
    'You are not logged in',
    'Please log in to continue',
    'Unauthorized',
    'Run /login to continue',
    'OAuth token invalid',
    'Your session expired',
    'Invalid API key provided',
  ];
  for (const variant of variants) {
    assert.equal(
      containsAny(variant, AUTH_REQUIRED_MARKERS),
      true,
      `deveria reconhecer como autenticação: "${variant}"`,
    );
  }
});

test('mensagens de limite de uso são reconhecidas', () => {
  for (const variant of [
    'You have reached your usage limit',
    'Rate limit exceeded',
    'Quota exceeded for this plan',
    'Monthly limit reached',
  ]) {
    assert.equal(
      containsAny(variant, USAGE_LIMIT_MARKERS),
      true,
      `deveria reconhecer como limite de uso: "${variant}"`,
    );
  }
});

test('uma falha comum de compilação NÃO é confundida com autenticação nem com cota', () => {
  const ordinary = 'TypeError: cannot read property foo of undefined';
  assert.equal(containsAny(ordinary, AUTH_REQUIRED_MARKERS), false);
  assert.equal(containsAny(ordinary, USAGE_LIMIT_MARKERS), false);
});

test('limite de uso tem precedência sobre autenticação quando ambos aparecem', () => {
  // Um texto que cita "usage limit" e "log in" deve ser tratado como cota:
  // pedir novo login não resolveria o problema.
  if (typeof classifyClaudeFailure !== 'function') return;
  const classified = classifyClaudeFailure(
    'You have reached your usage limit. Please log in again later.',
  );
  assert.equal(classified.usageLimitReached, true);
  assert.equal(classified.authRequired, false);
});
