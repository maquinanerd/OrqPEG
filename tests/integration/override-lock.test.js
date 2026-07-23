'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

/*
 * Concessão de override manual pelo CAMINHO REAL da rota.
 *
 * Estes testes não chamam `grantManualOverride` diretamente: eles sobem o
 * servidor do painel e disparam POST de verdade, porque o que está sob prova
 * não é a regra de negócio (coberta em tests/unit/override.test.js) e sim a
 * SERIALIZAÇÃO da concessão:
 *
 *  - duas concessões simultâneas não podem produzir duas autorizações;
 *  - painel e CLI são processos distintos, então a exclusão precisa estar no
 *    disco (lock persistente), não no event loop do Node;
 *  - a leitura do estado precisa acontecer DEPOIS do lock, senão a decisão é
 *    tomada sobre um retrato obsoleto e a gravação apaga o trabalho alheio;
 *  - execução sem política congelada não recebe autorização nenhuma, e o painel
 *    declara a ausência em vez de exibir os limites do cadastro de hoje.
 */

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'orqpeg-ovr-lock-'));
process.env.ORQPEG_HOME = HOME;
process.env.ORQPEG_NO_FILE_LOG = '1';

const { setOrqpegRootForTesting, ensureDataLayout } = require('../../dist/utils/paths');

setOrqpegRootForTesting(HOME);
ensureDataLayout();

const { startPanelServer } = require('../../dist/server/http-server');
const { defaultGlobalConfig } = require('../../dist/config/global-config');
const { nullLogger } = require('../../dist/utils/logger');
const { createProject } = require('../../dist/projects/project-store');
const { normalizeProjectConfig } = require('../../dist/projects/project-validator');
const { createRun, saveRun, loadRun } = require('../../dist/state/run-state');
const { acquireLock } = require('../../dist/state/locks');
const { grantManualOverride } = require('../../dist/execution/override');
const { createRunInput, loopGuardPolicyFor } = require('../helpers/policy');

const JUSTIFICATIVA =
  'O teste falhava por uma dependencia que acabei de instalar manualmente na maquina.';

let server = null;
let port = 0;
let counter = 0;

/* ------------------------------------------------------------------------ */
/* Infraestrutura                                                            */
/* ------------------------------------------------------------------------ */

function promptFiles() {
  return [
    {
      id: '010-a',
      name: 'A',
      fileName: '010-a.md',
      absolutePath: 'x',
      order: 10,
      sizeBytes: 1,
    },
  ];
}

function makeProject(patch = {}) {
  counter += 1;
  const id = `ovr${counter}`;
  const repositoryPath = path.join(HOME, 'repos', id);
  fs.mkdirSync(repositoryPath, { recursive: true });

  const created = createProject(
    normalizeProjectConfig({
      id,
      name: `Projeto ${counter}`,
      repositoryPath,
      githubRepository: 'maquinanerd/demo',
      ...patch,
    }),
  );
  assert.equal(created.ok, true, created.ok ? '' : JSON.stringify(created.error));
  return created.value;
}

/** Execução parada por gatilho BRANDO — o único caso que admite override. */
function makeStoppedRun(project, patch = {}) {
  const base = createRun(createRunInput(project, promptFiles()));
  const run = {
    ...base,
    state: 'LOOP_GUARD_TRIGGERED',
    previousState: 'RUNNING_CLAUDE',
    currentPromptId: '010-a',
    lastLoopGuard: {
      allowed: false,
      severity: 'soft_stop',
      trigger: 'NO_PROGRESS',
      reason: 'Duas tentativas seguidas produziram o mesmo diff.',
      evidence: {},
      nextActions: [],
    },
    ...patch,
  };
  const saved = saveRun(run);
  assert.equal(saved.ok, true, saved.ok ? '' : JSON.stringify(saved.error));
  return run;
}

function request(pathname, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: pathname,
        method: options.method ?? 'GET',
        headers: {
          Host: `127.0.0.1:${port}`,
          'Content-Type': 'application/json',
          ...(options.headers ?? {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          let payload = null;
          try {
            payload = JSON.parse(body);
          } catch {
            payload = null;
          }
          resolve({ status: res.statusCode, body, payload });
        });
      },
    );
    req.on('error', reject);

    if (options.body === undefined) {
      req.end();
      return;
    }

    const raw =
      typeof options.body === 'string' ? options.body : JSON.stringify(options.body);

    if (typeof options.betweenChunks !== 'function') {
      req.write(raw);
      req.end();
      return;
    }

    /* Corpo enviado em duas partes: o handler já recebeu a requisição e está
       preso lendo o corpo enquanto `betweenChunks` mexe no disco. */
    const cut = Math.max(1, Math.floor(raw.length / 2));
    req.write(raw.slice(0, cut));
    Promise.resolve()
      .then(() => options.betweenChunks())
      .then(
        () => {
          req.write(raw.slice(cut));
          req.end();
        },
        (error) => {
          req.destroy();
          reject(error);
        },
      );
  });
}

function postOverride(project, run, extra = {}) {
  return request(`/api/projects/${project.id}/runs/${run.runId}/override`, {
    method: 'POST',
    body: {
      promptId: '010-a',
      justification: JUSTIFICATIVA,
      authorizedBy: 'pablo',
      ...(extra.body ?? {}),
    },
    ...(extra.betweenChunks ? { betweenChunks: extra.betweenChunks } : {}),
  });
}

function overridesOnDisk(project, run) {
  const loaded = loadRun(project.id, run.runId);
  assert.equal(loaded.ok, true, loaded.ok ? '' : JSON.stringify(loaded.error));
  return loaded.value.overrides;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ------------------------------------------------------------------------ */

test('sobe o painel em porta efêmera de loopback', async () => {
  const config = defaultGlobalConfig();
  config.panel.port = 0;
  config.panel.openBrowserOnStart = false;

  const started = await startPanelServer({ config, logger: nullLogger() });
  assert.equal(started.ok, true, started.ok ? '' : JSON.stringify(started.error));
  server = started.value;
  port = started.value.port;
});

/* ------------------------------------------------------------------------ */
/* 1. Concessões concorrentes: uma só autorização, e nenhum 201 fantasma      */
/* ------------------------------------------------------------------------ */

/*
 * Duas fases, porque as duas concorrências são diferentes.
 *
 * A fase A é a concorrência barata: duas requisições ao MESMO processo. Ela
 * sozinha não prova nada sobre o lock — o event loop do Node já serializava um
 * bloco síncrono de ler-decidir-gravar, então ela passaria igual sem lock
 * nenhum. Está aqui como garantia ponta a ponta, não como prova.
 *
 * A prova é a fase B: um segundo escritor que assume o registro e conclui a
 * gravação DEPOIS da resposta do painel. Sem lock, o painel responde 201 e a
 * gravação do outro escritor — feita sobre o retrato anterior — apaga a
 * autorização recém-concedida. O 201 vira mentira: existe na resposta e não
 * existe no disco.
 */
test('concessões concorrentes produzem UMA autorização e nenhum 201 fantasma', async () => {
  /* --- Fase A: duas requisições simultâneas pela própria rota --- */
  const project = makeProject();
  const run = makeStoppedRun(project);

  const [primeira, segunda] = await Promise.all([
    postOverride(project, run),
    postOverride(project, run),
  ]);

  const status = [primeira.status, segunda.status].sort((a, b) => a - b);
  const concedidas = status.filter((code) => code === 201);
  const recusadas = status.filter((code) => code === 409 || code === 423);

  assert.equal(
    concedidas.length,
    1,
    `exatamente uma requisição pode ser aceita, veio ${JSON.stringify(status)}`,
  );
  assert.equal(
    recusadas.length,
    1,
    `a perdedora precisa ser recusada com 409 ou 423, veio ${JSON.stringify(status)}: ` +
      `${primeira.body} | ${segunda.body}`,
  );

  const overrides = overridesOnDisk(project, run);
  assert.equal(
    overrides.length,
    1,
    'o disco não pode registrar duas autorizações para a mesma parada',
  );
  assert.equal(overrides[0].consumed, false);
  assert.equal(overrides[0].promptId, '010-a');
  assert.equal(overrides[0].trigger, 'NO_PROGRESS');

  /* --- Fase B: escritor concorrente que conclui depois do painel --- */
  const outro = makeProject();
  const paralela = makeStoppedRun(outro);

  let lockDoCli = null;
  let retratoDoCli = null;

  const resposta = await postOverride(outro, paralela, {
    betweenChunks: async () => {
      /* A requisição já está no servidor. Neste instante o outro escritor
         assume o registro e tira o SEU retrato — o mesmo que usará para
         gravar mais tarde. */
      const adquirido = await acquireLock({
        scope: 'run',
        key: paralela.runId,
        projectId: outro.id,
        runId: paralela.runId,
        operation: 'concessão pelo CLI',
      });
      assert.equal(adquirido.ok, true, adquirido.ok ? '' : JSON.stringify(adquirido.error));
      lockDoCli = adquirido.value;

      const retrato = loadRun(outro.id, paralela.runId);
      assert.equal(retrato.ok, true, retrato.ok ? '' : JSON.stringify(retrato.error));
      retratoDoCli = retrato.value;
    },
  });

  /* O outro escritor termina AGORA, sobre o retrato que tirou antes. */
  assert.notEqual(retratoDoCli, null, 'o segundo escritor precisa ter tirado seu retrato');
  const doCli = grantManualOverride({
    run: retratoDoCli,
    promptId: '010-a',
    justification: 'Autorizacao concedida pelo CLI em outro processo, fora do painel.',
    authorizedBy: 'processo-cli',
    policy: loopGuardPolicyFor(outro),
  });
  assert.equal(doCli.ok, true, doCli.ok ? '' : JSON.stringify(doCli.error));
  const gravado = saveRun(doCli.value.run);
  assert.equal(gravado.ok, true, gravado.ok ? '' : JSON.stringify(gravado.error));
  await lockDoCli.release();

  const finais = overridesOnDisk(outro, paralela);
  const fantasma =
    resposta.status === 201 && !finais.some((entry) => entry.authorizedBy === 'pablo');
  assert.equal(
    fantasma,
    false,
    'a rota respondeu 201 e a autorização não existe no disco: a gravação do outro ' +
      `escritor apagou o que o painel disse ter concedido. Disco: ${JSON.stringify(finais)}`,
  );

  assert.equal(
    resposta.status,
    423,
    `com o registro assumido por outro escritor, a rota recusa em vez de decidir por cima: ${resposta.body}`,
  );
  assert.equal(finais.length, 1, 'a parada continua com uma única autorização');
  assert.equal(finais[0].authorizedBy, 'processo-cli');
});

/* ------------------------------------------------------------------------ */
/* 2. Painel e CLI não perdem autorização entre processos                     */
/* ------------------------------------------------------------------------ */

test('com o lock de execução em poder de outro processo, a rota responde 423 e não sobrescreve', async () => {
  const project = makeProject();
  const run = makeStoppedRun(project);

  /* Segundo escritor: o CLI segurando o mesmo recurso que o painel quer. */
  const doCli = await acquireLock({
    scope: 'run',
    key: run.runId,
    projectId: project.id,
    runId: run.runId,
    operation: 'retomada pelo CLI',
  });
  assert.equal(doCli.ok, true, doCli.ok ? '' : JSON.stringify(doCli.error));

  const bloqueada = await postOverride(project, run);
  assert.equal(
    bloqueada.status,
    423,
    `a rota precisa recusar com LOCK_HELD enquanto o CLI detém o lock: ${bloqueada.body}`,
  );
  assert.match(bloqueada.payload.error, /em uso por outro processo/i);
  assert.match(bloqueada.payload.error, new RegExp(String(process.pid)));
  assert.equal(
    overridesOnDisk(project, run).length,
    0,
    'nada pode ter sido gravado enquanto o outro processo detinha o lock',
  );

  await doCli.value.release();

  const concedida = await postOverride(project, run);
  assert.equal(
    concedida.status,
    201,
    `liberado o lock, a concessão precisa funcionar: ${concedida.body}`,
  );
  assert.equal(concedida.payload.granted, true);

  const overrides = overridesOnDisk(project, run);
  assert.equal(overrides.length, 1);
  assert.equal(overrides[0].authorizedBy, 'pablo');
});

/* ------------------------------------------------------------------------ */
/* 3. A releitura acontece sob o lock, não antes                              */
/* ------------------------------------------------------------------------ */

/*
 * A posse é conferida no momento de DECIDIR, não no momento em que a requisição
 * chega. Aqui o outro processo assume o registro depois que o painel já está
 * dentro do handler — e o painel, mesmo tendo chegado primeiro, não pode ler,
 * decidir nem gravar sobre um registro que agora tem outro dono.
 *
 * O trabalho que o outro escritor grava de propósito NÃO conflita com a
 * concessão (é um evento, não um override): sem lock, a concessão passaria e
 * gravaria a autorização, o que é exatamente o que as asserções abaixo proíbem.
 */
test('o painel não decide sobre um registro que outro processo assumiu depois do início da requisição', async () => {
  const project = makeProject();
  const run = makeStoppedRun(project);

  const antes = overridesOnDisk(project, run);
  assert.equal(antes.length, 0, 'o cenário começa sem autorização alguma');

  let lockDoCli = null;
  const MARCA = 'CLI assumiu a execucao para retomada.';

  const resposta = await postOverride(project, run, {
    betweenChunks: async () => {
      // A requisição já está no servidor; só o corpo ainda não terminou.
      await sleep(60);

      const adquirido = await acquireLock({
        scope: 'run',
        key: run.runId,
        projectId: project.id,
        runId: run.runId,
        operation: 'retomada pelo CLI',
      });
      assert.equal(adquirido.ok, true, adquirido.ok ? '' : JSON.stringify(adquirido.error));
      lockDoCli = adquirido.value;

      const atual = loadRun(project.id, run.runId);
      assert.equal(atual.ok, true, atual.ok ? '' : JSON.stringify(atual.error));
      const comTrabalhoDoCli = {
        ...atual.value,
        events: [
          ...atual.value.events,
          {
            at: new Date().toISOString(),
            state: atual.value.state,
            message: MARCA,
            data: {},
          },
        ],
      };
      const saved = saveRun(comTrabalhoDoCli);
      assert.equal(saved.ok, true, saved.ok ? '' : JSON.stringify(saved.error));
    },
  });

  assert.notEqual(lockDoCli, null, 'o segundo escritor precisa ter assumido o registro');

  assert.equal(
    overridesOnDisk(project, run).length,
    0,
    'nenhuma autorização pode ser gravada em um registro que pertence a outro processo',
  );
  assert.equal(
    resposta.status,
    423,
    `o handler precisa conferir a posse ao decidir, não ao receber a requisição: ${resposta.body}`,
  );
  assert.match(resposta.payload.error, /em uso por outro processo/i);

  const depois = loadRun(project.id, run.runId);
  assert.equal(depois.ok, true, depois.ok ? '' : JSON.stringify(depois.error));
  assert.equal(
    depois.value.events.some((entry) => entry.message === MARCA),
    true,
    'o trabalho do outro escritor não pode ser apagado por uma gravação do painel',
  );

  await lockDoCli.release();

  /* Devolvido o registro, a MESMA requisição é atendida: a recusa foi da posse
     concorrente, não do pedido. */
  const concedida = await postOverride(project, run);
  assert.equal(
    concedida.status,
    201,
    `liberado o registro, a concessão precisa funcionar: ${concedida.body}`,
  );
  assert.equal(overridesOnDisk(project, run).length, 1);
});

/* ------------------------------------------------------------------------ */
/* 4. Execução legada, sem política congelada                                 */
/* ------------------------------------------------------------------------ */

test('POST de override em execução sem snapshot de política responde 409 falando de política', async () => {
  const project = makeProject();
  const run = makeStoppedRun(project, { effectivePolicy: null, sourceSnapshots: null });

  const resposta = await postOverride(project, run);

  assert.equal(
    resposta.status,
    409,
    `sem política congelada não há limite conhecido para autorizar contra: ${resposta.body}`,
  );
  assert.match(resposta.payload.error, /pol[íi]tica/i);
  assert.equal(
    overridesOnDisk(project, run).length,
    0,
    'nenhuma autorização pode ser gravada sobre execução sem política congelada',
  );
});

/* ------------------------------------------------------------------------ */
/* 5. GET de execução legada não inventa limites                              */
/* ------------------------------------------------------------------------ */

test('GET de execução legada declara a ausência da política e NÃO devolve os limites do projeto atual', async () => {
  const project = makeProject({
    execution: { maxAttemptsPerPrompt: 9, loopGuard: { maxManualOverridesPerPrompt: 4 } },
  });
  assert.equal(project.execution.maxAttemptsPerPrompt, 9, 'o cadastro atual é distinto do padrão');

  /* Controle: com política congelada, a rota DEVOLVE os limites — o `null` do
     caso legado abaixo não é um `null` que a rota sempre devolveria. */
  const comPolitica = makeStoppedRun(project);
  const controle = await request(
    `/api/projects/${project.id}/runs/${comPolitica.runId}`,
  );
  assert.equal(controle.status, 200);
  assert.equal(controle.payload.loopGuard.maxAttemptsPerPrompt, 9);
  assert.equal(controle.payload.loopGuard.maxManualOverridesPerPrompt, 4);
  assert.equal(controle.payload.policyUnavailable, undefined);

  const legada = makeStoppedRun(project, { effectivePolicy: null, sourceSnapshots: null });
  const resposta = await request(`/api/projects/${project.id}/runs/${legada.runId}`);

  assert.equal(resposta.status, 200);
  assert.equal(
    resposta.payload.policyUnavailable.title,
    'POLÍTICA HISTÓRICA NÃO DISPONÍVEL',
  );
  assert.equal(resposta.payload.policyUnavailable.code, 'POLICY_SNAPSHOT_MISSING');
  assert.equal(resposta.payload.loopGuard, null, 'limite inventado é pior que limite nenhum');
  assert.equal(resposta.payload.override, null);
  assert.equal(resposta.payload.policy, undefined);

  assert.equal(
    resposta.body.includes('maxAttemptsPerPrompt'),
    false,
    'nenhum limite do cadastro de hoje pode vazar na resposta de uma execução legada',
  );
  assert.equal(
    resposta.body.includes('maxManualOverridesPerPrompt'),
    false,
    'nenhum limite do cadastro de hoje pode vazar na resposta de uma execução legada',
  );
});

/* ------------------------------------------------------------------------ */

test('encerra o painel', async () => {
  if (server) await server.close();
  server = null;
});
