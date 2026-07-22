import * as path from 'node:path';
import type { ProjectConfig, RunRecord } from '../types';
import { readTextSync } from '../utils/fs-atomic';
import { ORQPEG_DIRS } from '../utils/paths';
import { formatDuration, nowIso } from '../utils/time';
import { gateStatusLabel, promptStatusLabel } from '../reports/report-generator';

/**
 * Renderização do corpo da pull request a partir de `templates/PULL-REQUEST.md`.
 * Quando o template não estiver disponível, um corpo equivalente e completo é
 * gerado em código — nunca um texto vazio.
 */

export interface PullRequestBodyInput {
  project: ProjectConfig;
  run: RunRecord;
}

export function renderPullRequestBody(input: PullRequestBodyInput): string {
  const template = readTextSync(path.join(ORQPEG_DIRS.templates(), 'PULL-REQUEST.md'));
  const values = buildValues(input);

  if (template.ok && template.value.trim().length > 0) {
    return applyPlaceholders(template.value, values);
  }
  return buildFallbackBody(values);
}

function buildValues(input: PullRequestBodyInput): Record<string, string> {
  const { project, run } = input;
  return {
    PROJECT_NAME: project.name,
    PROJECT_ID: project.id,
    RUN_ID: run.runId,
    BRANCH: run.branchName ?? '—',
    BASE_BRANCH: project.baseBranch,
    REPOSITORY: project.githubRepository,
    PROMPT_TABLE: renderPromptTable(run),
    TEST_SUMMARY: renderTestSummary(run),
    COMMIT_LIST: renderCommitList(run),
    GATE_STATUS: renderGateStatus(run),
    GENERATED_AT: nowIso(),
  };
}

export function applyPlaceholders(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{([A-Z0-9_]+)\}\}/g, (match, key: string) => {
    const value = values[key];
    return value === undefined ? match : value;
  });
}

function renderPromptTable(run: RunRecord): string {
  if (run.prompts.length === 0) return '_Nenhum prompt._';
  const lines = ['| Prompt | Status | Tentativas | Commit |', '| --- | --- | --- | --- |'];
  for (const prompt of run.prompts) {
    lines.push(
      `| \`${prompt.promptId}\` | ${promptStatusLabel(prompt.status)} | ${prompt.attempts} | ${
        prompt.commitSha ? `\`${prompt.commitSha.slice(0, 12)}\`` : '—'
      } |`,
    );
  }
  return lines.join('\n');
}

function renderTestSummary(run: RunRecord): string {
  const tests = run.finalTests;
  if (!tests) return '_Suíte completa ainda não executada._';
  const lines = [
    `Status agregado: **${tests.status}** — duração ${formatDuration(tests.durationMs)}`,
    '',
    '| Comando | Status | Código |',
    '| --- | --- | --- |',
  ];
  for (const command of tests.commands) {
    lines.push(`| \`${command.command}\` | ${command.status} | ${command.exitCode ?? '—'} |`);
  }
  return lines.join('\n');
}

function renderCommitList(run: RunRecord): string {
  if (run.commits.length === 0) return '_Nenhum commit._';
  return run.commits
    .map((commit) => `- \`${commit.sha.slice(0, 12)}\` — ${commit.message}`)
    .join('\n');
}

function renderGateStatus(run: RunRecord): string {
  const report = run.gateReport;
  if (!report) {
    return '_Gates ainda não avaliados. O merge só ocorre quando os 20 gates passarem e as duas auditorias aprovarem o mesmo head SHA._';
  }
  const lines = [
    `Head SHA avaliado: \`${report.headSha}\` — todos aprovados: **${report.allPassed ? 'SIM' : 'NÃO'}**`,
    '',
    '| # | Gate | Status |',
    '| --- | --- | --- |',
  ];
  for (const gate of report.gates) {
    lines.push(`| ${gate.index} | ${gate.title} | ${gateStatusLabel(gate.status)} |`);
  }
  return lines.join('\n');
}

function buildFallbackBody(values: Record<string, string>): string {
  return [
    `## Resumo`,
    '',
    `Execução automatizada do OrqPEG para o projeto **${values['PROJECT_NAME'] ?? ''}**.`,
    '',
    `- **Execução:** \`${values['RUN_ID'] ?? ''}\``,
    `- **Branch:** \`${values['BRANCH'] ?? ''}\` → \`${values['BASE_BRANCH'] ?? ''}\``,
    `- **Repositório:** \`${values['REPOSITORY'] ?? ''}\``,
    '',
    '## Prompts executados',
    '',
    values['PROMPT_TABLE'] ?? '',
    '',
    '## Testes',
    '',
    values['TEST_SUMMARY'] ?? '',
    '',
    '## Commits',
    '',
    values['COMMIT_LIST'] ?? '',
    '',
    '## Gates de merge',
    '',
    values['GATE_STATUS'] ?? '',
    '',
    '---',
    '',
    'Esta PR só será mergeada automaticamente quando **Claude e Codex** aprovarem de forma independente **exatamente o mesmo head SHA**, todos os testes locais e checks obrigatórios passarem, e os 20 gates do OrqPEG forem satisfeitos.',
    '',
    `_Gerado pelo OrqPEG em ${values['GENERATED_AT'] ?? ''}._`,
    '',
  ].join('\n');
}
