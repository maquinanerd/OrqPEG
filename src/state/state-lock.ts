import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { Result } from '../types';
import { fail } from '../utils/errors';
import { ensureDir } from '../utils/paths';

/**
 * Exclusão mútua SÍNCRONA e entre processos para o arquivo de estado.
 *
 * Por que existe: a versão anterior chamava de "compare-and-swap" uma sequência
 * `ler → comparar revisão → montar → gravar` sem exclusão mútua nenhuma. Dois
 * processos podiam ler a MESMA revisão, ambos produzirem `revisão + 1` e o
 * último apagar o primeiro:
 *
 *     Disco: revision=10, pauseRequested=false
 *     A lê 10                      B lê 10
 *     A monta 11, pause=false      B monta 11, pause=true
 *     B grava (pause=true)
 *     A grava (pause=false)   <-- a pausa desaparece
 *
 * Comparar revisões só detecta a corrida quando um dos lados JÁ está atrasado.
 * Quando os dois partem do mesmo ponto, não há o que detectar — é preciso
 * impedir que partam do mesmo ponto. Este módulo faz isso: a leitura, a
 * reconciliação e a escrita acontecem inteiramente dentro do lock.
 *
 * Por que síncrono: `saveRun` é síncrono e é chamado dezenas de vezes por
 * execução, de dentro de código síncrono. Tornar tudo assíncrono espalharia
 * `await` por todo o orquestrador — e cada `await` novo é uma janela nova para
 * a corrida que este módulo existe para fechar.
 *
 * A primitiva é `fs.openSync(caminho, 'wx')`, que é atômica no NTFS e em
 * sistemas POSIX: entre dois processos que tentam criar o mesmo arquivo, o
 * sistema de arquivos garante que exatamente um vence.
 *
 * Nota sobre concorrência DENTRO do processo: código síncrono não é
 * interrompido pelo event loop, então duas chamadas a `saveRun` do mesmo
 * processo nunca se intercalam. O lock cobre o caso entre processos — painel de
 * um lado, `PAUSAR.cmd` do outro.
 */

/** Teto total de espera pelo lock antes de desistir. */
export const STATE_LOCK_TIMEOUT_MS = 10_000;

/** Idade a partir da qual um lock é considerado abandonado. */
export const STATE_LOCK_STALE_MS = 30_000;

/** Intervalo entre tentativas de aquisição. */
const RETRY_INTERVAL_MS = 4;

/**
 * Buffer dedicado ao adormecimento síncrono.
 *
 * `Atomics.wait` é a única forma de dormir sem ceder o event loop no Node; um
 * laço ocupado queimaria CPU durante toda a espera e, num teste de corrida com
 * dezenas de escritores, atrapalharia exatamente o que se quer medir.
 */
const SLEEP_SLOT = new Int32Array(new SharedArrayBuffer(4));

function sleepSync(ms: number): void {
  Atomics.wait(SLEEP_SLOT, 0, 0, ms);
}

interface LockOwner {
  pid: number;
  hostname: string;
  at: number;
}

/** `true` vivo, `false` inexistente, `null` indeterminado. */
function processIsAlive(pid: number): boolean | null {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    if (code === 'EPERM') return true;
    return null;
  }
}

function readOwner(lockPath: string): LockOwner | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return null;
    const raw = parsed as Record<string, unknown>;
    const pid = raw['pid'];
    const hostname = raw['hostname'];
    const at = raw['at'];
    if (typeof pid !== 'number' || typeof hostname !== 'string' || typeof at !== 'number') {
      return null;
    }
    return { pid, hostname, at };
  } catch {
    return null;
  }
}

/**
 * Descreve por que o lock deve ser considerado abandonado, ou `null` quando ele
 * ainda vale.
 *
 * A verificação por pid só faz sentido na máquina que criou o lock: em outra, o
 * mesmo número pertenceria a outro processo. Fora dela, sobra a idade.
 */
function abandonmentReason(owner: LockOwner | null, lockPath: string): string | null {
  if (owner === null) {
    /* Conteúdo ilegível: pode ser um lock recém-criado cujo `write` ainda não
       saiu, ou lixo de um processo morto. A idade do arquivo decide. */
    try {
      const age = Date.now() - fs.statSync(lockPath).mtimeMs;
      return age > STATE_LOCK_STALE_MS ? `conteúdo ilegível e parado há ${String(Math.round(age))} ms` : null;
    } catch {
      return null;
    }
  }

  if (owner.hostname === os.hostname() && processIsAlive(owner.pid) === false) {
    return `o processo ${String(owner.pid)} não existe mais nesta máquina`;
  }

  const age = Date.now() - owner.at;
  if (age > STATE_LOCK_STALE_MS) {
    return `lock parado há ${String(Math.round(age))} ms, acima do limite de ${String(STATE_LOCK_STALE_MS)} ms`;
  }
  return null;
}

/**
 * Executa `fn` com posse exclusiva do arquivo de estado indicado.
 *
 * `fn` roda SEMPRE dentro do lock, e o lock é liberado no `finally` — inclusive
 * quando `fn` lança. A liberação confere a posse antes de remover: um lock já
 * readquirido por outro processo (porque este aqui foi considerado abandonado)
 * nunca é apagado por engano.
 */
export function withStateLock<T>(statePath: string, fn: () => Result<T>): Result<T> {
  const lockPath = `${statePath}.lock`;

  try {
    ensureDir(path.dirname(lockPath));
  } catch (error) {
    return fail('LOCK_FAILED', `Falha ao preparar o diretório do lock de estado.`, { lockPath }, error);
  }

  const owner: LockOwner = { pid: process.pid, hostname: os.hostname(), at: Date.now() };
  const deadline = Date.now() + STATE_LOCK_TIMEOUT_MS;
  let handle: number | null = null;

  for (;;) {
    let failure: NodeJS.ErrnoException | null = null;
    try {
      handle = fs.openSync(lockPath, 'wx');
      break;
    } catch (error) {
      failure = error as NodeJS.ErrnoException;
    }

    const code = failure.code;

    /*
     * `EEXIST` é a disputa esperada: alguém já tem o lock.
     *
     * `EPERM`/`EACCES`/`EBUSY` são a MESMA disputa vista pelo Windows num
     * instante específico: quando um processo remove o arquivo enquanto outro
     * o abre, o NTFS deixa o arquivo em estado "exclusão pendente", e toda
     * abertura nesse intervalo devolve acesso negado em vez de "já existe".
     * Tratá-los como falha dura fazia o lock reprovar exatamente sob a carga
     * que ele existe para suportar — foi assim que o teste de corrida com
     * escritores concorrentes o pegou.
     */
    const contention = code === 'EEXIST';
    const transient = code === 'EPERM' || code === 'EACCES' || code === 'EBUSY';
    if (!contention && !transient) {
      return fail('LOCK_FAILED', `Falha ao adquirir o lock de estado ${lockPath}.`, { lockPath }, failure);
    }

    if (contention) {
      const reason = abandonmentReason(readOwner(lockPath), lockPath);
      if (reason !== null) {
        try {
          fs.unlinkSync(lockPath);
        } catch {
          /* outro processo pode ter removido primeiro: a próxima volta decide */
        }
      }
    }

    if (Date.now() >= deadline) {
      return fail(
        'LOCK_HELD',
        `O arquivo de estado está em uso por outro processo do OrqPEG e não foi liberado em ` +
          `${String(STATE_LOCK_TIMEOUT_MS)} ms (${lockPath}).`,
        { lockPath, timeoutMs: STATE_LOCK_TIMEOUT_MS, lastCode: code ?? null },
      );
    }
    sleepSync(RETRY_INTERVAL_MS);
  }

  try {
    try {
      fs.writeFileSync(handle, JSON.stringify(owner), 'utf8');
    } catch {
      /* A posse já é nossa: o conteúdo é só diagnóstico para o caso de queda. */
    }
    return fn();
  } finally {
    try {
      fs.closeSync(handle);
    } catch {
      /* já fechado */
    }
    const current = readOwner(lockPath);
    const stillOurs =
      current === null ||
      (current.pid === owner.pid && current.hostname === owner.hostname && current.at === owner.at);
    if (stillOurs) {
      try {
        fs.unlinkSync(lockPath);
      } catch {
        /* melhor esforço: já removido */
      }
    }
  }
}
