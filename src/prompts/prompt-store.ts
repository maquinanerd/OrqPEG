import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PromptFile, Result } from '../types';
import { fail, ok } from '../utils/errors';
import { directoryExists, fileExists, listFilesSync, readTextSync } from '../utils/fs-atomic';
import { leadingNumber, naturalCompare } from '../utils/natural-sort';
import { ORQPEG_DIRS, ensureDir, isInside, projectDir, projectPromptsDir } from '../utils/paths';
import { validateIdentifier } from '../security/path-guard';
import { toSlug } from '../projects/slug';
import type { ParsedPrompt } from './prompt-parser';
import { parsePrompt } from './prompt-parser';

/**
 * Descoberta de prompts de um projeto.
 *
 * Os prompts ficam em `data/projects/<slug>/prompts` e definem a ORDEM de
 * execução do OrqPEG. A ordenação é natural pelo nome do arquivo, de modo que
 * `2-etapa.md` venha antes de `10-etapa.md`, que venha antes de `20-etapa.md`.
 */

/** Arquivos de apoio que nunca são tratados como prompt. */
const IGNORED_FILE_NAMES: ReadonlySet<string> = new Set(['readme.md', 'template-prompt.md']);

export function discoverPrompts(projectId: string): Result<PromptFile[]> {
  const identifier = validateIdentifier(projectId, 'id do projeto');
  if (!identifier.ok) return identifier;

  if (!directoryExists(projectDir(identifier.value))) {
    return fail('PROJECT_NOT_FOUND', `Projeto "${projectId}" não está cadastrado no OrqPEG.`, {
      projectId,
    });
  }

  const promptsDir = projectPromptsDir(identifier.value);
  if (!directoryExists(promptsDir)) return ok([]);

  const fileNames = listFilesSync(promptsDir)
    .filter(isPromptFileName)
    .sort(naturalCompare);

  const prompts: PromptFile[] = [];
  const usedIds = new Set<string>();

  for (const fileName of fileNames) {
    const absolutePath = path.join(promptsDir, fileName);

    let sizeBytes: number;
    try {
      sizeBytes = fs.statSync(absolutePath).size;
    } catch {
      continue; // arquivo removido entre a listagem e a leitura
    }

    const text = readTextSync(absolutePath);
    // Com o conteúdo vazio o parser deriva o nome a partir do nome do arquivo.
    const parsed = parsePrompt(fileName, text.ok ? text.value : '');

    prompts.push({
      id: uniqueId(derivePromptId(fileName), usedIds),
      name: parsed.name,
      fileName,
      absolutePath,
      order: leadingNumber(fileName),
      sizeBytes,
    });
  }

  return ok(prompts);
}

export function readPrompt(prompt: PromptFile): Result<ParsedPrompt> {
  const absolutePath = path.resolve(prompt.absolutePath);
  if (!isInside(ORQPEG_DIRS.projects(), absolutePath)) {
    return fail(
      'PATH_UNSAFE',
      `O arquivo de prompt está fora de ${ORQPEG_DIRS.projects()}: ${absolutePath}`,
      { promptId: prompt.id, absolutePath },
    );
  }
  if (!fileExists(absolutePath)) {
    return fail('PROMPT_NOT_FOUND', `Arquivo de prompt não encontrado: ${absolutePath}`, {
      promptId: prompt.id,
      absolutePath,
    });
  }

  const text = readTextSync(absolutePath);
  if (!text.ok) return text;

  const parsed = parsePrompt(prompt.fileName, text.value);
  // O id do arquivo descoberto é a chave usada em estado e artefatos: ele manda.
  return ok({ ...parsed, id: prompt.id });
}

export function ensurePromptsDir(projectId: string): Result<string> {
  const identifier = validateIdentifier(projectId, 'id do projeto');
  if (!identifier.ok) return identifier;

  const promptsDir = projectPromptsDir(identifier.value);
  if (!isInside(ORQPEG_DIRS.projects(), promptsDir)) {
    return fail('PATH_UNSAFE', `Caminho de prompts inválido para o projeto "${projectId}".`, {
      projectId,
    });
  }

  try {
    ensureDir(promptsDir);
  } catch (error) {
    return fail(
      'IO_FAILED',
      `Falha ao criar a pasta de prompts do projeto "${projectId}".`,
      { promptsDir },
      error,
    );
  }
  return ok(promptsDir);
}

export function countPrompts(projectId: string): number {
  const discovered = discoverPrompts(projectId);
  return discovered.ok ? discovered.value.length : 0;
}

/** Apenas `.md`, ignorando README, template e arquivos iniciados por `_`. */
function isPromptFileName(fileName: string): boolean {
  if (fileName.startsWith('_')) return false;
  const lower = fileName.toLowerCase();
  if (!lower.endsWith('.md')) return false;
  return !IGNORED_FILE_NAMES.has(lower);
}

/**
 * Id do prompt: nome do arquivo sem extensão. Quando o nome não é um
 * identificador seguro para compor caminhos, ele é convertido em slug.
 */
function derivePromptId(fileName: string): string {
  const base = fileName.replace(/\.[^.]+$/, '');

  const direct = validateIdentifier(base, 'id do prompt');
  if (direct.ok) return direct.value;

  const slug = toSlug(base);
  if (slug.length === 0) return 'prompt';

  const sanitized = validateIdentifier(slug, 'id do prompt');
  return sanitized.ok ? sanitized.value : `prompt-${slug}`;
}

/** Garante unicidade dos ids dentro do projeto (`etapa`, `etapa-2`, `etapa-3`...). */
function uniqueId(candidate: string, used: Set<string>): string {
  if (!used.has(candidate)) {
    used.add(candidate);
    return candidate;
  }
  let suffix = 2;
  let next = `${candidate}-${suffix}`;
  while (used.has(next)) {
    suffix += 1;
    next = `${candidate}-${suffix}`;
  }
  used.add(next);
  return next;
}
