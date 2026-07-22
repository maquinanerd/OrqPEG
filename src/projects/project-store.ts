import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ProjectConfig, Result } from '../types';
import { fail, ok } from '../utils/errors';
import {
  directoryExists,
  fileExists,
  listDirectoriesSync,
  readJsonSync,
  writeJsonAtomicSync,
} from '../utils/fs-atomic';
import { naturalSort } from '../utils/natural-sort';
import { ORQPEG_DIRS, ensureDir, isInside, projectDir } from '../utils/paths';
import { nowIso } from '../utils/time';
import { validateIdentifier } from '../security/path-guard';
import { validateProjectConfig } from './project-validator';

/**
 * Cadastro de projetos.
 *
 * O OrqPEG guarda apenas METADADOS em `data/projects/<slug>`. O código-fonte do
 * usuário vive em `config.repositoryPath` e NUNCA é criado, movido ou removido
 * por este módulo — nem sequer é aberto para escrita.
 */

/** Subpastas criadas para todo projeto cadastrado. */
const PROJECT_SUBDIRS: readonly string[] = [
  'prompts',
  'state',
  'logs',
  'reviews',
  'reports',
  'artifacts',
];

const CONFIG_FILE_NAME = 'project.json';

/**
 * Valida o identificador e devolve o diretório de cadastro correspondente,
 * garantindo que ele fique dentro de `data/projects`.
 */
function resolveRegistrationDir(projectId: string): Result<string> {
  const identifier = validateIdentifier(projectId, 'id do projeto');
  if (!identifier.ok) return identifier;

  const root = ORQPEG_DIRS.projects();
  const dir = projectDir(identifier.value);
  if (!isInside(root, dir) || path.resolve(dir) === path.resolve(root)) {
    return fail('PATH_UNSAFE', `Caminho de cadastro inválido para o projeto "${projectId}".`, {
      projectId,
    });
  }
  return ok(dir);
}

/**
 * Lista os projetos cadastrados, ordenados pelo nome.
 *
 * Diretórios sem `project.json` são ignorados. Um cadastro corrompido ou
 * inválido também é ignorado na listagem — use `getProject` para obter o erro
 * detalhado daquele projeto específico.
 */
export function listProjects(): Result<ProjectConfig[]> {
  const root = ORQPEG_DIRS.projects();
  if (!directoryExists(root)) return ok([]);

  const projects: ProjectConfig[] = [];
  for (const entry of listDirectoriesSync(root)) {
    const configPath = path.join(root, entry, CONFIG_FILE_NAME);
    if (!fileExists(configPath)) continue;

    const raw = readJsonSync<unknown>(configPath);
    if (!raw.ok) continue;

    const validated = validateProjectConfig(raw.value);
    if (!validated.ok) continue;

    projects.push(validated.value);
  }

  return ok(naturalSort(projects, (project) => project.name));
}

export function getProject(projectId: string): Result<ProjectConfig> {
  const dir = resolveRegistrationDir(projectId);
  if (!dir.ok) return dir;

  const configPath = path.join(dir.value, CONFIG_FILE_NAME);
  if (!fileExists(configPath)) {
    return fail('PROJECT_NOT_FOUND', `Projeto "${projectId}" não está cadastrado no OrqPEG.`, {
      projectId,
    });
  }

  const raw = readJsonSync<unknown>(configPath);
  if (!raw.ok) return raw;
  return validateProjectConfig(raw.value);
}

export function projectExists(projectId: string): boolean {
  const dir = resolveRegistrationDir(projectId);
  if (!dir.ok) return false;
  return fileExists(path.join(dir.value, CONFIG_FILE_NAME));
}

/**
 * Cadastra um novo projeto: cria a estrutura de pastas em `data/projects/<slug>`
 * e grava `project.json` de forma atômica. Falha se o projeto já existir.
 */
export function createProject(config: ProjectConfig): Result<ProjectConfig> {
  const validated = validateProjectConfig(config);
  if (!validated.ok) return validated;

  const dir = resolveRegistrationDir(validated.value.id);
  if (!dir.ok) return dir;

  const configPath = path.join(dir.value, CONFIG_FILE_NAME);
  if (fileExists(configPath)) {
    return fail(
      'PROJECT_INVALID',
      `Já existe um projeto cadastrado com o id "${validated.value.id}". Escolha outro id ou use a atualização.`,
      { projectId: validated.value.id },
    );
  }

  const timestamp = nowIso();
  const stored: ProjectConfig = {
    ...validated.value,
    createdAt:
      typeof validated.value.createdAt === 'string' && validated.value.createdAt.length > 0
        ? validated.value.createdAt
        : timestamp,
    updatedAt: timestamp,
  };

  try {
    ensureDir(dir.value);
    for (const sub of PROJECT_SUBDIRS) {
      ensureDir(path.join(dir.value, sub));
    }
  } catch (error) {
    return fail(
      'IO_FAILED',
      `Falha ao criar a estrutura de pastas do projeto "${stored.id}".`,
      { dir: dir.value },
      error,
    );
  }

  const written = writeJsonAtomicSync(configPath, stored);
  if (!written.ok) return written;
  return ok(stored);
}

/**
 * Atualiza um projeto já cadastrado. Seções são substituídas por inteiro quando
 * informadas no patch; o `id` é imutável porque define o caminho do cadastro.
 */
export function updateProject(
  projectId: string,
  patch: Partial<ProjectConfig>,
): Result<ProjectConfig> {
  const current = getProject(projectId);
  if (!current.ok) return current;

  if (patch.id !== undefined && patch.id !== current.value.id) {
    return fail(
      'PROJECT_INVALID',
      'Não é permitido alterar o id de um projeto cadastrado. Remova o cadastro e crie outro.',
      { projectId, requestedId: patch.id },
    );
  }

  const merged: ProjectConfig = {
    ...current.value,
    ...patch,
    id: current.value.id,
    worktree: { ...current.value.worktree, ...(patch.worktree ?? {}) },
    commands: { ...current.value.commands, ...(patch.commands ?? {}) },
    execution: { ...current.value.execution, ...(patch.execution ?? {}) },
    git: { ...current.value.git, ...(patch.git ?? {}) },
    pullRequest: { ...current.value.pullRequest, ...(patch.pullRequest ?? {}) },
    merge: { ...current.value.merge, ...(patch.merge ?? {}) },
    agents: { ...current.value.agents, ...(patch.agents ?? {}) },
    createdAt: current.value.createdAt ?? nowIso(),
    updatedAt: nowIso(),
  };

  const validated = validateProjectConfig(merged);
  if (!validated.ok) return validated;

  const dir = resolveRegistrationDir(merged.id);
  if (!dir.ok) return dir;

  const written = writeJsonAtomicSync(path.join(dir.value, CONFIG_FILE_NAME), merged);
  if (!written.ok) return written;
  return ok(merged);
}

/**
 * Remove APENAS o cadastro do projeto, isto é, o conteúdo de
 * `data/projects/<slug>` (metadados, prompts copiados, estado, relatórios).
 *
 * O repositório do usuário (`config.repositoryPath`) JAMAIS é tocado: nenhum
 * caminho fora de `data/projects` pode ser apagado por esta função, e a
 * verificação com `isInside` abaixo é obrigatória. Com `keepData: true` apenas o
 * `project.json` é removido, "desregistrando" o projeto sem perder histórico.
 */
export function removeProjectRegistration(
  projectId: string,
  options?: { keepData?: boolean },
): Result<void> {
  const dir = resolveRegistrationDir(projectId);
  if (!dir.ok) return dir;

  const target = path.resolve(dir.value);
  const root = ORQPEG_DIRS.projects();

  // Trava de segurança: só é permitido apagar dentro de data/projects.
  if (!isInside(root, target) || target === path.resolve(root)) {
    return fail(
      'PATH_UNSAFE',
      `Remoção recusada: ${target} está fora de ${path.resolve(root)}.`,
      { projectId, target },
    );
  }

  if (!directoryExists(target)) {
    return fail('PROJECT_NOT_FOUND', `Projeto "${projectId}" não está cadastrado no OrqPEG.`, {
      projectId,
    });
  }

  const configPath = path.join(target, CONFIG_FILE_NAME);

  // Segunda trava: se por qualquer motivo o repositório do usuário estiver
  // aninhado dentro da pasta de cadastro, recusamos a remoção. Apagar código do
  // usuário é inaceitável, mesmo diante de um cadastro malformado.
  const existing = readJsonSync<{ repositoryPath?: unknown }>(configPath);
  if (existing.ok && typeof existing.value.repositoryPath === 'string') {
    const repositoryPath = existing.value.repositoryPath.trim();
    if (repositoryPath.length > 0 && isInside(target, path.resolve(repositoryPath))) {
      return fail(
        'PATH_UNSAFE',
        `Remoção recusada: o repositório do usuário (${repositoryPath}) está dentro da pasta de cadastro. Mova o repositório antes de remover o projeto.`,
        { projectId, target },
      );
    }
  }

  if (options?.keepData === true) {
    if (!fileExists(configPath)) {
      return fail('PROJECT_NOT_FOUND', `Projeto "${projectId}" não está cadastrado no OrqPEG.`, {
        projectId,
      });
    }
    try {
      fs.rmSync(configPath, { force: true });
    } catch (error) {
      return fail(
        'IO_FAILED',
        `Falha ao remover o arquivo de cadastro do projeto "${projectId}".`,
        { configPath },
        error,
      );
    }
    return ok(undefined);
  }

  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch (error) {
    return fail(
      'IO_FAILED',
      `Falha ao remover o cadastro do projeto "${projectId}".`,
      { target },
      error,
    );
  }
  return ok(undefined);
}
