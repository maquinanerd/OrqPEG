import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  BranchStrategy,
  MergeMode,
  MergeStrategy,
  ProjectConfig,
  Result,
} from '../types';
import { fail, ok } from '../utils/errors';
import { directoryExists, fileExists } from '../utils/fs-atomic';
import { validateBranchName } from '../security/branch-name';
import { validateAbsolutePath } from '../security/path-guard';
import { remoteMatchesRepository } from '../git/git';
import { isValidSlug, toSlug } from './slug';
import {
  normalizeLoopGuardConfig,
  validateLoopGuardConfig,
} from '../execution/loop-guard-config';

/**
 * Validação de projetos.
 *
 * Três responsabilidades bem separadas:
 *  - `validateProjectConfig`: validação estrutural, campo a campo, sem tocar no
 *    disco. Todo problema encontrado é reportado de uma vez, em português.
 *  - `validateProjectEnvironment`: validação de realidade — a pasta existe, é um
 *    repositório Git, o remoto aponta para o repositório declarado e a branch
 *    base existe localmente. Problemas não fatais viram avisos.
 *  - `normalizeProjectConfig`: preenche os padrões do produto a partir de um
 *    cadastro parcial.
 *
 * A leitura do repositório é feita diretamente sobre os arquivos de metadados do
 * Git (`.git/config`, `.git/refs`, `.git/packed-refs`). Isso evita depender do
 * executável `git` apenas para validar um cadastro e mantém a função rápida.
 */

const BRANCH_STRATEGIES: readonly BranchStrategy[] = ['per_run', 'fixed', 'per_prompt'];
const MERGE_MODES: readonly MergeMode[] = ['dual_ai_consensus', 'manual', 'disabled'];
const MERGE_STRATEGIES: readonly MergeStrategy[] = ['squash', 'merge', 'rebase'];

const GITHUB_REPOSITORY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;

const MERGE_BOOLEAN_FIELDS: readonly string[] = [
  'enabled',
  'deleteBranchAfterMerge',
  'requireClaudeApproval',
  'requireCodexApproval',
  'requireLocalTests',
  'requireCiSuccess',
  'requireNoConflicts',
  'requireNoUnresolvedThreads',
  'invalidateApprovalOnHeadChange',
];

/* ------------------------------------------------------------------------- */
/* Validação estrutural                                                       */
/* ------------------------------------------------------------------------- */

export function validateProjectConfig(config: unknown): Result<ProjectConfig> {
  if (!isRecord(config)) {
    return fail('PROJECT_INVALID', 'A configuração do projeto deve ser um objeto JSON.');
  }

  const issues: string[] = [];

  const id = config['id'];
  if (typeof id !== 'string' || id.trim().length === 0) {
    issues.push('id: campo obrigatório; informe um texto não vazio.');
  } else if (!isValidSlug(id)) {
    issues.push(
      `id: "${id}" não é um slug válido. Use apenas letras minúsculas, números e hífens simples (máximo de 60 caracteres), sem hífen no início ou no fim.`,
    );
  }

  const name = config['name'];
  if (typeof name !== 'string' || name.trim().length === 0) {
    issues.push('name: campo obrigatório; informe o nome legível do projeto.');
  }

  const repositoryPath = config['repositoryPath'];
  if (typeof repositoryPath !== 'string' || repositoryPath.trim().length === 0) {
    issues.push('repositoryPath: campo obrigatório; informe a pasta do repositório.');
  } else {
    const checked = validateAbsolutePath(repositoryPath, 'repositoryPath');
    if (!checked.ok) issues.push(checked.error.message);
  }

  const githubRepository = config['githubRepository'];
  if (typeof githubRepository !== 'string' || githubRepository.trim().length === 0) {
    issues.push('githubRepository: campo obrigatório no formato "owner/repo".');
  } else if (!GITHUB_REPOSITORY_PATTERN.test(githubRepository.trim())) {
    issues.push(
      `githubRepository: "${githubRepository}" não está no formato "owner/repo" (exemplo: maquinanerd/OrqPEG).`,
    );
  }

  const remote = config['remote'];
  if (typeof remote !== 'string' || remote.trim().length === 0) {
    issues.push('remote: campo obrigatório; informe o nome do remoto (por exemplo, "origin").');
  }

  const baseBranch = config['baseBranch'];
  if (typeof baseBranch !== 'string' || baseBranch.trim().length === 0) {
    issues.push('baseBranch: campo obrigatório; informe a branch base (por exemplo, "main").');
  } else {
    const checked = validateBranchName(baseBranch);
    if (!checked.ok) issues.push(`baseBranch: ${checked.error.message}`);
  }

  const branchStrategy = config['branchStrategy'];
  if (!isOneOf(branchStrategy, BRANCH_STRATEGIES)) {
    issues.push(
      `branchStrategy: valor inválido. Use um destes: ${BRANCH_STRATEGIES.join(', ')}.`,
    );
  }

  issues.push(...validateWorktreeSection(config['worktree']));
  issues.push(...validateCommandsSection(config['commands']));
  issues.push(...validateExecutionSection(config['execution']));
  issues.push(...validateGitSection(config['git']));
  issues.push(...validatePullRequestSection(config['pullRequest']));
  issues.push(...validateMergeSection(config['merge']));
  issues.push(...validateAgentsSection(config['agents']));
  issues.push(...validateOptionalFields(config));

  if (issues.length > 0) {
    const preview = issues.slice(0, 5).join(' ');
    return fail(
      'PROJECT_INVALID',
      `Configuração de projeto inválida (${issues.length} problema(s)). ${preview}`,
      { issues },
    );
  }

  // A partir daqui todos os campos foram verificados individualmente.
  return ok(config as unknown as ProjectConfig);
}

function validateWorktreeSection(value: unknown): string[] {
  if (!isRecord(value)) {
    return ['worktree: seção obrigatória (objeto com enabled, rootPath e reuseWhenSafe).'];
  }
  const issues = collectBooleans(value, 'worktree', ['enabled', 'reuseWhenSafe']);
  const rootPath = value['rootPath'];
  if (rootPath === null || rootPath === undefined) {
    if (rootPath === undefined) {
      issues.push('worktree.rootPath: campo obrigatório; use null para adotar a raiz padrão.');
    }
    return issues;
  }
  if (typeof rootPath !== 'string') {
    issues.push('worktree.rootPath: deve ser um caminho absoluto em texto ou null.');
    return issues;
  }
  if (rootPath.trim().length === 0) {
    issues.push('worktree.rootPath: use null em vez de texto vazio.');
    return issues;
  }
  const checked = validateAbsolutePath(rootPath, 'worktree.rootPath');
  if (!checked.ok) issues.push(checked.error.message);
  return issues;
}

function validateCommandsSection(value: unknown): string[] {
  if (!isRecord(value)) {
    return ['commands: seção obrigatória (objeto com install, tests e timeoutSeconds).'];
  }
  const issues = [
    ...validateCommandList(value['install'], 'commands.install', 0),
    ...validateCommandList(value['tests'], 'commands.tests', 1),
  ];
  const timeoutSeconds = value['timeoutSeconds'];
  if (typeof timeoutSeconds !== 'number' || !Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
    issues.push('commands.timeoutSeconds: deve ser um número maior que zero.');
  }
  return issues;
}

function validateCommandList(value: unknown, label: string, minItems: number): string[] {
  if (!Array.isArray(value)) {
    return [`${label}: deve ser uma lista de comandos em texto.`];
  }
  const items: unknown[] = value;
  const issues: string[] = [];
  if (items.length < minItems) {
    issues.push(`${label}: informe ao menos ${minItems} comando(s).`);
  }
  items.forEach((item, index) => {
    if (typeof item !== 'string' || item.trim().length === 0) {
      issues.push(`${label}[${index}]: cada item deve ser um comando em texto não vazio.`);
    }
  });
  return issues;
}

function validateExecutionSection(value: unknown): string[] {
  if (!isRecord(value)) {
    return ['execution: seção obrigatória (maxAttemptsPerPrompt, maxReviewerRetries, continueAfterApproval, stopOnBlocked).'];
  }
  const issues = collectBooleans(value, 'execution', ['continueAfterApproval', 'stopOnBlocked']);
  const maxAttempts = value['maxAttemptsPerPrompt'];
  if (!Number.isInteger(maxAttempts) || (typeof maxAttempts === 'number' && maxAttempts < 1)) {
    issues.push('execution.maxAttemptsPerPrompt: deve ser um número inteiro maior ou igual a 1.');
  }
  const maxRetries = value['maxReviewerRetries'];
  if (!Number.isInteger(maxRetries) || (typeof maxRetries === 'number' && maxRetries < 0)) {
    issues.push('execution.maxReviewerRetries: deve ser um número inteiro maior ou igual a 0.');
  }

  /* A seção do Loop Guard é opcional no arquivo — projetos anteriores à sua
     introdução continuam válidos e recebem os padrões seguros. O que não é
     aceito é uma seção presente com combinação incoerente de limites. */
  if (value['loopGuard'] !== undefined) {
    issues.push(...validateLoopGuardConfig(normalizeLoopGuardConfig(value['loopGuard'])));
  }
  return issues;
}

function validateGitSection(value: unknown): string[] {
  if (!isRecord(value)) {
    return ['git: seção obrigatória (commitAfterApproval, pushAfterRun, commitMessagePrefix).'];
  }
  const issues = collectBooleans(value, 'git', ['commitAfterApproval', 'pushAfterRun']);
  const prefix = value['commitMessagePrefix'];
  if (typeof prefix !== 'string' || prefix.trim().length === 0) {
    issues.push('git.commitMessagePrefix: deve ser um texto não vazio (por exemplo, "orqpeg:").');
  }
  return issues;
}

function validatePullRequestSection(value: unknown): string[] {
  if (!isRecord(value)) {
    return ['pullRequest: seção obrigatória (enabled, draftDuringExecution, markReadyBeforeMerge, waitForChecks).'];
  }
  return collectBooleans(value, 'pullRequest', [
    'enabled',
    'draftDuringExecution',
    'markReadyBeforeMerge',
    'waitForChecks',
  ]);
}

function validateMergeSection(value: unknown): string[] {
  if (!isRecord(value)) {
    return ['merge: seção obrigatória (mode, strategy, gates e minimumConfidence).'];
  }
  const issues = collectBooleans(value, 'merge', MERGE_BOOLEAN_FIELDS);

  if (!isOneOf(value['mode'], MERGE_MODES)) {
    issues.push(`merge.mode: valor inválido. Use um destes: ${MERGE_MODES.join(', ')}.`);
  }
  if (!isOneOf(value['strategy'], MERGE_STRATEGIES)) {
    issues.push(`merge.strategy: valor inválido. Use um destes: ${MERGE_STRATEGIES.join(', ')}.`);
  }

  const minimumConfidence = value['minimumConfidence'];
  if (
    typeof minimumConfidence !== 'number' ||
    !Number.isFinite(minimumConfidence) ||
    minimumConfidence < 0 ||
    minimumConfidence > 1
  ) {
    issues.push('merge.minimumConfidence: deve ser um número entre 0 e 1.');
  }
  return issues;
}

function validateAgentsSection(value: unknown): string[] {
  if (!isRecord(value)) {
    return ['agents: seção obrigatória (claudeModel e codexModel, ambos texto ou null).'];
  }
  const issues: string[] = [];
  for (const key of ['claudeModel', 'codexModel']) {
    const model = value[key];
    if (model === undefined) {
      issues.push(`agents.${key}: campo obrigatório; use null para adotar o modelo padrão.`);
      continue;
    }
    if (model !== null && (typeof model !== 'string' || model.trim().length === 0)) {
      issues.push(`agents.${key}: deve ser o nome do modelo em texto não vazio ou null.`);
    }
  }
  return issues;
}

function validateOptionalFields(config: Record<string, unknown>): string[] {
  const issues: string[] = [];

  const editor = config['editor'];
  if (editor !== undefined && editor !== null && typeof editor !== 'string') {
    issues.push('editor: deve ser um texto, null ou estar ausente.');
  }

  for (const key of ['createdAt', 'updatedAt']) {
    const value = config[key];
    if (value === undefined) continue;
    if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
      issues.push(`${key}: deve ser uma data ISO-8601 válida quando presente.`);
    }
  }
  return issues;
}

/* ------------------------------------------------------------------------- */
/* Validação de ambiente                                                      */
/* ------------------------------------------------------------------------- */

/**
 * Confere no sistema de arquivos que o cadastro corresponde a um repositório
 * Git real. Falhas que impedem qualquer execução são erros; o resto é aviso.
 *
 * A URL do remoto nunca é incluída em mensagens ou detalhes de erro: ela pode
 * conter credenciais embutidas (`https://usuario:token@github.com/...`).
 */
export async function validateProjectEnvironment(
  config: ProjectConfig,
): Promise<Result<{ warnings: string[] }>> {
  const warnings: string[] = [];

  const repositoryPathCheck = validateAbsolutePath(config.repositoryPath, 'repositoryPath');
  if (!repositoryPathCheck.ok) return repositoryPathCheck;
  const repositoryPath = repositoryPathCheck.value;

  const baseBranchCheck = validateBranchName(config.baseBranch);
  if (!baseBranchCheck.ok) return baseBranchCheck;
  const baseBranch = baseBranchCheck.value;

  if (!directoryExists(repositoryPath)) {
    return fail(
      'PROJECT_INVALID',
      `A pasta do repositório não existe: ${repositoryPath}`,
      { repositoryPath },
    );
  }

  const gitDir = resolveGitDir(repositoryPath);
  if (gitDir === null) {
    return fail(
      'PROJECT_INVALID',
      `A pasta não é um repositório Git (não encontrei ".git"): ${repositoryPath}`,
      { repositoryPath },
    );
  }
  const commonDir = resolveCommonDir(gitDir);

  const remoteUrl = readRemoteUrl(commonDir, config.remote);
  if (remoteUrl === null) {
    warnings.push(
      `O remoto "${config.remote}" não está configurado em ${repositoryPath}. Configure-o antes de enviar commits ou abrir Pull Request.`,
    );
  } else {
    // `remoteMatchesRepository` compara a URL do remoto com "owner/repo".
    // O retorno é interpretado de forma tolerante (booleano ou Result<boolean>)
    // para que este módulo não dependa da representação escolhida pelo módulo Git.
    const rawOutcome: unknown = await remoteMatchesRepository(remoteUrl, config.githubRepository);
    const matches = interpretBooleanOutcome(rawOutcome);
    if (matches === false) {
      return fail(
        'REMOTE_MISMATCH',
        `O remoto "${config.remote}" de ${repositoryPath} não aponta para ${config.githubRepository}. Corrija o cadastro ou o remoto antes de executar.`,
        { remote: config.remote, githubRepository: config.githubRepository, repositoryPath },
      );
    }
    if (matches === null) {
      warnings.push(
        `Não foi possível confirmar se o remoto "${config.remote}" aponta para ${config.githubRepository}. Verifique manualmente antes do primeiro push.`,
      );
    }
  }

  if (!localBranchExists(commonDir, baseBranch)) {
    warnings.push(
      `A branch base "${baseBranch}" não existe localmente em ${repositoryPath}. Traga-a do remoto (git fetch) antes de iniciar uma execução.`,
    );
  }

  if (config.worktree.enabled && config.worktree.rootPath !== null) {
    const rootPathCheck = validateAbsolutePath(config.worktree.rootPath, 'worktree.rootPath');
    if (!rootPathCheck.ok) return rootPathCheck;
    if (!directoryExists(rootPathCheck.value)) {
      warnings.push(
        `A raiz de worktrees ${rootPathCheck.value} ainda não existe e será criada na primeira execução.`,
      );
    }
  }

  return ok({ warnings });
}

/** Resolve o diretório `.git`, cobrindo o caso de worktree (arquivo `gitdir:`). */
function resolveGitDir(repositoryPath: string): string | null {
  const candidate = path.join(repositoryPath, '.git');
  let stats: fs.Stats;
  try {
    stats = fs.statSync(candidate);
  } catch {
    return null;
  }
  if (stats.isDirectory()) return candidate;
  if (!stats.isFile()) return null;

  let content: string;
  try {
    content = fs.readFileSync(candidate, 'utf8');
  } catch {
    return null;
  }
  const match = /^gitdir:\s*(.+)$/m.exec(content);
  const target = match?.[1]?.trim();
  if (target === undefined || target.length === 0) return null;
  const resolved = path.isAbsolute(target)
    ? path.resolve(target)
    : path.resolve(repositoryPath, target);
  return directoryExists(resolved) ? resolved : null;
}

/** Em worktrees, `config` e `packed-refs` vivem no diretório comum do repositório. */
function resolveCommonDir(gitDir: string): string {
  const commonFile = path.join(gitDir, 'commondir');
  if (!fileExists(commonFile)) return gitDir;
  try {
    const raw = fs.readFileSync(commonFile, 'utf8').trim();
    if (raw.length === 0) return gitDir;
    const resolved = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(gitDir, raw);
    return directoryExists(resolved) ? resolved : gitDir;
  } catch {
    return gitDir;
  }
}

/** Lê a URL de um remoto diretamente do arquivo `config` do repositório. */
function readRemoteUrl(commonDir: string, remote: string): string | null {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(commonDir, 'config'), 'utf8');
  } catch {
    return null;
  }

  let currentRemote: string | null = null;
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#') || trimmed.startsWith(';')) continue;
    if (trimmed.startsWith('[')) {
      currentRemote = parseRemoteSectionName(trimmed);
      continue;
    }
    if (currentRemote !== remote) continue;

    const separator = trimmed.indexOf('=');
    if (separator <= 0) continue;
    if (trimmed.slice(0, separator).trim().toLowerCase() !== 'url') continue;
    const value = trimmed.slice(separator + 1).trim();
    if (value.length > 0) return value;
  }
  return null;
}

function parseRemoteSectionName(line: string): string | null {
  const match = /^\[remote\s+"([^"]+)"\]/i.exec(line);
  return match?.[1] ?? null;
}

/** Verdadeiro quando existe uma referência local `refs/heads/<branch>`. */
function localBranchExists(commonDir: string, branch: string): boolean {
  const segments = branch.split('/').filter((segment) => segment.length > 0);
  if (segments.length === 0 || segments.some((segment) => segment === '..')) return false;

  if (fileExists(path.join(commonDir, 'refs', 'heads', ...segments))) return true;

  const packedRefs = path.join(commonDir, 'packed-refs');
  if (!fileExists(packedRefs)) return false;
  let raw: string;
  try {
    raw = fs.readFileSync(packedRefs, 'utf8');
  } catch {
    return false;
  }

  const target = `refs/heads/${segments.join('/')}`;
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#') || trimmed.startsWith('^')) continue;
    const separator = trimmed.indexOf(' ');
    if (separator < 0) continue;
    if (trimmed.slice(separator + 1).trim() === target) return true;
  }
  return false;
}

/** Converte um retorno booleano ou `Result<boolean>` em `true`/`false`/indefinido. */
function interpretBooleanOutcome(outcome: unknown): boolean | null {
  if (typeof outcome === 'boolean') return outcome;
  if (isRecord(outcome)) {
    const value = outcome['value'];
    if (outcome['ok'] === true && typeof value === 'boolean') return value;
  }
  return null;
}

/* ------------------------------------------------------------------------- */
/* Normalização                                                               */
/* ------------------------------------------------------------------------- */

/**
 * Preenche os padrões do produto a partir de um cadastro parcial.
 * O resultado é sempre estruturalmente completo — ainda assim, passe-o por
 * `validateProjectConfig` antes de gravar.
 */
export function normalizeProjectConfig(
  partial: Partial<ProjectConfig> & {
    id: string;
    name: string;
    repositoryPath: string;
    githubRepository: string;
  },
): ProjectConfig {
  const worktree = partial.worktree;
  const commands = partial.commands;
  const execution = partial.execution;
  const git = partial.git;
  const pullRequest = partial.pullRequest;
  const merge = partial.merge;
  const agents = partial.agents;

  const branchStrategy = partial.branchStrategy;
  const mergeMode = merge?.mode;
  const mergeStrategy = merge?.strategy;

  const normalized: ProjectConfig = {
    id: toSlug(partial.id),
    name: partial.name.trim(),
    repositoryPath: normalizeUserPath(partial.repositoryPath),
    githubRepository: normalizeGithubRepository(partial.githubRepository),
    remote: pickText(partial.remote, 'origin'),
    baseBranch: pickText(partial.baseBranch, 'main'),
    branchStrategy: isOneOf(branchStrategy, BRANCH_STRATEGIES) ? branchStrategy : 'per_run',
    worktree: {
      enabled: worktree?.enabled ?? true,
      rootPath: normalizeOptionalPath(worktree?.rootPath),
      reuseWhenSafe: worktree?.reuseWhenSafe ?? true,
    },
    commands: {
      install: pickTextList(commands?.install, []),
      tests: pickTextList(commands?.tests, ['npm test']),
      timeoutSeconds: pickPositiveNumber(commands?.timeoutSeconds, 1800),
    },
    execution: {
      maxAttemptsPerPrompt: pickInteger(execution?.maxAttemptsPerPrompt, 3, 1),
      maxReviewerRetries: pickInteger(execution?.maxReviewerRetries, 2, 0),
      continueAfterApproval: execution?.continueAfterApproval ?? true,
      stopOnBlocked: execution?.stopOnBlocked ?? true,
      // Projetos cadastrados antes do Loop Guard não têm esta seção: a
      // normalização preenche com os padrões seguros, sem quebrar o cadastro.
      loopGuard: normalizeLoopGuardConfig(execution?.loopGuard),
    },
    git: {
      commitAfterApproval: git?.commitAfterApproval ?? true,
      pushAfterRun: git?.pushAfterRun ?? true,
      commitMessagePrefix: pickText(git?.commitMessagePrefix, 'orqpeg:'),
    },
    pullRequest: {
      enabled: pullRequest?.enabled ?? true,
      draftDuringExecution: pullRequest?.draftDuringExecution ?? true,
      markReadyBeforeMerge: pullRequest?.markReadyBeforeMerge ?? true,
      waitForChecks: pullRequest?.waitForChecks ?? true,
    },
    merge: {
      enabled: merge?.enabled ?? true,
      mode: isOneOf(mergeMode, MERGE_MODES) ? mergeMode : 'dual_ai_consensus',
      strategy: isOneOf(mergeStrategy, MERGE_STRATEGIES) ? mergeStrategy : 'squash',
      deleteBranchAfterMerge: merge?.deleteBranchAfterMerge ?? false,
      requireClaudeApproval: merge?.requireClaudeApproval ?? true,
      requireCodexApproval: merge?.requireCodexApproval ?? true,
      requireLocalTests: merge?.requireLocalTests ?? true,
      requireCiSuccess: merge?.requireCiSuccess ?? true,
      requireNoConflicts: merge?.requireNoConflicts ?? true,
      requireNoUnresolvedThreads: merge?.requireNoUnresolvedThreads ?? true,
      invalidateApprovalOnHeadChange: merge?.invalidateApprovalOnHeadChange ?? true,
      minimumConfidence: pickConfidence(merge?.minimumConfidence, 0.9),
    },
    agents: {
      claudeModel: pickOptionalText(agents?.claudeModel),
      codexModel: pickOptionalText(agents?.codexModel),
    },
    editor: pickOptionalText(partial.editor),
  };

  if (typeof partial.createdAt === 'string' && partial.createdAt.trim().length > 0) {
    normalized.createdAt = partial.createdAt;
  }
  if (typeof partial.updatedAt === 'string' && partial.updatedAt.trim().length > 0) {
    normalized.updatedAt = partial.updatedAt;
  }
  return normalized;
}

/** Aceita `owner/repo`, `https://github.com/owner/repo(.git)` e `git@github.com:owner/repo.git`. */
function normalizeGithubRepository(value: string): string {
  const trimmed = value.trim().replace(/^"+|"+$/g, '');
  const fromUrl = /github\.com[:/]+(.+)$/i.exec(trimmed);
  const candidate = (fromUrl?.[1] ?? trimmed)
    .trim()
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
  return candidate.toLowerCase().endsWith('.git') ? candidate.slice(0, -4) : candidate;
}

/** Normaliza um caminho absoluto; caminhos relativos são preservados para que a validação os rejeite. */
function normalizeUserPath(value: string): string {
  const trimmed = value.trim().replace(/^"+|"+$/g, '');
  return path.isAbsolute(trimmed) ? path.resolve(trimmed) : trimmed;
}

function normalizeOptionalPath(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : normalizeUserPath(trimmed);
}

function pickText(value: string | undefined, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

function pickOptionalText(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function pickTextList(value: string[] | undefined, fallback: string[]): string[] {
  if (!Array.isArray(value)) return [...fallback];
  const items = value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return items.length > 0 ? items : [...fallback];
}

function pickPositiveNumber(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function pickInteger(value: number | undefined, fallback: number, minimum: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= minimum
    ? value
    : fallback;
}

function pickConfidence(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : fallback;
}

/* ------------------------------------------------------------------------- */
/* Utilitários internos                                                       */
/* ------------------------------------------------------------------------- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value);
}

function collectBooleans(
  source: Record<string, unknown>,
  prefix: string,
  keys: readonly string[],
): string[] {
  const issues: string[] = [];
  for (const key of keys) {
    if (typeof source[key] !== 'boolean') {
      issues.push(`${prefix}.${key}: deve ser booleano (true ou false).`);
    }
  }
  return issues;
}
