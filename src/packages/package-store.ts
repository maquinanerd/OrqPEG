import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CuratedPackage, ImportedPackageRecord, PackageRound, Result } from '../types';
import { fail, ok } from '../utils/errors';
import {
  createExclusiveDirSync,
  directoryExists,
  fileExists,
  readJsonSync,
  writeArtifactSync,
  writeJsonAtomicSync,
} from '../utils/fs-atomic';
import { ensureDir, projectDir } from '../utils/paths';
import { nowIso } from '../utils/time';
import { validateIdentifier } from '../security/path-guard';
import { readCuratedPackage } from './package-reader';

/**
 * Importação de um pacote curado para a área de dados do projeto.
 *
 * O pacote de ORIGEM nunca é tocado: a importação é uma cópia para dentro de
 * `data/projects/<id>/package/`, e a pasta original continua sendo do usuário.
 *
 * Uma versão já importada não é sobrescrita em silêncio. Reimportar exige ou
 * uma versão nova, ou a intenção explícita de substituir — porque sobrescrever
 * apagaria o pacote sob o qual execuções anteriores rodaram, e com ele a
 * possibilidade de entender o que aquelas execuções fizeram.
 */

const PACKAGE_DIR = 'package';
const RECORD_FILE = 'package.json';

export function projectPackageDir(projectId: string): string {
  return path.join(projectDir(projectId), PACKAGE_DIR);
}

export function packageRecordPath(projectId: string): string {
  return path.join(projectPackageDir(projectId), RECORD_FILE);
}

/** Pacote atualmente importado no projeto, se houver. */
export function getImportedPackage(projectId: string): Result<ImportedPackageRecord | null> {
  const check = validateIdentifier(projectId, 'id do projeto');
  if (!check.ok) return check;

  const filePath = packageRecordPath(check.value);
  if (!fileExists(filePath)) return ok(null);

  const read = readJsonSync<ImportedPackageRecord>(filePath);
  if (!read.ok) return read;
  return ok(read.value);
}

/** Rodada importada, lida da cópia local — nunca da origem. */
export function getImportedRound(
  projectId: string,
  roundId: string,
): Result<PackageRound> {
  const projectCheck = validateIdentifier(projectId, 'id do projeto');
  if (!projectCheck.ok) return projectCheck;
  const roundCheck = validateIdentifier(roundId, 'id da rodada');
  if (!roundCheck.ok) return roundCheck;

  const filePath = path.join(
    projectPackageDir(projectCheck.value),
    'rounds',
    roundCheck.value,
    'round.json',
  );
  if (!fileExists(filePath)) {
    return fail(
      'CONFIG_NOT_FOUND',
      `A rodada "${roundCheck.value}" não existe no pacote importado do projeto ${projectCheck.value}.`,
      { projectId: projectCheck.value, roundId: roundCheck.value },
    );
  }
  return readJsonSync<PackageRound>(filePath);
}

export interface ImportPackageInput {
  projectId: string;
  sourcePath: string;
  /** Versão declarada pelo operador. Reimportar exige versão diferente. */
  version: string;
  /**
   * Substituir uma versão já importada. Exige intenção explícita: o padrão é
   * recusar, para que nada seja perdido por engano.
   */
  replaceExisting?: boolean;
}

export interface ImportPackageOutput {
  record: ImportedPackageRecord;
  package: CuratedPackage;
}

/**
 * Valida e importa o pacote.
 *
 * A validação vem ANTES de qualquer escrita: um pacote inválido não deixa
 * rastro no projeto. Se a validação falhar, nada foi copiado e nada foi
 * alterado.
 */
export function importCuratedPackage(input: ImportPackageInput): Result<ImportPackageOutput> {
  const projectCheck = validateIdentifier(input.projectId, 'id do projeto');
  if (!projectCheck.ok) return projectCheck;
  const projectId = projectCheck.value;

  const version = (input.version ?? '').trim();
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    return fail(
      'VALIDATION_FAILED',
      `A versão do pacote precisa estar no formato X.Y.Z (recebido: "${version}").`,
      { version },
    );
  }

  const parsed = readCuratedPackage(input.sourcePath);
  if (!parsed.ok) return parsed;
  const pkg = parsed.value;

  const existing = getImportedPackage(projectId);
  if (!existing.ok) return existing;

  if (existing.value) {
    const previous = existing.value;
    if (previous.packageHash === pkg.packageHash && previous.version === version) {
      return fail(
        'VALIDATION_FAILED',
        `Este pacote (versão ${version}) já está importado e não mudou. Nada a fazer.`,
        { projectId, version, packageHash: pkg.packageHash },
      );
    }
    if (previous.version === version && input.replaceExisting !== true) {
      return fail(
        'VALIDATION_FAILED',
        `A versão ${version} já foi importada com conteúdo DIFERENTE. ` +
          'Publique uma versão nova, ou confirme explicitamente a substituição. ' +
          'Sobrescrever em silêncio apagaria o pacote sob o qual as execuções anteriores rodaram.',
        { projectId, version, previousHash: previous.packageHash, newHash: pkg.packageHash },
      );
    }
  }

  const target = projectPackageDir(projectId);
  const archived = existing.value ? archivePrevious(projectId, existing.value) : null;

  try {
    ensureDir(path.dirname(target));
    if (directoryExists(target)) fs.rmSync(target, { recursive: true, force: true });
    copyTree(pkg.rootPath, target);
  } catch (error) {
    return fail('IO_FAILED', `Falha ao copiar o pacote para ${target}.`, { target }, error);
  }

  const record: ImportedPackageRecord = {
    packageId: pkg.plan.packageId,
    name: pkg.plan.name,
    version,
    packageHash: pkg.packageHash,
    sourcePath: pkg.rootPath,
    importedAt: nowIso(),
    validatedCommitSha: pkg.plan.validation.validatedCommitSha,
    roundIds: pkg.rounds.map((round) => round.id),
  };

  const written = writeJsonAtomicSync(packageRecordPath(projectId), record);
  if (!written.ok) return written;

  if (archived) {
    writeArtifactSync(
      path.join(archived, 'SUBSTITUIDO.md'),
      [
        '# Pacote substituído',
        '',
        `Substituído em ${record.importedAt} pela versão ${version}.`,
        '',
        'Esta cópia é preservada porque execuções anteriores rodaram sob ela.',
        'Sem isto, entender o que aquelas execuções fizeram seria impossível.',
        '',
      ].join('\n'),
    );
  }

  return ok({ record, package: pkg });
}

/**
 * Move o pacote atual para `package-anterior/<versão>-<carimbo>`.
 *
 * Falha aqui não impede a importação, mas é registrada: perder o histórico é
 * ruim, não conseguir importar é pior.
 */
function archivePrevious(projectId: string, previous: ImportedPackageRecord): string | null {
  const current = projectPackageDir(projectId);
  if (!directoryExists(current)) return null;

  const stamp = nowIso().replace(/[:.]/g, '-');
  const destination = path.join(
    projectDir(projectId),
    'package-anterior',
    `${previous.version}-${stamp}`,
  );

  const created = createExclusiveDirSync(destination);
  if (!created.ok) return null;

  try {
    copyTree(current, destination);
    return destination;
  } catch {
    return null;
  }
}

/** Cópia recursiva. Não segue links: um pacote não empresta o disco do usuário. */
function copyTree(from: string, to: string): void {
  ensureDir(to);
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      copyTree(source, target);
    } else if (entry.isFile()) {
      fs.copyFileSync(source, target);
    }
  }
}
