'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'orqpeg-schema-'));
process.env.ORQPEG_HOME = HOME;
process.env.ORQPEG_NO_FILE_LOG = '1';

const { validateAgainstSchema } = require('../../dist/config/schema-validator');
const { createRun, transition, updatePromptProgress } = require('../../dist/state/run-state');
const { normalizeProjectConfig } = require('../../dist/projects/project-validator');
const { createProject } = require('../../dist/projects/project-store');
const { ensureDataLayout } = require('../../dist/utils/paths');
const { createRunInput } = require('../helpers/policy');

ensureDataLayout();

const SCHEMA = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '..', '..', 'schemas', 'state.schema.json'), 'utf8'),
);

/*
 * O schema de estado é documentação, não validação em runtime — `loadRun` usa
 * verificação manual. Mas ele tem `additionalProperties: false`, e vinha
 * descrevendo uma forma que NENHUM registro real satisfazia desde os commits
 * de loop-guard: quem o lesse para entender o estado leria algo falso.
 *
 * Estes testes prendem o schema ao tipo real. Sem eles a divergência volta na
 * primeira vez que alguém acrescentar um campo ao `RunRecord`, e volta em
 * silêncio, porque nada mais o exercita.
 */

let contador = 0;
function projetoDeTeste() {
  contador += 1;
  const id = `sch${contador}`;
  const repoPath = path.join(HOME, 'repos', id);
  fs.mkdirSync(repoPath, { recursive: true });
  const criado = createProject(
    normalizeProjectConfig({
      id,
      name: `Schema ${contador}`,
      repositoryPath: repoPath,
      githubRepository: 'maquinanerd/demo',
    }),
  );
  assert.equal(criado.ok, true, criado.ok ? '' : JSON.stringify(criado.error));
  return criado.value;
}

function promptsDeTeste() {
  return [
    { id: '010-a', name: 'Fundação', fileName: '010-a.md', absolutePath: 'x', order: 10, sizeBytes: 1 },
    { id: '020-b', name: 'Interface', fileName: '020-b.md', absolutePath: 'y', order: 20, sizeBytes: 1 },
  ];
}

function explicar(resultado) {
  if (resultado.valid) return '';
  return `erros do schema:\n- ${resultado.errors.join('\n- ')}`;
}

test('um RunRecord recém-criado satisfaz o schema de estado', () => {
  const projeto = projetoDeTeste();
  const run = createRun(createRunInput(projeto, promptsDeTeste()));

  const resultado = validateAgainstSchema(JSON.parse(JSON.stringify(run)), SCHEMA);
  assert.equal(resultado.valid, true, explicar(resultado));
});

test('o schema cobre a política congelada e os hashes de origem', () => {
  const projeto = projetoDeTeste();
  const run = createRun(createRunInput(projeto, promptsDeTeste()));

  // Pré-condição: o registro realmente traz o snapshot — senão o teste acima
  // passaria por vacuidade, validando um campo ausente.
  assert.ok(run.effectivePolicy, 'a execução precisa nascer com política congelada');
  assert.ok(run.effectivePolicy.integrityHash, 'o selo de integridade precisa existir');
  assert.ok(run.effectivePolicy.ci, 'o orçamento de CI faz parte do snapshot');
  assert.ok(run.effectivePolicy.mergeAudit, 'o orçamento de auditoria faz parte do snapshot');
  assert.ok(run.sourceSnapshots, 'os hashes de origem são congelados junto');

  const resultado = validateAgainstSchema(JSON.parse(JSON.stringify(run)), SCHEMA);
  assert.equal(resultado.valid, true, explicar(resultado));
});

test('um RunRecord com orçamento consumido, paradas e ciclos satisfaz o schema', () => {
  const projeto = projetoDeTeste();
  let run = createRun(createRunInput(projeto, promptsDeTeste()));

  run = transition(run, 'VALIDATING', 'Validando.');
  run = updatePromptProgress(run, '010-a', { status: 'APPROVED', commitSha: 'abc1234def56' });

  // Estado "gasto": é o formato que aparece depois de uma execução real, e o
  // que o schema precisa descrever para servir de documentação.
  run = {
    ...run,
    budgets: run.budgets.map((b) =>
      b.promptId === '010-a'
        ? {
            ...b,
            attempts: 3,
            claudeCalls: 3,
            codexCalls: 3,
            consumedMs: 120000,
            manualOverridesUsed: 1,
            startedAt: '2026-07-22T10:00:00.000Z',
            diffFingerprints: ['aaa', 'bbb', 'aaa'],
            reviewFingerprints: ['rrr'],
            testFailureFingerprints: ['ttt'],
            lastTrigger: 'MAX_ATTEMPTS_REACHED',
            lastDecisionAt: '2026-07-22T10:05:00.000Z',
          }
        : b,
    ),
    overrides: [
      {
        promptId: '010-a',
        trigger: 'MAX_ATTEMPTS_REACHED',
        authorizedAt: '2026-07-22T10:06:00.000Z',
        authorizedBy: 'operador local',
        justification: 'Ajustei o ambiente manualmente antes de tentar de novo.',
        consumed: true,
      },
    ],
    lastLoopGuard: {
      allowed: false,
      severity: 'soft_stop',
      trigger: 'MAX_ATTEMPTS_REACHED',
      reason: 'O limite de tentativas do prompt foi alcançado.',
      evidence: { attempts: 3, limit: 3 },
      nextActions: ['OPEN_REPORT', 'AUTHORIZE_EXTRA_ATTEMPT'],
    },
    ciRepairCycles: 1,
    mergeCorrectionCycles: 1,
    ciWait: {
      startedAt: '2026-07-22T11:00:00.000Z',
      headSha: 'a'.repeat(40),
      lastPolledAt: '2026-07-22T11:00:20.000Z',
      pollCount: 1,
      nextIntervalSeconds: 40,
    },
    ciFailureFingerprints: ['ci-1'],
    ciRepairs: [
      {
        cycle: 1,
        headShaBefore: 'a'.repeat(40),
        fingerprint: 'ci-1',
        failedChecks: ['build'],
        startedAt: '2026-07-22T11:01:00.000Z',
        finishedAt: '2026-07-22T11:04:00.000Z',
        outcome: 'REPAIRED',
        headShaAfter: 'b'.repeat(40),
      },
    ],
    mergeCorrections: [
      {
        cycle: 1,
        headShaBefore: 'b'.repeat(40),
        requestedBy: ['claude'],
        issueFingerprint: 'mc-1',
        startedAt: '2026-07-22T12:00:00.000Z',
        finishedAt: '2026-07-22T12:10:00.000Z',
        outcome: 'CORRECTED',
        headShaAfter: 'c'.repeat(40),
      },
    ],
  };

  const resultado = validateAgainstSchema(JSON.parse(JSON.stringify(run)), SCHEMA);
  assert.equal(resultado.valid, true, explicar(resultado));
});

test('execução legada, sem política congelada, continua descrita pelo schema', () => {
  const projeto = projetoDeTeste();
  const run = {
    ...createRun(createRunInput(projeto, promptsDeTeste())),
    effectivePolicy: null,
    sourceSnapshots: null,
    projectContextHash: null,
    projectConfigHash: null,
  };

  const resultado = validateAgainstSchema(JSON.parse(JSON.stringify(run)), SCHEMA);
  assert.equal(resultado.valid, true, explicar(resultado));
});

test('o schema REJEITA um registro sem os campos de política e de orçamento', () => {
  const projeto = projetoDeTeste();
  const run = JSON.parse(JSON.stringify(createRun(createRunInput(projeto, promptsDeTeste()))));

  // Sem esta recusa o teste de aceitação acima não provaria nada: um schema
  // permissivo aceitaria qualquer coisa e a divergência voltaria sem sintoma.
  delete run.effectivePolicy;
  delete run.budgets;
  delete run.ciRepairs;

  const resultado = validateAgainstSchema(run, SCHEMA);
  assert.equal(resultado.valid, false, 'campos obrigatórios ausentes precisam ser recusados');
});

test('o schema REJEITA um campo desconhecido no registro', () => {
  const projeto = projetoDeTeste();
  const run = JSON.parse(JSON.stringify(createRun(createRunInput(projeto, promptsDeTeste()))));
  run.campoInventado = 'não deveria passar';

  const resultado = validateAgainstSchema(run, SCHEMA);
  assert.equal(resultado.valid, false, 'additionalProperties:false precisa valer de fato');
});
