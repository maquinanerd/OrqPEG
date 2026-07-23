'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/*
 * Controle real de pausa, cancelamento e consistência de estado.
 *
 * O que estes testes exercitam NÃO é um dublê de função que nunca resolve:
 * cada etapa longa (Claude, Codex, suíte de testes) é um PROCESSO REAL, com
 * PID, com um NETO e com uma testemunha irmã que precisa sobreviver. É a única
 * forma de demonstrar as três coisas que o produto prometia e não fazia:
 *
 *   1. o pedido de pausa/cancelamento DERRUBA a árvore de processos em curso;
 *   2. nenhuma etapa posterior começa depois que a intenção foi aceita;
 *   3. o estado persistido nunca retrocede — nem por escrita concorrente, nem
 *      pelo `catch` de exceção.
 *
 * A evidência de PID antes/depois é impressa via asserção: se um processo
 * sobreviver, o teste falha nomeando o PID.
 */

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'orqpeg-ctl-'));
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
const { runTestSuite } = require('../../dist/tests-runner/test-runner');
const { createProject } = require('../../dist/projects/project-store');
const { normalizeProjectConfig } = require('../../dist/projects/project-validator');
const { nullLogger } = require('../../dist/utils/logger');
const { defaultGlobalConfig } = require('../../dist/config/global-config');
const { ensureDataLayout, projectPromptsDir } = require('../../dist/utils/paths');
const runState = require('../../dist/state/run-state');
const { latestRun, loadRun, requestPause, saveRun } = runState;
const {
  isRunLive,
  requestCancelOnLiveRun,
  requestPauseOnLiveRun,
  shutdownAllRuns,
  awaitAllRuns,
} = require('../../dist/execution/run-control');

const {
  isAlive,
  killAllWitnesses,
  longTestCommand,
  runLongChild,
  spawnWitness,
  tempDir,
  waitUntilDead,
  whenProcessStarts,
} = require('../helpers/long-process');

ensureDataLayout();

/* ------------------------------------------------------------------------ */
/* Fixtures                                                                  */
/* ------------------------------------------------------------------------ */

let projectCounter = 0;

/**
 * Projeto que termina no laço de prompts: sem push, sem PR, sem merge.
 * O escopo desta missão é o controle da execução, e um caminho mais curto
 * torna a causa de cada parada inequívoca.
 */
function makeProject(promptCount = 1, overrides = {}) {
  projectCounter += 1;
  const id = `ctl${projectCounter}`;
  const repoPath = path.join(HOME, 'repos', id);
  fs.mkdirSync(repoPath, { recursive: true });

  const config = normalizeProjectConfig({
    id,
    name: `Controle ${projectCounter}`,
    repositoryPath: repoPath,
    githubRepository: 'maquinanerd/demo',
    ...overrides,
  });
  config.worktree.enabled = false;
  config.git.pushAfterRun = false;
  config.pullRequest.enabled = false;
  config.merge.enabled = false;
  if (overrides.testCommands) config.commands.tests = overrides.testCommands;

  const created = createProject(config);
  assert.equal(created.ok, true, created.ok ? '' : JSON.stringify(created.error));

  const promptsDir = projectPromptsDir(id);
  fs.mkdirSync(promptsDir, { recursive: true });
  for (let index = 1; index <= promptCount; index += 1) {
    const promptId = `${String(index * 10).padStart(3, '0')}-etapa`;
    fs.writeFileSync(
      path.join(promptsDir, `${promptId}.md`),
      [
        '# Identificação',
        '',
        `ID: ${promptId}`,
        `Nome: Etapa ${index}`,
        '',
        '# Objetivo',
        '',
        `Construir a etapa ${index}.`,
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
  }

  return created.value;
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

function agentResult(output) {
  const at = new Date().toISOString();
  const proc = {
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
  };
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
      process: proc,
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
    durationMs: 5,
    commands: [
      {
        command: 'npm test',
        cwd: '',
        status: 'PASSED',
        exitCode: 0,
        startedAt: at,
        finishedAt: at,
        durationMs: 5,
        stdout: 'ok',
        stderr: '',
      },
    ],
    failedCommands: [],
  };
}

const OK = (value) => ({ ok: true, value });

/**
 * Portas com etapas LONGAS de verdade.
 *
 * `longClaude`, `longCodex` e `realTests` trocam o dublê instantâneo por um
 * processo com PID. `spy.processes` acumula todos os PIDs criados, para que
 * cada teste possa afirmar vida antes e morte depois.
 */
let portsCounter = 0;

function makePorts(workDir, options = {}) {
  portsCounter += 1;
  /* Cada conjunto de portas assina os commits com um prefixo próprio: numa
     retomada há DOIS conjuntos, e contadores reiniciados produziriam SHAs
     iguais que fariam um commit legítimo parecer duplicata. */
  const shaPrefix = `c0mm1t${portsCounter}x`;

  const spy = {
    processes: [],
    claudeCalls: 0,
    codexCalls: 0,
    commits: 0,
    testRuns: 0,
    stagedPaths: 0,
    shaPrefix,
  };

  const ports = {
    agents: {
      async runClaude(input) {
        spy.claudeCalls += 1;
        if (options.longClaude) {
          const { result } = await runLongChild({
            dir: workDir,
            label: `claude-${spy.claudeCalls}`,
            signal: input.signal,
            registry: spy.processes,
          });
          if (result.status === 'INTERRUPTED') {
            return {
              ok: false,
              error: { code: 'PROCESS_INTERRUPTED', message: 'Claude encerrado por cancelamento.' },
            };
          }
        }
        if (options.claudeThrowsOnCall === spy.claudeCalls) {
          throw new Error('falha injetada no executor');
        }
        return agentResult('Implementado.');
      },

      async runCodex(input) {
        spy.codexCalls += 1;
        if (options.longCodex) {
          const { result } = await runLongChild({
            dir: workDir,
            label: `codex-${spy.codexCalls}`,
            signal: input.signal,
            registry: spy.processes,
          });
          if (result.status === 'INTERRUPTED') {
            return {
              ok: false,
              error: { code: 'PROCESS_INTERRUPTED', message: 'Codex encerrado por cancelamento.' },
            };
          }
        }
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
        spy.diffRevision = (spy.diffRevision ?? 0) + 1;
        return OK(`diff --git a/src/app.ts b/src/app.ts\n@@\n+r${spy.diffRevision}\n`);
      },
      async addPaths() {
        spy.stagedPaths += 1;
        return OK(undefined);
      },
      async commit() {
        spy.commits += 1;
        return OK(`${shaPrefix}${spy.commits}`);
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
      /* Portas da conciliação de commit órfão: o contrato as exige, e um
         dublê incompleto esconderia uma quebra do contrato. */
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
          reason: 'merge desabilitado no teste',
          idempotentSkip: true,
        });
      },
    },

    tests: {
      async run(input) {
        spy.testRuns += 1;
        if (options.realTests) {
          return runTestSuite({
            commands: input.commands,
            cwd: input.cwd,
            timeoutSeconds: input.timeoutSeconds,
            ...(input.signal ? { signal: input.signal } : {}),
          });
        }
        return passingTests();
      },
    },
  };

  return { ports, spy };
}

function execute(project, ports, extra = {}) {
  return runProject({
    projectId: project.id,
    dryRun: false,
    config: defaultGlobalConfig(),
    logger: nullLogger(),
    ports,
    ...extra,
  });
}

/** PIDs de todos os processos criados, avô e neto. */
function allPids(spy) {
  const pids = [];
  for (const entry of spy.processes) {
    pids.push(entry.pid);
    if (typeof entry.grandchildPid === 'number') pids.push(entry.grandchildPid);
  }
  return pids;
}

/* ------------------------------------------------------------------------ */
/* 1. Pausa durante o Claude                                                 */
/* ------------------------------------------------------------------------ */

test('pausar enquanto o Claude está ativo encerra a árvore e NÃO inicia os testes', async () => {
  const project = makeProject(1);
  const workDir = tempDir('orqpeg-claude-');
  const { ports, spy } = makePorts(workDir, { longClaude: true });

  const witness = spawnWitness();
  const stopTrigger = whenProcessStarts(path.join(workDir, 'pids-claude-1-0.json'), () => {
    requestPauseOnLiveRun(project.id, 'panel');
  });

  const result = await execute(project, ports);
  stopTrigger();

  assert.equal(result.ok, true, result.ok ? '' : JSON.stringify(result.error));

  const pids = allPids(spy);
  assert.equal(pids.length, 2, `esperava avô e neto, obtive ${JSON.stringify(spy.processes)}`);

  // EVIDÊNCIA: nenhum PID da árvore sobrevive.
  const dead = await waitUntilDead(pids);
  assert.equal(dead, true, `processos sobreviveram à pausa: ${JSON.stringify(pids.filter(isAlive))}`);

  // EVIDÊNCIA: a testemunha irmã continua viva — o encerramento foi por PID, não por nome.
  assert.equal(isAlive(witness.pid), true, 'a testemunha foi morta junto: o encerramento não é por árvore');
  witness.kill();

  // A etapa seguinte NÃO começou.
  assert.equal(spy.testRuns, 0, 'a suíte de testes começou depois da pausa aceita');
  assert.equal(spy.codexCalls, 0, 'o revisor foi chamado depois da pausa aceita');
  assert.equal(spy.commits, 0, 'houve commit depois da pausa aceita');

  // Estado retomável e coerente.
  assert.equal(result.value.state, 'INTERRUPTED');
  assert.equal(result.value.lastLoopGuard?.trigger, 'USER_PAUSED');

  const persisted = loadRun(project.id, result.value.runId);
  assert.equal(persisted.ok, true);
  assert.equal(persisted.value.state, 'INTERRUPTED');
  assert.equal(persisted.value.pauseRequested, true);
  assert.equal(persisted.value.branchName !== null, true, 'a branch foi perdida na pausa');
  assert.equal(persisted.value.commits.length, 0);
  // A tentativa consumida continua contabilizada: ela custou assinatura.
  assert.equal(persisted.value.budgets[0].attempts, 1);
  assert.equal(persisted.value.prompts[0].status, 'PENDING');

  // O registro em memória foi limpo.
  assert.equal(isRunLive(project.id), false);
});

/* ------------------------------------------------------------------------ */
/* 2. Pausa durante a suíte de testes (runner REAL)                          */
/* ------------------------------------------------------------------------ */

test('pausar durante os testes encerra o processo e preserva o checkpoint', async () => {
  const workDir = tempDir('orqpeg-tests-');
  const pidFile = path.join(workDir, 'suite-pids.json');
  const project = makeProject(1, {
    testCommands: [longTestCommand(pidFile)],
  });
  const { ports, spy } = makePorts(workDir, { realTests: true });

  const witness = spawnWitness();
  const stopTrigger = whenProcessStarts(pidFile, () => {
    requestPauseOnLiveRun(project.id, 'panel');
  });

  const result = await execute(project, ports);
  stopTrigger();

  assert.equal(result.ok, true, result.ok ? '' : JSON.stringify(result.error));
  assert.equal(spy.testRuns, 1, 'a suíte precisava ter começado para o teste fazer sentido');

  const suitePids = JSON.parse(fs.readFileSync(pidFile, 'utf8'));
  const dead = await waitUntilDead([suitePids.pid, suitePids.grandchildPid]);
  assert.equal(dead, true, 'a árvore da suíte de testes sobreviveu à pausa');

  assert.equal(isAlive(witness.pid), true, 'a testemunha irmã foi morta junto');
  witness.kill();

  // O revisor (etapa seguinte) não começou.
  assert.equal(spy.codexCalls, 0, 'o Codex foi chamado depois da pausa aceita');
  assert.equal(spy.commits, 0);

  assert.equal(result.value.state, 'INTERRUPTED');

  // Checkpoint preservado: identidade, branch e orçamento consumido.
  const persisted = loadRun(project.id, result.value.runId);
  assert.equal(persisted.ok, true);
  assert.equal(persisted.value.branchName !== null, true);
  assert.equal(persisted.value.workingDirectory !== null, true);
  assert.equal(persisted.value.budgets[0].claudeCalls, 1);
  assert.equal(persisted.value.revision > 0, true, 'a revisão de estado não avançou');
});

/* ------------------------------------------------------------------------ */
/* 3. Retomada não repete commit                                             */
/* ------------------------------------------------------------------------ */

test('retomar continua sem repetir commit já existente', async () => {
  const project = makeProject(2);
  const workDir = tempDir('orqpeg-resume-');

  /* Primeira volta: o prompt 1 é aprovado e commitado; a pausa chega enquanto
     o Claude do prompt 2 está ativo. */
  const first = makePorts(workDir, { longClaude: false });
  let pausedOnce = false;
  const originalRunClaude = first.ports.agents.runClaude;
  first.ports.agents.runClaude = async (input) => {
    const outcome = await originalRunClaude(input);
    if (!pausedOnce && first.spy.claudeCalls === 2) {
      pausedOnce = true;
      requestPauseOnLiveRun(project.id, 'panel');
    }
    return outcome;
  };

  const firstResult = await execute(project, first.ports);
  assert.equal(firstResult.ok, true, firstResult.ok ? '' : JSON.stringify(firstResult.error));
  assert.equal(firstResult.value.state, 'INTERRUPTED');
  assert.equal(first.spy.commits, 1, 'a primeira volta deveria ter produzido exatamente um commit');

  const runId = firstResult.value.runId;
  const afterPause = loadRun(project.id, runId);
  assert.equal(afterPause.ok, true);
  assert.equal(afterPause.value.commits.length, 1);
  assert.equal(afterPause.value.prompts[0].status, 'APPROVED');
  assert.equal(afterPause.value.prompts[0].commitSha, `${first.spy.shaPrefix}1`);

  /* Segunda volta: retomada. O prompt 1 não pode ser reexecutado nem
     recommitado; o prompt 2 segue do zero. */
  const second = makePorts(workDir, {});
  const resumed = await execute(project, second.ports, { resumeRunId: runId });
  assert.equal(resumed.ok, true, resumed.ok ? '' : JSON.stringify(resumed.error));

  assert.equal(second.spy.commits, 1, 'a retomada criou um commit a mais do que devia');
  assert.equal(second.spy.claudeCalls, 1, 'a retomada reexecutou um prompt já aprovado');

  const final = loadRun(project.id, runId);
  assert.equal(final.ok, true);
  assert.equal(final.value.commits.length, 2, 'o total de commits do registro não bate');
  const shas = final.value.commits.map((entry) => entry.sha);
  assert.equal(new Set(shas).size, shas.length, `commits duplicados no registro: ${shas.join(', ')}`);
  assert.deepEqual(
    final.value.commits.map((entry) => entry.promptId),
    ['010-etapa', '020-etapa'],
  );
  // A intenção de pausa foi deliberadamente limpa pela retomada.
  assert.equal(final.value.pauseRequested, false);
});

/* ------------------------------------------------------------------------ */
/* 4. Cancelamento durante Claude, Codex e testes                            */
/* ------------------------------------------------------------------------ */

for (const cenario of [
  { nome: 'Claude', options: { longClaude: true }, pidFile: 'pids-claude-1-0.json' },
  { nome: 'Codex', options: { longCodex: true }, pidFile: 'pids-codex-1-0.json' },
]) {
  test(`cancelar durante o ${cenario.nome} termina em CANCELLED e derruba a árvore`, async () => {
    const project = makeProject(1);
    const workDir = tempDir(`orqpeg-cancel-${cenario.nome.toLowerCase()}-`);
    const { ports, spy } = makePorts(workDir, cenario.options);

    const witness = spawnWitness();
    const stopTrigger = whenProcessStarts(path.join(workDir, cenario.pidFile), () => {
      requestCancelOnLiveRun(project.id, 'panel');
    });

    const result = await execute(project, ports);
    stopTrigger();

    assert.equal(result.ok, true, result.ok ? '' : JSON.stringify(result.error));
    assert.equal(result.value.state, 'CANCELLED');
    assert.equal(result.value.lastLoopGuard?.trigger, 'USER_CANCELLED');

    const pids = allPids(spy);
    assert.equal(pids.length > 0, true);
    const dead = await waitUntilDead(pids);
    assert.equal(dead, true, `processos sobreviveram ao cancelamento: ${JSON.stringify(pids.filter(isAlive))}`);

    assert.equal(isAlive(witness.pid), true, 'a testemunha irmã foi morta junto');
    witness.kill();

    assert.equal(spy.commits, 0, 'houve commit depois do cancelamento');

    const persisted = loadRun(project.id, result.value.runId);
    assert.equal(persisted.ok, true);
    assert.equal(persisted.value.state, 'CANCELLED');
    assert.equal(persisted.value.cancelRequested, true);
    assert.equal(persisted.value.finishedAt !== null, true, 'estado terminal sem carimbo de término');
    // Nada foi apagado.
    assert.equal(persisted.value.branchName !== null, true);
  });
}

test('cancelar durante a suíte de testes termina em CANCELLED', async () => {
  const workDir = tempDir('orqpeg-cancel-tests-');
  const pidFile = path.join(workDir, 'suite-pids.json');
  const project = makeProject(1, {
    testCommands: [longTestCommand(pidFile)],
  });
  const { ports, spy } = makePorts(workDir, { realTests: true });

  const stopTrigger = whenProcessStarts(pidFile, () => {
    requestCancelOnLiveRun(project.id, 'panel');
  });

  const result = await execute(project, ports);
  stopTrigger();

  assert.equal(result.ok, true, result.ok ? '' : JSON.stringify(result.error));
  assert.equal(result.value.state, 'CANCELLED');

  const suitePids = JSON.parse(fs.readFileSync(pidFile, 'utf8'));
  const dead = await waitUntilDead([suitePids.pid, suitePids.grandchildPid]);
  assert.equal(dead, true, 'a árvore da suíte sobreviveu ao cancelamento');

  assert.equal(spy.codexCalls, 0, 'o revisor foi chamado depois do cancelamento');
});

/* ------------------------------------------------------------------------ */
/* 5. Idempotência do cancelamento                                           */
/* ------------------------------------------------------------------------ */

test('cancelar duas vezes é idempotente: um estado terminal, uma transição', async () => {
  const project = makeProject(1);
  const workDir = tempDir('orqpeg-cancel2-');
  const { ports } = makePorts(workDir, { longClaude: true });

  const stopTrigger = whenProcessStarts(path.join(workDir, 'pids-claude-1-0.json'), () => {
    const first = requestCancelOnLiveRun(project.id, 'panel');
    const second = requestCancelOnLiveRun(project.id, 'cli');
    assert.equal(first?.accepted, true, 'o primeiro cancelamento não foi aceito');
    assert.equal(second?.accepted, true, 'o segundo cancelamento não foi aceito');
    assert.equal(first?.alreadyRequested, false);
    assert.equal(second?.alreadyRequested, true, 'o segundo pedido deveria se declarar repetido');
    assert.equal(second?.intent, 'CANCEL');
  });

  const result = await execute(project, ports);
  stopTrigger();

  assert.equal(result.ok, true, result.ok ? '' : JSON.stringify(result.error));
  assert.equal(result.value.state, 'CANCELLED');

  const persisted = loadRun(project.id, result.value.runId);
  assert.equal(persisted.ok, true);
  const cancelEvents = persisted.value.events.filter((event) => event.state === 'CANCELLED');
  assert.equal(cancelEvents.length, 1, `houve ${cancelEvents.length} transições para CANCELLED`);

  // Cancelar de novo, com a execução já encerrada, não altera nada.
  assert.equal(requestCancelOnLiveRun(project.id, 'panel'), null);
  const again = loadRun(project.id, result.value.runId);
  assert.equal(again.value.state, 'CANCELLED');
  assert.equal(again.value.revision, persisted.value.revision);
});

test('pausa não rebaixa um cancelamento já aceito', async () => {
  const project = makeProject(1);
  const workDir = tempDir('orqpeg-precedence-');
  const { ports } = makePorts(workDir, { longClaude: true });

  const stopTrigger = whenProcessStarts(path.join(workDir, 'pids-claude-1-0.json'), () => {
    requestCancelOnLiveRun(project.id, 'panel');
    const later = requestPauseOnLiveRun(project.id, 'cli');
    assert.equal(later?.intent, 'CANCEL', 'a pausa rebaixou o cancelamento');
  });

  const result = await execute(project, ports);
  stopTrigger();
  assert.equal(result.value.state, 'CANCELLED');
});

/* ------------------------------------------------------------------------ */
/* 6. Intenção persistida vinda de OUTRO processo                            */
/* ------------------------------------------------------------------------ */

test('intenção gravada no estado por outro processo interrompe a etapa em curso', async () => {
  const project = makeProject(1);
  const workDir = tempDir('orqpeg-file-intent-');
  const { ports, spy } = makePorts(workDir, { longClaude: true });

  /* Simula a CLI: escreve a intenção no arquivo de estado, sem tocar no
     controlador em memória. É exatamente o que `PAUSAR.cmd` faz de outro
     processo. */
  const stopTrigger = whenProcessStarts(path.join(workDir, 'pids-claude-1-0.json'), () => {
    const current = latestRun(project.id);
    assert.equal(current.ok, true);
    const saved = saveRun(requestPause(current.value));
    assert.equal(saved.ok, true, saved.ok ? '' : JSON.stringify(saved.error));
  });

  const result = await execute(project, ports);
  stopTrigger();

  assert.equal(result.ok, true, result.ok ? '' : JSON.stringify(result.error));
  assert.equal(result.value.state, 'INTERRUPTED');
  assert.equal(spy.testRuns, 0, 'a etapa seguinte começou apesar da intenção persistida');

  const pids = allPids(spy);
  const dead = await waitUntilDead(pids);
  assert.equal(dead, true, 'a árvore sobreviveu à intenção lida do estado persistido');
});

/* ------------------------------------------------------------------------ */
/* 7. Exceção não apaga o progresso persistido                               */
/* ------------------------------------------------------------------------ */

test('exceção depois de dois prompts preserva os dois prompts e os commits no JSON', async () => {
  const project = makeProject(3);
  const workDir = tempDir('orqpeg-throw-');
  /* A terceira chamada ao executor lança. Antes, o `catch` externo gravava a
     cópia capturada ANTES da pipeline e apagava os dois prompts aprovados. */
  const { ports, spy } = makePorts(workDir, { claudeThrowsOnCall: 3 });

  const result = await execute(project, ports);

  assert.equal(result.ok, false, 'a exceção deveria virar um Result de erro');
  assert.equal(result.error.code, 'INTERNAL');
  assert.equal(spy.commits, 2);

  const runs = latestRun(project.id);
  assert.equal(runs.ok, true);
  const persisted = loadRun(project.id, runs.value.runId);
  assert.equal(persisted.ok, true);

  const record = persisted.value;
  assert.equal(record.state, 'FAILED');
  assert.equal(record.lastError?.code, 'INTERNAL');

  // O progresso dos dois primeiros prompts SOBREVIVEU à exceção.
  assert.equal(record.commits.length, 2, `commits preservados: ${JSON.stringify(record.commits)}`);
  assert.deepEqual(
    record.commits.map((entry) => entry.promptId),
    ['010-etapa', '020-etapa'],
  );
  const approved = record.prompts.filter((prompt) => prompt.status === 'APPROVED');
  assert.equal(approved.length, 2, `prompts aprovados preservados: ${JSON.stringify(record.prompts)}`);
  assert.equal(record.prompts[0].commitSha, `${spy.shaPrefix}1`);
  assert.equal(record.prompts[1].commitSha, `${spy.shaPrefix}2`);

  // O registro em memória é limpo também no caminho da exceção.
  assert.equal(isRunLive(project.id), false, 'o controlador ficou pendurado após a exceção');
});

/* ------------------------------------------------------------------------ */
/* 7b. Falha de persistência interrompe em vez de seguir às cegas            */
/* ------------------------------------------------------------------------ */

test('falha ao persistir o estado interrompe a execução antes de gastar mais assinatura', async () => {
  const project = makeProject(2);
  const workDir = tempDir('orqpeg-persist-');
  const { ports, spy } = makePorts(workDir, {});

  /*
   * A partir da décima gravação o disco recusa. O que precisa acontecer: a
   * execução PARA declarando o motivo — não segue chamando IA, commitando e
   * publicando com o estado congelado numa versão antiga.
   */
  const original = runState.saveRun;
  let gravacoes = 0;
  runState.saveRun = (record, mode) => {
    gravacoes += 1;
    if (gravacoes >= 10) {
      return { ok: false, error: { code: 'IO_FAILED', message: 'disco cheio (falha injetada)' } };
    }
    return original(record, mode);
  };

  let result;
  try {
    result = await execute(project, ports);
  } finally {
    runState.saveRun = original;
  }

  assert.equal(result.ok, false, 'a execução seguiu apesar de o estado não poder ser gravado');
  assert.equal(result.error.code, 'IO_FAILED');
  assert.match(result.error.message, /não pôde ser persistido/);
  assert.equal(spy.commits < 2, true, 'houve commit depois de a persistência falhar');
  assert.equal(isRunLive(project.id), false);
});

/* ------------------------------------------------------------------------ */
/* 8. Desligamento não deixa processo órfão                                  */
/* ------------------------------------------------------------------------ */

test('desligamento interrompe a árvore e aguarda o término: nenhum órfão', async () => {
  const project = makeProject(1);
  const workDir = tempDir('orqpeg-shutdown-');
  const { ports, spy } = makePorts(workDir, { longClaude: true });

  const witness = spawnWitness();
  let shutdownDone = null;
  const stopTrigger = whenProcessStarts(path.join(workDir, 'pids-claude-1-0.json'), () => {
    const affected = shutdownAllRuns();
    assert.equal(affected.length, 1, 'o desligamento não encontrou a execução viva');
    shutdownDone = awaitAllRuns(20_000);
  });

  const result = await execute(project, ports);
  stopTrigger();

  assert.equal(result.ok, true, result.ok ? '' : JSON.stringify(result.error));
  assert.equal(shutdownDone !== null, true, 'o gatilho de desligamento não chegou a rodar');
  assert.equal(await shutdownDone, true, 'a espera do desligamento estourou o prazo');

  const pids = allPids(spy);
  const dead = await waitUntilDead(pids);
  assert.equal(dead, true, `processos órfãos após o desligamento: ${JSON.stringify(pids.filter(isAlive))}`);

  assert.equal(isAlive(witness.pid), true, 'a testemunha irmã foi morta pelo desligamento');
  witness.kill();

  /* Interrupção por queda do hospedeiro é RETOMÁVEL, não cancelamento: as três
     paradas continuam distintas. */
  assert.equal(result.value.state, 'INTERRUPTED');
  assert.equal(result.value.cancelRequested, false);
  assert.equal(isRunLive(project.id), false, 'o registro em memória não foi limpo');
});

/* ------------------------------------------------------------------------ */
/* 9. O encerramento atinge só a árvore correta                              */
/* ------------------------------------------------------------------------ */

test('o encerramento atinge apenas a árvore da execução: irmãos node sobrevivem', async () => {
  const project = makeProject(1);
  const workDir = tempDir('orqpeg-pid-scope-');
  const { ports, spy } = makePorts(workDir, { longClaude: true });

  /* Três testemunhas: processos "node" idênticos aos da execução. Matar por
     nome — `taskkill /IM node.exe` — levaria as três junto. */
  const witnesses = [spawnWitness(), spawnWitness(), spawnWitness()];

  const stopTrigger = whenProcessStarts(path.join(workDir, 'pids-claude-1-0.json'), () => {
    requestCancelOnLiveRun(project.id, 'panel');
  });

  const result = await execute(project, ports);
  stopTrigger();
  assert.equal(result.value.state, 'CANCELLED');

  const pids = allPids(spy);
  assert.equal(await waitUntilDead(pids), true, 'a árvore alvo sobreviveu');

  for (const witness of witnesses) {
    assert.equal(
      isAlive(witness.pid),
      true,
      `a testemunha ${witness.pid} foi morta: o encerramento não está restrito ao PID da execução`,
    );
    witness.kill();
  }
});

/* ------------------------------------------------------------------------ */
/* 10. Duas execuções do mesmo projeto no mesmo processo                     */
/* ------------------------------------------------------------------------ */

test('o registro em memória recusa uma segunda execução do mesmo projeto', async () => {
  const project = makeProject(1);
  const workDir = tempDir('orqpeg-double-');
  const { ports } = makePorts(workDir, { longClaude: true });

  let secondAttempt = null;
  const stopTrigger = whenProcessStarts(path.join(workDir, 'pids-claude-1-0.json'), async () => {
    const second = makePorts(workDir, {});
    secondAttempt = await execute(project, second.ports);
    requestCancelOnLiveRun(project.id, 'panel');
  });

  const result = await execute(project, ports);
  stopTrigger();

  assert.equal(result.ok, true, result.ok ? '' : JSON.stringify(result.error));
  assert.equal(secondAttempt !== null, true, 'a segunda tentativa não chegou a rodar');
  assert.equal(secondAttempt.ok, false);
  assert.equal(secondAttempt.error.code, 'LOCK_HELD');
});

/* ------------------------------------------------------------------------ */
/* Limpeza                                                                   */
/* ------------------------------------------------------------------------ */

test('limpeza: nenhuma testemunha fica viva ao fim do arquivo', () => {
  killAllWitnesses();
});
