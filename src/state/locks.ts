import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { LockHandle, LockInfo, LockScope, Result } from '../types';
import { fail, ok } from '../utils/errors';
import { fileExists, listFilesSync, readJsonSync, writeJsonAtomicSync } from '../utils/fs-atomic';
import { createLogger } from '../utils/logger';
import { ORQPEG_DIRS, ensureDir } from '../utils/paths';
import { formatDuration, nowIso, sleep } from '../utils/time';
import { validateIdentifier } from '../security/path-guard';

/**
 * Locks cooperativos baseados em arquivo.
 *
 * Um arquivo `data/locks/<escopo>-<chave>.lock` representa a posse exclusiva de
 * um recurso (um projeto, uma worktree, uma execução, um PR, um merge ou o
 * próprio estado em disco). A criação usa `fs.openSync(..., 'wx')`, que é
 * atômica no NTFS e em sistemas POSIX: se dois processos do OrqPEG tentarem
 * adquirir o mesmo lock ao mesmo tempo, apenas um consegue criar o arquivo.
 *
 * O conteúdo do arquivo é um `LockInfo` em JSON, o que permite dizer ao usuário
 * QUEM detém o lock (pid, máquina, operação, desde quando) em vez de apenas
 * recusar a operação.
 *
 * Detecção de lock abandonado (processo morto sem liberar, queda de energia):
 *  - o processo dono não existe mais (só verificável quando o lock foi criado
 *    nesta mesma máquina); ou
 *  - o heartbeat parou há mais tempo que `staleAfterMs`.
 */

/** Idade máxima do heartbeat antes de o lock ser considerado abandonado. */
export const DEFAULT_LOCK_STALE_MS = 15 * 60 * 1000;

/**
 * Intervalo de renovação do heartbeat, com folga larga em relação ao tempo de
 * expiração: mesmo que várias renovações falhem seguidas, o lock continua vivo.
 */
export const HEARTBEAT_INTERVAL_MS = 60 * 1000;

/** Piso de segurança para `staleAfterMs`, evita roubo de lock recém-criado. */
const MIN_LOCK_STALE_MS = 1000;

/** Tentativas de aquisição após remoção de locks abandonados. */
const MAX_ACQUIRE_ATTEMPTS = 3;

const LOCK_SCOPES: readonly LockScope[] = [
  'project',
  'worktree',
  'run',
  'pr',
  'merge',
  'state',
];

const logger = createLogger({ scope: 'locks' });

export interface AcquireLockInput {
  scope: LockScope;
  key: string;
  projectId?: string | null;
  runId?: string | null;
  operation: string;
  staleAfterMs?: number;
}

/* ------------------------------------------------------------------------- */
/* Aquisição                                                                  */
/* ------------------------------------------------------------------------- */

export async function acquireLock(input: AcquireLockInput): Promise<Result<LockHandle>> {
  const keyCheck = validateIdentifier(input.key, 'chave de lock');
  if (!keyCheck.ok) return keyCheck;
  if (!LOCK_SCOPES.includes(input.scope)) {
    return fail('LOCK_FAILED', `Escopo de lock desconhecido: ${String(input.scope)}.`, {
      scope: input.scope,
    });
  }

  const key = keyCheck.value;
  const operation = input.operation.trim().length > 0 ? input.operation.trim() : 'operação';
  const staleAfterMs = normalizeStaleMs(input.staleAfterMs);

  const dir = ORQPEG_DIRS.locks();
  try {
    ensureDir(dir);
  } catch (error) {
    return fail('LOCK_FAILED', 'Falha ao criar o diretório de locks.', { dir }, error);
  }
  const filePath = path.join(dir, lockFileName(input.scope, key));

  for (let attempt = 1; attempt <= MAX_ACQUIRE_ATTEMPTS; attempt += 1) {
    const at = nowIso();
    const info: LockInfo = {
      scope: input.scope,
      key,
      pid: process.pid,
      hostname: os.hostname(),
      projectId: input.projectId ?? null,
      runId: input.runId ?? null,
      operation,
      acquiredAt: at,
      heartbeatAt: at,
    };

    const created = createExclusive(filePath, info);
    if (created.ok) return ok(new FileLockHandle(info));
    if (created.error.code !== 'LOCK_HELD') return created;

    // O arquivo existe: descobrir se o dono ainda está vivo.
    const read = readJsonSync<unknown>(filePath);
    if (!read.ok) {
      if (read.error.code === 'CONFIG_NOT_FOUND') {
        // Liberado entre o `open` e a leitura: tentar de novo.
        await sleep(20);
        continue;
      }
      logger.warn(
        `Arquivo de lock ilegível em ${filePath}. Tratando como abandonado e removendo.`,
      );
      removeQuietly(filePath);
      await sleep(20);
      continue;
    }

    const parsed: unknown = read.value;
    if (!isLockInfo(parsed)) {
      logger.warn(
        `Arquivo de lock com conteúdo inválido em ${filePath}. Tratando como abandonado e removendo.`,
      );
      removeQuietly(filePath);
      await sleep(20);
      continue;
    }

    const existing: LockInfo = parsed;
    const abandonment = describeAbandonment(existing, staleAfterMs);
    if (abandonment !== null) {
      logger.warn(
        `Lock ${existing.scope}/${existing.key} abandonado (${abandonment}). ` +
          `Removendo e readquirindo. Dono anterior: pid ${existing.pid} em ${existing.hostname}, ` +
          `operação "${existing.operation}", desde ${existing.acquiredAt}.`,
      );
      removeQuietly(filePath);
      await sleep(20);
      continue;
    }

    return fail(
      'LOCK_HELD',
      `Recurso ${existing.scope}/${existing.key} está em uso por outro processo do OrqPEG ` +
        `(pid ${existing.pid} em ${existing.hostname}, operação "${existing.operation}", ` +
        `desde ${existing.acquiredAt}). Aguarde o término ou use o diagnóstico para liberar.`,
      {
        scope: existing.scope,
        key: existing.key,
        holderPid: existing.pid,
        holderHostname: existing.hostname,
        holderOperation: existing.operation,
        acquiredAt: existing.acquiredAt,
        heartbeatAt: existing.heartbeatAt,
        projectId: existing.projectId,
        runId: existing.runId,
        lockFile: filePath,
        attempt,
      },
    );
  }

  return fail(
    'LOCK_FAILED',
    `Não foi possível adquirir o lock ${input.scope}/${key} após ${MAX_ACQUIRE_ATTEMPTS} tentativas.`,
    { scope: input.scope, key, lockFile: filePath },
  );
}

/* ------------------------------------------------------------------------- */
/* Handle                                                                     */
/* ------------------------------------------------------------------------- */

class FileLockHandle implements LockHandle {
  readonly info: LockInfo;
  private released = false;

  constructor(info: LockInfo) {
    this.info = info;
  }

  /**
   * Remove o arquivo apenas se ele ainda descrever ESTA posse (mesmo pid, mesma
   * máquina e mesmo `acquiredAt`). Assim, um lock já readquirido por outro
   * processo — porque este aqui foi considerado abandonado — nunca é apagado
   * por engano.
   */
  release(): Promise<void> {
    if (this.released) return Promise.resolve();
    this.released = true;

    const filePath = lockFilePath(this.info.scope, this.info.key);
    if (filePath === null) return Promise.resolve();

    const current = readLockInfo(filePath);
    if (current === null) return Promise.resolve();

    if (!isSameOwner(current, this.info)) {
      logger.warn(
        `Lock ${this.info.scope}/${this.info.key} pertence agora a pid ${current.pid} em ` +
          `${current.hostname}. Liberação ignorada para não remover o lock de terceiros.`,
      );
      return Promise.resolve();
    }

    removeQuietly(filePath);
    return Promise.resolve();
  }
}

/**
 * Atualiza o `heartbeatAt` do lock. Deve ser chamado periodicamente durante
 * operações longas para que o lock não seja considerado abandonado.
 * Falhas são silenciosas de propósito: um heartbeat perdido nunca derruba a
 * operação protegida.
 */
export function heartbeat(handle: LockHandle): void {
  const filePath = lockFilePath(handle.info.scope, handle.info.key);
  if (filePath === null) return;

  const current = readLockInfo(filePath);
  if (current === null || !isSameOwner(current, handle.info)) return;

  const at = nowIso();
  const updated: LockInfo = { ...handle.info, heartbeatAt: at };
  const written = writeJsonAtomicSync(filePath, updated);
  if (written.ok) {
    handle.info.heartbeatAt = at;
  }
}

/* ------------------------------------------------------------------------- */
/* Consulta e liberação forçada                                               */
/* ------------------------------------------------------------------------- */

/** Todos os locks atualmente registrados em `data/locks`. */
export function listLocks(): LockInfo[] {
  const dir = ORQPEG_DIRS.locks();
  const result: LockInfo[] = [];

  for (const fileName of listFilesSync(dir)) {
    if (!fileName.toLowerCase().endsWith('.lock')) continue;
    const info = readLockInfo(path.join(dir, fileName));
    if (info !== null) result.push(info);
  }

  result.sort((a, b) => {
    if (a.scope !== b.scope) return a.scope < b.scope ? -1 : 1;
    if (a.key !== b.key) return a.key < b.key ? -1 : 1;
    return 0;
  });
  return result;
}

/**
 * Remove um lock sem verificar a posse. É uma operação de manutenção exposta
 * pelo diagnóstico: só deve ser usada quando o usuário tem certeza de que
 * nenhum outro processo do OrqPEG está em execução, sob risco de dois processos
 * mexerem no mesmo repositório ao mesmo tempo.
 */
export function forceReleaseLock(scope: LockScope, key: string): Result<void> {
  const keyCheck = validateIdentifier(key, 'chave de lock');
  if (!keyCheck.ok) return keyCheck;

  const filePath = lockFilePath(scope, keyCheck.value);
  if (filePath === null) {
    return fail('LOCK_FAILED', `Escopo de lock desconhecido: ${String(scope)}.`, { scope });
  }
  if (!fileExists(filePath)) return ok(undefined);

  const existing = readLockInfo(filePath);
  const owner =
    existing === null
      ? 'dono desconhecido (arquivo ilegível)'
      : `pid ${existing.pid} em ${existing.hostname}, operação "${existing.operation}"`;
  logger.warn(
    `AVISO: liberando à força o lock ${scope}/${keyCheck.value} (${owner}). ` +
      'Faça isso apenas com certeza de que nenhum outro processo do OrqPEG está rodando.',
  );

  try {
    fs.unlinkSync(filePath);
    return ok(undefined);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return ok(undefined);
    return fail('LOCK_FAILED', `Falha ao remover o arquivo de lock ${filePath}.`, { filePath }, error);
  }
}

/* ------------------------------------------------------------------------- */
/* Execução protegida                                                         */
/* ------------------------------------------------------------------------- */

/**
 * Adquire o lock, executa `fn` e SEMPRE libera no `finally`, inclusive quando
 * `fn` lança. Exceções vindas de `fn` viram `Result` de erro.
 */
export async function withLock<T>(
  input: AcquireLockInput,
  fn: () => Promise<T>,
): Promise<Result<T>> {
  const acquired = await acquireLock(input);
  if (!acquired.ok) return acquired;

  const handle = acquired.value;

  /*
   * Heartbeat automático.
   *
   * `acquireLock` considera abandonado todo lock cujo heartbeat esteja parado há
   * mais de `DEFAULT_LOCK_STALE_MS` (15 minutos). Uma execução real do OrqPEG
   * dura muito mais que isso — só o timeout padrão do Claude é de 3600s — então,
   * sem esta renovação periódica, um segundo processo consideraria o lock morto
   * e passaria a operar no mesmo repositório em paralelo. O intervalo usa
   * `unref` para nunca segurar o processo vivo por conta própria.
   */
  const beat = setInterval(() => {
    heartbeat(handle);
  }, HEARTBEAT_INTERVAL_MS);
  beat.unref?.();

  try {
    const value = await fn();
    return ok(value);
  } catch (error) {
    return fail(
      'INTERNAL',
      `Falha durante operação protegida pelo lock ${input.scope}/${input.key}.`,
      { scope: input.scope, key: input.key, operation: input.operation },
      error,
    );
  } finally {
    clearInterval(beat);
    await handle.release();
  }
}

/* ------------------------------------------------------------------------- */
/* Auxiliares internos                                                        */
/* ------------------------------------------------------------------------- */

function lockFileName(scope: LockScope, key: string): string {
  return `${scope}-${key}.lock`;
}

/** Caminho do lock, ou `null` quando escopo/chave são inválidos. */
function lockFilePath(scope: LockScope, key: string): string | null {
  if (!LOCK_SCOPES.includes(scope)) return null;
  const keyCheck = validateIdentifier(key, 'chave de lock');
  if (!keyCheck.ok) return null;
  return path.join(ORQPEG_DIRS.locks(), lockFileName(scope, keyCheck.value));
}

/** Criação exclusiva: falha com `LOCK_HELD` quando o arquivo já existe. */
function createExclusive(filePath: string, info: LockInfo): Result<void> {
  let handle: number | null = null;
  try {
    handle = fs.openSync(filePath, 'wx');
    fs.writeFileSync(handle, `${JSON.stringify(info, null, 2)}\n`, 'utf8');
    fs.fsyncSync(handle);
    fs.closeSync(handle);
    handle = null;
    return ok(undefined);
  } catch (error) {
    if (handle !== null) {
      try {
        fs.closeSync(handle);
      } catch {
        /* já fechado */
      }
    }
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') {
      return fail('LOCK_HELD', 'Arquivo de lock já existe.', { filePath });
    }
    return fail('LOCK_FAILED', `Falha ao criar o arquivo de lock ${filePath}.`, { filePath }, error);
  }
}

function readLockInfo(filePath: string): LockInfo | null {
  const read = readJsonSync<unknown>(filePath);
  if (!read.ok) return null;
  const parsed: unknown = read.value;
  return isLockInfo(parsed) ? parsed : null;
}

function isLockInfo(value: unknown): value is LockInfo {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  const scope = raw['scope'];
  const key = raw['key'];
  const pid = raw['pid'];
  const hostname = raw['hostname'];
  const operation = raw['operation'];
  const acquiredAt = raw['acquiredAt'];
  const heartbeatAt = raw['heartbeatAt'];
  const projectId = raw['projectId'];
  const runId = raw['runId'];

  if (typeof scope !== 'string' || !LOCK_SCOPES.includes(scope as LockScope)) return false;
  if (typeof key !== 'string' || key.length === 0) return false;
  if (typeof pid !== 'number' || !Number.isFinite(pid)) return false;
  if (typeof hostname !== 'string') return false;
  if (typeof operation !== 'string') return false;
  if (typeof acquiredAt !== 'string') return false;
  if (typeof heartbeatAt !== 'string') return false;
  if (projectId !== null && typeof projectId !== 'string') return false;
  if (runId !== null && typeof runId !== 'string') return false;
  return true;
}

function isSameOwner(a: LockInfo, b: LockInfo): boolean {
  return a.pid === b.pid && a.hostname === b.hostname && a.acquiredAt === b.acquiredAt;
}

/**
 * Descreve por que o lock deve ser considerado abandonado, ou `null` quando ele
 * ainda é válido.
 */
function describeAbandonment(info: LockInfo, staleAfterMs: number): string | null {
  // A verificação por pid só faz sentido na máquina que criou o lock: em outra
  // máquina o mesmo número de pid pertenceria a um processo diferente.
  if (info.hostname === os.hostname()) {
    const alive = processIsAlive(info.pid);
    if (alive === false) {
      return `o processo ${info.pid} não existe mais nesta máquina`;
    }
  }

  const beat = Date.parse(info.heartbeatAt);
  if (Number.isNaN(beat)) return 'heartbeat com data inválida';

  const age = Date.now() - beat;
  if (age > staleAfterMs) {
    return `heartbeat parado há ${formatDuration(age)}, acima do limite de ${formatDuration(staleAfterMs)}`;
  }
  return null;
}

/**
 * `true` vivo, `false` inexistente, `null` indeterminado.
 * O sinal 0 não envia sinal algum: apenas testa a existência do processo.
 */
function processIsAlive(pid: number): boolean | null {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    if (code === 'EPERM') return true; // existe, mas pertence a outro usuário
    return null;
  }
}

function removeQuietly(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch {
    /* melhor esforço: o arquivo pode já ter sido removido por outro processo */
  }
}

function normalizeStaleMs(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_LOCK_STALE_MS;
  }
  return Math.max(MIN_LOCK_STALE_MS, Math.floor(value));
}
