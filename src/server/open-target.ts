import type { Result } from '../types';
import { fail, ok } from '../utils/errors';
import { getProject } from '../projects/project-store';
import { loadRun } from '../state/run-state';
import { projectLogsDir } from '../utils/paths';
import { directoryExists } from '../utils/fs-atomic';
import { validateIdentifier } from '../security/path-guard';
import { runProcess } from '../agents/process-runner';

/**
 * Abertura de pastas, editor e URLs a partir do painel.
 *
 * Restrições de segurança:
 *  - o alvo é escolhido por um enum fechado, nunca por caminho arbitrário
 *    vindo do navegador;
 *  - o caminho é derivado do cadastro do projeto no servidor;
 *  - URLs só são abertas quando começam com `https://github.com/`;
 *  - os argumentos são vetorizados (sem shell), impedindo injeção.
 */

export type OpenTargetKind = 'repo' | 'worktree' | 'editor' | 'pr' | 'logs';

export interface OpenTargetInput {
  target: string;
  projectId: string;
  runId?: string;
}

const VALID_TARGETS: ReadonlySet<string> = new Set<OpenTargetKind>([
  'repo',
  'worktree',
  'editor',
  'pr',
  'logs',
]);

export async function openTarget(input: OpenTargetInput): Promise<Result<void>> {
  if (!VALID_TARGETS.has(input.target)) {
    return fail('VALIDATION_FAILED', `Alvo inválido: ${input.target}`);
  }

  const projectId = validateIdentifier(input.projectId, 'projeto');
  if (!projectId.ok) return projectId;

  const project = getProject(projectId.value);
  if (!project.ok) return project;

  if (input.target === 'pr') {
    const runId = input.runId;
    if (!runId) return fail('VALIDATION_FAILED', 'runId é obrigatório para abrir a PR.');
    const validRunId = validateIdentifier(runId, 'execução');
    if (!validRunId.ok) return validRunId;

    const run = loadRun(projectId.value, validRunId.value);
    if (!run.ok) return run;
    const url = run.value.pullRequest?.url;
    if (!url) return fail('VALIDATION_FAILED', 'Esta execução ainda não possui pull request.');
    if (!url.startsWith('https://github.com/')) {
      return fail('VALIDATION_FAILED', 'URL da pull request não é do GitHub.');
    }
    return openWithShell(url);
  }

  let targetPath: string;
  switch (input.target) {
    case 'repo':
      targetPath = project.value.repositoryPath;
      break;
    case 'logs':
      targetPath = projectLogsDir(projectId.value);
      break;
    case 'worktree': {
      const runId = input.runId;
      if (!runId) return fail('VALIDATION_FAILED', 'runId é obrigatório para abrir o worktree.');
      const validRunId = validateIdentifier(runId, 'execução');
      if (!validRunId.ok) return validRunId;
      const run = loadRun(projectId.value, validRunId.value);
      if (!run.ok) return run;
      const worktreePath = run.value.worktreePath;
      if (!worktreePath) {
        return fail('VALIDATION_FAILED', 'Esta execução não utilizou worktree.');
      }
      targetPath = worktreePath;
      break;
    }
    case 'editor':
      targetPath = project.value.repositoryPath;
      break;
    default:
      return fail('VALIDATION_FAILED', `Alvo não suportado: ${input.target}`);
  }

  if (!directoryExists(targetPath)) {
    return fail('IO_FAILED', `Diretório não encontrado: ${targetPath}`);
  }

  if (input.target === 'editor') {
    const editor = project.value.editor;
    if (editor && editor.trim().length > 0) {
      const result = await runProcess(editor, [targetPath], {
        cwd: targetPath,
        timeoutMs: 15_000,
      });
      if (result.status === 'COMMAND_NOT_FOUND') {
        return fail('TOOL_MISSING', `Editor não encontrado: ${editor}`);
      }
      return ok(undefined);
    }
    // Sem editor configurado: abre a pasta no explorador.
  }

  return openWithShell(targetPath);
}

async function openWithShell(target: string): Promise<Result<void>> {
  if (process.platform === 'win32') {
    // `explorer.exe` aceita tanto caminho quanto URL e não interpreta o
    // argumento como opção. Ele retorna código 1 mesmo em sucesso, por isso o
    // exit code não é tratado como erro.
    await runProcess('explorer.exe', [target], { cwd: process.cwd(), timeoutMs: 15_000 });
    return ok(undefined);
  }
  const command = process.platform === 'darwin' ? 'open' : 'xdg-open';
  const result = await runProcess(command, [target], { cwd: process.cwd(), timeoutMs: 15_000 });
  if (result.status === 'COMMAND_NOT_FOUND') {
    return fail('TOOL_MISSING', `Comando "${command}" não encontrado para abrir "${target}".`);
  }
  return ok(undefined);
}
