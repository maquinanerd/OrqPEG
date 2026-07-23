'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/*
 * Evidência de parada é append-only.
 *
 * O que está sob teste aqui não é "o Loop Guard decide bem" — isso vive em
 * tests/unit/loop-guard.test.js. É a garantia física de que a decisão gravada
 * JAMAIS é sobrescrita: cada parada mora em seu próprio `stops/stop-NNN`, cada
 * tentativa mora em seu próprio `attempt-N`, e uma colisão de nome interrompe a
 * execução com `STATE_CORRUPT` em vez de truncar o que já estava em disco.
 *
 * O caso concreto que isso protege: a pessoa lê a decisão da parada, autoriza
 * um override com base nela, a tentativa extra roda e para de novo. Se a
 * segunda parada escrevesse por cima da primeira, a decisão que fundamentou a
 * autorização deixaria de existir para conferência.
 */

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'orqpeg-stops-'));
process.env.ORQPEG_HOME = HOME;
process.env.ORQPEG_NO_FILE_LOG = '1';

// O parser de revisão valida contra os schemas reais e o construtor de
// instruções lê os templates reais: ambos precisam existir sob a raiz isolada.
const REPO_ROOT = path.resolve(__dirname, '..', '..');
for (const pasta of ['schemas', 'templates']) {
  fs.mkdirSync(path.join(HOME, pasta), { recursive: true });
  for (const nome of fs.readdirSync(path.join(REPO_ROOT, pasta))) {
    fs.copyFileSync(path.join(REPO_ROOT, pasta, nome), path.join(HOME, pasta, nome));
  }
}

const {
  createExclusiveDirSync,
  writeExclusiveSync,
} = require('../../dist/utils/fs-atomic');
const { runProject } = require('../../dist/execution/orchestrator');
const { createProject } = require('../../dist/projects/project-store');
const { normalizeProjectConfig } = require('../../dist/projects/project-validator');
const { grantManualOverride } = require('../../dist/execution/override');
const { loadRun, saveRun } = require('../../dist/state/run-state');
const { nullLogger } = require('../../dist/utils/logger');
const { defaultGlobalConfig } = require('../../dist/config/global-config');
const {
  ensureDataLayout,
  projectArtifactsDir,
  projectPromptsDir,
  setOrqpegRootForTesting,
} = require('../../dist/utils/paths');
const { loopGuardPolicyFor } = require('../helpers/policy');

setOrqpegRootForTesting(HOME);
ensureDataLayout();

const PROMPT_ID = '010-fundacao';

/* ------------------------------------------------------------------------ */
/* Bloco 1 — a primitiva exclusiva, isolada                                  */
/* ------------------------------------------------------------------------ */

let sandboxCounter = 0;
function sandbox() {
  sandboxCounter += 1;
  const dir = path.join(HOME, 'sandbox', `caso-${sandboxCounter}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

test('createExclusiveDirSync cria os diretórios pais que faltam', () => {
  const raiz = sandbox();
  const alvo = path.join(raiz, 'a', 'b', 'c', 'stop-001');

  const criado = createExclusiveDirSync(alvo);

  assert.equal(criado.ok, true, criado.ok ? '' : criado.error.message);
  assert.equal(criado.value, alvo, 'o caminho criado é devolvido para uso do chamador');
  assert.equal(fs.statSync(alvo).isDirectory(), true, 'o alvo precisa existir de fato');
});

test('createExclusiveDirSync recusa alvo já existente com STATE_CORRUPT e preserva o conteúdo', () => {
  const raiz = sandbox();
  const alvo = path.join(raiz, 'stops', 'stop-001');
  fs.mkdirSync(alvo, { recursive: true });
  fs.writeFileSync(path.join(alvo, 'loop-guard.json'), '{"decisao":"original"}', 'utf8');

  const segundo = createExclusiveDirSync(alvo);

  assert.equal(segundo.ok, false, 'diretório de evidência jamais é reaproveitado em silêncio');
  assert.equal(segundo.error.code, 'STATE_CORRUPT');
  assert.match(segundo.error.message, /já existe/i);

  // A colisão não pode ter tocado no que já estava gravado.
  assert.equal(
    fs.readFileSync(path.join(alvo, 'loop-guard.json'), 'utf8'),
    '{"decisao":"original"}',
    'a evidência anterior precisa continuar byte a byte como estava',
  );
  assert.deepEqual(fs.readdirSync(alvo), ['loop-guard.json'], 'nada foi removido do diretório');
});

test('writeExclusiveSync grava quando o arquivo não existe e cria o diretório pai', () => {
  const raiz = sandbox();
  const alvo = path.join(raiz, 'stops', 'stop-001', 'LOOP-GUARD.md');

  const gravado = writeExclusiveSync(alvo, '# parada 1\n');

  assert.equal(gravado.ok, true, gravado.ok ? '' : gravado.error.message);
  assert.equal(fs.readFileSync(alvo, 'utf8'), '# parada 1\n');
});

test('writeExclusiveSync recusa arquivo já existente com STATE_CORRUPT e não altera o conteúdo anterior', () => {
  const raiz = sandbox();
  const alvo = path.join(raiz, 'loop-guard.json');
  const original = '{"stopSequence":1,"trigger":"NO_PROGRESS"}\n';
  fs.writeFileSync(alvo, original, 'utf8');

  const segundo = writeExclusiveSync(alvo, '{"stopSequence":2}\n');

  assert.equal(segundo.ok, false, 'sobrescrever evidência é erro, não comportamento normal');
  assert.equal(segundo.error.code, 'STATE_CORRUPT');
  assert.match(segundo.error.message, /já existe/i);
  assert.equal(
    fs.readFileSync(alvo, 'utf8'),
    original,
    'o conteúdo anterior não pode ter sido truncado nem substituído',
  );
});

/* ------------------------------------------------------------------------ */
/* Harness do ciclo real                                                     */
/* ------------------------------------------------------------------------ */

/*
 * `writeLoopGuardArtifacts` é privado ao orquestrador. A única forma honesta de
 * exercitar a função REAL — numeração, encadeamento e índice — é rodar o ciclo
 * com dublês, como faz tests/e2e/orchestrator-loop.test.js.
 */

let projectCounter = 0;

function makeProject() {
  projectCounter += 1;
  const id = `stops${projectCounter}`;
  const repoPath = path.join(HOME, 'repos', id);
  fs.mkdirSync(repoPath, { recursive: true });

  const config = normalizeProjectConfig({
    id,
    name: `Paradas ${projectCounter}`,
    repositoryPath: repoPath,
    githubRepository: 'maquinanerd/demo',
  });
  config.worktree.enabled = false;

  const created = createProject(config);
  assert.equal(created.ok, true, created.ok ? '' : JSON.stringify(created.error));

  const promptsDir = projectPromptsDir(id);
  fs.mkdirSync(promptsDir, { recursive: true });
  fs.writeFileSync(
    path.join(promptsDir, `${PROMPT_ID}.md`),
    [
      '# Identificação',
      '',
      `ID: ${PROMPT_ID}`,
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

  return created.value;
}

function agentResult(output) {
  const at = new Date().toISOString();
  const invocation = {
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
  };
  return {
    ok: true,
    value: {
      output,
      invocation,
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

/**
 * Revisão que sempre pede mudança, mas SEMPRE apontando algo diferente.
 *
 * Repetir o mesmo apontamento dispararia REPEATED_REVIEW_ISSUES antes do teto:
 * aqui interessa chegar a MAX_ATTEMPTS_REACHED, que é gatilho brando e portanto
 * admite o override que produz a segunda parada.
 */
function revisaoDistinta(seed) {
  let rodada = seed;
  return () => {
    rodada += 1;
    return agentResult(
      JSON.stringify({
        verdict: 'CHANGES_REQUESTED',
        summary: `Revisão da rodada ${rodada}.`,
        confidence: 0.97,
        meetsPromptRequirements: false,
        blockingIssues: [
          {
            severity: 'blocking',
            title: `Problema distinto ${rodada}`,
            description: `Descrição específica da rodada ${rodada}.`,
          },
        ],
        nonBlockingIssues: [],
        requiredActions: [`Corrigir o ponto número ${rodada}.`],
        scopeAssessment: { withinScope: true, unexpectedChanges: [] },
        testsAssessment: { localTestsPassed: true, coverageAcceptable: true },
        riskAssessment: { level: 'low', summary: 'Baixo risco.' },
      }),
    );
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

const OK = (value) => ({ ok: true, value });

/**
 * Portas mockadas mínimas para o laço de prompts.
 *
 * `diffSeed` faz o diff continuar de onde a execução anterior parou: repetir a
 * numeração ao retomar produziria uma assinatura de diff já vista e o gatilho
 * mudaria de MAX_ATTEMPTS_REACHED para outro, alterando o cenário sob teste.
 */
function makePorts(options = {}) {
  const spy = { claudeCalls: [], codexCalls: [], commits: 0 };
  let revisao = options.diffSeed ?? 0;
  const review = revisaoDistinta(options.diffSeed ?? 0);

  return {
    spy,
    ports: {
      agents: {
        async runClaude(input) {
          spy.claudeCalls.push(input.role);
          return agentResult('Implementado.');
        },
        async runCodex(input) {
          spy.codexCalls.push(input.role);
          return review();
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
          return OK(' src/app.ts | 10 +++++');
        },
        async diffPatch() {
          revisao += 1;
          return OK(`diff --git a/src/app.ts b/src/app.ts\n@@\n+revisao ${revisao}\n`);
        },
        async addPaths() {
          return OK(undefined);
        },
        async commit() {
          spy.commits += 1;
          return OK(`c0mm1t${spy.commits}`);
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
      },
      worktree: {
        async prepare(input) {
          return OK({ path: input.worktreePath, branch: input.branch });
        },
        async verifyOwnership() {
          return OK(undefined);
        },
      },
      github: {
        async createDraftPullRequest() {
          throw new Error('a execução não deveria chegar a publicar');
        },
        async getPullRequest() {
          throw new Error('a execução não deveria chegar a publicar');
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
          throw new Error('a execução não deveria chegar a publicar');
        },
        async waitForChecks() {
          throw new Error('a execução não deveria chegar a publicar');
        },
      },
      merge: {
        async execute() {
          throw new Error('a execução não deveria chegar ao merge');
        },
      },
      tests: {
        async run() {
          return passingTests();
        },
      },
    },
  };
}

async function executar(project, options = {}) {
  const { ports, spy } = makePorts(options);
  const result = await runProject({
    projectId: project.id,
    dryRun: false,
    config: defaultGlobalConfig(),
    logger: nullLogger(),
    ports,
    ...(options.resumeRunId ? { resumeRunId: options.resumeRunId } : {}),
  });
  return { result, spy };
}

function stopsDirOf(project, runId) {
  return path.join(projectArtifactsDir(project.id), runId, PROMPT_ID, 'stops');
}

function lerJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** Primeira parada: as três tentativas se esgotam com progresso real. */
async function ateAPrimeiraParada() {
  const project = makeProject();
  const { result } = await executar(project);

  assert.equal(result.ok, true, result.ok ? '' : JSON.stringify(result.error));
  assert.equal(
    result.value.state,
    'LOOP_GUARD_TRIGGERED',
    'o cenário depende de uma parada consciente do Loop Guard',
  );
  assert.equal(result.value.lastLoopGuard.trigger, 'MAX_ATTEMPTS_REACHED');

  return { project, run: result.value };
}

/** Autoriza a tentativa extra que a pessoa concede depois de ler a parada. */
function autorizarTentativaExtra(project, run) {
  const concedido = grantManualOverride({
    run,
    promptId: PROMPT_ID,
    justification: 'Ajustei o ambiente manualmente; mais uma tentativa deve resolver.',
    authorizedBy: 'teste',
    policy: loopGuardPolicyFor(project),
  });
  assert.equal(concedido.ok, true, concedido.ok ? '' : concedido.error.message);
  saveRun(concedido.value.run);
}

/* ------------------------------------------------------------------------ */
/* Bloco 2 — paradas sucessivas no ciclo real                                */
/* ------------------------------------------------------------------------ */

test('paradas sucessivas não sobrescrevem relatórios: stop-001 permanece intacto ao lado de stop-002', async () => {
  const { project, run } = await ateAPrimeiraParada();
  const stopsDir = stopsDirOf(project, run.runId);

  const primeiraJson = path.join(stopsDir, 'stop-001', 'loop-guard.json');
  const primeiraMd = path.join(stopsDir, 'stop-001', 'LOOP-GUARD.md');
  assert.equal(fs.existsSync(primeiraJson), true, 'a primeira parada grava stops/stop-001');
  assert.equal(fs.existsSync(primeiraMd), true, 'o relatório legível acompanha a decisão');

  const jsonAntes = fs.readFileSync(primeiraJson, 'utf8');
  const mdAntes = fs.readFileSync(primeiraMd, 'utf8');

  autorizarTentativaExtra(project, run);

  const retomada = await executar(project, { resumeRunId: run.runId, diffSeed: 3 });
  assert.equal(retomada.result.ok, true, retomada.result.ok ? '' : JSON.stringify(retomada.result.error));
  assert.equal(
    retomada.result.value.state,
    'LOOP_GUARD_TRIGGERED',
    'a tentativa extra também termina em parada, que é o cenário de duas paradas',
  );

  // A segunda parada mora em seu próprio diretório.
  assert.equal(
    fs.existsSync(path.join(stopsDir, 'stop-002', 'loop-guard.json')),
    true,
    'a segunda parada precisa de um diretório novo, stop-002',
  );

  // E a primeira continua exatamente como estava — é ela que fundamentou o
  // override e é ela que a pessoa vai reler para conferir a decisão.
  assert.equal(fs.readFileSync(primeiraJson, 'utf8'), jsonAntes, 'stop-001/loop-guard.json foi alterado');
  assert.equal(fs.readFileSync(primeiraMd, 'utf8'), mdAntes, 'stop-001/LOOP-GUARD.md foi alterado');

  const diretorios = fs
    .readdirSync(stopsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  assert.deepEqual(
    diretorios,
    ['stop-001', 'stop-002'],
    'cada parada numera o próprio diretório, sem reaproveitar caminho fixo',
  );
});

test('a cadeia de paradas é auditável: stop-002 aponta para o hash de stop-001 e o índice lista as duas em ordem', async () => {
  const { project, run } = await ateAPrimeiraParada();
  const stopsDir = stopsDirOf(project, run.runId);

  autorizarTentativaExtra(project, run);
  const retomada = await executar(project, { resumeRunId: run.runId, diffSeed: 3 });
  assert.equal(retomada.result.ok, true, retomada.result.ok ? '' : JSON.stringify(retomada.result.error));

  const primeira = lerJson(path.join(stopsDir, 'stop-001', 'loop-guard.json'));
  const segunda = lerJson(path.join(stopsDir, 'stop-002', 'loop-guard.json'));

  assert.equal(primeira.stopSequence, 1);
  assert.equal(segunda.stopSequence, 2, 'a numeração continua a partir do que está em disco');
  assert.equal(primeira.previousStopHash, null, 'a primeira parada não tem antecessora');
  assert.ok(
    typeof primeira.decisionHash === 'string' && primeira.decisionHash.length > 0,
    'cada parada precisa carregar o próprio hash',
  );
  assert.equal(
    segunda.previousStopHash,
    primeira.decisionHash,
    'a segunda parada precisa encadear no hash da primeira, senão a cadeia não é auditável',
  );
  assert.notEqual(
    segunda.decisionHash,
    primeira.decisionHash,
    'duas paradas distintas não podem ter o mesmo hash',
  );

  const index = lerJson(path.join(stopsDir, 'index.json'));
  assert.equal(Array.isArray(index), true, 'o índice é uma lista');
  assert.equal(index.length, 2, 'o índice lista as duas paradas');
  assert.deepEqual(
    index.map((entry) => entry.stopSequence),
    [1, 2],
    'a ordem do índice é a ordem cronológica das paradas',
  );
  assert.equal(index[0].decisionHash, primeira.decisionHash);
  assert.equal(index[1].decisionHash, segunda.decisionHash);
  assert.equal(index[1].previousStopHash, index[0].decisionHash);
  assert.equal(index[0].trigger, 'MAX_ATTEMPTS_REACHED');
});

/* ------------------------------------------------------------------------ */
/* Bloco 3 — proteção física do diretório da tentativa                       */
/* ------------------------------------------------------------------------ */

/*
 * A numeração das tentativas já deriva do orçamento persistido, o que resolve a
 * causa lógica da sobrescrita. Este teste cobre a proteção FÍSICA: se o número
 * repetir por qualquer outro motivo — restauração de backup, cópia manual,
 * defeito futuro — a execução tem de parar em vez de truncar a evidência.
 */
test('diretório attempt-4 preexistente interrompe a tentativa em vez de sobrescrever a evidência', async () => {
  const { project, run } = await ateAPrimeiraParada();
  autorizarTentativaExtra(project, run);

  const attemptDir = path.join(
    projectArtifactsDir(project.id),
    run.runId,
    PROMPT_ID,
    'attempt-4',
  );
  fs.mkdirSync(attemptDir, { recursive: true });
  const sentinela = path.join(attemptDir, 'git-diff.patch');
  fs.writeFileSync(sentinela, 'evidencia anterior da quarta tentativa\n', 'utf8');

  const retomada = await executar(project, { resumeRunId: run.runId, diffSeed: 3 });

  assert.equal(retomada.result.ok, false, 'a colisão de diretório precisa interromper a execução');
  assert.equal(retomada.result.error.code, 'STATE_CORRUPT');
  assert.match(retomada.result.error.message, /já existe/i);

  assert.equal(
    fs.readFileSync(sentinela, 'utf8'),
    'evidencia anterior da quarta tentativa\n',
    'o conteúdo do attempt-4 preexistente não pode ter sido tocado',
  );
  assert.deepEqual(
    fs.readdirSync(attemptDir),
    ['git-diff.patch'],
    'nenhum artefato novo pode ter sido escrito por cima da tentativa preexistente',
  );

  // Nenhuma IA foi acionada: a proteção age antes de gastar a assinatura.
  assert.deepEqual(retomada.spy.claudeCalls, [], 'a parada acontece antes de chamar o executor');

  const persistido = loadRun(project.id, run.runId);
  assert.equal(persistido.ok, true);
  assert.equal(
    persistido.value.state,
    'FAILED',
    'a execução precisa registrar a falha, não seguir como se nada tivesse acontecido',
  );
});
