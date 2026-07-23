import * as path from 'node:path';
import * as fs from 'node:fs';

/**
 * Resolução de caminhos do OrqPEG.
 *
 * A raiz de instalação é derivada da localização do código compilado
 * (`dist/utils/paths.js` → `<raiz>`), com sobrescrita explícita por
 * `ORQPEG_HOME` para permitir testes isolados.
 */

let cachedRoot: string | null = null;

export function orqpegRoot(): string {
  if (cachedRoot) return cachedRoot;
  const override = process.env['ORQPEG_HOME'];
  if (override && override.trim().length > 0) {
    cachedRoot = path.resolve(override.trim());
    return cachedRoot;
  }
  // __dirname aponta para <raiz>/dist/utils em produção e <raiz>/src/utils sob ts-node.
  cachedRoot = path.resolve(__dirname, '..', '..');
  return cachedRoot;
}

/** Apenas para testes: redefine a raiz e limpa o cache. */
export function setOrqpegRootForTesting(root: string | null): void {
  cachedRoot = root === null ? null : path.resolve(root);
}

export const ORQPEG_DIRS = {
  config: (): string => path.join(orqpegRoot(), 'config'),
  data: (): string => path.join(orqpegRoot(), 'data'),
  projects: (): string => path.join(orqpegRoot(), 'data', 'projects'),
  state: (): string => path.join(orqpegRoot(), 'data', 'state'),
  locks: (): string => path.join(orqpegRoot(), 'data', 'locks'),
  logs: (): string => path.join(orqpegRoot(), 'data', 'logs'),
  reviews: (): string => path.join(orqpegRoot(), 'data', 'reviews'),
  reports: (): string => path.join(orqpegRoot(), 'data', 'reports'),
  artifacts: (): string => path.join(orqpegRoot(), 'data', 'artifacts'),
  worktrees: (): string => path.join(orqpegRoot(), 'data', 'worktrees'),
  schemas: (): string => path.join(orqpegRoot(), 'schemas'),
  templates: (): string => path.join(orqpegRoot(), 'templates'),
  publicDir: (): string => path.join(orqpegRoot(), 'public'),
} as const;

export function projectDir(projectId: string): string {
  return path.join(ORQPEG_DIRS.projects(), projectId);
}

export function projectConfigPath(projectId: string): string {
  return path.join(projectDir(projectId), 'project.json');
}

export function projectPromptsDir(projectId: string): string {
  return path.join(projectDir(projectId), 'prompts');
}

export function projectStateDir(projectId: string): string {
  return path.join(projectDir(projectId), 'state');
}

export function projectLogsDir(projectId: string): string {
  return path.join(projectDir(projectId), 'logs');
}

export function projectReviewsDir(projectId: string): string {
  return path.join(projectDir(projectId), 'reviews');
}

export function projectReportsDir(projectId: string): string {
  return path.join(projectDir(projectId), 'reports');
}

export function projectArtifactsDir(projectId: string): string {
  return path.join(projectDir(projectId), 'artifacts');
}

export function runStatePath(projectId: string, runId: string): string {
  return path.join(projectStateDir(projectId), `${runId}.json`);
}

export function attemptArtifactDir(
  projectId: string,
  runId: string,
  promptId: string,
  attempt: number,
): string {
  return path.join(
    projectArtifactsDir(projectId),
    runId,
    promptId,
    `attempt-${String(attempt)}`,
  );
}

export function mergeAuditArtifactDir(
  projectId: string,
  runId: string,
  auditor: 'claude' | 'codex',
  headSha: string,
): string {
  return path.join(
    projectArtifactsDir(projectId),
    runId,
    'merge-audit',
    `${auditor}-${headSha.slice(0, 12)}`,
  );
}

/** Cria o diretório (recursivo) e devolve o caminho. Idempotente. */
export function ensureDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Cria toda a estrutura `data/` esperada pelo produto. */
export function ensureDataLayout(): void {
  ensureDir(ORQPEG_DIRS.config());
  for (const make of [
    ORQPEG_DIRS.projects,
    ORQPEG_DIRS.state,
    ORQPEG_DIRS.locks,
    ORQPEG_DIRS.logs,
    ORQPEG_DIRS.reviews,
    ORQPEG_DIRS.reports,
    ORQPEG_DIRS.artifacts,
    ORQPEG_DIRS.worktrees,
  ]) {
    ensureDir(make());
  }
}

/** Normaliza um caminho do Windows para comparação (case-insensitive, sem barra final). */
export function normalizeForCompare(target: string): string {
  const resolved = path.resolve(target);
  const trimmed = resolved.length > 3 ? resolved.replace(/[\\/]+$/, '') : resolved;
  return process.platform === 'win32' ? trimmed.toLowerCase() : trimmed;
}

/** Verdadeiro quando `child` está dentro de `parent` (ou é o próprio `parent`). */
export function isInside(parent: string, child: string): boolean {
  const normalizedParent = normalizeForCompare(parent);
  const normalizedChild = normalizeForCompare(child);
  if (normalizedParent === normalizedChild) return true;
  const relative = path.relative(normalizedParent, normalizedChild);
  return (
    relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative)
  );
}
