'use strict';

/**
 * Processo filho longo e controlável — o "Claude/Codex/npm test" dos testes de
 * pausa e cancelamento.
 *
 * Existe porque um dublê de função não prova nada sobre encerramento: uma
 * `Promise` que nunca resolve não tem PID, não tem árvore e não pode ficar
 * órfã. O que precisa ser demonstrado é que a árvore REAL morre — e para isso é
 * preciso que ela exista.
 *
 * O processo:
 *  1. cria um NETO (`node -e`), para que só um encerramento de ÁRVORE o mate;
 *  2. publica os dois PIDs num arquivo, para que o teste possa conferir vida e
 *     morte de cada um antes e depois;
 *  3. fica vivo até ser morto.
 *
 * Uso: node long-child.js <arquivo-de-pids> [tree|solo]
 */

const fs = require('node:fs');
const { spawn } = require('node:child_process');

const pidFile = process.argv[2];
const mode = process.argv[3] ?? 'tree';

if (!pidFile) {
  process.stderr.write('uso: long-child.js <arquivo-de-pids> [tree|solo]\n');
  process.exit(2);
}

let grandchildPid = null;
if (mode === 'tree') {
  /* `stdio: 'ignore'` de propósito: o neto não pode segurar os canos do avô,
     senão o evento `close` do runner esperaria por ele e o teste mediria a
     coisa errada. */
  const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 3600000)'], {
    stdio: 'ignore',
    windowsHide: true,
  });
  grandchildPid = typeof grandchild.pid === 'number' ? grandchild.pid : null;
}

fs.writeFileSync(
  pidFile,
  JSON.stringify({ pid: process.pid, grandchildPid, startedAt: Date.now() }),
  'utf8',
);

process.stdout.write('LONG_CHILD_STARTED\n');

/* Uma hora é muito além de qualquer teste: se o processo sobreviver ao teste,
   o teste falha por PID vivo, e não por espera bem-sucedida. */
setInterval(() => {}, 3_600_000);
