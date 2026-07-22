import type {
  LoopGuardDecision,
  LoopGuardNextAction,
  ProjectConfig,
  PromptBudget,
  RunRecord,
} from '../types';
import { formatDuration, nowIso } from '../utils/time';

/**
 * Relatório legível de uma parada do Loop Guard.
 *
 * O objetivo é responder, sem que ninguém precise abrir log: o que parou, por
 * quê, quanto de orçamento foi consumido, qual evidência sustenta a decisão, o
 * que foi preservado e quais caminhos existem a partir daqui.
 */

export interface LoopGuardReportInput {
  project: ProjectConfig;
  run: RunRecord;
  promptId: string;
  decision: LoopGuardDecision;
  budget: PromptBudget;
}

const ACTION_LABEL: Record<LoopGuardNextAction, string> = {
  OPEN_REPORT: 'Abrir o relatório completo da tentativa',
  OPEN_DIFF: 'Inspecionar o diff produzido',
  OPEN_TESTS: 'Inspecionar a saída dos testes',
  OPEN_REVIEW: 'Ler a revisão do Codex',
  EDIT_PROMPT: 'Editar o prompt e iniciar uma nova execução',
  AUTHORIZE_EXTRA_ATTEMPT: 'Autorizar uma única tentativa adicional',
  MARK_FOR_MANUAL_REVIEW: 'Marcar para revisão manual',
  SKIP_PROMPT: 'Pular este prompt (respeitando dependências)',
  CANCEL_RUN: 'Cancelar a execução preservando o trabalho',
  FIX_AUTH: 'Refazer o login do CLI e retomar',
  WAIT_QUOTA: 'Aguardar a renovação da cota da assinatura',
  INSTALL_TOOL: 'Instalar a ferramenta ausente e rodar o diagnóstico',
  SPLIT_PROMPT: 'Dividir a entrega em prompts menores',
  START_NEW_RUN: 'Iniciar uma nova execução com o material atualizado',
};

export function renderLoopGuardReport(input: LoopGuardReportInput): string {
  const { decision, budget, project, run, promptId } = input;
  const lines: string[] = [];

  lines.push('# Proteção contra looping');
  lines.push('');
  lines.push(
    'Este documento registra uma parada deliberada do OrqPEG. Não houve falha ' +
      'inesperada: o sistema detectou que continuar automaticamente consumiria ' +
      'assinatura sem produzir progresso, e preservou tudo para decisão humana.',
  );
  lines.push('');

  /* --- Resultado ------------------------------------------------------- */
  lines.push('## Resultado');
  lines.push('');
  lines.push(...pairs([
    ['Gatilho', decision.trigger ?? '(nenhum)'],
    ['Severidade', severityLabel(decision.severity)],
    ['Projeto', `${project.name} (${project.id})`],
    ['Execução', run.runId],
    ['Prompt', promptId],
    ['Tentativas realizadas', String(budget.attempts)],
    ['Data', nowIso()],
  ]));
  lines.push('');

  /* --- Orçamento ------------------------------------------------------- */
  const loop = project.execution.loopGuard;
  lines.push('## Orçamento consumido');
  lines.push('');
  lines.push('| Recurso | Consumido | Limite |');
  lines.push('| --- | --- | --- |');
  lines.push(`| Tentativas | ${budget.attempts} | ${project.execution.maxAttemptsPerPrompt} |`);
  lines.push(`| Chamadas do Claude | ${budget.claudeCalls} | ${loop.maxClaudeCallsPerPrompt} |`);
  lines.push(`| Chamadas do Codex | ${budget.codexCalls} | ${loop.maxCodexCallsPerPrompt} |`);
  lines.push(
    `| Total de chamadas de IA | ${budget.claudeCalls + budget.codexCalls} | ${loop.maxTotalAgentCallsPerPrompt} |`,
  );
  lines.push(
    `| Tempo do prompt | ${formatDuration(budget.consumedMs)} | ${loop.maxPromptDurationMinutes} min |`,
  );
  lines.push(
    `| Retentativas de formato | ${budget.reviewFormatRetries} | ${loop.maxReviewFormatRetries} |`,
  );
  lines.push(
    `| Overrides manuais | ${budget.manualOverridesUsed} | ${loop.maxManualOverridesPerPrompt} |`,
  );
  lines.push('');

  /* --- Motivo ---------------------------------------------------------- */
  lines.push('## Motivo da interrupção');
  lines.push('');
  lines.push(decision.reason);
  lines.push('');

  /* --- Evidências ------------------------------------------------------ */
  lines.push('## Evidências');
  lines.push('');
  lines.push(...fingerprintList('Assinaturas de diff', budget.diffFingerprints));
  lines.push(...fingerprintList('Assinaturas de revisão', budget.reviewFingerprints));
  lines.push(...fingerprintList('Assinaturas de falha de teste', budget.testFailureFingerprints));
  lines.push('');
  lines.push('Dados que embasaram a decisão:');
  lines.push('');
  lines.push('```json');
  lines.push(JSON.stringify(decision.evidence, null, 2));
  lines.push('```');
  lines.push('');

  /* --- Preservação ----------------------------------------------------- */
  lines.push('## Alterações preservadas');
  lines.push('');
  lines.push(
    'Nada foi desfeito. O OrqPEG não executa `reset --hard`, `git clean` nem ' +
      'remove worktree com trabalho pendente.',
  );
  lines.push('');
  lines.push(...pairs([
    ['Branch', run.branchName ?? '(não criada)'],
    ['Worktree', run.worktreePath ?? '(não utilizado)'],
    ['Diretório de trabalho', run.workingDirectory ?? '(não definido)'],
    ['Commit base', run.baseCommitSha ?? '(não registrado)'],
  ]));
  lines.push('');

  /* --- Próximas ações -------------------------------------------------- */
  lines.push('## Próximas ações possíveis');
  lines.push('');
  if (decision.nextActions.length === 0) {
    lines.push('- Nenhuma ação automática disponível; avalie manualmente.');
  } else {
    for (const action of decision.nextActions) {
      lines.push(`- ${ACTION_LABEL[action] ?? action}`);
    }
  }
  lines.push('');

  if (decision.severity === 'hard_stop') {
    lines.push(
      '> Esta é uma parada dura: não existe botão de "continuar". A causa precisa ' +
        'ser corrigida fora do laço antes de qualquer nova execução.',
    );
  } else {
    lines.push(
      '> Esta é uma parada branda: uma única tentativa adicional pode ser autorizada ' +
        'explicitamente por uma pessoa, com justificativa registrada. A autorização ' +
        'não é reutilizável e não altera os limites configurados.',
    );
  }
  lines.push('');

  return lines.join('\n');
}

function severityLabel(severity: LoopGuardDecision['severity']): string {
  switch (severity) {
    case 'hard_stop':
      return 'parada dura (hard stop)';
    case 'soft_stop':
      return 'parada branda (soft stop)';
    default:
      return 'nenhuma';
  }
}

function pairs(entries: ReadonlyArray<readonly [string, string]>): string[] {
  return entries.map(([label, value]) => `- **${label}:** ${value}`);
}

function fingerprintList(title: string, values: readonly string[]): string[] {
  if (values.length === 0) return [`- **${title}:** (nenhuma registrada)`];
  const marked = values.map((value, index) => {
    const repeated = values.indexOf(value) !== index;
    return `\`${value}\`${repeated ? ' ← repetida' : ''}`;
  });
  return [`- **${title}:** ${marked.join(' → ')}`];
}
