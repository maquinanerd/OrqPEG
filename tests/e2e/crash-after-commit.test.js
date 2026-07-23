'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

/*
 * Queda entre `git commit` e a gravação do estado.
 *
 * A guarda anterior contra commit duplicado consultava apenas `run.commits`.
 * Ela não cobria a janela real:
 *
 *     git commit concluído
 *     -> processo cai
 *     -> saveRun nunca aconteceu
 *
 * Na retomada, o commit EXISTE na branch e NÃO existe no registro: a guarda não
 * o encontrava e o prompt era refeito e commitado de novo, duplicando trabalho
 * aprovado na branch que segue para o merge.
 *
 * Este teste usa um repositório Git REAL e uma queda REAL (`process.exit` de um
 * processo separado, exatamente entre as duas operações). Nenhum dublê poderia
 * reproduzi-la: a janela só existe entre duas operações de verdade.
 */

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'orqpeg-crash-'));
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

const { runProject } = require('../../dist/execution/orchestrator');
const realGit = require('../../dist/git/git');
const { createProject } = require('../../dist/projects/project-store');
const { normalizeProjectConfig } = require('../../dist/projects/project-validator');
const { nullLogger } = require('../../dist/utils/logger');
const { defaultGlobalConfig } = require('../../dist/config/global-config');
const { ensureDataLayout, projectPromptsDir } = require('../../dist/utils/paths');
const { latestRun, loadRun, mutateRun } = require('../../dist/state/run-state');
const {
  TRAILER_OPERATION_ID,
  TRAILER_PROMPT_ID,
  readCommitJournal,
  readTrailer,
} = require('../../dist/state/commit-journal');

ensureDataLayout();

const CRASH_RUNNER = path.resolve(__dirname, '..', 'helpers', 'crash-after-commit.js');

function git(dir, args) {
  const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8', windowsHide: true });
  assert.equal(
    result.status,
    0,
    `git ${args.join(' ')} falhou: ${result.stderr || result.stdout}`,
  );
  return result.stdout.trim();
}

/** Repositório Git real, com um commit inicial. */
function makeRepo(name) {
  const dir = path.join(HOME, 'repos', name);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ['init', '--initial-branch=main']);
  git(dir, ['config', 'user.name', 'OrqPEG Teste']);
  git(dir, ['config', 'user.email', 'teste@orqpeg.local']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(dir, 'README.md'), '# base\n', 'utf8');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-m', 'base inicial']);
  return dir;
}

function makeProject(name, repoDir) {
  const config = normalizeProjectConfig({
    id: name,
    name: `Queda ${name}`,
    repositoryPath: repoDir,
    githubRepository: 'maquinanerd/demo',
  });
  config.worktree.enabled = false;
  config.git.pushAfterRun = false;
  config.pullRequest.enabled = false;
  config.merge.enabled = false;

  const created = createProject(config);
  assert.equal(created.ok, true, created.ok ? '' : JSON.stringify(created.error));

  const promptsDir = projectPromptsDir(name);
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

/** Portas de retomada, com Git real e um contador de commits novos. */
function resumePorts(repoDir, spy) {
  return {
    agents: {
      async runClaude() {
        spy.claudeCalls += 1;
        fs.writeFileSync(path.join(repoDir, 'app.txt'), `retomada ${Date.now()}\n`, 'utf8');
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
      headSha: (dir) => realGit.headSha(dir),
      currentBranch: (dir) => realGit.currentBranch(dir),
      changedFiles: (dir) => realGit.changedFiles(dir),
      async statusText() {
        return OK('');
      },
      diffStat: (dir, from) => realGit.diffStat(dir, from),
      diffPatch: (dir, from) => realGit.diffPatch(dir, from),
      addPaths: (dir, paths) => realGit.addPaths(dir, paths),
      async commit(dir, message) {
        spy.commits += 1;
        return realGit.commit(dir, message);
      },
      async push() {
        return OK(undefined);
      },
      async remoteUrl() {
        return OK('https://github.com/maquinanerd/demo.git');
      },
      async commitLog() {
        return OK('');
      },
      listCommitsSince: (dir, fromRef) => realGit.listCommitsSince(dir, fromRef),
      commitChangedFiles: (dir, sha) => realGit.commitChangedFiles(dir, sha),
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
        return passingTests();
      },
    },
  };
}

/* ------------------------------------------------------------------------ */

test('queda entre o commit e a gravação do estado: a retomada adota o commit e NÃO cria outro', async () => {
  const repoDir = makeRepo('crash1');
  const project = makeProject('crash1', repoDir);
  const outFile = path.join(HOME, 'crash1-out.json');

  /* --- Fase 1: a queda, em processo separado ------------------------- */
  const crashed = spawnSync(
    process.execPath,
    [CRASH_RUNNER, HOME, project.id, repoDir, outFile],
    { encoding: 'utf8', windowsHide: true, timeout: 120_000 },
  );

  assert.equal(
    crashed.status,
    9,
    `o processo deveria ter caído com código 9 no ponto do commit; saiu com ${crashed.status}: ` +
      `${crashed.stdout}${crashed.stderr}`,
  );

  const crashInfo = JSON.parse(fs.readFileSync(outFile, 'utf8'));
  assert.equal(typeof crashInfo.sha, 'string', `queda sem SHA: ${JSON.stringify(crashInfo)}`);
  const shaAntes = crashInfo.sha;

  /* EVIDÊNCIA: o commit existe no Git... */
  const logDepoisDaQueda = git(repoDir, ['log', '--format=%H', 'main']);
  assert.equal(
    logDepoisDaQueda.split('\n').includes(shaAntes),
    true,
    'o commit não está no histórico após a queda',
  );
  const totalAntes = logDepoisDaQueda.split('\n').length;
  assert.equal(totalAntes, 2, 'esperava base + commit da execução');

  /* ...e o carimbo de identidade está nele. */
  const corpo = git(repoDir, ['log', '-1', '--format=%B', shaAntes]);
  assert.equal(readTrailer(corpo, TRAILER_PROMPT_ID), '010-etapa');
  const operationId = readTrailer(corpo, TRAILER_OPERATION_ID);
  assert.equal(typeof operationId, 'string');
  assert.equal(operationId.length, 32, 'o identificador de operação não tem 128 bits');

  /* ...mas NÃO está no registro de estado. */
  const registro = latestRun(project.id);
  assert.equal(registro.ok, true);
  const runId = registro.value.runId;
  const aposQueda = loadRun(project.id, runId);
  assert.equal(aposQueda.ok, true);
  assert.equal(
    aposQueda.value.commits.length,
    0,
    `o estado já conhecia o commit; a janela não foi reproduzida: ${JSON.stringify(aposQueda.value.commits)}`,
  );

  /* ...e o diário guarda a intenção PENDENTE. */
  const diario = readCommitJournal(project.id, runId);
  assert.equal(diario.length, 1, `diário inesperado: ${JSON.stringify(diario)}`);
  assert.equal(diario[0].outcome, null, 'a entrada do diário deveria estar pendente');
  assert.equal(diario[0].operationId, operationId);

  /* --- Fase 2: retomada ---------------------------------------------- */
  /* Uma queda dura deixa o registro no estado em que parou. O operador retoma;
     é a retomada que precisa reconhecer o commit órfão. */
  const marcado = mutateRun(project.id, runId, (current) => ({
    ok: true,
    value: { ...current, state: 'INTERRUPTED', previousState: current.state },
  }));
  assert.equal(marcado.ok, true, marcado.ok ? '' : JSON.stringify(marcado.error));

  const spy = { commits: 0, claudeCalls: 0, codexCalls: 0 };
  const resumed = await runProject({
    projectId: project.id,
    dryRun: false,
    resumeRunId: runId,
    config: defaultGlobalConfig(),
    logger: nullLogger(),
    ports: resumePorts(repoDir, spy),
  });

  assert.equal(resumed.ok, true, resumed.ok ? '' : JSON.stringify(resumed.error));

  /* EVIDÊNCIA CENTRAL: nenhum commit novo foi criado. */
  assert.equal(spy.commits, 0, 'a retomada criou um commit novo apesar de o commit já existir');
  assert.equal(spy.claudeCalls, 0, 'a retomada reexecutou um prompt cujo commit já existia');

  const logFinal = git(repoDir, ['log', '--format=%H', 'main']).split('\n');
  assert.equal(
    logFinal.length,
    totalAntes,
    `o histórico ganhou commits na retomada: ${logFinal.join(', ')}`,
  );

  /* O commit órfão foi ADOTADO pelo registro. */
  const final = loadRun(project.id, runId);
  assert.equal(final.ok, true);
  assert.equal(final.value.commits.length, 1, 'o commit órfão não foi adotado');
  assert.equal(final.value.commits[0].sha, shaAntes);
  assert.equal(final.value.commits[0].promptId, '010-etapa');
  assert.equal(final.value.prompts[0].status, 'APPROVED');
  assert.equal(final.value.prompts[0].commitSha, shaAntes);

  /* E o diário foi encerrado como adoção. */
  const diarioFinal = readCommitJournal(project.id, runId);
  assert.equal(diarioFinal[0].outcome, 'ADOPTED');
  assert.equal(diarioFinal[0].commitSha, shaAntes);
});

test('carimbo sem commit correspondente é abandonado, não adotado', async () => {
  const repoDir = makeRepo('crash2');
  const project = makeProject('crash2', repoDir);

  /* Uma intenção aberta que NUNCA virou commit — queda antes do `git commit`. */
  const { openCommitIntent } = require('../../dist/state/commit-journal');
  const { createRun, saveRun } = require('../../dist/state/run-state');
  const { createRunInput } = require('../helpers/policy');
  const { contentHash } = require('../../dist/execution/fingerprints');
  const { readTextSync } = require('../../dist/utils/fs-atomic');

  const promptPath = path.join(projectPromptsDir(project.id), '010-etapa.md');
  const entrada = createRunInput(project, [
    {
      id: '010-etapa',
      name: 'Etapa',
      fileName: '010-etapa.md',
      absolutePath: promptPath,
      order: 10,
      sizeBytes: 1,
    },
  ]);
  /* O hash do prompt precisa ser o REAL: o Loop Guard compara o snapshot com o
     arquivo em disco e, com um valor sintético, pararia em
     PROMPT_CHANGED_DURING_RUN antes de qualquer chamada de IA. */
  entrada.sourceSnapshots.promptHashes['010-etapa'] = contentHash(readTextSync(promptPath).value);

  const run = createRun(entrada);
  const criado = saveRun({ ...run, baseCommitSha: git(repoDir, ['rev-parse', 'HEAD']) });
  assert.equal(criado.ok, true);

  const intent = openCommitIntent({
    projectId: project.id,
    runId: criado.value.runId,
    promptId: '010-etapa',
    attempt: 1,
    message: 'commit que nunca aconteceu',
  });
  assert.equal(intent.ok, true);

  const marcado = mutateRun(project.id, criado.value.runId, (current) => ({
    ok: true,
    value: { ...current, state: 'INTERRUPTED' },
  }));
  assert.equal(marcado.ok, true);

  const spy = { commits: 0, claudeCalls: 0, codexCalls: 0 };
  const resumed = await runProject({
    projectId: project.id,
    dryRun: false,
    resumeRunId: criado.value.runId,
    config: defaultGlobalConfig(),
    logger: nullLogger(),
    ports: resumePorts(repoDir, spy),
  });
  assert.equal(resumed.ok, true, resumed.ok ? '' : JSON.stringify(resumed.error));

  /* Como não havia commit, o prompt roda normalmente e produz UM commit. */
  assert.equal(
    spy.claudeCalls,
    1,
    `o prompt deveria ter sido executado; estado final ${resumed.value.state} ` +
      `(${resumed.value.lastLoopGuard ? resumed.value.lastLoopGuard.trigger : 'sem gatilho'})`,
  );
  assert.equal(spy.commits, 1, 'o prompt deveria ter produzido exatamente um commit');

  const diario = readCommitJournal(project.id, criado.value.runId);
  const abandonada = diario.find((entry) => entry.operationId === intent.value.operationId);
  assert.equal(abandonada.outcome, 'ABANDONED', 'a intenção órfã não foi encerrada corretamente');

  const final = loadRun(project.id, criado.value.runId);
  assert.equal(final.value.commits.length, 1);
});
