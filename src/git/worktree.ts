import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Result, WorktreeInfo } from '../types';
import { fail, ok } from '../utils/errors';
import { isInside, normalizeForCompare } from '../utils/paths';
import { validateAbsolutePath } from '../security/path-guard';
import { validateBranchName } from '../security/branch-name';
import type { GitCommandOptions } from './git';
import { hasRef, runGitChecked, status } from './git';

/**
 * Gerenciamento de worktrees do Git.
 *
 * O OrqPEG isola cada execução em um worktree próprio para nunca mexer na cópia
 * de trabalho que o usuário tem aberta no editor.
 *
 * REGRAS DESTRUTIVAS — PROIBIDAS POR DESIGN:
 *  - um worktree SUJO jamais é apagado, sobrescrito ou reaproveitado;
 *  - `git worktree remove --force` não é usado em hipótese alguma;
 *  - `git clean` e `git reset --hard` não existem neste módulo;
 *  - um diretório preexistente que não seja worktree registrado nunca é
 *    removido: o fluxo para e devolve erro pedindo decisão humana.
 */

export interface CreateWorktreeInput {
  repoDir: string;
  worktreePath: string;
  branch: string;
  baseRef: string;
}

export interface ReuseOrCreateWorktreeInput extends CreateWorktreeInput {
  reuseWhenSafe: boolean;
}

interface ValidatedWorktreeInput {
  repoDir: string;
  worktreePath: string;
  branch: string;
  baseRef: string;
}

/* ------------------------------------------------------------------------- */
/* Listagem                                                                   */
/* ------------------------------------------------------------------------- */

export async function listWorktrees(
  repoDir: string,
  options: GitCommandOptions = {},
): Promise<Result<WorktreeInfo[]>> {
  const result = await runGitChecked(repoDir, ['worktree', 'list', '--porcelain'], options);
  if (!result.ok) return result;
  return ok(parseWorktreeList(result.value.stdout));
}

/**
 * Faz o parse de `git worktree list --porcelain`.
 *
 * Cada worktree é um bloco separado por linha em branco:
 *   worktree <caminho absoluto>
 *   HEAD <sha>
 *   branch refs/heads/<nome>   (ou a linha "detached")
 *   locked [<motivo>]          (opcional)
 *   bare                       (opcional, apenas repositório bare)
 *
 * O primeiro bloco é sempre o worktree principal.
 */
export function parseWorktreeList(stdout: string): WorktreeInfo[] {
  const worktrees: WorktreeInfo[] = [];

  for (const rawBlock of stdout.split(/\r?\n\r?\n/)) {
    const lines = rawBlock
      .split('\n')
      .map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line))
      .filter((line) => line.trim().length > 0);
    if (lines.length === 0) continue;

    let worktreePath: string | null = null;
    let branch: string | null = null;
    let headSha: string | null = null;
    let isDetached = false;
    let isLocked = false;

    for (const line of lines) {
      if (line.startsWith('worktree ')) {
        const value = line.slice('worktree '.length).trim();
        if (value.length > 0) worktreePath = path.resolve(value);
      } else if (line.startsWith('HEAD ')) {
        const value = line.slice('HEAD '.length).trim();
        if (value.length > 0) headSha = value;
      } else if (line.startsWith('branch ')) {
        branch = shortBranchName(line.slice('branch '.length).trim());
      } else if (line === 'detached') {
        isDetached = true;
      } else if (line === 'locked' || line.startsWith('locked ')) {
        isLocked = true;
      }
    }

    if (worktreePath === null) continue;

    worktrees.push({
      path: worktreePath,
      branch,
      headSha,
      isMain: worktrees.length === 0,
      isDetached,
      isLocked,
    });
  }

  return worktrees;
}

function shortBranchName(ref: string): string | null {
  if (ref.length === 0) return null;
  if (ref.startsWith('refs/heads/')) return ref.slice('refs/heads/'.length);
  return ref;
}

/** Localiza um worktree pelo caminho, comparando de forma segura no Windows. */
export function findWorktreeByPath(
  worktrees: readonly WorktreeInfo[],
  targetPath: string,
): WorktreeInfo | null {
  const target = normalizeForCompare(targetPath);
  for (const worktree of worktrees) {
    if (normalizeForCompare(worktree.path) === target) return worktree;
  }
  return null;
}

/* ------------------------------------------------------------------------- */
/* Prova de propriedade                                                       */
/* ------------------------------------------------------------------------- */

/**
 * Operações do Git que deixam a árvore em estado intermediário.
 *
 * Um merge ou cherry-pick em conflito mantém o HEAD ANEXADO à branch. Isso
 * significa que `currentBranch` devolve exatamente o nome esperado e uma
 * verificação baseada só na branch aprova a adoção — e então o OrqPEG passa a
 * commitar por cima de um merge que uma pessoa deixou pela metade.
 */
const IN_PROGRESS_MARKERS: ReadonlyArray<{ marker: string; label: string }> = [
  { marker: 'MERGE_HEAD', label: 'merge' },
  { marker: 'CHERRY_PICK_HEAD', label: 'cherry-pick' },
  { marker: 'REVERT_HEAD', label: 'revert' },
  { marker: 'REBASE_HEAD', label: 'rebase' },
  { marker: 'rebase-merge', label: 'rebase interativo' },
  { marker: 'rebase-apply', label: 'rebase/am' },
  { marker: 'BISECT_LOG', label: 'bisect' },
];

/**
 * Detecta operação do Git incompleta dentro de um worktree.
 *
 * O diretório Git real é resolvido com `git rev-parse --git-path`: num worktree
 * secundário `.git` é um ARQUIVO apontando para
 * `<repo>/.git/worktrees/<nome>`, então procurar `<worktree>/.git/MERGE_HEAD`
 * no sistema de arquivos não encontraria nada e a checagem passaria sempre.
 */
export async function detectGitOperationInProgress(
  worktreePath: string,
  options: GitCommandOptions = {},
): Promise<Result<string | null>> {
  for (const { marker, label } of IN_PROGRESS_MARKERS) {
    const resolved = await runGitChecked(
      worktreePath,
      ['rev-parse', '--git-path', marker],
      options,
    );
    if (!resolved.ok) return resolved;

    const raw = resolved.value.stdout.trim();
    if (raw.length === 0) continue;
    const absolute = path.isAbsolute(raw) ? raw : path.resolve(worktreePath, raw);
    if (fs.existsSync(absolute)) return ok(label);
  }
  return ok(null);
}

export interface WorktreeOwnershipInput {
  repoDir: string;
  /** Caminho persistido no `RunRecord`. */
  worktreePath: string;
  /** Caminho canônico recalculado a partir do projeto e do `runId`. */
  canonicalPath: string;
  /** Branch persistida no `RunRecord`. */
  branch: string;
  /** Raiz sob a qual worktrees deste projeto podem existir. */
  allowedRoot: string;
}

/**
 * Prova POSITIVA de que o worktree pertence a esta execução.
 *
 * Adotar um worktree sujo na retomada é correto — a sujeira é o trabalho que o
 * OrqPEG preservou de propósito ao parar. Mas a única evidência que existia era
 * `git -C <caminho> rev-parse --abbrev-ref HEAD`, e `git -C` responde pelo
 * repositório que CONTÉM o diretório: a resposta certa podia vir de um worktree
 * que não é este, ou de um diretório que nem worktree é.
 *
 * A regra é: worktree sujo da MESMA execução, adota; de outra, recusa.
 */
export async function verifyWorktreeOwnership(
  input: WorktreeOwnershipInput,
  options: GitCommandOptions = {},
): Promise<Result<WorktreeInfo>> {
  const pathCheck = validateAbsolutePath(input.worktreePath, 'caminho do worktree');
  if (!pathCheck.ok) return pathCheck;
  const branchCheck = validateBranchName(input.branch);
  if (!branchCheck.ok) return branchCheck;

  /* 1. Caminho canônico. Divergência significa que o registro aponta para um
        lugar que este projeto e este runId não produziriam. */
  if (normalizeForCompare(input.worktreePath) !== normalizeForCompare(input.canonicalPath)) {
    return fail(
      'WORKTREE_OWNERSHIP_MISMATCH',
      `O registro da execução aponta para ${input.worktreePath}, mas o caminho canônico deste projeto e execução é ${input.canonicalPath}. A divergência precisa de decisão humana.`,
      { persisted: input.worktreePath, canonical: input.canonicalPath },
    );
  }

  /* 2. Contenção na raiz autorizada. */
  if (!isInside(input.allowedRoot, input.worktreePath)) {
    return fail(
      'WORKTREE_OUTSIDE_ALLOWED_ROOT',
      `O worktree ${input.worktreePath} está fora da raiz autorizada ${input.allowedRoot}.`,
      { worktreePath: input.worktreePath, allowedRoot: input.allowedRoot },
    );
  }

  /* 3. Registro no Git do repositório DO PROJETO. É isto que amarra o worktree
        ao repositório certo — a existência da pasta não amarra a nada. */
  const listed = await listWorktrees(input.repoDir, options);
  if (!listed.ok) return listed;

  const registered = findWorktreeByPath(listed.value, input.worktreePath);
  if (registered === null) {
    return fail(
      'WORKTREE_NOT_REGISTERED',
      `O diretório ${input.worktreePath} existe, mas não está registrado como worktree de ${input.repoDir}. Um diretório solto não é prova de propriedade e não será adotado.`,
      { worktreePath: input.worktreePath, repoDir: input.repoDir },
    );
  }
  if (registered.isMain) {
    return fail(
      'WORKTREE_OWNERSHIP_MISMATCH',
      `${input.worktreePath} é o worktree principal do repositório e nunca é adotado por uma execução.`,
      { worktreePath: input.worktreePath },
    );
  }
  if (registered.isLocked) {
    return fail(
      'WORKTREE_OWNERSHIP_MISMATCH',
      `O worktree ${input.worktreePath} está travado (locked) e não pode ser adotado.`,
      { worktreePath: input.worktreePath },
    );
  }

  /* 4. Branch. HEAD destacado é recusa explícita, não efeito colateral. */
  if (registered.isDetached || registered.branch === null) {
    return fail(
      'WORKTREE_OWNERSHIP_MISMATCH',
      `O worktree ${input.worktreePath} está com HEAD destacado; esta execução espera a branch "${input.branch}".`,
      { worktreePath: input.worktreePath, expectedBranch: input.branch },
    );
  }
  if (registered.branch !== input.branch) {
    return fail(
      'WORKTREE_OWNERSHIP_MISMATCH',
      `O worktree ${input.worktreePath} está na branch "${registered.branch}", mas esta execução é da branch "${input.branch}". Worktree sujo de OUTRA execução não é adotado.`,
      {
        worktreePath: input.worktreePath,
        currentBranch: registered.branch,
        expectedBranch: input.branch,
      },
    );
  }

  /* 5. Nenhuma operação do Git pela metade. */
  const inProgress = await detectGitOperationInProgress(input.worktreePath, options);
  if (!inProgress.ok) return inProgress;
  if (inProgress.value !== null) {
    return fail(
      'GIT_OPERATION_IN_PROGRESS',
      `Há um ${inProgress.value} em andamento no worktree ${input.worktreePath}. Conclua ou aborte a operação manualmente antes de retomar: o OrqPEG não commita por cima de um estado intermediário.`,
      { worktreePath: input.worktreePath, operation: inProgress.value },
    );
  }

  return ok(registered);
}

/* ------------------------------------------------------------------------- */
/* Criação                                                                    */
/* ------------------------------------------------------------------------- */

function validateInput(input: CreateWorktreeInput): Result<ValidatedWorktreeInput> {
  const repoCheck = validateAbsolutePath(input.repoDir, 'diretório do repositório');
  if (!repoCheck.ok) return repoCheck;

  const pathCheck = validateAbsolutePath(input.worktreePath, 'caminho do worktree');
  if (!pathCheck.ok) return pathCheck;

  const branchCheck = validateBranchName(input.branch);
  if (!branchCheck.ok) return branchCheck;

  const baseCheck = validateBranchName(input.baseRef);
  if (!baseCheck.ok) {
    return fail(
      'VALIDATION_FAILED',
      `Referência base inválida para o worktree: "${input.baseRef}".`,
      { baseRef: input.baseRef },
    );
  }

  if (isInside(repoCheck.value, pathCheck.value)) {
    return fail(
      'WORKTREE_FAILED',
      'O worktree não pode ficar dentro do próprio repositório: escolha uma pasta fora de ' +
        `${repoCheck.value}.`,
      { repoDir: repoCheck.value, worktreePath: pathCheck.value },
    );
  }

  return ok({
    repoDir: repoCheck.value,
    worktreePath: pathCheck.value,
    branch: branchCheck.value,
    baseRef: baseCheck.value,
  });
}

/** Cria um worktree novo com uma branch nova (`git worktree add -b`). */
export async function createWorktree(
  input: CreateWorktreeInput,
  options: GitCommandOptions = {},
): Promise<Result<WorktreeInfo>> {
  const validated = validateInput(input);
  if (!validated.ok) return validated;
  const { repoDir, worktreePath, branch, baseRef } = validated.value;

  const listed = await listWorktrees(repoDir, options);
  if (!listed.ok) return listed;

  if (findWorktreeByPath(listed.value, worktreePath) !== null) {
    return fail(
      'WORKTREE_FAILED',
      `Já existe um worktree registrado em ${worktreePath}. O OrqPEG não sobrescreve worktrees existentes.`,
      { worktreePath },
    );
  }

  if (directoryHasContent(worktreePath)) {
    return fail(
      'WORKTREE_FAILED',
      `O diretório ${worktreePath} já existe e não está vazio. Remova-o manualmente ou escolha outro caminho: o OrqPEG nunca apaga diretórios do usuário.`,
      { worktreePath },
    );
  }

  const prepared = ensureParentDirectory(worktreePath);
  if (!prepared.ok) return prepared;

  const result = await runGitChecked(
    repoDir,
    ['worktree', 'add', '-b', branch, worktreePath, baseRef],
    options,
  );
  if (!result.ok) return result;

  return locateCreatedWorktree(repoDir, worktreePath, options);
}

/**
 * Reaproveita um worktree existente quando for seguro, ou cria um novo.
 *
 * O reaproveitamento só acontece se TODAS as condições forem verdadeiras:
 *  - `reuseWhenSafe` está habilitado no projeto;
 *  - o worktree está registrado no repositório;
 *  - está na branch esperada (não destacado, não travado);
 *  - o `git status` está completamente limpo.
 *
 * Um worktree sujo NÃO é reaproveitado e NÃO é apagado: a execução para com
 * erro para que o usuário decida o que fazer com o trabalho pendente.
 */
export async function reuseOrCreateWorktree(
  input: ReuseOrCreateWorktreeInput,
  options: GitCommandOptions = {},
): Promise<Result<WorktreeInfo>> {
  const validated = validateInput(input);
  if (!validated.ok) return validated;
  const { repoDir, worktreePath, branch, baseRef } = validated.value;
  const reuseWhenSafe = input.reuseWhenSafe;

  const listed = await listWorktrees(repoDir, options);
  if (!listed.ok) return listed;

  const existing = findWorktreeByPath(listed.value, worktreePath);
  if (existing !== null) {
    if (!reuseWhenSafe) {
      return fail(
        'WORKTREE_FAILED',
        `Já existe um worktree em ${worktreePath}, mas o reaproveitamento está desabilitado no projeto. Remova-o manualmente ou habilite "worktree.reuseWhenSafe".`,
        { worktreePath, branch },
      );
    }
    if (existing.isLocked) {
      return fail(
        'WORKTREE_FAILED',
        `O worktree em ${worktreePath} está travado (locked) e não pode ser reaproveitado.`,
        { worktreePath },
      );
    }
    /* Operação incompleta é diagnosticada ANTES do HEAD destacado: durante um
       rebase o HEAD fica destacado como consequência, e reportar "HEAD
       destacado" mandava o usuário investigar o sintoma em vez da causa. */
    const inProgress = await detectGitOperationInProgress(worktreePath, options);
    if (!inProgress.ok) return inProgress;
    if (inProgress.value !== null) {
      return fail(
        'GIT_OPERATION_IN_PROGRESS',
        `Há um ${inProgress.value} em andamento no worktree ${worktreePath}. Conclua ou aborte a operação manualmente: o OrqPEG não reaproveita um worktree em estado intermediário.`,
        { worktreePath, operation: inProgress.value },
      );
    }

    if (existing.isDetached || existing.branch === null) {
      return fail(
        'WORKTREE_FAILED',
        `O worktree em ${worktreePath} está com HEAD destacado; era esperada a branch "${branch}".`,
        { worktreePath, expectedBranch: branch },
      );
    }
    if (existing.branch !== branch) {
      return fail(
        'WORKTREE_FAILED',
        `O worktree em ${worktreePath} está na branch "${existing.branch}", mas era esperada a branch "${branch}".`,
        { worktreePath, currentBranch: existing.branch, expectedBranch: branch },
      );
    }

    const current = await status(worktreePath, options);
    if (!current.ok) return current;
    if (!current.value.clean) {
      const samples = current.value.entries.slice(0, 10).map((entry) => entry.path);
      return fail(
        'WORKTREE_FAILED',
        `O worktree em ${worktreePath} possui alterações não commitadas e por isso não será reaproveitado. Nada foi apagado: revise ou salve o trabalho pendente antes de executar novamente.`,
        {
          worktreePath,
          changedCount: current.value.entries.length,
          sampleFiles: samples,
        },
      );
    }

    return ok(existing);
  }

  if (directoryHasContent(worktreePath)) {
    return fail(
      'WORKTREE_FAILED',
      `O diretório ${worktreePath} já existe, não está vazio e não é um worktree registrado. O OrqPEG não apaga diretórios do usuário: escolha outro caminho ou limpe-o manualmente.`,
      { worktreePath },
    );
  }

  // A branch pode já existir de uma execução anterior cujo worktree foi
  // removido. Nesse caso o worktree é reconectado à branch existente, sem
  // recriá-la e sem descartar commits.
  const branchAlreadyExists = await hasRef(repoDir, `refs/heads/${branch}`, options);
  if (!branchAlreadyExists) {
    return createWorktree({ repoDir, worktreePath, branch, baseRef }, options);
  }

  if (!reuseWhenSafe) {
    return fail(
      'WORKTREE_FAILED',
      `A branch "${branch}" já existe no repositório e o reaproveitamento está desabilitado no projeto. Escolha outro nome de branch ou habilite "worktree.reuseWhenSafe".`,
      { branch },
    );
  }

  const prepared = ensureParentDirectory(worktreePath);
  if (!prepared.ok) return prepared;

  const result = await runGitChecked(
    repoDir,
    ['worktree', 'add', worktreePath, branch],
    options,
  );
  if (!result.ok) return result;

  return locateCreatedWorktree(repoDir, worktreePath, options);
}

async function locateCreatedWorktree(
  repoDir: string,
  worktreePath: string,
  options: GitCommandOptions,
): Promise<Result<WorktreeInfo>> {
  const listed = await listWorktrees(repoDir, options);
  if (!listed.ok) return listed;

  const created = findWorktreeByPath(listed.value, worktreePath);
  if (created === null) {
    return fail(
      'WORKTREE_FAILED',
      `O Git não registrou o worktree em ${worktreePath} após a criação.`,
      { repoDir, worktreePath },
    );
  }
  return ok(created);
}

/* ------------------------------------------------------------------------- */
/* Remoção segura e manutenção                                                */
/* ------------------------------------------------------------------------- */

/**
 * Remove o worktree APENAS se ele estiver limpo.
 *
 * Devolve `ok(true)` quando removeu e `ok(false)` quando decidiu não remover
 * (worktree inexistente, travado, principal ou com alterações pendentes).
 * `--force` nunca é usado: nenhuma alteração do usuário pode ser descartada.
 */
export async function removeWorktreeIfClean(
  repoDir: string,
  worktreePath: string,
  options: GitCommandOptions = {},
): Promise<Result<boolean>> {
  const repoCheck = validateAbsolutePath(repoDir, 'diretório do repositório');
  if (!repoCheck.ok) return repoCheck;
  const pathCheck = validateAbsolutePath(worktreePath, 'caminho do worktree');
  if (!pathCheck.ok) return pathCheck;

  const listed = await listWorktrees(repoCheck.value, options);
  if (!listed.ok) return listed;

  const existing = findWorktreeByPath(listed.value, pathCheck.value);
  if (existing === null) return ok(false);
  if (existing.isMain) return ok(false);
  if (existing.isLocked) return ok(false);
  if (!directoryExists(pathCheck.value)) return ok(false);

  const current = await status(pathCheck.value, options);
  if (!current.ok) return current;
  if (!current.value.clean) return ok(false);

  const result = await runGitChecked(
    repoCheck.value,
    ['worktree', 'remove', pathCheck.value],
    options,
  );
  if (!result.ok) return result;
  return ok(true);
}

/**
 * Limpa registros administrativos de worktrees cujo diretório já não existe.
 * Não toca em nenhum diretório presente no disco.
 */
export async function pruneWorktrees(
  repoDir: string,
  options: GitCommandOptions = {},
): Promise<Result<void>> {
  const result = await runGitChecked(repoDir, ['worktree', 'prune'], options);
  if (!result.ok) return result;
  return ok(undefined);
}

/** Caminho padrão de worktree: `<raiz>/<projeto>/<execução>`. */
export function defaultWorktreePath(
  rootPath: string,
  projectId: string,
  runId: string,
): string {
  return path.join(path.resolve(rootPath), sanitizeSegment(projectId), sanitizeSegment(runId));
}

function sanitizeSegment(value: string): string {
  const cleaned = value
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[-.]+/, '')
    .replace(/[-.]+$/, '');
  return cleaned.length > 0 ? cleaned.slice(0, 80) : 'orqpeg';
}

/* ------------------------------------------------------------------------- */
/* Sistema de arquivos                                                        */
/* ------------------------------------------------------------------------- */

function directoryExists(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

/** Verdadeiro quando o caminho existe e possui qualquer conteúdo. */
function directoryHasContent(target: string): boolean {
  try {
    const stat = fs.statSync(target);
    if (!stat.isDirectory()) return true;
    return fs.readdirSync(target).length > 0;
  } catch {
    return false;
  }
}

function ensureParentDirectory(target: string): Result<string> {
  const parent = path.dirname(target);
  try {
    fs.mkdirSync(parent, { recursive: true });
    return ok(parent);
  } catch (error) {
    return fail(
      'IO_FAILED',
      `Não foi possível criar o diretório pai do worktree: ${parent}.`,
      { parent },
      error,
    );
  }
}
