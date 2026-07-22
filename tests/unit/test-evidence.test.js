'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'orqpeg-evid-'));
process.env.ORQPEG_HOME = HOME;
process.env.ORQPEG_NO_FILE_LOG = '1';

const { verifyTestEvidence, describeEvidenceCheck } = require('../../dist/tests-runner/evidence');

/*
 * Regressão de integridade.
 *
 * Numa auditoria real desta plataforma, o gate "Testes locais passaram" foi
 * APROVADO com base num objeto montado à mão: duração de 1 ms para 175 testes,
 * horários vazios e uma saída inventada ("165/165 aprovados") que não
 * corresponde ao formato realmente emitido pelo executor. Só o auditor de IA
 * percebeu. O gate agora rejeita esse dado por conta própria.
 */

const FABRICADO = {
  status: 'PASSED',
  passed: true,
  startedAt: '',
  finishedAt: '',
  durationMs: 1,
  failedCommands: [],
  commands: [
    {
      command: 'npm test',
      cwd: 'C:/OrqPEG',
      status: 'PASSED',
      exitCode: 0,
      startedAt: '',
      finishedAt: '',
      durationMs: 1,
      stdout: '165/165 aprovados',
      stderr: '',
    },
  ],
};

function autentico(overrides = {}) {
  const inicio = '2026-07-22T01:00:00.000Z';
  const fim = '2026-07-22T01:02:00.000Z';
  return {
    status: 'PASSED',
    passed: true,
    startedAt: inicio,
    finishedAt: fim,
    durationMs: 120_000,
    failedCommands: [],
    commands: [
      {
        command: 'npm test',
        cwd: 'C:/OrqPEG',
        status: 'PASSED',
        exitCode: 0,
        startedAt: inicio,
        finishedAt: fim,
        durationMs: 120_000,
        stdout: 'ℹ tests 175\nℹ pass 175\nℹ fail 0',
        stderr: '',
      },
    ],
    ...overrides,
  };
}

test('a evidência exata que foi fabricada é REJEITADA', () => {
  const check = verifyTestEvidence(FABRICADO);
  assert.equal(check.authentic, false, 'este é o objeto real que enganou o gate');
  assert.ok(check.problems.length > 0);
  const texto = describeEvidenceCheck(check);
  assert.match(texto, /REJEITADA/);
});

test('uma execução real é aceita', () => {
  const check = verifyTestEvidence(autentico());
  assert.equal(check.authentic, true, describeEvidenceCheck(check));
  assert.deepEqual(check.problems, []);
});

test('suíte ausente não conta como aprovação', () => {
  assert.equal(verifyTestEvidence(null).authentic, false);
});

test('suíte sem nenhum comando executado é rejeitada', () => {
  assert.equal(verifyTestEvidence(autentico({ commands: [] })).authentic, false);
});

test('duração impossível para um processo externo é rejeitada', () => {
  const suite = autentico();
  suite.commands[0].durationMs = 1;
  assert.equal(verifyTestEvidence(suite).authentic, false);
});

test('horários ausentes são rejeitados', () => {
  const suite = autentico();
  suite.commands[0].startedAt = '';
  assert.equal(verifyTestEvidence(suite).authentic, false);
});

test('PASSED com código de saída diferente de zero é rejeitado', () => {
  const suite = autentico();
  suite.commands[0].exitCode = 1;
  assert.equal(verifyTestEvidence(suite).authentic, false);
});

test('PASSED sem nenhuma saída capturada é rejeitado', () => {
  const suite = autentico();
  suite.commands[0].stdout = '';
  suite.commands[0].stderr = '';
  assert.equal(verifyTestEvidence(suite).authentic, false);
});

test('incoerência entre status agregado e comandos é rejeitada', () => {
  const suite = autentico();
  suite.commands[0].status = 'FAILED';
  assert.equal(verifyTestEvidence(suite).authentic, false);
});

test('duração total menor que a soma dos comandos é rejeitada', () => {
  const suite = autentico();
  suite.durationMs = 10;
  assert.equal(verifyTestEvidence(suite).authentic, false);
});

test('comando NOT_RUN não exige horários (não foi executado)', () => {
  const suite = autentico();
  suite.commands.push({
    command: 'npm run build',
    cwd: 'C:/OrqPEG',
    status: 'NOT_RUN',
    exitCode: null,
    startedAt: '',
    finishedAt: '',
    durationMs: 0,
    stdout: '',
    stderr: '',
  });
  suite.status = 'FAILED';
  suite.passed = false;
  const check = verifyTestEvidence(suite);
  const sobreNotRun = check.problems.filter((p) => p.field.includes('npm run build'));
  assert.deepEqual(sobreNotRun, [], 'NOT_RUN não deve gerar acusação de evidência falsa');
});

/* ------------------------------------------------------------------------ */
/* O gate 7 precisa reprovar com evidência fabricada                         */
/* ------------------------------------------------------------------------ */

const { evaluateGates } = require('../../dist/merge/gates');

function projeto() {
  return {
    id: 'demo', name: 'Demo', repositoryPath: 'E:\\P\\Demo',
    githubRepository: 'maquinanerd/demo', remote: 'origin', baseBranch: 'main',
    branchStrategy: 'per_run',
    worktree: { enabled: false, rootPath: null, reuseWhenSafe: true },
    commands: { install: [], tests: ['npm test'], timeoutSeconds: 1800 },
    execution: { maxAttemptsPerPrompt: 3, maxReviewerRetries: 2, continueAfterApproval: true, stopOnBlocked: true },
    git: { commitAfterApproval: true, pushAfterRun: true, commitMessagePrefix: 'orqpeg:' },
    pullRequest: { enabled: true, draftDuringExecution: true, markReadyBeforeMerge: true, waitForChecks: true },
    merge: {
      enabled: true, mode: 'dual_ai_consensus', strategy: 'squash', deleteBranchAfterMerge: false,
      requireClaudeApproval: true, requireCodexApproval: true, requireLocalTests: true,
      requireCiSuccess: true, requireNoConflicts: true, requireNoUnresolvedThreads: true,
      invalidateApprovalOnHeadChange: true, minimumConfidence: 0.9,
    },
    agents: { claudeModel: null, codexModel: null },
  };
}

test('o gate 7 REPROVA quando a evidência de teste é fabricada', () => {
  const report = evaluateGates({
    project: projeto(),
    run: {
      prompts: [{ promptId: 'a', status: 'APPROVED', attempts: 1, commitSha: 'abc1234' }],
      commits: [{ promptId: 'a', sha: 'abc1234', message: 'm', at: '2026-07-22T01:00:00.000Z' }],
      branchName: 'orqpeg/demo/run-1', pushedAt: '2026-07-22T01:00:00.000Z', pushedRemote: 'origin',
      mergeReviews: [],
    },
    pr: null, checks: null,
    finalTests: FABRICADO,
    currentHeadSha: 'a'.repeat(40), currentBaseSha: 'b'.repeat(40),
    claudeReview: null, codexReview: null,
  });

  const gate7 = report.gates.find((g) => g.id === 'LOCAL_TESTS_PASSED');
  assert.equal(gate7.status, 'FAILED', 'evidência sintética não pode aprovar o gate de testes');
  assert.match(gate7.reason, /não é consistente com uma execução real/);
});
