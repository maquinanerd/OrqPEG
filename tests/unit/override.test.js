'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'orqpeg-ovr-'));
process.env.ORQPEG_HOME = HOME;
process.env.ORQPEG_NO_FILE_LOG = '1';

const {
  grantManualOverride,
  consumeOverride,
  hasPendingOverride,
  pendingOverrideCount,
  isOverridable,
  describeOverrides,
  NEVER_OVERRIDABLE,
  MIN_JUSTIFICATION_LENGTH,
} = require('../../dist/execution/override');
const { evaluateLoopGuard, createPromptBudget, wasOverrideApplied } = require('../../dist/execution/loop-guard');
const { defaultLoopGuardConfig } = require('../../dist/execution/loop-guard-config');
const { syntheticLoopGuardPolicy } = require('../helpers/policy');

const JUSTIFICATIVA = 'O teste falhava por uma dependencia que acabei de instalar manualmente.';

function runWith(trigger, severity, overrides = []) {
  return {
    runId: 'run-1',
    projectId: 'p',
    state: 'LOOP_GUARD_TRIGGERED',
    budgets: [createPromptBudget('010-x')],
    overrides,
    lastLoopGuard: trigger
      ? { allowed: false, severity, trigger, reason: 'motivo', evidence: {}, nextActions: [] }
      : null,
  };
}

function grant(run, extra = {}) {
  return grantManualOverride({
    run,
    promptId: '010-x',
    justification: JUSTIFICATIVA,
    authorizedBy: 'pablo',
    policy: syntheticLoopGuardPolicy(),
    ...extra,
  });
}

/* ------------------------------------------------------------------------ */
/* Quem pode e quem não pode                                                 */
/* ------------------------------------------------------------------------ */

test('a lista de gatilhos não-autorizáveis é exatamente a esperada', () => {
  const esperados = [
    'FORBIDDEN_AREA_CHANGED',
    'SCOPE_VIOLATION',
    'PROMPT_CHANGED_DURING_RUN',
    'PROJECT_CONTEXT_CHANGED',
    'AUTH_REQUIRED',
    'USAGE_LIMIT_REACHED',
    'TOOL_MISSING',
    'INCOMPLETE_REVIEW_EVIDENCE',
  ];
  for (const trigger of esperados) {
    assert.equal(NEVER_OVERRIDABLE.has(trigger), true, `${trigger} deve ser não-autorizável`);
    assert.equal(isOverridable(trigger), false, `${trigger} não pode admitir override`);
  }
});

test('paradas brandas admitem override', () => {
  for (const trigger of [
    'MAX_ATTEMPTS_REACHED',
    'NO_PROGRESS',
    'REPEATED_REVIEW_ISSUES',
    'REPEATED_TEST_FAILURE',
    'OSCILLATION_DETECTED',
    'PROCESS_TIMEOUT',
  ]) {
    assert.equal(isOverridable(trigger), true, `${trigger} deveria admitir override`);
  }
});

test('BACKEND RECUSA override para todo gatilho não-autorizável', () => {
  for (const trigger of NEVER_OVERRIDABLE) {
    const result = grant(runWith(trigger, 'hard_stop'));
    assert.equal(result.ok, false, `${trigger} não pode ser autorizado`);
    assert.match(result.error.message, /não admite tentativa adicional|parada dura|não permite/i);
  }
});

/* ------------------------------------------------------------------------ */
/* Concessão válida                                                          */
/* ------------------------------------------------------------------------ */

test('parada branda com justificativa é autorizada', () => {
  const result = grant(runWith('REPEATED_TEST_FAILURE', 'soft_stop'));
  assert.equal(result.ok, true, result.ok ? '' : result.error.message);
  assert.equal(result.value.override.trigger, 'REPEATED_TEST_FAILURE');
  assert.equal(result.value.override.consumed, false);
  assert.equal(result.value.override.authorizedBy, 'pablo');
  assert.equal(result.value.override.justification, JUSTIFICATIVA);
  assert.ok(result.value.override.authorizedAt, 'a data precisa ser registrada');
});

test('sem autor identificado, registra o operador local', () => {
  const result = grant(runWith('NO_PROGRESS', 'soft_stop'), { authorizedBy: '   ' });
  assert.equal(result.ok, true);
  assert.equal(result.value.override.authorizedBy, 'operador local');
});

/* ------------------------------------------------------------------------ */
/* Justificativa                                                             */
/* ------------------------------------------------------------------------ */

test('justificativa vazia ou curta é recusada', () => {
  for (const texto of ['', '   ', 'ok', 'porque sim']) {
    const result = grant(runWith('NO_PROGRESS', 'soft_stop'), { justification: texto });
    assert.equal(result.ok, false, `"${texto}" não deveria bastar`);
    assert.match(result.error.message, new RegExp(String(MIN_JUSTIFICATION_LENGTH)));
  }
});

test('justificativa longa demais é recusada', () => {
  const result = grant(runWith('NO_PROGRESS', 'soft_stop'), { justification: 'x'.repeat(5000) });
  assert.equal(result.ok, false);
});

/* ------------------------------------------------------------------------ */
/* Estado da execução                                                        */
/* ------------------------------------------------------------------------ */

test('sem parada registrada não há o que autorizar', () => {
  const result = grant(runWith(null, 'none'));
  assert.equal(result.ok, false);
  assert.match(result.error.message, /não há parada/i);
});

test('execução fora de LOOP_GUARD_TRIGGERED recusa override', () => {
  const run = runWith('NO_PROGRESS', 'soft_stop');
  run.state = 'RUNNING_CLAUDE';
  const result = grant(run);
  assert.equal(result.ok, false);
  assert.match(result.error.message, /RUNNING_CLAUDE/);
});

test('prompt inexistente na execução é recusado', () => {
  const result = grant(runWith('NO_PROGRESS', 'soft_stop'), { promptId: '999-inexistente' });
  assert.equal(result.ok, false);
  assert.match(result.error.message, /não pertence/i);
});

/* ------------------------------------------------------------------------ */
/* Um único override                                                         */
/* ------------------------------------------------------------------------ */

test('o segundo override para o mesmo prompt é recusado', () => {
  const primeiro = grant(runWith('NO_PROGRESS', 'soft_stop'));
  assert.equal(primeiro.ok, true);

  // Consome o primeiro e tenta de novo.
  const consumido = consumeOverride(primeiro.value.run, '010-x');
  const segundo = grant(consumido);

  assert.equal(segundo.ok, false, 'o limite é de um override por prompt');
  assert.match(segundo.error.message, /limite de 1 override/i);
});

test('override pendente impede conceder outro', () => {
  const primeiro = grant(runWith('NO_PROGRESS', 'soft_stop'));
  const segundo = grant(primeiro.value.run);
  assert.equal(segundo.ok, false);
  assert.match(segundo.error.message, /pendente/i);
});

test('projeto com limite zero não permite override algum', () => {
  const config = syntheticLoopGuardPolicy({ maxManualOverridesPerPrompt: 0 });
  const result = grant(runWith('NO_PROGRESS', 'soft_stop'), { policy: config });
  assert.equal(result.ok, false);
  assert.match(result.error.message, /não permite override/i);
});

/* ------------------------------------------------------------------------ */
/* Consumo                                                                   */
/* ------------------------------------------------------------------------ */

test('consumir marca como usado e incrementa o contador do orçamento', () => {
  const concedido = grant(runWith('NO_PROGRESS', 'soft_stop'));
  assert.equal(hasPendingOverride(concedido.value.run, '010-x'), true);
  assert.equal(pendingOverrideCount(concedido.value.run, '010-x'), 1);

  const consumido = consumeOverride(concedido.value.run, '010-x');
  assert.equal(hasPendingOverride(consumido, '010-x'), false);
  assert.equal(consumido.overrides[0].consumed, true);
  assert.equal(consumido.budgets[0].manualOverridesUsed, 1);
});

test('consumir duas vezes não incrementa duas vezes', () => {
  const concedido = grant(runWith('NO_PROGRESS', 'soft_stop'));
  const uma = consumeOverride(concedido.value.run, '010-x');
  const duas = consumeOverride(uma, '010-x');
  assert.equal(duas.budgets[0].manualOverridesUsed, 1, 'não pode ser reaproveitado');
});

/* ------------------------------------------------------------------------ */
/* Efeito no Loop Guard                                                      */
/* ------------------------------------------------------------------------ */

function gateScenario(overrideAvailable, budgetPatch = {}) {
  const now = Date.now();
  return {
    config: defaultLoopGuardConfig(),
    budget: { ...createPromptBudget('010-x'), ...budgetPatch },
    maxAttemptsPerPrompt: 3,
    nextAttempt: 4,
    nowMs: now,
    runStartedAtMs: now - 1000,
    pauseRequested: false,
    cancelRequested: false,
    aborted: false,
    lastAgentErrorCode: null,
    promptHashNow: 'p', promptHashSnapshot: 'p',
    contextHashNow: 'c', contextHashSnapshot: 'c',
    configHashNow: 'g', configHashSnapshot: 'g',
    previousDiffFingerprint: null, currentDiffFingerprint: 'A',
    reviewFingerprint: null, testFailureFingerprint: null, lastReview: null,
    scopeViolations: [], forbiddenViolations: [],
    changedFileCount: 1, changedLineCount: 5,
    reviewEvidenceComplete: true,
    overrideAvailable,
  };
}

test('override pendente libera a tentativa que seria bloqueada', () => {
  const sem = evaluateLoopGuard(gateScenario(false));
  assert.equal(sem.allowed, false);
  assert.equal(sem.trigger, 'MAX_ATTEMPTS_REACHED');

  const com = evaluateLoopGuard(gateScenario(true));
  assert.equal(com.allowed, true, 'a autorização precisa liberar a passagem');
  assert.equal(com.trigger, null);
  assert.equal(wasOverrideApplied(com), true);
  assert.equal(com.evidence.suppressedTrigger, 'MAX_ATTEMPTS_REACHED');
});

test('override NÃO libera parada dura', () => {
  const cenario = gateScenario(true);
  cenario.forbiddenViolations = ['test/x.test.js'];
  const decision = evaluateLoopGuard(cenario);
  assert.equal(decision.allowed, false, 'parada dura ignora autorização manual');
  assert.equal(decision.trigger, 'FORBIDDEN_AREA_CHANGED');
  assert.equal(decision.severity, 'hard_stop');
});

test('override NÃO libera cota nem autenticação', () => {
  for (const code of ['USAGE_LIMIT_REACHED', 'AUTH_REQUIRED', 'TOOL_MISSING']) {
    const cenario = gateScenario(true);
    cenario.lastAgentErrorCode = code;
    const decision = evaluateLoopGuard(cenario);
    assert.equal(decision.allowed, false, `${code} não pode ser contornado`);
  }
});

/* ------------------------------------------------------------------------ */
/* Descrição para o painel                                                   */
/* ------------------------------------------------------------------------ */

test('describeOverrides explica por que o botão não aparece', () => {
  const config = syntheticLoopGuardPolicy();

  const duro = describeOverrides(
    runWith('FORBIDDEN_AREA_CHANGED', 'hard_stop'),
    '010-x',
    createPromptBudget('010-x'),
    config,
  );
  assert.equal(duro.overridable, false);
  assert.match(duro.reason, /parada dura/i);

  const brando = describeOverrides(
    runWith('NO_PROGRESS', 'soft_stop'),
    '010-x',
    createPromptBudget('010-x'),
    config,
  );
  assert.equal(brando.overridable, true);
  assert.equal(brando.limit, 1);
  assert.equal(brando.used, 0);
});
