import * as path from 'node:path';
import type {
  AttemptSummary,
  GateResult,
  MergeGateReport,
  ProjectConfig,
  PromptProgress,
  ReportBundle,
  Result,
  RunRecord,
  TestSuiteResult,
} from '../types';
import { ok } from '../utils/errors';
import { writeArtifactSync } from '../utils/fs-atomic';
import { ensureDir, projectReportsDir } from '../utils/paths';
import { formatDuration, nowIso } from '../utils/time';
import { redactText } from '../utils/redact';

/**
 * Geração de relatórios nos três formatos exigidos: JSON, Markdown e HTML.
 *
 * Todo texto proveniente de execução (saída de IA, log de teste, mensagem de
 * erro) passa por `redactText` e, no HTML, por `escapeHtml`. O HTML é
 * autocontido: sem CDN, sem script externo, abre offline.
 */

/* ------------------------------------------------------------------------- */
/* Escapes                                                                    */
/* ------------------------------------------------------------------------- */

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeMarkdownCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

/* ------------------------------------------------------------------------- */
/* Rótulos                                                                    */
/* ------------------------------------------------------------------------- */

const PROMPT_STATUS_LABEL: Record<string, string> = {
  PENDING: 'PENDENTE',
  RUNNING: 'EXECUTANDO',
  CHANGES_REQUESTED: 'EM CORREÇÃO',
  APPROVED: 'APROVADO',
  BLOCKED: 'BLOQUEADO',
  SKIPPED: 'IGNORADO',
  FAILED: 'FALHOU',
};

const GATE_STATUS_LABEL: Record<string, string> = {
  PASSED: 'APROVADO',
  FAILED: 'REPROVADO',
  SKIPPED: 'DISPENSADO',
  NOT_EVALUATED: 'NÃO AVALIADO',
};

export function promptStatusLabel(status: string): string {
  return PROMPT_STATUS_LABEL[status] ?? status;
}

export function gateStatusLabel(status: string): string {
  return GATE_STATUS_LABEL[status] ?? status;
}

function statusCssClass(status: string): string {
  switch (status) {
    case 'APPROVED':
    case 'PASSED':
    case 'MERGED':
      return 'is-approved';
    case 'RUNNING':
      return 'is-running';
    case 'CHANGES_REQUESTED':
    case 'PENDING':
      return 'is-waiting';
    case 'FAILED':
    case 'BLOCKED':
      return 'is-failed';
    case 'SKIPPED':
    case 'NOT_EVALUATED':
      return 'is-pending';
    default:
      return 'is-pending';
  }
}

/* ------------------------------------------------------------------------- */
/* Relatório de execução                                                      */
/* ------------------------------------------------------------------------- */

export interface RunReportInput {
  project: ProjectConfig;
  run: RunRecord;
  attempts?: AttemptSummary[];
}

export function buildRunReport(input: RunReportInput): ReportBundle {
  return {
    json: buildRunJson(input),
    markdown: buildRunMarkdown(input),
    html: buildRunHtml(input),
  };
}

function buildRunJson(input: RunReportInput): string {
  const { project, run, attempts } = input;
  const payload = {
    generatedAt: nowIso(),
    product: 'OrqPEG',
    project: {
      id: project.id,
      name: project.name,
      repositoryPath: project.repositoryPath,
      githubRepository: project.githubRepository,
      baseBranch: project.baseBranch,
    },
    run: {
      runId: run.runId,
      state: run.state,
      dryRun: run.dryRun,
      createdAt: run.createdAt,
      finishedAt: run.finishedAt,
      branchName: run.branchName,
      worktreePath: run.worktreePath,
      baseCommitSha: run.baseCommitSha,
      prompts: run.prompts,
      commits: run.commits,
      pullRequest: run.pullRequest,
      checks: run.checks,
      finalTests: run.finalTests,
      mergeReviews: run.mergeReviews,
      consensus: run.consensus,
      gateReport: run.gateReport,
      mergeOutcome: run.mergeOutcome,
      lastError: run.lastError,
    },
    attempts: attempts ?? [],
  };
  return `${JSON.stringify(payload, null, 2)}\n`;
}

function buildRunMarkdown(input: RunReportInput): string {
  const { project, run } = input;
  const lines: string[] = [];

  lines.push(`# Relatório de execução — ${project.name}`);
  lines.push('');
  lines.push(`- **Execução:** \`${run.runId}\``);
  lines.push(`- **Estado:** ${run.state}`);
  lines.push(`- **Modo:** ${run.dryRun ? 'dry-run (nenhuma alteração real)' : 'execução real'}`);
  lines.push(`- **Repositório local:** \`${project.repositoryPath}\``);
  lines.push(`- **Repositório GitHub:** \`${project.githubRepository}\``);
  lines.push(`- **Branch base:** \`${project.baseBranch}\``);
  lines.push(`- **Branch da execução:** \`${run.branchName ?? '—'}\``);
  lines.push(`- **Worktree:** \`${run.worktreePath ?? '—'}\``);
  lines.push(`- **Commit base:** \`${run.baseCommitSha ?? '—'}\``);
  lines.push(`- **Início:** ${run.createdAt}`);
  lines.push(`- **Fim:** ${run.finishedAt ?? '—'}`);
  lines.push('');

  lines.push('## Prompts');
  lines.push('');
  lines.push('| Prompt | Status | Tentativas | Commit |');
  lines.push('| --- | --- | --- | --- |');
  for (const prompt of run.prompts) {
    lines.push(
      `| ${escapeMarkdownCell(prompt.promptId)} | ${promptStatusLabel(prompt.status)} | ${prompt.attempts} | ${prompt.commitSha ? `\`${prompt.commitSha.slice(0, 12)}\`` : '—'} |`,
    );
  }
  lines.push('');

  if (run.finalTests) {
    lines.push('## Testes finais');
    lines.push('');
    lines.push(renderTestsMarkdown(run.finalTests));
    lines.push('');
  }

  lines.push('## Commits');
  lines.push('');
  if (run.commits.length === 0) {
    lines.push('_Nenhum commit criado._');
  } else {
    for (const commit of run.commits) {
      lines.push(`- \`${commit.sha.slice(0, 12)}\` — ${escapeMarkdownCell(commit.message)}`);
    }
  }
  lines.push('');

  lines.push('## Pull request e CI');
  lines.push('');
  if (run.pullRequest) {
    lines.push(`- **PR:** #${run.pullRequest.number} — ${run.pullRequest.url}`);
    lines.push(`- **Estado:** ${run.pullRequest.state}${run.pullRequest.isDraft ? ' (draft)' : ''}`);
    lines.push(`- **Base:** \`${run.pullRequest.baseRefName}\` ← \`${run.pullRequest.headRefName}\``);
    lines.push(`- **Head SHA:** \`${run.pullRequest.headSha}\``);
    lines.push(`- **Mergeable:** ${run.pullRequest.mergeable}`);
    lines.push(`- **Threads não resolvidas:** ${describeThreads(run.pullRequest.unresolvedThreadCount)}`);
  } else {
    lines.push('_PR não criada._');
  }
  if (run.checks) {
    lines.push(
      `- **CI:** ${run.checks.passed} aprovados, ${run.checks.failed} falhos, ${run.checks.pending} pendentes de ${run.checks.total}`,
    );
  }
  lines.push('');

  lines.push('## Auditoria final e consenso');
  lines.push('');
  if (run.mergeReviews.length === 0) {
    lines.push('_Nenhuma auditoria final executada._');
  } else {
    lines.push('| Auditor | Veredito | Confiança | SHA revisado | Válida |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const record of run.mergeReviews) {
      lines.push(
        `| ${record.auditor} | ${record.review.verdict} | ${formatConfidence(record.review.confidence)} | \`${record.review.reviewedHeadSha.slice(0, 12)}\` | ${record.invalidated ? `não (${escapeMarkdownCell(record.invalidationReason ?? '')})` : 'sim'} |`,
      );
    }
  }
  lines.push('');
  if (run.consensus) {
    lines.push(`- **Consenso alcançado:** ${run.consensus.reached ? 'SIM' : 'NÃO'}`);
    lines.push(`- **Mesmo head SHA:** ${run.consensus.sameHeadSha ? 'SIM' : 'NÃO'}`);
    if (run.consensus.reasons.length > 0) {
      lines.push('- **Motivos:**');
      for (const reason of run.consensus.reasons) lines.push(`  - ${reason}`);
    }
  }
  lines.push('');

  if (run.gateReport) {
    lines.push('## Gates de merge');
    lines.push('');
    lines.push(renderGatesMarkdown(run.gateReport));
    lines.push('');
  }

  lines.push('## Resultado do merge');
  lines.push('');
  if (run.mergeOutcome) {
    lines.push(`- **Mergeado:** ${run.mergeOutcome.merged ? 'SIM' : 'NÃO'}`);
    lines.push(`- **Estratégia:** ${run.mergeOutcome.strategy}`);
    lines.push(`- **Merge SHA:** \`${run.mergeOutcome.mergeSha ?? '—'}\``);
    lines.push(`- **Head SHA protegido:** \`${run.mergeOutcome.matchedHeadSha ?? '—'}\``);
    lines.push(`- **Momento:** ${run.mergeOutcome.performedAt ?? '—'}`);
    lines.push(`- **Motivo:** ${run.mergeOutcome.reason}`);
  } else {
    lines.push('_Merge não executado._');
  }
  lines.push('');

  if (run.lastError) {
    lines.push('## Último erro');
    lines.push('');
    lines.push('```');
    lines.push(redactText(`[${run.lastError.code}] ${run.lastError.message}`));
    lines.push('```');
    lines.push('');
  }

  lines.push('---');
  lines.push('');
  lines.push(`_Gerado pelo OrqPEG em ${nowIso()}._`);
  lines.push('');

  return lines.join('\n');
}

function renderTestsMarkdown(tests: TestSuiteResult): string {
  const lines: string[] = [];
  lines.push(`**Status agregado:** ${tests.status} — duração ${formatDuration(tests.durationMs)}`);
  lines.push('');
  lines.push('| Comando | Status | Código | Duração |');
  lines.push('| --- | --- | --- | --- |');
  for (const command of tests.commands) {
    lines.push(
      `| \`${escapeMarkdownCell(command.command)}\` | ${command.status} | ${command.exitCode ?? '—'} | ${formatDuration(command.durationMs)} |`,
    );
  }
  return lines.join('\n');
}

function renderGatesMarkdown(report: MergeGateReport): string {
  const lines: string[] = [];
  lines.push(`**Head SHA:** \`${report.headSha}\` — **Todos aprovados:** ${report.allPassed ? 'SIM' : 'NÃO'}`);
  lines.push('');
  lines.push('| # | Gate | Status | Motivo |');
  lines.push('| --- | --- | --- | --- |');
  for (const gate of report.gates) {
    lines.push(
      `| ${gate.index} | ${escapeMarkdownCell(gate.title)} | ${gateStatusLabel(gate.status)} | ${escapeMarkdownCell(gate.reason)} |`,
    );
  }
  return lines.join('\n');
}

function describeThreads(count: number): string {
  if (count < 0) return 'desconhecido';
  return String(count);
}

function formatConfidence(value: number): string {
  return value.toFixed(2).replace('.', ',');
}

/* ------------------------------------------------------------------------- */
/* HTML                                                                       */
/* ------------------------------------------------------------------------- */

function buildRunHtml(input: RunReportInput): string {
  const { project, run } = input;

  const promptRows = run.prompts
    .map(
      (prompt: PromptProgress) => `
        <tr>
          <td><code>${escapeHtml(prompt.promptId)}</code></td>
          <td><span class="badge ${statusCssClass(prompt.status)}">${escapeHtml(promptStatusLabel(prompt.status))}</span></td>
          <td>${prompt.attempts}</td>
          <td>${prompt.commitSha ? `<code>${escapeHtml(prompt.commitSha.slice(0, 12))}</code>` : '—'}</td>
        </tr>`,
    )
    .join('');

  const gateRows = run.gateReport
    ? run.gateReport.gates
        .map(
          (gate: GateResult) => `
        <tr>
          <td>${gate.index}</td>
          <td>${escapeHtml(gate.title)}</td>
          <td><span class="badge ${statusCssClass(gate.status)}">${escapeHtml(gateStatusLabel(gate.status))}</span></td>
          <td>${escapeHtml(gate.reason)}</td>
        </tr>`,
        )
        .join('')
    : '';

  const testRows = run.finalTests
    ? run.finalTests.commands
        .map(
          (command) => `
        <tr>
          <td><code>${escapeHtml(command.command)}</code></td>
          <td><span class="badge ${statusCssClass(command.status)}">${escapeHtml(command.status)}</span></td>
          <td>${command.exitCode ?? '—'}</td>
          <td>${escapeHtml(formatDuration(command.durationMs))}</td>
        </tr>`,
        )
        .join('')
    : '';

  const auditRows = run.mergeReviews
    .map(
      (record) => `
        <tr>
          <td>${escapeHtml(record.auditor)}</td>
          <td><span class="badge ${record.review.verdict === 'APPROVED_FOR_MERGE' ? 'is-approved' : 'is-failed'}">${escapeHtml(record.review.verdict)}</span></td>
          <td>${escapeHtml(formatConfidence(record.review.confidence))}</td>
          <td><code>${escapeHtml(record.review.reviewedHeadSha.slice(0, 12))}</code></td>
          <td>${record.invalidated ? `<span class="badge is-failed">invalidada</span> ${escapeHtml(record.invalidationReason ?? '')}` : '<span class="badge is-approved">válida</span>'}</td>
        </tr>`,
    )
    .join('');

  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>OrqPEG — ${escapeHtml(project.name)} — ${escapeHtml(run.runId)}</title>
<style>
:root{
  --bg:#f6f7f9;--surface:#fff;--border:#d8dce3;--text:#15181d;--muted:#5b6472;
  --status-approved:#1a7f45;--status-running:#1656b8;--status-waiting:#9a6a00;
  --status-failed:#b3261e;--status-pending:#6b7280;--status-audit:#6d3fb5;
}
@media (prefers-color-scheme:dark){
  :root{--bg:#0f1216;--surface:#171b21;--border:#2b3139;--text:#e6e9ee;--muted:#9aa4b2;
  --status-approved:#3ecf7a;--status-running:#5b9bff;--status-waiting:#e0a52a;
  --status-failed:#ff6b60;--status-pending:#8b95a3;--status-audit:#b18aff;}
}
*{box-sizing:border-box}
body{margin:0;padding:2rem 1.25rem;background:var(--bg);color:var(--text);
  font:15px/1.55 "Segoe UI",system-ui,-apple-system,sans-serif}
main{max-width:1100px;margin:0 auto}
h1{font-size:1.6rem;margin:0 0 .35rem}
h2{font-size:1.15rem;margin:2.2rem 0 .75rem;padding-bottom:.4rem;border-bottom:1px solid var(--border)}
.sub{color:var(--muted);margin:0 0 1.5rem}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:.75rem;margin-bottom:1rem}
.card{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:.85rem 1rem}
.card dt{font-size:.75rem;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin:0 0 .3rem}
.card dd{margin:0;font-weight:600;word-break:break-all}
table{width:100%;border-collapse:collapse;background:var(--surface);
  border:1px solid var(--border);border-radius:8px;overflow:hidden}
th,td{padding:.55rem .75rem;text-align:left;border-bottom:1px solid var(--border);vertical-align:top}
th{background:rgba(127,127,127,.08);font-size:.78rem;text-transform:uppercase;letter-spacing:.04em;color:var(--muted)}
tr:last-child td{border-bottom:none}
code{font-family:"Cascadia Mono",Consolas,monospace;font-size:.88em;
  background:rgba(127,127,127,.12);padding:.1rem .35rem;border-radius:4px}
.badge{display:inline-block;padding:.15rem .55rem;border-radius:999px;font-size:.75rem;
  font-weight:700;letter-spacing:.03em;color:#fff}
.is-approved{background:var(--status-approved)}
.is-running{background:var(--status-running)}
.is-waiting{background:var(--status-waiting)}
.is-failed{background:var(--status-failed)}
.is-pending{background:var(--status-pending)}
.is-audit{background:var(--status-audit)}
.empty{color:var(--muted);font-style:italic}
.table-wrap{overflow-x:auto}
footer{margin-top:2.5rem;padding-top:1rem;border-top:1px solid var(--border);color:var(--muted);font-size:.85rem}
</style>
</head>
<body>
<main>
  <h1>Relatório de execução — ${escapeHtml(project.name)}</h1>
  <p class="sub">Execução <code>${escapeHtml(run.runId)}</code> · estado <strong>${escapeHtml(run.state)}</strong>${run.dryRun ? ' · <strong>dry-run</strong>' : ''}</p>

  <div class="grid">
    <dl class="card"><dt>Repositório GitHub</dt><dd>${escapeHtml(project.githubRepository)}</dd></dl>
    <dl class="card"><dt>Branch base</dt><dd>${escapeHtml(project.baseBranch)}</dd></dl>
    <dl class="card"><dt>Branch da execução</dt><dd>${escapeHtml(run.branchName ?? '—')}</dd></dl>
    <dl class="card"><dt>Commit base</dt><dd>${escapeHtml((run.baseCommitSha ?? '—').slice(0, 12))}</dd></dl>
    <dl class="card"><dt>Worktree</dt><dd>${escapeHtml(run.worktreePath ?? '—')}</dd></dl>
    <dl class="card"><dt>Início</dt><dd>${escapeHtml(run.createdAt)}</dd></dl>
  </div>

  <h2>Prompts</h2>
  <div class="table-wrap">
  <table><thead><tr><th scope="col">Prompt</th><th scope="col">Status</th><th scope="col">Tentativas</th><th scope="col">Commit</th></tr></thead>
  <tbody>${promptRows || '<tr><td colspan="4" class="empty">Nenhum prompt.</td></tr>'}</tbody></table>
  </div>

  <h2>Testes finais</h2>
  <div class="table-wrap">
  ${
    run.finalTests
      ? `<table><thead><tr><th scope="col">Comando</th><th scope="col">Status</th><th scope="col">Código</th><th scope="col">Duração</th></tr></thead><tbody>${testRows}</tbody></table>`
      : '<p class="empty">Suíte final não executada.</p>'
  }
  </div>

  <h2>Pull request e CI</h2>
  ${
    run.pullRequest
      ? `<div class="grid">
    <dl class="card"><dt>PR</dt><dd>#${run.pullRequest.number}</dd></dl>
    <dl class="card"><dt>Estado</dt><dd>${escapeHtml(run.pullRequest.state)}${run.pullRequest.isDraft ? ' (draft)' : ''}</dd></dl>
    <dl class="card"><dt>Head SHA</dt><dd>${escapeHtml(run.pullRequest.headSha.slice(0, 12))}</dd></dl>
    <dl class="card"><dt>Mergeable</dt><dd>${escapeHtml(run.pullRequest.mergeable)}</dd></dl>
    <dl class="card"><dt>Threads não resolvidas</dt><dd>${escapeHtml(describeThreads(run.pullRequest.unresolvedThreadCount))}</dd></dl>
    <dl class="card"><dt>CI</dt><dd>${run.checks ? `${run.checks.passed}/${run.checks.total} aprovados` : '—'}</dd></dl>
  </div>`
      : '<p class="empty">PR não criada.</p>'
  }

  <h2>Auditoria final e consenso</h2>
  <div class="table-wrap">
  ${
    auditRows
      ? `<table><thead><tr><th scope="col">Auditor</th><th scope="col">Veredito</th><th scope="col">Confiança</th><th scope="col">SHA revisado</th><th scope="col">Validade</th></tr></thead><tbody>${auditRows}</tbody></table>`
      : '<p class="empty">Nenhuma auditoria final executada.</p>'
  }
  </div>
  ${
    run.consensus
      ? `<p><strong>Consenso:</strong> ${run.consensus.reached ? '<span class="badge is-approved">ALCANÇADO</span>' : '<span class="badge is-failed">NÃO ALCANÇADO</span>'}${
          run.consensus.reasons.length > 0
            ? `<br><span class="empty">${escapeHtml(run.consensus.reasons.join(' · '))}</span>`
            : ''
        }</p>`
      : ''
  }

  <h2>Gates de merge</h2>
  <div class="table-wrap">
  ${
    run.gateReport
      ? `<table><thead><tr><th scope="col">#</th><th scope="col">Gate</th><th scope="col">Status</th><th scope="col">Motivo</th></tr></thead><tbody>${gateRows}</tbody></table>`
      : '<p class="empty">Gates ainda não avaliados.</p>'
  }
  </div>

  <h2>Resultado do merge</h2>
  ${
    run.mergeOutcome
      ? `<div class="grid">
    <dl class="card"><dt>Mergeado</dt><dd>${run.mergeOutcome.merged ? 'SIM' : 'NÃO'}</dd></dl>
    <dl class="card"><dt>Estratégia</dt><dd>${escapeHtml(run.mergeOutcome.strategy)}</dd></dl>
    <dl class="card"><dt>Merge SHA</dt><dd>${escapeHtml((run.mergeOutcome.mergeSha ?? '—').slice(0, 12))}</dd></dl>
    <dl class="card"><dt>Motivo</dt><dd>${escapeHtml(run.mergeOutcome.reason)}</dd></dl>
  </div>`
      : '<p class="empty">Merge não executado.</p>'
  }

  <footer>Gerado pelo OrqPEG em ${escapeHtml(nowIso())}. Documento autocontido, sem recursos externos.</footer>
</main>
</body>
</html>
`;
}

/* ------------------------------------------------------------------------- */
/* Persistência                                                               */
/* ------------------------------------------------------------------------- */

export interface WrittenReport {
  jsonPath: string;
  markdownPath: string;
  htmlPath: string;
}

export function writeRunReport(input: RunReportInput): Result<WrittenReport> {
  const bundle = buildRunReport(input);
  const dir = ensureDir(path.join(projectReportsDir(input.project.id), input.run.runId));

  const jsonPath = path.join(dir, 'relatorio.json');
  const markdownPath = path.join(dir, 'relatorio.md');
  const htmlPath = path.join(dir, 'relatorio.html');

  const writes = [
    writeArtifactSync(jsonPath, bundle.json),
    writeArtifactSync(markdownPath, bundle.markdown),
    writeArtifactSync(htmlPath, bundle.html),
  ];
  for (const write of writes) {
    if (!write.ok) return write;
  }

  return ok({ jsonPath, markdownPath, htmlPath });
}

/** Relatório enxuto de uma tentativa, gravado junto aos artefatos. */
export function buildAttemptSummaryJson(summary: AttemptSummary): string {
  return `${JSON.stringify(summary, null, 2)}\n`;
}
