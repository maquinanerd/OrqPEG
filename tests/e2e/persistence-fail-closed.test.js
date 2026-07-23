'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/*
 * Falha de persistência é PARADA, não aviso.
 *
 * A versão anterior guardava o erro de escrita num campo do contexto e devolvia
 * o objeto NÃO persistido. O fluxo seguia: os testes rodavam, o pacote era
 * montado, o Codex era chamado, o prompt era aprovado e um commit nascia — tudo
 * com o disco parado numa versão antiga. Um commit que o estado persistido não
 * conhece é exatamente o que a Missão 01 existia para eliminar.
 *
 * Cada teste aqui derruba a gravação num ponto diferente da tentativa e prova,
 * por CONTADORES, que nenhuma etapa posterior chegou a acontecer.
 */

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'orqpeg-failclosed-'));
process.env.ORQPEG_HOME = HOME;
process.env.ORQPEG_NO_FILE_LOG = '1';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
fs.mkdirSync(path.join(HOME, 'schemas'), { recursive: true });
for (const name of fs.readdirSync(path.join(REPO_ROOT, 'schemas'))) {
  fs.copyFileSync(path.join(REPO_ROOT, 'schemas', name), path.join(HOME, 'schemas', name));
}
fs.mkdirSync(path.join(HOME, 'templates'), { recursive: true });
for (const name of fs.readdirSync(path.join(REPO_ROOT, 'templates'))) {
  fs.copyFileSync(path.join(REPO_ROOT, 'templates', name), path.join(HOME, 'templates', name));
}

const runState = require('../../dist/state/run-state');
const { runProject } = require('../../dist/execution/orchestrator');
const { createProject } = require('../../dist/projects/project-store');
const { normalizeProjectConfig } = require('../../dist/projects/project-validator');
const { nullLogger } = require('../../dist/utils/logger');
const { defaultGlobalConfig } = require('../../dist/config/global-config');
const { ensureDataLayout, projectPromptsDir } = require('../../dist/utils/paths');
const { readCommitJournal } = require('../../dist/state/commit-journal');

ensureDataLayout();

let counter = 0;

function makeProject() {
  counter += 1;
  const id = `fc${counter}`;
  const repoPath = path.join(HOME, 'repos', id);
  fs.mkdirSync(repoPath, { recursive: true });

  const config = normalizeProjectConfig({
    id,
    name: `FailClosed ${counter}`,
    repositoryPath: repoPath,
    githubRepository: 'maquinanerd/demo',
  });
  config.worktree.enabled = false;
  config.git.pushAfterRun = false;
  config.pullRequest.enabled = false;
  config.merge.enabled = false;

  const created = createProject(config);
  assert.equal(created.ok, true, created.ok ? '' : JSON.stringify(created.error));

  const promptsDir = projectPromptsDir(id);
  fs.mkdirSync(promptsDir, { recursive: true });
  fs.writeFileSync(
    path.join(promptsDir, '010-etapa.md'),
    [
      '# Identificação',
      '',
      'ID: 010-etapa',
      'Nome: Etapa única',
      '',
      '# Objetivo',
      '',
      'Construir a etapa.',
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

  return created.value;
}

const OK = (value) => ({ ok: true, value });

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

function promptReviewJson() {
  return JSON.stringify({
    verdict: 'APPROVED',
    summary: 'Revisão automatizada de teste.',
    confidence: 0.97,
    meetsPromptRequirements: true,
    blockingIssues: [],
    nonBlockingIssues: [],
    requiredActions: [],
    scopeAssessment: { withinScope: true, unexpectedChanges: [] },
    testsAssessment: { localTestsPassed: true, coverageAcceptable: true },
    riskAssessment: { level: 'low', summary: 'Baixo risco.' },
  });
}

function passingTests() {
  const at = new Date().toISOString();
  return {
    status: 'PASSED',
    passed: true,
    startedAt: at,
    finishedAt: at,
    durationMs: 1,
    commands: [
      {
        command: 'noop',
        cwd: '',
        status: 'PASSED',
        exitCode: 0,
        startedAt: at,
        finishedAt: at,
        durationMs: 1,
        stdout: 'ok',
        stderr: '',
      },
    ],
    failedCommands: [],
  };
}

/** Portas com contadores de TODAS as etapas que produzem efeito. */
function makePorts() {
  const spy = {
    claudeCalls: 0,
    codexCalls: 0,
    testRuns: 0,
    addPaths: 0,
    commits: 0,
    pushes: 0,
    prs: 0,
    merges: 0,
  };

  const ports = {
    agents: {
      async runClaude() {
        spy.claudeCalls += 1;
        return agentResult('Implementado.');
      },
      async runCodex() {
        spy.codexCalls += 1;
        return agentResult(promptReviewJson());
      },
      async claudeAvailable() {
        return true;
      },
      async codexAvailable() {
        return true;
      },
    },
    git: {
      async headSha() {
        return OK('0000111122223333444455556666777788889999');
      },
      async currentBranch() {
        return OK('main');
      },
      async changedFiles() {
        return OK(['src/app.ts']);
      },
      async statusText() {
        return OK('M src/app.ts');
      },
      async diffStat() {
        return OK(' src/app.ts | 3 +++');
      },
      async diffPatch() {
        return OK('diff --git a/src/app.ts b/src/app.ts\n@@\n+x\n');
      },
      async addPaths() {
        spy.addPaths += 1;
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
        return OK('https://github.com/maquinanerd/demo.git');
      },
      async commitLog() {
        return OK('');
      },
      async listCommitsSince() {
        return OK([]);
      },
      async commitChangedFiles() {
        return OK([]);
      },
    },
    worktree: {
      async prepare(input) {
        return OK({ path: input.worktreePath, branch: input.branch });
      },
      async verifyOwnership(input) {
        return OK({ path: input.worktreePath, branch: input.branch });
      },
    },
    github: {
      async createDraftPullRequest() {
        spy.prs += 1;
        return OK(null);
      },
      async getPullRequest() {
        return OK(null);
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
        return OK(null);
      },
      async waitForChecks() {
        return OK(null);
      },
    },
    merge: {
      async execute() {
        spy.merges += 1;
        return OK({
          attempted: false,
          merged: false,
          mergeSha: null,
          strategy: 'squash',
          matchedHeadSha: null,
          performedAt: null,
          reason: 'desabilitado',
          idempotentSkip: true,
        });
      },
    },
    tests: {
      async run() {
        spy.testRuns += 1;
        return passingTests();
      },
    },
  };

  return { ports, spy };
}

/**
 * Roda a execução derrubando a gravação assim que `gatilho(step)` for
 * verdadeiro. A etapa é identificada pelo rótulo que `persistCheckpoint`
 * carrega — o mesmo que aparece na mensagem de erro do produto.
 */
async function executarComFalhaEm(project, ports, gatilho) {
  const original = runState.saveRun;
  let falhouEm = null;

  /*
   * A injeção observa o REGISTRO, não o rótulo: `saveRun` não recebe o passo.
   * O gatilho decide a partir do estado e do progresso, que é o que distingue
   * um ponto do outro dentro da tentativa.
   */
  runState.saveRun = (record, mode) => {
    if (falhouEm === null && gatilho(record)) {
      falhouEm = `${record.state}`;
      return { ok: false, error: { code: 'IO_FAILED', message: 'disco cheio (falha injetada)' } };
    }
    return original(record, mode);
  };

  try {
    const result = await runProject({
      projectId: project.id,
      dryRun: false,
      config: defaultGlobalConfig(),
      logger: nullLogger(),
      ports,
    });
    return { result, falhouEm };
  } finally {
    runState.saveRun = original;
  }
}

/** Toda falha de persistência precisa reprovar a execução, nomeando o passo. */
function assertParouPorPersistencia(result) {
  assert.equal(result.ok, false, 'a execução seguiu apesar de o estado não poder ser gravado');
  assert.equal(result.error.code, 'IO_FAILED');
  assert.match(result.error.message, /não pôde ser persistido/);
  assert.equal(
    typeof result.error.details.step,
    'string',
    'o erro não nomeia a etapa em que a persistência falhou',
  );
}

/* ------------------------------------------------------------------------ */

test('falha ao gravar a contabilização do Claude: os testes NÃO começam', async () => {
  const project = makeProject();
  const { ports, spy } = makePorts();

  /* O primeiro registro após a chamada do Claude é a contabilização, ainda em
     RUNNING_CLAUDE e com a chamada já somada ao orçamento. */
  const { result } = await executarComFalhaEm(
    project,
    ports,
    (record) => record.state === 'RUNNING_CLAUDE' && (record.budgets[0]?.claudeCalls ?? 0) >= 1,
  );

  assertParouPorPersistencia(result);
  assert.equal(spy.claudeCalls, 1, 'o Claude deveria ter sido chamado uma vez');
  assert.equal(spy.testRuns, 0, 'a suíte de testes começou depois de a persistência falhar');
  assert.equal(spy.codexCalls, 0, 'o Codex foi chamado depois de a persistência falhar');
  assert.equal(spy.addPaths, 0);
  assert.equal(spy.commits, 0, 'houve commit depois de a persistência falhar');
  assert.equal(spy.pushes, 0);
  assert.equal(spy.prs, 0);
  assert.equal(spy.merges, 0);
});

test('falha ao entrar em RUNNING_TESTS: nem os testes nem o Codex começam', async () => {
  const project = makeProject();
  const { ports, spy } = makePorts();

  const { result } = await executarComFalhaEm(
    project,
    ports,
    (record) => record.state === 'RUNNING_TESTS',
  );

  assertParouPorPersistencia(result);
  assert.equal(spy.claudeCalls, 1);
  assert.equal(spy.testRuns, 0, 'a suíte rodou apesar de a transição não ter sido gravada');
  assert.equal(spy.codexCalls, 0);
  assert.equal(spy.commits, 0);
});

test('falha ao montar o pacote de auditoria: o Codex NÃO é chamado', async () => {
  const project = makeProject();
  const { ports, spy } = makePorts();

  const { result } = await executarComFalhaEm(
    project,
    ports,
    (record) => record.state === 'BUILDING_REVIEW_PACKAGE',
  );

  assertParouPorPersistencia(result);
  assert.equal(spy.testRuns, 1, 'a suíte precisava ter rodado antes do ponto de falha');
  assert.equal(spy.codexCalls, 0, 'o Codex foi chamado depois de a persistência falhar');
  assert.equal(spy.commits, 0);
});

test('falha ao entrar em RUNNING_CODEX: o revisor NÃO é chamado', async () => {
  const project = makeProject();
  const { ports, spy } = makePorts();

  const { result } = await executarComFalhaEm(
    project,
    ports,
    (record) => record.state === 'RUNNING_CODEX',
  );

  assertParouPorPersistencia(result);
  assert.equal(spy.codexCalls, 0, 'o Codex rodou apesar de a transição não ter sido gravada');
  assert.equal(spy.commits, 0);
});

test('falha ao gravar a contabilização do Codex: NÃO há aprovação nem commit', async () => {
  const project = makeProject();
  const { ports, spy } = makePorts();

  const { result } = await executarComFalhaEm(
    project,
    ports,
    (record) => record.state === 'RUNNING_CODEX' && (record.budgets[0]?.codexCalls ?? 0) >= 1,
  );

  assertParouPorPersistencia(result);
  assert.equal(spy.codexCalls, 1, 'o Codex deveria ter sido chamado uma vez');
  assert.equal(spy.addPaths, 0, 'houve `git add` depois de a persistência falhar');
  assert.equal(spy.commits, 0, 'houve commit depois de a persistência falhar');
});

test('falha ao gravar a aprovação: NÃO há `git add` nem commit', async () => {
  const project = makeProject();
  const { ports, spy } = makePorts();

  const { result } = await executarComFalhaEm(
    project,
    ports,
    (record) => record.state === 'PROMPT_APPROVED',
  );

  assertParouPorPersistencia(result);
  assert.equal(spy.codexCalls, 1);
  assert.equal(spy.addPaths, 0, 'o índice foi preparado sem a aprovação estar no disco');
  assert.equal(spy.commits, 0, 'houve commit sem a aprovação estar no disco');
  assert.equal(spy.pushes, 0);
});

test('falha ao entrar em COMMITTING: nem o diário nem o commit acontecem', async () => {
  const project = makeProject();
  const { ports, spy } = makePorts();

  const { result } = await executarComFalhaEm(
    project,
    ports,
    (record) => record.state === 'COMMITTING',
  );

  assertParouPorPersistencia(result);
  assert.equal(spy.addPaths, 0, 'houve `git add` sem a entrada em COMMITTING no disco');
  assert.equal(spy.commits, 0, 'houve commit sem a entrada em COMMITTING no disco');

  const runs = runState.latestRun(project.id);
  assert.equal(runs.ok, true);
  const diario = readCommitJournal(project.id, runs.value.runId);
  assert.equal(diario.length, 0, 'o diário abriu uma intenção que não deveria ter começado');
});

test('falha ao gravar o SHA logo APÓS o commit: o diário fica pendente para a retomada', async () => {
  const project = makeProject();
  const { ports, spy } = makePorts();

  /* O registro do commit é a primeira gravação com `commits.length === 1`. */
  const { result } = await executarComFalhaEm(
    project,
    ports,
    (record) => record.commits.length >= 1,
  );

  assertParouPorPersistencia(result);
  assert.equal(spy.commits, 1, 'o commit precisava ter acontecido para o teste fazer sentido');
  assert.equal(spy.pushes, 0, 'houve push com o commit fora do estado persistido');
  assert.equal(spy.prs, 0);
  assert.equal(spy.merges, 0);

  /*
   * O ponto central: o commit existe e o estado não o conhece — e é
   * exatamente por isso que a entrada do diário precisa continuar PENDENTE.
   * É ela que fará a retomada adotar o commit em vez de criar um segundo.
   */
  const runs = runState.latestRun(project.id);
  const diario = readCommitJournal(project.id, runs.value.runId);
  assert.equal(diario.length, 1, `diário inesperado: ${JSON.stringify(diario)}`);
  assert.equal(
    diario[0].outcome,
    null,
    'o diário foi encerrado apesar de o SHA não ter chegado ao estado',
  );

  const persistido = runState.loadRun(project.id, runs.value.runId);
  assert.equal(persistido.value.commits.length, 0, 'o commit chegou ao estado; o teste não reproduziu a janela');
});

test('falha ao entrar em VALIDATING: nenhuma IA é chamada', async () => {
  const project = makeProject();
  const { ports, spy } = makePorts();

  const { result } = await executarComFalhaEm(
    project,
    ports,
    (record) => record.state === 'VALIDATING',
  );

  assertParouPorPersistencia(result);
  assert.equal(spy.claudeCalls, 0, 'o Claude foi chamado sem a validação estar no disco');
  assert.equal(spy.testRuns, 0);
  assert.equal(spy.commits, 0);
});
