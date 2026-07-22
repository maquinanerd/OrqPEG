'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/*
 * Ciclo completo do OrqPEG contra dublês.
 *
 * Nenhuma IA real, nenhuma rede, nenhum repositório do usuário é tocado.
 * ORQPEG_HOME é redirecionado para uma pasta temporária antes de qualquer
 * import, de modo que todo o estado gravado fique isolado.
 */

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'orqpeg-e2e-'));
process.env.ORQPEG_HOME = HOME;
process.env.ORQPEG_NO_FILE_LOG = '1';

// A raiz precisa conter os schemas reais: o parser de revisão valida contra eles.
const REPO_ROOT = path.resolve(__dirname, '..', '..');
fs.mkdirSync(path.join(HOME, 'schemas'), { recursive: true });
for (const name of fs.readdirSync(path.join(REPO_ROOT, 'schemas'))) {
  fs.copyFileSync(path.join(REPO_ROOT, 'schemas', name), path.join(HOME, 'schemas', name));
}
fs.mkdirSync(path.join(HOME, 'templates'), { recursive: true });
for (const name of fs.readdirSync(path.join(REPO_ROOT, 'templates'))) {
  fs.copyFileSync(path.join(REPO_ROOT, 'templates', name), path.join(HOME, 'templates', name));
}

const { runProject } = require('../../dist/execution/orchestrator');
const { createProject } = require('../../dist/projects/project-store');
const { normalizeProjectConfig } = require('../../dist/projects/project-validator');
const { nullLogger } = require('../../dist/utils/logger');
const { defaultGlobalConfig } = require('../../dist/config/global-config');
const { ensureDataLayout, projectPromptsDir } = require('../../dist/utils/paths');

ensureDataLayout();

const HEAD = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const BASE = '0000111122223333444455556666777788889999';

/* ------------------------------------------------------------------------ */
/* Fixtures                                                                  */
/* ------------------------------------------------------------------------ */

let projectCounter = 0;

function makeProject(overrides = {}) {
  projectCounter += 1;
  const id = `demo${projectCounter}`;
  const repoPath = path.join(HOME, 'repos', id);
  fs.mkdirSync(repoPath, { recursive: true });

  const config = normalizeProjectConfig({
    id,
    name: `Demo ${projectCounter}`,
    repositoryPath: repoPath,
    githubRepository: 'maquinanerd/demo',
    ...overrides,
  });
  config.worktree.enabled = false;
  Object.assign(config.merge, overrides.merge ?? {});

  const created = createProject(config);
  assert.equal(created.ok, true, created.ok ? '' : JSON.stringify(created.error));

  const promptsDir = projectPromptsDir(id);
  fs.mkdirSync(promptsDir, { recursive: true });
  fs.writeFileSync(
    path.join(promptsDir, '010-fundacao.md'),
    [
      '# Identificação',
      '',
      'ID: 010-fundacao',
      'Nome: Fundação',
      '',
      '# Objetivo',
      '',
      'Criar a fundação do módulo.',
      '',
      '# Critérios de aceitação',
      '',
      '- O módulo compila.',
      '',
      '# Testes obrigatórios',
      '',
      '- npm test',
      '',
    ].join('\n'),
    'utf8',
  );
  // Arquivos reservados nunca podem virar prompt.
  fs.writeFileSync(path.join(promptsDir, 'README.md'), '# leia-me', 'utf8');
  fs.writeFileSync(path.join(promptsDir, '_rascunho.md'), '# rascunho', 'utf8');

  return created.value;
}

function promptReviewJson(verdict = 'APPROVED', extra = {}) {
  return JSON.stringify({
    verdict,
    summary: 'Revisão automatizada de teste.',
    confidence: 0.97,
    meetsPromptRequirements: verdict === 'APPROVED',
    blockingIssues: [],
    nonBlockingIssues: [],
    requiredActions: [],
    scopeAssessment: { withinScope: true, unexpectedChanges: [] },
    testsAssessment: { localTestsPassed: true, coverageAcceptable: true },
    riskAssessment: { level: 'low', summary: 'Baixo risco.' },
    ...extra,
  });
}

function mergeReviewJson(overrides = {}) {
  return JSON.stringify({
    verdict: 'APPROVED_FOR_MERGE',
    reviewedHeadSha: HEAD,
    summary: 'Auditoria final de teste.',
    confidence: 0.96,
    blockingIssues: [],
    nonBlockingIssues: [],
    requiredActions: [],
    riskAssessment: { level: 'low', summary: 'Baixo risco.' },
    testsAssessment: { localTestsPassed: true, ciPassed: true, coverageAcceptable: true },
    scopeAssessment: { withinScope: true, unexpectedChanges: [] },
    ...overrides,
  });
}

function agentResult(output) {
  const at = new Date().toISOString();
  return {
    ok: true,
    value: {
      output,
      invocation: {
        agent: 'claude',
        role: 'executor',
        instructionPath: '',
        cwd: '',
        model: null,
        startedAt: at,
        finishedAt: at,
        durationMs: 1,
        status: 'COMPLETED',
        exitCode: 0,
        sessionId: null,
        stdoutPath: '',
        stderrPath: '',
        usageLimitReached: false,
        authRequired: false,
      },
      process: {
        command: 'mock',
        args: [],
        cwd: '',
        status: 'COMPLETED',
        exitCode: 0,
        signal: null,
        stdout: output,
        stderr: '',
        startedAt: at,
        finishedAt: at,
        durationMs: 1,
        timedOut: false,
        stdoutTruncated: false,
        stderrTruncated: false,
      },
    },
  };
}

function passingTests() {
  const at = new Date().toISOString();
  return {
    status: 'PASSED',
    passed: true,
    startedAt: at,
    finishedAt: at,
    durationMs: 10,
    commands: [
      {
        command: 'npm test',
        cwd: '',
        status: 'PASSED',
        exitCode: 0,
        startedAt: at,
        finishedAt: at,
        durationMs: 10,
        stdout: 'ok',
        stderr: '',
      },
    ],
    failedCommands: [],
  };
}

function failingTests() {
  const suite = passingTests();
  suite.status = 'FAILED';
  suite.passed = false;
  suite.commands[0].status = 'FAILED';
  suite.commands[0].exitCode = 1;
  suite.failedCommands = ['npm test'];
  return suite;
}

function pullRequest(overrides = {}) {
  return {
    number: 7,
    url: 'https://github.com/maquinanerd/demo/pull/7',
    title: 'orqpeg: demo',
    state: 'OPEN',
    isDraft: false,
    baseRefName: 'main',
    headRefName: 'orqpeg/demo/run-1',
    headSha: HEAD,
    baseSha: BASE,
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    merged: false,
    mergeCommitSha: null,
    reviewDecision: null,
    unresolvedThreadCount: 0,
    ...overrides,
  };
}

function checksSummary(overrides = {}) {
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

const OK = (value) => ({ ok: true, value });

/**
 * Portas mockadas. `spy` acumula o que foi chamado para as asserções.
 */
function makePorts(options = {}) {
  const spy = {
    merged: false,
    mergeCalls: 0,
    pushes: 0,
    commits: 0,
    claudeCalls: [],
    codexCalls: [],
    // O nome da branch é gerado pelo orquestrador; a PR simulada precisa
    // refletir exatamente esse valor, senão o gate 3 reprova (com razão).
    branch: 'orqpeg/demo/run-1',
  };

  const ports = {
    agents: {
      async runClaude(input) {
        spy.claudeCalls.push(input.role);
        if (input.role === 'merge-auditor') {
          return options.claudeAudit
            ? options.claudeAudit()
            : agentResult(mergeReviewJson(options.claudeAuditOverrides ?? {}));
        }
        return agentResult('Implementado.');
      },
      async runCodex(input) {
        spy.codexCalls.push(input.role);
        if (input.role === 'merge-auditor') {
          if (options.codexAudit) return options.codexAudit();
          return agentResult(mergeReviewJson(options.codexAuditOverrides ?? {}));
        }
        if (options.codexReview) return options.codexReview(spy.codexCalls.length);
        return agentResult(promptReviewJson('APPROVED'));
      },
      async claudeAvailable() {
        return options.claudeAvailable !== false;
      },
      async codexAvailable() {
        return options.codexAvailable !== false;
      },
    },

    git: {
      async headSha() {
        return OK(BASE);
      },
      async currentBranch() {
        return OK('main');
      },
      async changedFiles() {
        return OK(options.changedFiles ?? ['src/app.ts']);
      },
      async statusText() {
        return OK('M src/app.ts');
      },
      async diffStat() {
        return OK(' src/app.ts | 10 +++++');
      },
      async diffPatch() {
        return OK('diff --git a/src/app.ts b/src/app.ts');
      },
      async addPaths() {
        return OK(undefined);
      },
      async commit() {
        spy.commits += 1;
        return OK(`c0mm1t${spy.commits}`);
      },
      async push() {
        spy.pushes += 1;
        return OK(undefined);
      },
      async remoteUrl() {
        return OK(options.remoteUrl ?? 'https://github.com/maquinanerd/demo.git');
      },
      async commitLog() {
        return OK('c0mm1t1 orqpeg: demo');
      },
    },

    worktree: {
      async prepare(input) {
        spy.branch = input.branch;
        return OK({ path: input.worktreePath, branch: input.branch });
      },
    },

    github: {
      async createDraftPullRequest(input) {
        spy.branch = input.head;
        return OK(pullRequest({ headRefName: input.head, ...(options.prOverrides ?? {}) }));
      },
      async getPullRequest() {
        return OK(
          pullRequest({
            headRefName: spy.branch,
            ...(options.prOverrides ?? {}),
            ...(options.freshPrOverrides ?? {}),
          }),
        );
      },
      async findPullRequestForBranch() {
        return OK(null);
      },
      async updatePullRequestBody() {
        return OK(undefined);
      },
      async markReadyForReview() {
        return OK(undefined);
      },
      async getChecks() {
        return OK(checksSummary(options.checksOverrides ?? {}));
      },
      async waitForChecks() {
        return OK(checksSummary(options.checksOverrides ?? {}));
      },
    },

    merge: {
      async execute(input) {
        spy.mergeCalls += 1;
        if (input.pr.merged) {
          return OK({
            attempted: false,
            merged: true,
            mergeSha: input.pr.mergeCommitSha,
            strategy: 'squash',
            matchedHeadSha: input.pr.headSha,
            performedAt: null,
            reason: 'PR já estava mergeada; nada a fazer.',
            idempotentSkip: true,
          });
        }
        spy.merged = true;
        return OK({
          attempted: true,
          merged: true,
          mergeSha: 'merged00',
          strategy: 'squash',
          matchedHeadSha: input.pr.headSha,
          performedAt: new Date().toISOString(),
          reason: 'Todos os gates aprovados.',
          idempotentSkip: false,
        });
      },
    },

    tests: {
      async run() {
        return options.tests ? options.tests() : passingTests();
      },
    },
  };

  return { ports, spy };
}

async function execute(project, options = {}) {
  const { ports, spy } = makePorts(options);
  const result = await runProject({
    projectId: project.id,
    dryRun: options.dryRun === true,
    config: defaultGlobalConfig(),
    logger: nullLogger(),
    ports,
  });
  return { result, spy };
}

/* ------------------------------------------------------------------------ */
/* Caminho feliz completo                                                    */
/* ------------------------------------------------------------------------ */

test('ciclo completo com ambas as IAs aprovando chega a MERGED', async () => {
  const project = makeProject();
  const { result, spy } = await execute(project);

  assert.equal(result.ok, true, result.ok ? '' : JSON.stringify(result.error));
  const run = result.value;

  assert.equal(run.state, 'MERGED', `estado final inesperado: ${run.state}`);
  assert.equal(run.prompts[0].status, 'APPROVED');
  assert.equal(run.commits.length, 1, 'deve existir um commit por prompt aprovado');
  assert.equal(spy.pushes, 1);
  assert.equal(spy.merged, true);
  assert.equal(run.consensus.reached, true);
  assert.equal(run.gateReport.allPassed, true);
  assert.equal(run.mergeOutcome.merged, true);

  // As duas auditorias finais foram executadas, em sessões separadas do executor.
  assert.ok(spy.claudeCalls.includes('executor'));
  assert.ok(spy.claudeCalls.includes('merge-auditor'));
  assert.ok(spy.codexCalls.includes('prompt-reviewer'));
  assert.ok(spy.codexCalls.includes('merge-auditor'));
});

test('arquivos reservados não viram prompts', async () => {
  const project = makeProject();
  const { result } = await execute(project);
  assert.equal(result.value.prompts.length, 1, 'README.md e _rascunho.md devem ser ignorados');
  assert.equal(result.value.prompts[0].promptId, '010-fundacao');
});

/* ------------------------------------------------------------------------ */
/* O OrqPEG é a autoridade dos testes                                        */
/* ------------------------------------------------------------------------ */

test('teste falhando impede aprovação mesmo com o Codex dizendo APPROVED', async () => {
  const project = makeProject();
  const { result, spy } = await execute(project, { tests: failingTests });

  assert.equal(result.ok, true);
  assert.notEqual(result.value.state, 'MERGED');
  assert.notEqual(result.value.prompts[0].status, 'APPROVED');
  assert.equal(spy.merged, false, 'jamais mergear com teste falhando');
  assert.equal(spy.commits, 0, 'nenhum commit com teste falhando');
});

test('Codex pedindo mudanças gera nova tentativa e o Claude é chamado de novo', async () => {
  const project = makeProject();
  let call = 0;
  const { result, spy } = await execute(project, {
    codexReview: () => {
      call += 1;
      return agentResult(promptReviewJson(call === 1 ? 'CHANGES_REQUESTED' : 'APPROVED'));
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.value.prompts[0].status, 'APPROVED');
  assert.equal(result.value.prompts[0].attempts, 2, 'deve ter havido uma segunda tentativa');
  assert.ok(spy.claudeCalls.includes('corrector'), 'a correção deve usar o papel de corretor');
});

test('veredito BLOCKED interrompe o prompt sem commit', async () => {
  const project = makeProject();
  const { result, spy } = await execute(project, {
    codexReview: () => agentResult(promptReviewJson('BLOCKED')),
  });

  assert.equal(result.ok, true);
  assert.equal(result.value.prompts[0].status, 'BLOCKED');
  assert.equal(spy.commits, 0);
  assert.equal(spy.merged, false);
});

test('JSON de revisão inválido não aprova e não trava a execução', async () => {
  const project = makeProject();
  const { result, spy } = await execute(project, {
    codexReview: () => agentResult('desculpe, não consegui gerar o JSON'),
  });

  assert.equal(result.ok, true);
  assert.notEqual(result.value.prompts[0].status, 'APPROVED');
  assert.equal(spy.merged, false);
});

/* ------------------------------------------------------------------------ */
/* Merge exige as DUAS IAs                                                   */
/* ------------------------------------------------------------------------ */

test('Codex indisponível na auditoria final BLOQUEIA o merge', async () => {
  const project = makeProject();
  const { result, spy } = await execute(project, {
    codexAudit: () => ({
      ok: false,
      error: { code: 'TOOL_MISSING', message: 'Codex CLI não encontrado.' },
    }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.value.state, 'BLOCKED');
  assert.equal(spy.merged, false, 'nunca mergear com apenas uma aprovação');
  assert.equal(result.value.consensus.reached, false);
  assert.equal(result.value.gateReport.allPassed, false);
  assert.ok(result.value.gateReport.failedGates.includes('CODEX_MERGE_APPROVED'));
});

test('Claude bloqueando a auditoria final impede o merge', async () => {
  const project = makeProject();
  const { result, spy } = await execute(project, {
    claudeAuditOverrides: {
      verdict: 'BLOCKED',
      blockingIssues: [
        { severity: 'blocking', title: 'Regressão', description: 'quebra o login' },
      ],
    },
  });

  assert.equal(result.value.state, 'BLOCKED');
  assert.equal(spy.merged, false);
  assert.ok(result.value.gateReport.failedGates.includes('CLAUDE_MERGE_APPROVED'));
});

test('auditoria sobre SHA diferente é rejeitada e impede o merge', async () => {
  const project = makeProject();
  const { result, spy } = await execute(project, {
    codexAuditOverrides: { reviewedHeadSha: 'ffff1111222233334444555566667777888899' },
  });

  assert.equal(spy.merged, false, 'SHA divergente jamais pode mergear');
  assert.equal(result.value.state, 'BLOCKED');
});

test('confiança abaixo do mínimo impede o merge', async () => {
  const project = makeProject();
  const { result, spy } = await execute(project, {
    codexAuditOverrides: { confidence: 0.4 },
  });

  assert.equal(spy.merged, false);
  assert.equal(result.value.consensus.reached, false);
});

/* ------------------------------------------------------------------------ */
/* CI                                                                        */
/* ------------------------------------------------------------------------ */

test('CI reprovado interrompe antes da auditoria final', async () => {
  const project = makeProject();
  const { result, spy } = await execute(project, {
    checksOverrides: {
      passed: 0,
      failed: 1,
      allRequiredPassed: false,
      anyRequiredFailed: true,
    },
  });

  assert.equal(result.value.state, 'CI_FAILED');
  assert.equal(spy.merged, false);
  assert.equal(
    spy.claudeCalls.includes('merge-auditor'),
    false,
    'não faz sentido auditar para merge com o CI reprovado',
  );
});

/* ------------------------------------------------------------------------ */
/* Política do projeto e segurança                                           */
/* ------------------------------------------------------------------------ */

test('remoto divergente impede toda a execução', async () => {
  const project = makeProject();
  const { result, spy } = await execute(project, {
    remoteUrl: 'https://github.com/outro-dono/outro-repo.git',
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'REMOTE_MISMATCH');
  assert.equal(spy.pushes, 0, 'nunca enviar para um remoto que não confere');
});

test('merge desabilitado no projeto conclui sem mergear', async () => {
  const project = makeProject({ merge: { enabled: false } });
  const { result, spy } = await execute(project);

  assert.equal(result.value.state, 'COMPLETED');
  assert.equal(spy.merged, false);
});

test('Claude indisponível falha com TOOL_MISSING antes de qualquer efeito', async () => {
  const project = makeProject();
  const { result, spy } = await execute(project, { claudeAvailable: false });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'TOOL_MISSING');
  assert.equal(spy.commits, 0);
  assert.equal(spy.pushes, 0);
});

/* ------------------------------------------------------------------------ */
/* Idempotência do merge                                                     */
/* ------------------------------------------------------------------------ */

test('PR já mergeada não é mergeada de novo', async () => {
  const project = makeProject();
  const { result, spy } = await execute(project, {
    freshPrOverrides: { merged: true, state: 'MERGED', mergeCommitSha: 'jamerged' },
  });

  assert.equal(result.ok, true);
  assert.equal(spy.merged, false, 'não deve executar um segundo merge');
  if (result.value.mergeOutcome) {
    assert.equal(result.value.mergeOutcome.idempotentSkip, true);
  }
});

/* ------------------------------------------------------------------------ */
/* Dry-run                                                                   */
/* ------------------------------------------------------------------------ */

test('dry-run não chama IA, não commita, não faz push e não mergeia', async () => {
  const project = makeProject();
  const { result, spy } = await execute(project, { dryRun: true });

  assert.equal(result.ok, true);
  assert.equal(result.value.state, 'COMPLETED');
  assert.equal(result.value.dryRun, true);
  assert.deepEqual(spy.claudeCalls, [], 'dry-run não pode chamar o Claude');
  assert.deepEqual(spy.codexCalls, [], 'dry-run não pode chamar o Codex');
  assert.equal(spy.commits, 0);
  assert.equal(spy.pushes, 0);
  assert.equal(spy.merged, false);
});

/* ------------------------------------------------------------------------ */
/* Retomada                                                                  */
/* ------------------------------------------------------------------------ */

test('prompt já aprovado não é reexecutado ao retomar', async () => {
  const project = makeProject();
  const first = await execute(project);
  assert.equal(first.result.value.state, 'MERGED');

  const { ports, spy } = makePorts({});
  const resumed = await runProject({
    projectId: project.id,
    dryRun: false,
    resumeRunId: first.result.value.runId,
    config: defaultGlobalConfig(),
    logger: nullLogger(),
    ports,
  });

  assert.equal(resumed.ok, true);
  assert.equal(
    spy.claudeCalls.includes('executor'),
    false,
    'prompt já aprovado não deve ser reexecutado',
  );
});
