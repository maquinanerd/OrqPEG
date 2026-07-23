'use strict';

/**
 * Escritor de estado usado nos testes de corrida REAL entre processos.
 *
 * Roda como processo separado. Recebe o que fazer por argumentos, sincroniza
 * com os irmãos por uma BARREIRA de arquivo e só então escreve. A barreira é o
 * que garante que todos os escritores partam do MESMO ponto — que é exatamente
 * a corrida que a versão anterior do "compare-and-swap" não detectava:
 * comparar revisões só acusa quem já está atrasado, e dois processos que leem a
 * mesma revisão não têm o que comparar.
 *
 * Uso:
 *   node race-writer.js <home> <projectId> <runId> <barreira> <n> <ação>
 *
 * Ações: `pause`, `cancel`, `progress:<campo>`.
 */

const fs = require('node:fs');
const path = require('node:path');

const [home, projectId, runId, barrierPath, expectedRaw, action] = process.argv.slice(2);
const expected = Number(expectedRaw);

process.env.ORQPEG_HOME = home;
process.env.ORQPEG_NO_FILE_LOG = '1';

const runState = require(path.resolve(__dirname, '..', '..', 'dist', 'state', 'run-state'));

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Anuncia a chegada e espera até que TODOS os participantes tenham chegado. */
async function barrier() {
  fs.mkdirSync(barrierPath, { recursive: true });
  fs.writeFileSync(path.join(barrierPath, `${process.pid}.ready`), '1', 'utf8');

  const deadline = Date.now() + 30_000;
  for (;;) {
    const arrived = fs.readdirSync(barrierPath).filter((name) => name.endsWith('.ready')).length;
    if (arrived >= expected) return;
    if (Date.now() > deadline) throw new Error(`barreira não completou: ${arrived}/${expected}`);
    await sleep(3);
  }
}

async function main() {
  /*
   * A LEITURA acontece ANTES da barreira, de propósito.
   *
   * É assim que todos os escritores ficam com a mesma revisão em mãos quando a
   * barreira abre — a condição exata em que a comparação de revisão é inútil e
   * só a exclusão mútua resolve.
   */
  const loaded = runState.loadRun(projectId, runId);
  if (!loaded.ok) {
    process.stdout.write(`ERRO ${JSON.stringify(loaded.error)}\n`);
    process.exit(1);
  }

  await barrier();

  let result;
  if (action === 'pause') {
    result = runState.recordRunIntent(projectId, runId, 'PAUSE');
  } else if (action === 'cancel') {
    result = runState.recordRunIntent(projectId, runId, 'CANCEL');
  } else if (action.startsWith('progress:')) {
    /* Escreve a partir da cópia lida ANTES da barreira: é o orquestrador
       segurando o registro enquanto uma etapa longa roda. */
    const field = action.slice('progress:'.length);
    result = runState.saveRun({ ...loaded.value, currentPromptId: field });
  } else {
    process.stdout.write(`ERRO acao desconhecida: ${action}\n`);
    process.exit(2);
    return;
  }

  process.stdout.write(
    `${result.ok ? 'OK' : 'FALHA'} ${JSON.stringify(
      result.ok
        ? { revision: result.value.revision, pause: result.value.pauseRequested, cancel: result.value.cancelRequested }
        : result.error,
    )}\n`,
  );
  process.exit(result.ok ? 0 : 3);
}

main().catch((error) => {
  process.stdout.write(`ERRO ${String(error && error.message)}\n`);
  process.exit(1);
});
