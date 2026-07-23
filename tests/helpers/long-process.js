'use strict';

/**
 * Apoio aos testes de pausa, cancelamento e desligamento com processos REAIS.
 *
 * A regra que estes auxiliares existem para servir: nada aqui prova nada com
 * `Promise` que não resolve. Cada "etapa longa" de uma execução é um processo
 * de verdade, com PID, com um NETO, e com uma testemunha irmã que precisa
 * SOBREVIVER — é assim que se demonstra que o encerramento atinge a árvore
 * certa e só ela.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { runProcess } = require('../../dist/agents/process-runner');

const LONG_CHILD = path.resolve(__dirname, 'long-child.js');

/** Espera padrão por um PID aparecer ou morrer. Folgada para máquina lenta. */
const DEFAULT_TIMEOUT_MS = 20_000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * `true` quando o processo existe.
 * `EPERM` significa que existe e pertence a outro usuário — também é vida.
 */
function isAlive(pid) {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function readPids(pidFile) {
  try {
    const parsed = JSON.parse(fs.readFileSync(pidFile, 'utf8'));
    return typeof parsed?.pid === 'number' ? parsed : null;
  } catch {
    return null;
  }
}

async function waitForPids(pidFile, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const pids = readPids(pidFile);
    if (pids) return pids;
    if (Date.now() > deadline) {
      throw new Error(`o processo longo não publicou os PIDs em ${pidFile}`);
    }
    await sleep(20);
  }
}

/**
 * Espera até que TODOS os PIDs tenham morrido.
 *
 * O `taskkill /T /F` do Windows é assíncrono em relação ao evento `close` do
 * processo encerrado: o avô pode fechar os canos antes de o neto ter sumido da
 * tabela de processos. Esperar aqui evita um teste instável sem esconder um
 * processo que ficou de fato órfão — se ele sobreviver, o prazo estoura.
 */
async function waitUntilDead(pids, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const list = pids.filter((pid) => typeof pid === 'number');
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const survivors = list.filter((pid) => isAlive(pid));
    if (survivors.length === 0) return true;
    if (Date.now() > deadline) return false;
    await sleep(25);
  }
}

/**
 * Dispara `action` assim que o arquivo de PIDs aparecer.
 *
 * É o gatilho que permite pedir a pausa ENQUANTO a etapa está de fato em
 * andamento — e não antes, que testaria outra coisa, nem depois, que não
 * testaria nada.
 */
function whenProcessStarts(pidFile, action) {
  let fired = false;
  const timer = setInterval(() => {
    if (fired) return;
    const pids = readPids(pidFile);
    if (!pids) return;
    fired = true;
    clearInterval(timer);
    void Promise.resolve(action(pids)).catch(() => undefined);
  }, 20);
  timer.unref?.();
  return () => clearInterval(timer);
}

/** Testemunhas vivas, para a limpeza final não depender de nenhum teste passar. */
const witnesses = [];

/**
 * Processo irmão que NÃO pode ser morto por um encerramento de árvore alheia.
 *
 * `unref` é essencial: sem ele, uma testemunha que sobreviva a uma asserção
 * falha seguraria o event loop e o arquivo de teste jamais terminaria — o
 * sintoma pareceria "teste travado" e esconderia a falha real.
 */
function spawnWitness() {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 3600000)'], {
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  const handle = {
    pid: child.pid,
    kill() {
      try {
        child.kill();
      } catch {
        /* já morreu */
      }
    },
  };
  witnesses.push(handle);
  return handle;
}

/** Encerra toda testemunha ainda viva. Chamado no fim do arquivo de teste. */
function killAllWitnesses() {
  for (const witness of witnesses) witness.kill();
  witnesses.length = 0;
}

/*
 * Rede de segurança.
 *
 * As testemunhas são `unref`adas de propósito — precisam sobreviver ao
 * encerramento de árvore que o teste exercita. O efeito colateral é que uma
 * asserção que falhe antes da limpeza deixaria processos para trás. Este
 * gancho fecha o caso do encerramento normal do arquivo de teste; um `SIGKILL`
 * no próprio runner, naturalmente, nenhum gancho alcança.
 */
process.on('exit', () => {
  for (const witness of witnesses) witness.kill();
});

/**
 * Executa o processo longo pelo runner REAL do produto.
 *
 * Devolve `{ result, pids }`, com `result.status === 'INTERRUPTED'` quando o
 * sinal abortou a etapa.
 */
async function runLongChild({ dir, label, signal, timeoutMs = 120_000, registry }) {
  const pidFile = path.join(dir, `pids-${label}-${registry ? registry.length : 0}.json`);
  const promise = runProcess(process.execPath, [LONG_CHILD, pidFile, 'tree'], {
    cwd: dir,
    timeoutMs,
    ...(signal ? { signal } : {}),
  });

  const pids = await waitForPids(pidFile);
  if (registry) registry.push({ label, ...pids });

  const result = await promise;
  return { result, pids, pidFile };
}

/** Diretório temporário isolado, removido pelo sistema ao fim da sessão. */
function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * Comando de teste que dispara o processo longo, com aspas em toda parte.
 *
 * `process.execPath` mora em "C:\Program Files\nodejs" na instalação padrão do
 * Windows; sem as aspas o tokenizador de comandos quebraria no espaço e a
 * suíte falharia com COMMAND_NOT_FOUND — testando outra coisa.
 */
function longTestCommand(pidFile) {
  return `"${process.execPath}" "${LONG_CHILD}" "${pidFile}" tree`;
}

module.exports = {
  LONG_CHILD,
  longTestCommand,
  killAllWitnesses,
  isAlive,
  readPids,
  waitForPids,
  waitUntilDead,
  whenProcessStarts,
  spawnWitness,
  runLongChild,
  tempDir,
  sleep,
};
