'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/*
 * Encerramento de árvore de processos, no runner REAL.
 *
 * Duas propriedades precisam valer ao mesmo tempo, e uma sem a outra é um
 * defeito grave:
 *
 *  - o encerramento alcança os DESCENDENTES. No Windows, `child.kill()` mataria
 *    apenas o `cmd.exe` intermediário e deixaria a ferramenta real órfã; por
 *    isso o runner usa `taskkill /T /F`.
 *  - o encerramento alcança SÓ a árvore alvo. `taskkill /IM node.exe` mataria
 *    todo processo `node` da máquina, inclusive o próprio OrqPEG. O runner
 *    passa `/pid <pid>`, e estes testes provam a diferença com testemunhas
 *    irmãs idênticas ao alvo.
 */

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'orqpeg-tree-'));
process.env.ORQPEG_HOME = HOME;
process.env.ORQPEG_NO_FILE_LOG = '1';

const { runProcess } = require('../../dist/agents/process-runner');
const {
  LONG_CHILD,
  isAlive,
  killAllWitnesses,
  spawnWitness,
  tempDir,
  waitForPids,
  waitUntilDead,
} = require('../helpers/long-process');

test('abortar encerra o processo E o neto, e devolve status INTERRUPTED', async () => {
  const dir = tempDir('orqpeg-tree-kill-');
  const pidFile = path.join(dir, 'pids.json');
  const controller = new AbortController();

  const promise = runProcess(process.execPath, [LONG_CHILD, pidFile, 'tree'], {
    cwd: dir,
    timeoutMs: 120_000,
    signal: controller.signal,
  });

  const pids = await waitForPids(pidFile);

  // EVIDÊNCIA (antes): os dois processos existem.
  assert.equal(isAlive(pids.pid), true, `o processo ${pids.pid} não chegou a existir`);
  assert.equal(
    isAlive(pids.grandchildPid),
    true,
    `o neto ${pids.grandchildPid} não chegou a existir`,
  );

  controller.abort();
  const result = await promise;

  assert.equal(result.status, 'INTERRUPTED');
  assert.equal(result.timedOut, false);

  // EVIDÊNCIA (depois): os dois morreram.
  const dead = await waitUntilDead([pids.pid, pids.grandchildPid]);
  assert.equal(
    dead,
    true,
    `sobreviveram ao encerramento: ${[pids.pid, pids.grandchildPid].filter(isAlive).join(', ')}`,
  );
});

test('o encerramento é restrito ao PID alvo: processos node irmãos sobrevivem', async () => {
  const dir = tempDir('orqpeg-tree-scope-');
  const pidFile = path.join(dir, 'pids.json');
  const controller = new AbortController();

  /* Três `node` idênticos ao alvo. Encerramento por nome levaria os três. */
  const testemunhas = [spawnWitness(), spawnWitness(), spawnWitness()];

  const promise = runProcess(process.execPath, [LONG_CHILD, pidFile, 'tree'], {
    cwd: dir,
    timeoutMs: 120_000,
    signal: controller.signal,
  });
  const pids = await waitForPids(pidFile);

  controller.abort();
  await promise;

  assert.equal(await waitUntilDead([pids.pid, pids.grandchildPid]), true, 'a árvore alvo sobreviveu');

  for (const testemunha of testemunhas) {
    assert.equal(
      isAlive(testemunha.pid),
      true,
      `a testemunha ${testemunha.pid} morreu: o encerramento não está restrito ao PID`,
    );
  }
});

test('sinal já abortado impede o spawn: nenhum processo chega a nascer', async () => {
  const dir = tempDir('orqpeg-tree-pre-');
  const pidFile = path.join(dir, 'pids.json');
  const controller = new AbortController();
  controller.abort();

  const result = await runProcess(process.execPath, [LONG_CHILD, pidFile, 'tree'], {
    cwd: dir,
    timeoutMs: 120_000,
    signal: controller.signal,
  });

  assert.equal(result.status, 'INTERRUPTED');
  assert.equal(result.exitCode, null);
  assert.equal(
    fs.existsSync(pidFile),
    false,
    'um processo nasceu apesar de o sinal já estar abortado',
  );
});

test('limpeza: nenhuma testemunha fica viva', () => {
  killAllWitnesses();
});
