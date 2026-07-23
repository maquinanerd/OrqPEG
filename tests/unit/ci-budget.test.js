'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  decideCi,
  startCiWait,
  advanceCiWait,
  rebaseCiWaitOnHead,
  waitTimedOut,
  elapsedWaitMs,
  failureSignalsFrom,
} = require('../../dist/execution/ci-budget');
const { ciFailureFingerprint, normalizeCiText } = require('../../dist/execution/fingerprints');

/*
 * Orçamento de CI.
 *
 * O CI é o terceiro laço do produto (depois do prompt e do merge) e o único
 * cujo tempo é gasto esperando em vez de executando. As três formas de laço
 * infinito que estes testes fecham: esperar para sempre, corrigir para sempre,
 * e renovar a espera reiniciando o processo.
 */

const POLICY = {
  maxRepairCycles: 2,
  pollingInitialSeconds: 20,
  pollingMaxSeconds: 60,
  waitTimeoutMinutes: 60,
  stopOnRepeatedFailure: true,
};

const HEAD = 'a'.repeat(40);

function checks(overrides = {}) {
  return {
    headSha: HEAD,
    total: 1,
    passed: 1,
    failed: 0,
    pending: 0,
    skipped: 0,
    allRequiredPassed: true,
    anyRequiredPending: false,
    anyRequiredFailed: false,
    anyRequiredSkipped: false,
    runs: [],
    ...overrides,
  };
}

function checkRun(overrides = {}) {
  return {
    name: 'build',
    status: 'COMPLETED',
    conclusion: 'FAILURE',
    detailsUrl: null,
    required: true,
    workflowName: 'CI',
    startedAt: null,
    completedAt: null,
    ...overrides,
  };
}

function run(overrides = {}) {
  return {
    runId: 'run-1',
    projectId: 'p',
    ciRepairCycles: 0,
    ciFailureFingerprints: [],
    ciRepairs: [],
    ciWait: startCiWait(HEAD, POLICY, '2026-07-22T10:00:00.000Z'),
    ...overrides,
  };
}

const T0 = Date.parse('2026-07-22T10:00:00.000Z');

/* ------------------------------------------------------------------------ */
/* Polling e backoff                                                         */
/* ------------------------------------------------------------------------ */

test('o backoff dobra mas nunca ultrapassa o teto configurado', () => {
  let state = startCiWait(HEAD, POLICY, '2026-07-22T10:00:00.000Z');
  assert.equal(state.nextIntervalSeconds, 20);

  state = advanceCiWait(state, POLICY, '2026-07-22T10:00:20.000Z');
  assert.equal(state.nextIntervalSeconds, 40);
  assert.equal(state.pollCount, 1);

  state = advanceCiWait(state, POLICY, '2026-07-22T10:01:00.000Z');
  assert.equal(state.nextIntervalSeconds, 60, 'chega ao teto');

  state = advanceCiWait(state, POLICY, '2026-07-22T10:02:00.000Z');
  assert.equal(state.nextIntervalSeconds, 60, 'e permanece no teto, não cresce sem limite');
  assert.equal(state.pollCount, 3, 'cada consulta é contada');
});

test('a última consulta é persistida a cada avanço', () => {
  const state = advanceCiWait(
    startCiWait(HEAD, POLICY, '2026-07-22T10:00:00.000Z'),
    POLICY,
    '2026-07-22T10:00:20.000Z',
  );
  assert.equal(state.lastPolledAt, '2026-07-22T10:00:20.000Z');
  assert.equal(state.startedAt, '2026-07-22T10:00:00.000Z', 'o início não se move');
});

/* ------------------------------------------------------------------------ */
/* Timeout histórico                                                         */
/* ------------------------------------------------------------------------ */

test('o timeout conta desde a PRIMEIRA espera e não reinicia na retomada', () => {
  // Espera iniciada há 59 minutos e o processo reiniciou várias vezes: o que
  // vale é `startedAt`, não o instante em que o laço voltou a rodar.
  const state = startCiWait(HEAD, POLICY, '2026-07-22T10:00:00.000Z');
  const cinquentaNove = T0 + 59 * 60_000;
  const sessentaEUm = T0 + 61 * 60_000;

  assert.equal(waitTimedOut(state, POLICY, cinquentaNove), false);
  assert.equal(waitTimedOut(state, POLICY, sessentaEUm), true);
  assert.equal(elapsedWaitMs(state, sessentaEUm), 61 * 60_000);
});

test('reiniciar o laço com o MESMO head preserva o relógio', () => {
  const original = startCiWait(HEAD, POLICY, '2026-07-22T10:00:00.000Z');
  const depois = rebaseCiWaitOnHead(original, HEAD, POLICY, '2026-07-22T10:59:00.000Z');
  assert.equal(depois.startedAt, original.startedAt, 'o relógio não pode ser renovado');
  assert.equal(waitTimedOut(depois, POLICY, T0 + 61 * 60_000), true);
});

test('head SHA novo reancora o relógio: commit novo é CI novo', () => {
  const original = startCiWait(HEAD, POLICY, '2026-07-22T10:00:00.000Z');
  const outroHead = 'b'.repeat(40);
  const depois = rebaseCiWaitOnHead(original, outroHead, POLICY, '2026-07-22T10:59:00.000Z');
  assert.equal(depois.startedAt, '2026-07-22T10:59:00.000Z');
  assert.equal(depois.headSha, outroHead);
  assert.equal(depois.nextIntervalSeconds, 20, 'o backoff também recomeça');
});

test('espera estourada com checks pendentes nomeia CI_WAIT_TIMEOUT', () => {
  const decisao = decideCi({
    run: run(),
    policy: POLICY,
    checks: checks({
      passed: 0,
      pending: 1,
      allRequiredPassed: false,
      anyRequiredPending: true,
      runs: [checkRun({ status: 'IN_PROGRESS', conclusion: 'NEUTRAL' })],
    }),
    failureSignals: [],
    nowMs: T0 + 61 * 60_000,
  });

  assert.equal(decisao.action, 'STOP');
  assert.equal(decisao.trigger, 'CI_WAIT_TIMEOUT');
  assert.deepEqual(decisao.evidence.pendingChecks, ['build']);
});

test('dentro do prazo, checks pendentes apenas esperam — sem gastar IA', () => {
  const decisao = decideCi({
    run: run(),
    policy: POLICY,
    checks: checks({
      passed: 0,
      pending: 1,
      allRequiredPassed: false,
      anyRequiredPending: true,
    }),
    failureSignals: [],
    nowMs: T0 + 60_000,
  });

  assert.equal(decisao.action, 'WAIT');
  assert.equal(decisao.waitSeconds, 20);
});

/* ------------------------------------------------------------------------ */
/* Configuração e checks obrigatórios                                        */
/* ------------------------------------------------------------------------ */

test('nenhum check registrado espera primeiro e só depois vira CI_CONFIGURATION_ERROR', () => {
  const semChecks = checks({ total: 0, passed: 0, allRequiredPassed: false });

  const cedo = decideCi({
    run: run(),
    policy: POLICY,
    checks: semChecks,
    failureSignals: [],
    nowMs: T0 + 60_000,
  });
  assert.equal(cedo.action, 'WAIT', 'o GitHub pode ainda não ter registrado os checks');

  const tarde = decideCi({
    run: run(),
    policy: POLICY,
    checks: semChecks,
    failureSignals: [],
    nowMs: T0 + 61 * 60_000,
  });
  assert.equal(tarde.action, 'STOP');
  assert.equal(tarde.trigger, 'CI_CONFIGURATION_ERROR');
});

test('check obrigatório pulado nomeia CI_REQUIRED_CHECK_MISSING', () => {
  const decisao = decideCi({
    run: run(),
    policy: POLICY,
    checks: checks({
      passed: 0,
      skipped: 1,
      allRequiredPassed: false,
      anyRequiredSkipped: true,
      runs: [checkRun({ name: 'seguranca', conclusion: 'SKIPPED' })],
    }),
    failureSignals: [],
    nowMs: T0,
  });

  assert.equal(decisao.action, 'STOP');
  assert.equal(decisao.trigger, 'CI_REQUIRED_CHECK_MISSING');
  assert.deepEqual(decisao.evidence.skipped, ['seguranca']);
});

/* ------------------------------------------------------------------------ */
/* Orçamento de reparo                                                       */
/* ------------------------------------------------------------------------ */

const REPROVADO = checks({
  passed: 0,
  failed: 1,
  allRequiredPassed: false,
  anyRequiredFailed: true,
  runs: [checkRun()],
});

test('CI reprovado dentro do orçamento autoriza um ciclo de reparo', () => {
  const decisao = decideCi({
    run: run(),
    policy: POLICY,
    checks: REPROVADO,
    failureSignals: failureSignalsFrom(REPROVADO),
    nowMs: T0,
  });

  assert.equal(decisao.action, 'REPAIR');
  assert.equal(decisao.cycle, 1);
  assert.deepEqual(decisao.failedChecks, ['build']);
});

test('orçamento de reparo esgotado nomeia CI_REPAIR_BUDGET_EXHAUSTED', () => {
  const decisao = decideCi({
    run: run({ ciRepairCycles: 2 }),
    policy: POLICY,
    checks: REPROVADO,
    failureSignals: failureSignalsFrom(REPROVADO),
    nowMs: T0,
  });

  assert.equal(decisao.action, 'STOP');
  assert.equal(decisao.trigger, 'CI_REPAIR_BUDGET_EXHAUSTED');
  assert.equal(decisao.evidence.limit, 2);
});

test('a MESMA falha depois de uma correção nomeia REPEATED_CI_FAILURE', () => {
  const assinatura = ciFailureFingerprint(failureSignalsFrom(REPROVADO));
  assert.ok(assinatura, 'a falha precisa produzir assinatura');

  const decisao = decideCi({
    run: run({ ciRepairCycles: 1, ciFailureFingerprints: [assinatura] }),
    policy: POLICY,
    checks: REPROVADO,
    failureSignals: failureSignalsFrom(REPROVADO),
    nowMs: T0,
  });

  assert.equal(decisao.action, 'STOP');
  assert.equal(decisao.trigger, 'REPEATED_CI_FAILURE');
});

test('falha DIFERENTE depois de uma correção ainda autoriza reparo', () => {
  const outra = ciFailureFingerprint([
    { workflow: 'CI', job: 'lint', conclusion: 'FAILURE' },
  ]);

  const decisao = decideCi({
    run: run({ ciRepairCycles: 1, ciFailureFingerprints: [outra] }),
    policy: POLICY,
    checks: REPROVADO,
    failureSignals: failureSignalsFrom(REPROVADO),
    nowMs: T0,
  });

  assert.equal(decisao.action, 'REPAIR', 'progresso real merece a tentativa restante');
  assert.equal(decisao.cycle, 2);
});

test('desligar stopOnRepeatedFailure não desliga o orçamento', () => {
  const assinatura = ciFailureFingerprint(failureSignalsFrom(REPROVADO));
  const decisao = decideCi({
    run: run({ ciRepairCycles: 2, ciFailureFingerprints: [assinatura] }),
    policy: { ...POLICY, stopOnRepeatedFailure: false },
    checks: REPROVADO,
    failureSignals: failureSignalsFrom(REPROVADO),
    nowMs: T0,
  });

  assert.equal(decisao.action, 'STOP');
  assert.equal(decisao.trigger, 'CI_REPAIR_BUDGET_EXHAUSTED', 'o teto continua valendo');
});

test('CI aprovado segue em frente', () => {
  const decisao = decideCi({
    run: run(),
    policy: POLICY,
    checks: checks(),
    failureSignals: [],
    nowMs: T0,
  });
  assert.equal(decisao.action, 'PROCEED');
});

/* ------------------------------------------------------------------------ */
/* Fingerprint normalizado                                                   */
/* ------------------------------------------------------------------------ */

test('a assinatura ignora run ID, timestamp, duração e URL temporária', () => {
  const base = {
    workflow: 'CI',
    job: 'build',
    conclusion: 'FAILURE',
    command: 'npm test',
  };

  const primeira = ciFailureFingerprint([
    {
      ...base,
      message:
        'Run #4821 failed at 2026-07-22T10:00:00Z in 4.21s — see https://github.com/x/y/actions/runs/4821',
    },
  ]);
  const segunda = ciFailureFingerprint([
    {
      ...base,
      message:
        'Run #9134 failed at 2026-07-23T18:42:11Z in 7.09s — see https://github.com/x/y/actions/runs/9134',
    },
  ]);

  assert.equal(primeira, segunda, 'a mesma falha em execuções diferentes tem a mesma assinatura');
});

test('a assinatura MUDA quando o job, o passo ou a mensagem real mudam', () => {
  const base = { workflow: 'CI', job: 'build', conclusion: 'FAILURE', message: 'x falhou' };
  const referencia = ciFailureFingerprint([base]);

  assert.notEqual(ciFailureFingerprint([{ ...base, job: 'lint' }]), referencia);
  assert.notEqual(ciFailureFingerprint([{ ...base, message: 'y falhou' }]), referencia);
  assert.notEqual(ciFailureFingerprint([{ ...base, step: 'instalar' }]), referencia);
  assert.notEqual(ciFailureFingerprint([{ ...base, workflow: 'Release' }]), referencia);
});

test('a ordem em que o GitHub devolve os checks não muda a assinatura', () => {
  const a = { workflow: 'CI', job: 'build', conclusion: 'FAILURE' };
  const b = { workflow: 'CI', job: 'lint', conclusion: 'FAILURE' };
  assert.equal(ciFailureFingerprint([a, b]), ciFailureFingerprint([b, a]));
});

test('sem falha alguma não há assinatura', () => {
  assert.equal(ciFailureFingerprint([]), null);
});

test('normalizeCiText remove os identificadores voláteis conhecidos', () => {
  const limpo = normalizeCiText(
    'erro em /runner/work/repo/src/a.ts run-4821 sha a1b2c3d4e5f6 às 10:00:00 levou 4.21s ver https://x.y/z',
  );
  assert.equal(/4821/.test(limpo), false, 'run id some');
  assert.equal(/a1b2c3d4e5f6/.test(limpo), false, 'sha some');
  assert.equal(/10:00:00/.test(limpo), false, 'horário some');
  assert.equal(/4\.21s/.test(limpo), false, 'duração some');
  assert.equal(/https/.test(limpo), false, 'URL some');
  assert.equal(limpo.includes('erro em'), true, 'o que identifica a falha permanece');
});

test('failureSignalsFrom considera apenas checks obrigatórios reprovados', () => {
  const sinais = failureSignalsFrom(
    checks({
      runs: [
        checkRun({ name: 'build' }),
        checkRun({ name: 'opcional', required: false }),
        checkRun({ name: 'ok', conclusion: 'SUCCESS' }),
      ],
    }),
  );
  assert.deepEqual(
    sinais.map((s) => s.job),
    ['build'],
  );
});
