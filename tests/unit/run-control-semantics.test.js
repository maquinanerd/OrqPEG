'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/*
 * Semântica do controlador vivo e da confirmação de término.
 *
 * A auditoria apontou que responder "processo filho interrompido" logo depois
 * de `AbortController.abort()` afirma como concluído algo que apenas começou:
 * o `abort()` envia o sinal, e a árvore leva um tempo real para morrer.
 *
 * `awaitRunSettled` é o que permite a fronteira dizer a verdade. Seus três
 * desfechos são distintos e cada um significa uma coisa diferente para quem
 * está do outro lado da API.
 */

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'orqpeg-ctlsem-'));
process.env.ORQPEG_HOME = HOME;
process.env.ORQPEG_NO_FILE_LOG = '1';

const {
  awaitRunSettled,
  getController,
  isRunLive,
  listControllers,
  registerRun,
  releaseRun,
  requestCancelOnLiveRun,
  requestPauseOnLiveRun,
  resetRunControlForTests,
} = require('../../dist/execution/run-control');

test.afterEach(() => {
  resetRunControlForTests();
});

test('o controlador existe ANTES de o runId ser conhecido', () => {
  const controller = registerRun({ projectId: 'p1' });
  assert.notEqual(controller, null);
  assert.equal(controller.runId, null, 'o runId não deveria existir ainda');
  assert.equal(isRunLive('p1'), true, 'o projeto deveria estar vivo mesmo sem runId');

  /* E já é possível pausar: é exatamente a janela em que a rota antiga
     respondia 404 por procurar o registro primeiro. */
  const aceito = requestPauseOnLiveRun('p1', 'panel');
  assert.equal(aceito.accepted, true);
  assert.equal(aceito.runId, null);
  assert.equal(controller.signal.aborted, true, 'o sinal não foi abortado');

  controller.bindRun('run-20260101-000000-aaaa');
  assert.equal(getController('p1').runId, 'run-20260101-000000-aaaa');
});

test('awaitRunSettled: ABSENT quando não há execução viva', async () => {
  assert.equal(await awaitRunSettled('inexistente', 50), 'ABSENT');
});

test('awaitRunSettled: PENDING enquanto a execução não terminou', async () => {
  const controller = registerRun({ projectId: 'p2' });
  requestCancelOnLiveRun('p2', 'panel');

  /* O sinal foi enviado, mas nada terminou: a resposta honesta é "encerrando". */
  const desfecho = await awaitRunSettled('p2', 60);
  assert.equal(desfecho, 'PENDING', 'declarou término sem que nada tivesse terminado');
  assert.equal(controller.released, false);
});

test('awaitRunSettled: SETTLED quando a execução termina durante a espera', async () => {
  const controller = registerRun({ projectId: 'p3' });
  requestCancelOnLiveRun('p3', 'panel');

  const espera = awaitRunSettled('p3', 5_000);
  setTimeout(() => releaseRun(controller), 40);

  assert.equal(await espera, 'SETTLED');
  assert.equal(controller.released, true);
  assert.equal(isRunLive('p3'), false, 'o registro em memória não foi limpo');
});

test('cancelamento sobrepõe pausa e nunca é rebaixado', () => {
  registerRun({ projectId: 'p4' });

  assert.equal(requestPauseOnLiveRun('p4', 'cli').intent, 'PAUSE');
  assert.equal(requestCancelOnLiveRun('p4', 'panel').intent, 'CANCEL');
  assert.equal(requestPauseOnLiveRun('p4', 'cli').intent, 'CANCEL', 'a pausa rebaixou o cancelamento');
  assert.equal(getController('p4').cancelRequested, true);
});

test('repetir o pedido é idempotente e se declara repetido', () => {
  registerRun({ projectId: 'p5' });

  const primeiro = requestCancelOnLiveRun('p5', 'panel');
  const segundo = requestCancelOnLiveRun('p5', 'panel');

  assert.equal(primeiro.accepted, true);
  assert.equal(segundo.accepted, true);
  assert.equal(primeiro.alreadyRequested, false);
  assert.equal(segundo.alreadyRequested, true);
});

test('um segundo registro do mesmo projeto é recusado', () => {
  assert.notEqual(registerRun({ projectId: 'p6' }), null);
  assert.equal(registerRun({ projectId: 'p6' }), null, 'dois controladores para o mesmo projeto');
});

test('liberar um controlador antigo não apaga o controlador da execução seguinte', () => {
  const antigo = registerRun({ projectId: 'p7' });
  releaseRun(antigo);

  const novo = registerRun({ projectId: 'p7' });
  assert.notEqual(novo, null);

  /* Liberação repetida do antigo: o novo permanece. */
  releaseRun(antigo);
  assert.equal(isRunLive('p7'), true, 'o controlador novo foi removido pelo antigo');
  assert.equal(getController('p7'), novo);
});

test('um sinal externo já abortado nasce com intenção de desligamento', () => {
  const externo = new AbortController();
  externo.abort();

  const controller = registerRun({ projectId: 'p8', externalSignal: externo.signal });
  assert.equal(controller.signal.aborted, true);
  assert.equal(controller.intent, 'SHUTDOWN');
  /* Desligamento é interrupção retomável, não cancelamento do usuário. */
  assert.equal(controller.cancelRequested, false);
  assert.equal(controller.pauseRequested, true);
});

test('o instantâneo descreve identidade, etapa e intenção', () => {
  const controller = registerRun({ projectId: 'p9', runId: 'run-x' });
  controller.setStep('Claude implementando');
  requestPauseOnLiveRun('p9', 'state-file');

  const [snapshot] = listControllers();
  assert.equal(snapshot.projectId, 'p9');
  assert.equal(snapshot.runId, 'run-x');
  assert.equal(snapshot.step, 'Claude implementando');
  assert.equal(snapshot.intent, 'PAUSE');
  assert.equal(snapshot.intentSource, 'state-file');
  assert.equal(snapshot.aborted, true);
  assert.equal(typeof snapshot.intentAt, 'string');
});
