import * as path from 'node:path';
import type { GlobalConfig, ProjectConfig, Result } from '../types';
import { ok } from '../utils/errors';
import { inspectApiEnvironment } from '../security/api-guard';
import { buildRunBranchName } from '../security/branch-name';
import { getProject } from '../projects/project-store';
import { discoverPrompts } from '../prompts/prompt-store';
import { defaultWorktreePath } from '../git/worktree';
import { GATE_DEFINITIONS } from '../merge/gates';
import { describeLoopGuardPolicy } from './loop-guard-config';
import { compactStamp } from '../utils/time';

/**
 * Dry-run: valida tudo e mostra exatamente o que seria feito, sem efeito algum.
 *
 * Garantias do dry-run — nenhuma destas ações ocorre:
 * chamar Claude, chamar Codex, editar arquivo, criar branch, criar worktree,
 * fazer commit, fazer push, criar PR, executar merge.
 */

export interface DryRunPlan {
  project: ProjectConfig;
  promptCount: number;
  prompts: Array<{ id: string; name: string; fileName: string; order: number }>;
  branchName: string;
  worktreePath: string | null;
  workingDirectory: string;
  installCommands: string[];
  testCommands: string[];
  gitPolicy: string[];
  pullRequestPolicy: string[];
  mergePolicy: string[];
  loopGuardPolicy: Array<[string, string]>;
  gates: Array<{ index: number; id: string; title: string }>;
  apiGuard: { presentKeys: string[]; warnKeys: string[]; blocked: boolean };
  warnings: string[];
}

export function buildDryRunPlan(
  projectId: string,
  config: GlobalConfig,
): Result<DryRunPlan> {
  const projectResult = getProject(projectId);
  if (!projectResult.ok) return projectResult;
  const project = projectResult.value;

  const promptsResult = discoverPrompts(project.id);
  if (!promptsResult.ok) return promptsResult;
  const prompts = promptsResult.value;

  const stamp = compactStamp();
  const branchResult = buildRunBranchName(project.id, stamp);
  if (!branchResult.ok) return branchResult;

  const worktreePath = project.worktree.enabled
    ? defaultWorktreePath(
        project.worktree.rootPath ?? path.join(project.repositoryPath, '..', 'AI-Worktrees'),
        project.id,
        `run-${stamp}`,
      )
    : null;

  const guard = inspectApiEnvironment({ config });
  const warnings: string[] = [];

  if (prompts.length === 0) {
    warnings.push(
      `Nenhum prompt encontrado em data/projects/${project.id}/prompts. Adicione arquivos .md antes de executar.`,
    );
  }
  if (guard.blocked) {
    warnings.push(
      `Variáveis de API presentes (${guard.presentKeys.join(', ')}): a execução real seria bloqueada.`,
    );
  }
  if (guard.warnKeys.length > 0) {
    warnings.push(`Variáveis de roteamento ativas: ${guard.warnKeys.join(', ')}.`);
  }
  if (project.merge.mode !== 'dual_ai_consensus') {
    warnings.push(
      `Modo de merge "${project.merge.mode}": o merge automático por consenso das duas IAs não será executado.`,
    );
  }

  return ok({
    project,
    promptCount: prompts.length,
    prompts: prompts.map((p) => ({
      id: p.id,
      name: p.name,
      fileName: p.fileName,
      order: p.order,
    })),
    branchName: branchResult.value,
    worktreePath,
    workingDirectory: worktreePath ?? project.repositoryPath,
    installCommands: project.commands.install,
    testCommands: project.commands.tests,
    gitPolicy: [
      `commit após aprovação: ${yesNo(project.git.commitAfterApproval)}`,
      `push ao final: ${yesNo(project.git.pushAfterRun)}`,
      `prefixo de commit: "${project.git.commitMessagePrefix}"`,
      'force push: PROIBIDO por design',
      'reset --hard / git clean: PROIBIDOS por design',
    ],
    pullRequestPolicy: [
      `PR habilitada: ${yesNo(project.pullRequest.enabled)}`,
      `criar como draft: ${yesNo(project.pullRequest.draftDuringExecution)}`,
      `marcar pronta antes do merge: ${yesNo(project.pullRequest.markReadyBeforeMerge)}`,
      `aguardar checks: ${yesNo(project.pullRequest.waitForChecks)}`,
    ],
    mergePolicy: [
      `merge habilitado: ${yesNo(project.merge.enabled)}`,
      `modo: ${project.merge.mode}`,
      `estratégia: ${project.merge.strategy}`,
      `exige aprovação do Claude: ${yesNo(project.merge.requireClaudeApproval)}`,
      `exige aprovação do Codex: ${yesNo(project.merge.requireCodexApproval)}`,
      `confiança mínima: ${project.merge.minimumConfidence}`,
      `invalidar aprovação se o head SHA mudar: ${yesNo(project.merge.invalidateApprovalOnHeadChange)}`,
      `apagar branch após merge: ${yesNo(project.merge.deleteBranchAfterMerge)}`,
    ],
    loopGuardPolicy: describeLoopGuardPolicy(project.execution.loopGuard),
    gates: GATE_DEFINITIONS.map((gate) => ({
      index: gate.index,
      id: gate.id,
      title: gate.title,
    })),
    apiGuard: {
      presentKeys: guard.presentKeys,
      warnKeys: guard.warnKeys,
      blocked: guard.blocked,
    },
    warnings,
  });
}

export function renderDryRunPlan(plan: DryRunPlan): string {
  const lines: string[] = [];
  const rule = '─'.repeat(72);

  lines.push(rule);
  lines.push(`  DRY-RUN — ${plan.project.name} (${plan.project.id})`);
  lines.push(rule);
  lines.push('');
  lines.push('  Nada será alterado: nenhuma IA é chamada, nenhum arquivo é editado,');
  lines.push('  nenhum commit, push, PR ou merge é executado.');
  lines.push('');

  lines.push('  DESTINO');
  lines.push(`    Repositório local : ${plan.project.repositoryPath}`);
  lines.push(`    Repositório GitHub: ${plan.project.githubRepository}`);
  lines.push(`    Remoto            : ${plan.project.remote}`);
  lines.push(`    Branch base       : ${plan.project.baseBranch}`);
  lines.push(`    Branch da execução: ${plan.branchName}`);
  lines.push(`    Worktree          : ${plan.worktreePath ?? '(desabilitado)'}`);
  lines.push(`    Diretório de trabalho: ${plan.workingDirectory}`);
  lines.push('');

  lines.push(`  PROMPTS (${plan.promptCount})`);
  if (plan.prompts.length === 0) {
    lines.push('    (nenhum prompt encontrado)');
  } else {
    for (const prompt of plan.prompts) {
      lines.push(`    ${String(prompt.order).padStart(4, ' ')}  ${prompt.fileName}`);
    }
  }
  lines.push('');

  lines.push('  COMANDOS DE TESTE (executados pelo OrqPEG, não pelas IAs)');
  for (const command of plan.testCommands) lines.push(`    $ ${command}`);
  if (plan.installCommands.length > 0) {
    lines.push('  COMANDOS DE INSTALAÇÃO');
    for (const command of plan.installCommands) lines.push(`    $ ${command}`);
  }
  lines.push('');

  lines.push('  POLÍTICA GIT');
  for (const item of plan.gitPolicy) lines.push(`    · ${item}`);
  lines.push('');
  lines.push('  POLÍTICA DE PULL REQUEST');
  for (const item of plan.pullRequestPolicy) lines.push(`    · ${item}`);
  lines.push('');
  lines.push('  POLÍTICA DE MERGE');
  for (const item of plan.mergePolicy) lines.push(`    · ${item}`);
  lines.push('');

  lines.push('  POLÍTICA ANTI-LOOP');
  for (const [label, value] of plan.loopGuardPolicy) {
    lines.push(`    ${label.padEnd(30, ' ')} ${value}`);
  }
  lines.push('');

  lines.push('  GATES OBRIGATÓRIOS DO MERGE');
  for (const gate of plan.gates) {
    lines.push(`    ${String(gate.index).padStart(2, ' ')}. ${gate.title}`);
  }
  lines.push('');

  lines.push('  AMBIENTE');
  lines.push(
    `    Variáveis de API detectadas: ${
      plan.apiGuard.presentKeys.length === 0 ? 'nenhuma' : plan.apiGuard.presentKeys.join(', ')
    }`,
  );
  lines.push(
    `    Variáveis de roteamento    : ${
      plan.apiGuard.warnKeys.length === 0 ? 'nenhuma' : plan.apiGuard.warnKeys.join(', ')
    }`,
  );
  lines.push('');

  if (plan.warnings.length > 0) {
    lines.push('  AVISOS');
    for (const warning of plan.warnings) lines.push(`    ! ${warning}`);
    lines.push('');
  }

  lines.push(rule);
  return lines.join('\n');
}

function yesNo(value: boolean): string {
  return value ? 'sim' : 'não';
}
