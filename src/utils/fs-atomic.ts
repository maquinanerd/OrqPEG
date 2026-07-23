import * as fs from 'node:fs';
import * as path from 'node:path';
import type { OrqError, Result } from '../types';
import { fail, ok } from './errors';
import { ensureDir } from './paths';

/**
 * Gravação atômica.
 *
 * Estratégia: escrever em arquivo temporário no mesmo diretório → validar →
 * `fsync` → `rename` sobre o destino. `rename` no mesmo volume é atômico tanto
 * no NTFS quanto em sistemas POSIX, o que impede que uma interrupção
 * (Ctrl+C, queda de energia) deixe um arquivo de estado truncado.
 */

let counter = 0;

export function writeFileAtomicSync(filePath: string, contents: string): Result<void> {
  const dir = path.dirname(filePath);
  counter += 1;
  const tempPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${counter}.tmp`);
  let handle: number | null = null;
  try {
    ensureDir(dir);
    handle = fs.openSync(tempPath, 'w');
    fs.writeFileSync(handle, contents, 'utf8');
    fs.fsyncSync(handle);
    fs.closeSync(handle);
    handle = null;
    fs.renameSync(tempPath, filePath);
    return ok(undefined);
  } catch (error) {
    if (handle !== null) {
      try {
        fs.closeSync(handle);
      } catch {
        /* já fechado */
      }
    }
    try {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    } catch {
      /* melhor esforço */
    }
    return fail('IO_FAILED', `Falha ao gravar arquivo: ${filePath}`, { filePath }, error);
  }
}

/**
 * Grava JSON atomicamente. O conteúdo é validado por `JSON.parse` antes do
 * `rename`, garantindo que jamais seja publicado um JSON inválido.
 */
export function writeJsonAtomicSync(filePath: string, value: unknown): Result<void> {
  let serialized: string;
  try {
    serialized = `${JSON.stringify(value, null, 2)}\n`;
  } catch (error) {
    return fail('IO_FAILED', `Valor não serializável para ${filePath}`, { filePath }, error);
  }
  try {
    JSON.parse(serialized);
  } catch (error) {
    return fail('IO_FAILED', `JSON gerado é inválido para ${filePath}`, { filePath }, error);
  }
  return writeFileAtomicSync(filePath, serialized);
}

export function readJsonSync<T>(filePath: string): Result<T> {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return fail('CONFIG_NOT_FOUND', `Arquivo não encontrado: ${filePath}`, { filePath });
    }
    return fail('IO_FAILED', `Falha ao ler arquivo: ${filePath}`, { filePath }, error);
  }
  try {
    return ok(JSON.parse(stripBom(raw)) as T);
  } catch (error) {
    return fail('STATE_CORRUPT', `JSON inválido em ${filePath}`, { filePath }, error);
  }
}

export function readTextSync(filePath: string): Result<string> {
  try {
    return ok(stripBom(fs.readFileSync(filePath, 'utf8')));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return fail('IO_FAILED', `Arquivo não encontrado: ${filePath}`, { filePath });
    }
    return fail('IO_FAILED', `Falha ao ler arquivo: ${filePath}`, { filePath }, error);
  }
}

/** Anexa uma linha a um arquivo, criando diretório e arquivo se necessário. */
export function appendLineSync(filePath: string, line: string): Result<void> {
  try {
    ensureDir(path.dirname(filePath));
    fs.appendFileSync(filePath, `${line}\n`, 'utf8');
    return ok(undefined);
  } catch (error) {
    return fail('IO_FAILED', `Falha ao anexar em ${filePath}`, { filePath }, error);
  }
}

/** Grava um arquivo de artefato sem atomicidade (logs volumosos). */
export function writeArtifactSync(filePath: string, contents: string): Result<void> {
  try {
    ensureDir(path.dirname(filePath));
    fs.writeFileSync(filePath, contents, 'utf8');
    return ok(undefined);
  } catch (error) {
    return fail('IO_FAILED', `Falha ao gravar artefato: ${filePath}`, { filePath }, error);
  }
}

/**
 * Cria um diretório que ainda NÃO pode existir.
 *
 * `ensureDir` usa `recursive: true`, que por definição suprime `EEXIST`. Para
 * evidência append-only isso é o comportamento errado: se o número da tentativa
 * ou da parada repetir por qualquer motivo, o sistema de arquivos coopera em
 * silêncio com a destruição do que já estava lá. Aqui a colisão é um erro
 * nomeado, e a execução para em vez de sobrescrever.
 */
export function createExclusiveDirSync(dirPath: string): Result<string> {
  try {
    ensureDir(path.dirname(dirPath));
    fs.mkdirSync(dirPath, { recursive: false });
    return ok(dirPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      return fail(
        'STATE_CORRUPT',
        `O diretório ${dirPath} já existe. A execução foi interrompida para preservar as evidências já gravadas.`,
        { dirPath },
        error,
      );
    }
    return fail('IO_FAILED', `Falha ao criar ${dirPath}`, { dirPath }, error);
  }
}

/** Grava um arquivo que ainda NÃO pode existir (`O_EXCL`). */
export function writeExclusiveSync(filePath: string, contents: string): Result<void> {
  try {
    ensureDir(path.dirname(filePath));
    fs.writeFileSync(filePath, contents, { encoding: 'utf8', flag: 'wx' });
    return ok(undefined);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      return fail(
        'STATE_CORRUPT',
        `O arquivo ${filePath} já existe. A execução foi interrompida para não sobrescrever evidência.`,
        { filePath },
        error,
      );
    }
    return fail('IO_FAILED', `Falha ao gravar ${filePath}`, { filePath }, error);
  }
}

export function fileExists(filePath: string): boolean {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

export function directoryExists(dirPath: string): boolean {
  try {
    return fs.statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

export function listFilesSync(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

export function listDirectoriesSync(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function stripBom(value: string): string {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}

export type { OrqError };
