'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/*
 * Compare-and-swap do estado persistido.
 *
 * O defeito que estes testes prendem: o orquestrador segura o `RunRecord` em
 * memória por minutos (uma chamada de IA dura até uma hora). Se, nesse
 * intervalo, o painel gravar um pedido de pausa, a gravação seguinte do
 * orquestrador — feita a partir da cópia antiga, com `pauseRequested: false` —
 * apagava o pedido. O botão de pausar funcionava, e a pausa sumia.
 *
 * A regra que substitui isso: a intenção é MONOTÔNICA. Uma gravação nunca
 * desliga pausa ou cancelamento; só a retomada, que grava em modo `REPLACE`,
 * pode limpar a folha. E toda gravação obsoleta que apagaria progresso já
 * persistido é RECUSADA por nome, em vez de aceita em silêncio.
 */

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'orqpeg-cas-'));
process.env.ORQPEG_HOME = HOME;
process.env.ORQPEG_NO_FILE_LOG = '1';

const {
  createRun,
  loadRun,
  saveRun,
  requestPause,
  requestCancel,
  recordRunIntent,
  readPersistedIntent,
  transition,
  updatePromptProgress,
} = require('../../dist/state/run-state');
const { createProject } = require('../../dist/projects/project-store');
const { normalizeProjectConfig } = require('../../dist/projects/project-validator');
const { ensureDataLayout, projectStateDir } = require('../../dist/utils/paths');
const { createRunInput } = require('../helpers/policy');

ensureDataLayout();

let counter = 0;

function projeto() {
  counter += 1;
  const id = `cas${counter}`;
  const repoPath = path.join(HOME, 'repos', id);
  fs.mkdirSync(repoPath, { recursive: true });
  const criado = createProject(
    normalizeProjectConfig({
      id,
      name: `CAS ${counter}`,
      repositoryPath: repoPath,
      githubRepository: 'maquinanerd/demo',
    }),
  );
  assert.equal(criado.ok, true, criado.ok ? '' : JSON.stringify(criado.error));
  return criado.value;
}

function prompts() {
  return [
    {
      id: '010-a',
      name: 'Fundação',
      fileName: '010-a.md',
      absolutePath: 'x',
      order: 10,
      sizeBytes: 1,
    },
    {
      id: '020-b',
      name: 'Interface',
      fileName: '020-b.md',
      absolutePath: 'y',
      order: 20,
      sizeBytes: 1,
    },
  ];
}

function novaExecucao(project) {
  const run = createRun(createRunInput(project, prompts()));
  const saved = saveRun(run);
  assert.equal(saved.ok, true, saved.ok ? '' : JSON.stringify(saved.error));
  return saved.value;
}

/* ------------------------------------------------------------------------ */

test('a revisão nasce em zero e cresce a cada gravação bem-sucedida', () => {
  const project = projeto();
  const run = createRun(createRunInput(project, prompts()));
  assert.equal(run.revision, 0);

  const first = saveRun(run);
  assert.equal(first.ok, true);
  assert.equal(first.value.revision, 1);
  // O objeto do chamador é carimbado com o que foi gravado.
  assert.equal(run.revision, 1);

  const second = saveRun(first.value);
  assert.equal(second.value.revision, 2);
});

test('gravação concorrente do orquestrador NÃO apaga a intenção de pausa', () => {
  const project = projeto();
  const inicial = novaExecucao(project);

  /* O orquestrador segura esta cópia enquanto uma etapa longa roda. */
  const copiaDoOrquestrador = { ...inicial };

  /* Enquanto isso, o painel registra a pausa sobre o estado do disco. */
  const doDisco = loadRun(project.id, inicial.runId);
  assert.equal(doDisco.ok, true);
  const pausado = saveRun(requestPause(doDisco.value));
  assert.equal(pausado.ok, true);
  assert.equal(pausado.value.pauseRequested, true);
  assert.equal(pausado.value.revision, inicial.revision + 1);

  /* O orquestrador grava a cópia OBSOLETA, com `pauseRequested: false`. */
  assert.equal(copiaDoOrquestrador.pauseRequested, false);
  const depois = saveRun({ ...copiaDoOrquestrador, currentAttempt: 2 });
  assert.equal(depois.ok, true, depois.ok ? '' : JSON.stringify(depois.error));

  // A intenção sobreviveu...
  assert.equal(depois.value.pauseRequested, true, 'a gravação obsoleta apagou a pausa');
  // ...o progresso da gravação também...
  assert.equal(depois.value.currentAttempt, 2);
  // ...e a revisão avançou por cima da do disco.
  assert.equal(depois.value.revision, pausado.value.revision + 1);

  // O disco confirma.
  const relido = loadRun(project.id, inicial.runId);
  assert.equal(relido.value.pauseRequested, true);
  assert.equal(relido.value.currentAttempt, 2);
});

test('gravação concorrente NÃO apaga a intenção de cancelamento', () => {
  const project = projeto();
  const inicial = novaExecucao(project);
  const copiaDoOrquestrador = { ...inicial };

  const doDisco = loadRun(project.id, inicial.runId);
  const cancelado = saveRun(requestCancel(doDisco.value));
  assert.equal(cancelado.value.cancelRequested, true);

  const depois = saveRun(copiaDoOrquestrador);
  assert.equal(depois.value.cancelRequested, true, 'a gravação obsoleta apagou o cancelamento');
});

test('a intenção é monotônica mesmo sem obsolescência de revisão', () => {
  const project = projeto();
  const inicial = novaExecucao(project);

  const pausado = saveRun(requestPause(inicial));
  assert.equal(pausado.value.pauseRequested, true);

  /* Mesma revisão, mas tentando desligar a marca: em MERGE isso é recusado por
     construção. Só `REPLACE` desliga — e só a retomada usa `REPLACE`. */
  const tentativa = saveRun({ ...pausado.value, pauseRequested: false });
  assert.equal(tentativa.ok, true);
  assert.equal(tentativa.value.pauseRequested, true, 'MERGE permitiu desligar a intenção');
});

test('REPLACE limpa a intenção: é o modo exclusivo da retomada', () => {
  const project = projeto();
  const inicial = novaExecucao(project);
  const pausado = saveRun(requestPause(inicial));
  assert.equal(pausado.value.pauseRequested, true);

  const limpo = saveRun(
    { ...pausado.value, pauseRequested: false, cancelRequested: false },
    'REPLACE',
  );
  assert.equal(limpo.ok, true);
  assert.equal(limpo.value.pauseRequested, false);
  assert.equal(limpo.value.cancelRequested, false);

  const relido = loadRun(project.id, inicial.runId);
  assert.equal(relido.value.pauseRequested, false);
});

test('gravação obsoleta que apagaria commits é RECUSADA com STATE_REGRESSION', () => {
  const project = projeto();
  const inicial = novaExecucao(project);
  const copiaAntiga = { ...inicial };

  /* O disco avança: dois commits e um prompt aprovado. */
  const comProgresso = saveRun({
    ...loadRun(project.id, inicial.runId).value,
    commits: [
      { promptId: '010-a', sha: 'aaa1', message: 'm1', at: new Date().toISOString() },
      { promptId: '020-b', sha: 'bbb2', message: 'm2', at: new Date().toISOString() },
    ],
  });
  assert.equal(comProgresso.ok, true);
  assert.equal(comProgresso.value.commits.length, 2);

  /* A cópia antiga tenta gravar por cima, sem commit nenhum. */
  const recusado = saveRun(copiaAntiga);
  assert.equal(recusado.ok, false, 'a gravação obsoleta foi aceita e apagaria os commits');
  assert.equal(recusado.error.code, 'STATE_REGRESSION');
  assert.match(recusado.error.message, /commit/);

  // O disco continua íntegro.
  const relido = loadRun(project.id, inicial.runId);
  assert.equal(relido.value.commits.length, 2);
});

test('gravação obsoleta que apagaria aprovação de prompt é RECUSADA', () => {
  const project = projeto();
  const inicial = novaExecucao(project);
  const copiaAntiga = { ...inicial };

  const aprovado = saveRun(
    updatePromptProgress(loadRun(project.id, inicial.runId).value, '010-a', {
      status: 'APPROVED',
      approvedAt: new Date().toISOString(),
    }),
  );
  assert.equal(aprovado.ok, true);

  const recusado = saveRun(copiaAntiga);
  assert.equal(recusado.ok, false);
  assert.equal(recusado.error.code, 'STATE_REGRESSION');
  assert.match(recusado.error.message, /aprovado/);
});

test('gravação obsoleta sobre estado terminal é RECUSADA', () => {
  const project = projeto();
  const inicial = novaExecucao(project);
  const copiaAntiga = { ...transition(inicial, 'VALIDATING', 'seguindo o fluxo') };

  const terminal = saveRun(
    transition(loadRun(project.id, inicial.runId).value, 'CANCELLED', 'cancelado pelo usuário'),
  );
  assert.equal(terminal.ok, true);
  assert.equal(terminal.value.state, 'CANCELLED');

  const recusado = saveRun(copiaAntiga);
  assert.equal(recusado.ok, false, 'uma gravação obsoleta ressuscitou uma execução terminal');
  assert.equal(recusado.error.code, 'STATE_REGRESSION');

  assert.equal(loadRun(project.id, inicial.runId).value.state, 'CANCELLED');
});

test('recordRunIntent grava sobre a revisão mais recente do disco', () => {
  const project = projeto();
  const inicial = novaExecucao(project);

  /* Alguém avança o disco entre a leitura e a escrita de quem pede a pausa. */
  saveRun({ ...loadRun(project.id, inicial.runId).value, currentAttempt: 7 });

  const marcado = recordRunIntent(project.id, inicial.runId, 'PAUSE');
  assert.equal(marcado.ok, true, marcado.ok ? '' : JSON.stringify(marcado.error));
  assert.equal(marcado.value.pauseRequested, true);
  assert.equal(marcado.value.currentAttempt, 7, 'a intenção foi gravada sobre um estado antigo');

  const cancelado = recordRunIntent(project.id, inicial.runId, 'CANCEL');
  assert.equal(cancelado.ok, true);
  assert.equal(cancelado.value.cancelRequested, true);
  assert.equal(cancelado.value.pauseRequested, true, 'o cancelamento apagou a pausa anterior');
});

test('readPersistedIntent enxerga a intenção sem validar o registro inteiro', () => {
  const project = projeto();
  const inicial = novaExecucao(project);

  const antes = readPersistedIntent(project.id, inicial.runId);
  assert.equal(antes.pauseRequested, false);
  assert.equal(antes.cancelRequested, false);
  assert.equal(antes.revision, inicial.revision);

  saveRun(requestCancel(loadRun(project.id, inicial.runId).value));
  const depois = readPersistedIntent(project.id, inicial.runId);
  assert.equal(depois.cancelRequested, true);
  assert.equal(depois.revision > antes.revision, true);

  assert.equal(readPersistedIntent(project.id, 'run-inexistente'), null);
});

test('registro legado sem revisão entra em zero e a primeira gravação o adianta', () => {
  const project = projeto();
  const inicial = novaExecucao(project);

  const filePath = path.join(projectStateDir(project.id), `${inicial.runId}.json`);
  const bruto = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  delete bruto.revision;
  fs.writeFileSync(filePath, `${JSON.stringify(bruto, null, 2)}\n`, 'utf8');

  const relido = loadRun(project.id, inicial.runId);
  assert.equal(relido.ok, true);
  assert.equal(relido.value.revision, 0, 'a ausência de revisão deveria virar zero explícito');

  const gravado = saveRun(relido.value);
  assert.equal(gravado.ok, true);
  assert.equal(gravado.value.revision, 1);
});

test('falha REAL de escrita devolve Result de erro; o resultado não é descartado', () => {
  const project = projeto();
  const inicial = novaExecucao(project);

  /*
   * Falha de E/S de verdade, sem dublê: um DIRETÓRIO ocupando exatamente o
   * caminho do arquivo de estado faz o `rename` atômico falhar. É o cenário
   * "o disco não aceita a escrita", e o produto precisa dizê-lo em vez de
   * seguir em frente achando que gravou.
   */
  const outro = projeto();
  const bloqueado = path.join(projectStateDir(outro.id), `${inicial.runId}.json`);
  fs.mkdirSync(bloqueado, { recursive: true });

  const resultado = saveRun({ ...inicial, projectId: outro.id });
  assert.equal(resultado.ok, false, 'gravar sobre um diretório foi reportado como sucesso');
  assert.equal(resultado.error.code, 'IO_FAILED');
  assert.match(resultado.error.message, /gravar/i);

  // O estado original permanece intocado e legível.
  const relido = loadRun(project.id, inicial.runId);
  assert.equal(relido.ok, true);
  assert.equal(relido.value.revision, inicial.revision);
});
