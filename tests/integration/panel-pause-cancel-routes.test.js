'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

/*
 * Rotas de pausa e cancelamento do painel.
 *
 * O contrato que estes testes prendem:
 *
 *  - a API só responde 200 depois que um CONTROLADOR VIVO aceitou o pedido;
 *    quando só houve registro da intenção, a resposta é 202 e diz isso;
 *  - falha ao persistir a intenção NUNCA vira resposta de sucesso;
 *  - cancelar duas vezes responde sucesso nas duas — inclusive depois de a
 *    execução já ter terminado em CANCELLED.
 *
 * Antes, `handlePause`/`handleCancel` descartavam o `Result` da gravação e
 * respondiam 200 incondicionalmente, sem falar com controlador nenhum: o
 * operador lia "pausado" enquanto o processo filho seguia rodando.
 */

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'orqpeg-routes-'));
process.env.ORQPEG_HOME = HOME;
process.env.ORQPEG_NO_FILE_LOG = '1';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
fs.mkdirSync(path.join(HOME, 'public'), { recursive: true });
fs.writeFileSync(path.join(HOME, 'public', 'index.html'), '<h1>painel</h1>', 'utf8');
fs.mkdirSync(path.join(HOME, 'schemas'), { recursive: true });
for (const name of fs.readdirSync(path.join(REPO_ROOT, 'schemas'))) {
  fs.copyFileSync(path.join(REPO_ROOT, 'schemas', name), path.join(HOME, 'schemas', name));
}
fs.mkdirSync(path.join(HOME, 'templates'), { recursive: true });
for (const name of fs.readdirSync(path.join(REPO_ROOT, 'templates'))) {
  fs.copyFileSync(path.join(REPO_ROOT, 'templates', name), path.join(HOME, 'templates', name));
}

const runState = require('../../dist/state/run-state');
const { startPanelServer } = require('../../dist/server/http-server');
const { runProject } = require('../../dist/execution/orchestrator');
const { createProject } = require('../../dist/projects/project-store');
const { normalizeProjectConfig } = require('../../dist/projects/project-validator');
const { nullLogger } = require('../../dist/utils/logger');
const { defaultGlobalConfig } = require('../../dist/config/global-config');
const { ensureDataLayout, projectPromptsDir } = require('../../dist/utils/paths');
const { createRunInput } = require('../helpers/policy');

const {
  registerRun,
  releaseRun,
  resetRunControlForTests,
} = require('../../dist/execution/run-control');

const {
  isAlive,
  killAllWitnesses,
  runLongChild,
  spawnWitness,
  tempDir,
  waitUntilDead,
  whenProcessStarts,
} = require('../helpers/long-process');

ensureDataLayout();

let server = null;
let port = 0;

test('sobe o painel em porta efêmera de loopback', async () => {
  const config = defaultGlobalConfig();
  config.panel.port = 0;
  config.panel.openBrowserOnStart = false;
  const started = await startPanelServer({ config, logger: nullLogger() });
  assert.equal(started.ok, true, started.ok ? '' : JSON.stringify(started.error));
  server = started.value;
  port = started.value.port;
});

function post(pathname) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: pathname,
        method: 'POST',
        headers: { Host: `127.0.0.1:${port}`, 'Content-Type': 'application/json' },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = JSON.parse(body);
          } catch {
            /* resposta não-JSON: o teste examina o corpo cru */
          }
          resolve({ status: res.statusCode, body, json });
        });
      },
    );
    req.on('error', reject);
    req.end('{}');
  });
}

/* ------------------------------------------------------------------------ */
/* Fixtures                                                                  */
/* ------------------------------------------------------------------------ */

let counter = 0;

function makeProject() {
  counter += 1;
  const id = `rot${counter}`;
  const repoPath = path.join(HOME, 'repos', id);
  fs.mkdirSync(repoPath, { recursive: true });

  const config = normalizeProjectConfig({
    id,
    name: `Rota ${counter}`,
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

function longPorts(workDir, registry) {
  return {
    agents: {
      async runClaude(input) {
        const { result } = await runLongChild({
          dir: workDir,
          label: 'claude',
          signal: input.signal,
          registry,
        });
        if (result.status === 'INTERRUPTED') {
          return {
            ok: false,
            error: { code: 'PROCESS_INTERRUPTED', message: 'encerrado' },
          };
        }
        return { ok: false, error: { code: 'INTERNAL', message: 'não deveria completar' } };
      },
      async runCodex() {
        return { ok: false, error: { code: 'INTERNAL', message: 'não deveria ser chamado' } };
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
        return OK([]);
      },
      async statusText() {
        return OK('');
      },
      async diffStat() {
        return OK('');
      },
      async diffPatch() {
        return OK('');
      },
      async addPaths() {
        return OK(undefined);
      },
      async commit() {
        return OK('deadbeef');
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
          reason: 'desabilitado',
          idempotentSkip: true,
        });
      },
    },
    tests: {
      async run() {
        throw new Error('a suíte não deveria começar depois da intenção aceita');
      },
    },
  };
}

/* ------------------------------------------------------------------------ */
/* POST /pause com execução viva                                             */
/* ------------------------------------------------------------------------ */

test('POST /pause responde 200 apenas depois de o controlador vivo aceitar', async () => {
  const project = makeProject();
  const workDir = tempDir('orqpeg-route-pause-');
  const registry = [];
  const witness = spawnWitness();

  /*
   * A resposta é aguardada SEPARADAMENTE da execução: a rota confirma o
   * término antes de responder, e `runProject` resolve no mesmo instante em
   * que o controlador é liberado. Ler `response` logo após a execução leria
   * uma requisição ainda em voo.
   */
  let responsePromise = null;
  const stopTrigger = whenProcessStarts(path.join(workDir, 'pids-claude-0.json'), () => {
    responsePromise = post(`/api/projects/${project.id}/pause`);
  });

  const result = await runProject({
    projectId: project.id,
    dryRun: false,
    config: defaultGlobalConfig(),
    logger: nullLogger(),
    ports: longPorts(workDir, registry),
  });
  stopTrigger();

  assert.equal(responsePromise !== null, true, 'a rota não chegou a ser chamada');
  const response = await responsePromise;

  assert.equal(result.ok, true, result.ok ? '' : JSON.stringify(result.error));
  assert.equal(response.status, 200, `resposta inesperada: ${response.body}`);
  assert.equal(response.json.paused, true);
  assert.equal(response.json.accepted, true, 'a rota respondeu sucesso sem aceitação do controlador');
  assert.equal(
    response.json.terminated,
    true,
    'a rota respondeu 200 sem confirmar o encerramento da árvore',
  );
  assert.equal(response.json.intentPersisted, true, 'a intenção não foi declarada como persistida');
  assert.equal(typeof response.json.step, 'string');
  assert.equal(response.json.runId, result.value.runId);

  // A árvore do processo morreu.
  const pids = registry.flatMap((entry) => [entry.pid, entry.grandchildPid]);
  assert.equal(await waitUntilDead(pids), true, `sobreviventes: ${JSON.stringify(pids.filter(isAlive))}`);
  assert.equal(isAlive(witness.pid), true, 'a testemunha irmã foi morta junto');

  assert.equal(result.value.state, 'INTERRUPTED');
  const persisted = runState.loadRun(project.id, result.value.runId);
  assert.equal(persisted.value.pauseRequested, true);
});

/* ------------------------------------------------------------------------ */
/* POST /cancel: idempotência                                                */
/* ------------------------------------------------------------------------ */

test('POST /cancel é idempotente antes e depois do término da execução', async () => {
  const project = makeProject();
  const workDir = tempDir('orqpeg-route-cancel-');
  const registry = [];

  let respostasPromise = null;
  const stopTrigger = whenProcessStarts(path.join(workDir, 'pids-claude-0.json'), () => {
    /* As duas chamadas partem juntas e são resolvidas depois: cada uma aguarda
       a confirmação de término antes de responder. */
    const primeira = post(`/api/projects/${project.id}/cancel`);
    const segunda = primeira.then(() => post(`/api/projects/${project.id}/cancel`));
    respostasPromise = Promise.all([primeira, segunda]);
  });

  const result = await runProject({
    projectId: project.id,
    dryRun: false,
    config: defaultGlobalConfig(),
    logger: nullLogger(),
    ports: longPorts(workDir, registry),
  });
  stopTrigger();

  assert.equal(result.ok, true, result.ok ? '' : JSON.stringify(result.error));
  assert.equal(result.value.state, 'CANCELLED');

  assert.equal(respostasPromise !== null, true, 'as chamadas não aconteceram');
  const respostas = await respostasPromise;
  assert.equal(respostas.length, 2, 'as duas chamadas precisavam ter acontecido');
  for (const resposta of respostas) {
    assert.equal(resposta.status, 200, `resposta inesperada: ${resposta.body}`);
    assert.equal(resposta.json.cancelled, true);
  }

  const pids = registry.flatMap((entry) => [entry.pid, entry.grandchildPid]);
  assert.equal(await waitUntilDead(pids), true);

  /* Terceira chamada, com a execução JÁ terminal: continua sendo sucesso, e
     declara que nada foi alterado. */
  const antes = runState.loadRun(project.id, result.value.runId);
  const terceira = await post(`/api/projects/${project.id}/cancel`);
  assert.equal(terceira.status, 200, `resposta inesperada: ${terceira.body}`);
  assert.equal(terceira.json.cancelled, true);
  assert.equal(terceira.json.alreadyCancelled, true);

  const depois = runState.loadRun(project.id, result.value.runId);
  assert.equal(depois.value.state, 'CANCELLED');
  assert.equal(depois.value.revision, antes.value.revision, 'a chamada repetida gravou de novo');
});

/* ------------------------------------------------------------------------ */
/* Falha de persistência não pode virar sucesso                              */
/* ------------------------------------------------------------------------ */

test('erro ao persistir a pausa responde 500 e NÃO reporta sucesso', async () => {
  const project = makeProject();

  /* Execução não terminal no disco, sem controlador vivo: o objeto do teste é
     a fronteira HTTP, não o orquestrador. */
  const run = runState.createRun(
    createRunInput(project, [
      { id: '010-etapa', name: 'Etapa', fileName: '010-etapa.md', absolutePath: 'x', order: 10, sizeBytes: 1 },
    ]),
  );
  const criado = runState.saveRun(run);
  assert.equal(criado.ok, true);

  /* A fronteira persiste a intenção por `recordRunIntent`, que faz a leitura e
     a escrita dentro do mesmo lock de estado. É ele o ponto de injeção. */
  const original = runState.recordRunIntent;
  let chamadas = 0;
  runState.recordRunIntent = () => {
    chamadas += 1;
    return {
      ok: false,
      error: { code: 'IO_FAILED', message: 'disco cheio (falha injetada)' },
    };
  };

  let resposta;
  try {
    resposta = await post(`/api/projects/${project.id}/pause`);
  } finally {
    runState.recordRunIntent = original;
  }

  assert.equal(chamadas, 1, 'a rota não tentou persistir a intenção');
  assert.equal(resposta.status, 500, `resposta inesperada: ${resposta.body}`);
  assert.equal(resposta.json.paused, false, 'a API declarou pausa que não foi registrada');
  assert.equal(resposta.json.intentPersisted, false);
  assert.equal(resposta.json.code, 'IO_FAILED');
  assert.match(resposta.json.error, /NÃO foi registrada/);

  // O registro no disco continua sem intenção de pausa.
  const persisted = runState.loadRun(project.id, criado.value.runId);
  assert.equal(persisted.ok, true);
  assert.equal(persisted.value.pauseRequested, false);
});

test('erro ao persistir o cancelamento responde 500 e NÃO reporta sucesso', async () => {
  const project = makeProject();
  const run = runState.createRun(
    createRunInput(project, [
      { id: '010-etapa', name: 'Etapa', fileName: '010-etapa.md', absolutePath: 'x', order: 10, sizeBytes: 1 },
    ]),
  );
  const criado = runState.saveRun(run);
  assert.equal(criado.ok, true);

  const original = runState.recordRunIntent;
  runState.recordRunIntent = () => ({
    ok: false,
    error: { code: 'STATE_REGRESSION', message: 'gravação obsoleta (falha injetada)' },
  });

  let resposta;
  try {
    resposta = await post(`/api/projects/${project.id}/cancel`);
  } finally {
    runState.recordRunIntent = original;
  }

  assert.equal(resposta.status, 500, `resposta inesperada: ${resposta.body}`);
  assert.equal(resposta.json.cancelled, false);
  assert.equal(resposta.json.code, 'STATE_REGRESSION');

  const persisted = runState.loadRun(project.id, criado.value.runId);
  assert.equal(persisted.value.cancelRequested, false);
});

/* ------------------------------------------------------------------------ */
/* Sem execução viva: a resposta diz a verdade                               */
/* ------------------------------------------------------------------------ */

test('sem controlador vivo a pausa é 202 (registrada), não 200 (aceita)', async () => {
  const project = makeProject();
  const run = runState.createRun(
    createRunInput(project, [
      { id: '010-etapa', name: 'Etapa', fileName: '010-etapa.md', absolutePath: 'x', order: 10, sizeBytes: 1 },
    ]),
  );
  const criado = runState.saveRun(run);
  assert.equal(criado.ok, true);

  const resposta = await post(`/api/projects/${project.id}/pause`);
  assert.equal(resposta.status, 202, `resposta inesperada: ${resposta.body}`);
  assert.equal(resposta.json.paused, true);
  assert.equal(resposta.json.accepted, false, 'a rota afirmou aceitação sem controlador vivo');

  const persisted = runState.loadRun(project.id, criado.value.runId);
  assert.equal(persisted.value.pauseRequested, true, 'a intenção não chegou ao disco');
});

test('sem execução nenhuma o cancelamento responde 404', async () => {
  const project = makeProject();
  const resposta = await post(`/api/projects/${project.id}/cancel`);
  assert.equal(resposta.status, 404, `resposta inesperada: ${resposta.body}`);
});

/* ------------------------------------------------------------------------ */
/* Janela antes de o RunRecord existir                                       */
/* ------------------------------------------------------------------------ */

test('pausa imediata, com controlador vivo e SEM RunRecord, NÃO responde 404', async () => {
  const project = makeProject();

  /*
   * A janela real: `runProject` publica o controlador antes do primeiro
   * `await`, mas o registro em disco só nasce depois da validação. A rota
   * antiga procurava o registro primeiro e respondia 404 a um pedido que
   * tinha quem atender.
   */
  const controller = registerRun({ projectId: project.id });
  assert.notEqual(controller, null);
  assert.equal(controller.runId, null, 'o cenário exige que o runId ainda não exista');

  try {
    const resposta = await post(`/api/projects/${project.id}/pause`);

    assert.notEqual(resposta.status, 404, `a rota respondeu 404 na janela: ${resposta.body}`);
    assert.equal(resposta.status, 202, `resposta inesperada: ${resposta.body}`);
    assert.equal(resposta.json.paused, true);
    assert.equal(resposta.json.accepted, true, 'o controlador vivo não recebeu o pedido');
    assert.equal(
      resposta.json.terminated,
      false,
      'a rota afirmou encerramento sem que nada tivesse terminado',
    );

    /* O pedido chegou ao controlador e abortou o sinal: nenhuma etapa
       posterior pode começar. */
    assert.equal(controller.signal.aborted, true, 'o sinal não foi abortado');
    assert.equal(controller.intent, 'PAUSE');
  } finally {
    releaseRun(controller);
    resetRunControlForTests();
  }
});

test('cancelamento imediato na mesma janela é aceito e marca intenção terminal', async () => {
  const project = makeProject();
  const controller = registerRun({ projectId: project.id });

  try {
    const resposta = await post(`/api/projects/${project.id}/cancel`);
    assert.notEqual(resposta.status, 404, `a rota respondeu 404 na janela: ${resposta.body}`);
    assert.equal(resposta.json.cancelled, true);
    assert.equal(resposta.json.accepted, true);
    assert.equal(controller.intent, 'CANCEL');
  } finally {
    releaseRun(controller);
    resetRunControlForTests();
  }
});

/* ------------------------------------------------------------------------ */

test('encerra o painel e as testemunhas', async () => {
  killAllWitnesses();
  if (server) await server.close();
});
