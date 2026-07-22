import type {
  ChecksSummary,
  ProjectConfig,
  PromptReview,
  PullRequestInfo,
  ReviewIssue,
  RunRecord,
  TestCommandResult,
  TestSuiteResult,
} from '../types';
import type { ParsedPrompt } from '../prompts/prompt-parser';
import { redactText } from '../utils/redact';
import { formatDuration, nowIso } from '../utils/time';

/**
 * Montagem dos pacotes de revisão entregues às IAs.
 *
 * O pacote é a única fonte de contexto do revisor: ele precisa ser completo e
 * honesto. O patch nunca é encurtado em silêncio — se o limite máximo for
 * atingido, o corte é anunciado no próprio documento, com o tamanho original.
 */

/** Limite máximo de caracteres do patch dentro do pacote. */
export const MAX_PATCH_CHARS = 2_000_000;

/** Quantidade de caracteres do fim de cada fluxo de saída de teste exibida. */
export const TEST_OUTPUT_TAIL_CHARS = 6_000;

export interface ReviewPackageInput {
  project: ProjectConfig;
  prompt: ParsedPrompt;
  promptRaw: string;
  attempt: number;
  workingDir: string;
  changedFiles: string[];
  diffStat: string;
  diffPatch: string;
  gitStatus: string;
  tests: TestSuiteResult;
  previousReview?: PromptReview | null;
}

export interface MergeAuditPackageInput {
  project: ProjectConfig;
  run: RunRecord;
  pr: PullRequestInfo;
  checks: ChecksSummary | null;
  finalTests: TestSuiteResult | null;
  commitLog: string;
  diffStat: string;
  diffPatch: string;
}

/* ------------------------------------------------------------------------- */
/* Pacote de revisão de prompt                                                */
/* ------------------------------------------------------------------------- */

export function buildReviewPackage(input: ReviewPackageInput): string {
  const prompt = input.prompt;
  const lines: string[] = [];

  lines.push('# Pacote de revisão de prompt — OrqPEG');
  lines.push('');
  lines.push(
    'Você é o revisor independente desta entrega. Analise **apenas** o que está ' +
      'neste documento e responda no formato JSON exigido no final.',
  );
  lines.push('');
  lines.push(`Gerado em: ${nowIso()}`);
  lines.push('');

  /* Identificação -------------------------------------------------------- */
  lines.push('## 1. Identificação');
  lines.push('');
  lines.push(...bulletList([
    ['Projeto', `${input.project.name} (id: ${input.project.id})`],
    ['Repositório local', input.project.repositoryPath],
    ['Repositório GitHub', input.project.githubRepository],
    ['Branch base', input.project.baseBranch],
    ['Diretório de trabalho desta execução', input.workingDir],
    ['Prompt', prompt.name],
    ['Identificador do prompt', prompt.id],
    ['Tentativa', String(input.attempt)],
  ]));
  lines.push('');

  /* Escopo --------------------------------------------------------------- */
  lines.push('## 2. Escopo do prompt');
  lines.push('');
  lines.push('### Objetivo');
  lines.push('');
  lines.push(safeText(prompt.objective, '(o prompt não declarou um objetivo)'));
  lines.push('');

  lines.push('### Escopo OBRIGATÓRIO (o que precisava ser feito)');
  lines.push('');
  lines.push(...listBlock('Escopo declarado', prompt.scope));
  lines.push(...listBlock('Requisitos funcionais', prompt.functionalRequirements));
  lines.push(...listBlock('Requisitos técnicos', prompt.technicalRequirements));
  lines.push(...listBlock('Testes obrigatórios', prompt.requiredTests));
  lines.push(...listBlock('Áreas permitidas', prompt.allowedAreas));

  lines.push('### Escopo PROIBIDO (o que não podia ser tocado)');
  lines.push('');
  lines.push(...listBlock('Fora do escopo', prompt.outOfScope));
  lines.push(...listBlock('Áreas proibidas', prompt.forbiddenAreas));
  lines.push(...listBlock('Restrições', prompt.restrictions));
  lines.push(
    'Qualquer alteração fora das áreas permitidas, ou que invada as áreas ' +
      'proibidas, é violação de escopo e deve virar problema bloqueante.',
  );
  lines.push('');

  lines.push('### Critérios de aceitação e dependências');
  lines.push('');
  lines.push(...listBlock('Critérios de aceitação', prompt.acceptanceCriteria));
  lines.push(...listBlock('Dependências', prompt.dependencies));

  lines.push('### Texto integral do prompt (fonte da verdade)');
  lines.push('');
  lines.push(
    'O texto abaixo é o prompt exatamente como foi entregue ao executor. Em caso ' +
      'de divergência com o resumo estruturado acima, **vale o texto integral**.',
  );
  lines.push('');
  lines.push(...fencedBlock(safeText(input.promptRaw, '(prompt vazio)'), 'markdown'));
  lines.push('');

  /* Mudanças ------------------------------------------------------------- */
  lines.push('## 3. Arquivos alterados');
  lines.push('');
  if (input.changedFiles.length === 0) {
    lines.push('**Nenhum arquivo foi alterado nesta tentativa.**');
  } else {
    lines.push(`Total: ${String(input.changedFiles.length)} arquivo(s).`);
    lines.push('');
    for (const file of input.changedFiles) {
      lines.push(`- \`${file}\``);
    }
  }
  lines.push('');

  lines.push('## 4. Estado do repositório (`git status`)');
  lines.push('');
  lines.push(...fencedBlock(safeText(input.gitStatus, '(git status vazio)'), 'text'));
  lines.push('');

  lines.push('## 5. Resumo do diff (`git diff --stat`)');
  lines.push('');
  lines.push(...fencedBlock(safeText(input.diffStat, '(sem diferenças)'), 'text'));
  lines.push('');

  lines.push('## 6. Patch completo');
  lines.push('');
  lines.push(...patchSection(input.diffPatch));
  lines.push('');

  /* Testes --------------------------------------------------------------- */
  lines.push('## 7. Resultado real dos testes (autoridade: OrqPEG)');
  lines.push('');
  lines.push(
    'Estes resultados foram produzidos pelo OrqPEG executando os comandos do ' +
      'projeto. **Não presuma outro resultado**: o status abaixo é definitivo.',
  );
  lines.push('');
  lines.push(...testsSection(input.tests));
  lines.push('');

  /* Revisão anterior ----------------------------------------------------- */
  lines.push('## 8. Revisão anterior');
  lines.push('');
  if (input.previousReview) {
    lines.push(...previousReviewSection(input.previousReview));
  } else {
    lines.push('Não há revisão anterior: esta é a primeira avaliação deste prompt.');
  }
  lines.push('');

  /* Resposta ------------------------------------------------------------- */
  lines.push('## 9. Formato obrigatório da resposta');
  lines.push('');
  lines.push(...promptReviewResponseSpec());

  return lines.join('\n');
}

/* ------------------------------------------------------------------------- */
/* Pacote de auditoria final de merge                                         */
/* ------------------------------------------------------------------------- */

export function buildMergeAuditPackage(input: MergeAuditPackageInput): string {
  const headSha = input.pr.headSha;
  const lines: string[] = [];

  lines.push('# Pacote de auditoria final de merge — OrqPEG');
  lines.push('');
  lines.push(`Gerado em: ${nowIso()}`);
  lines.push('');
  lines.push('> ## HEAD SHA AUDITADO');
  lines.push('>');
  lines.push(`> ### \`${headSha}\``);
  lines.push('>');
  lines.push(
    '> Este é o commit exato que será integrado. O campo `reviewedHeadSha` do ' +
      'JSON de resposta **deve ser exatamente este SHA**, copiado sem alteração. ' +
      'Qualquer outro valor invalida a auditoria e o merge é recusado.',
  );
  lines.push('');

  lines.push('## 1. Identificação');
  lines.push('');
  lines.push(...bulletList([
    ['Projeto', `${input.project.name} (id: ${input.project.id})`],
    ['Repositório GitHub', input.project.githubRepository],
    ['Branch base', input.pr.baseRefName],
    ['Branch da execução', input.pr.headRefName],
    ['Execução (runId)', input.run.runId],
    ['Estado da execução', input.run.state],
    ['Estratégia de merge configurada', input.project.merge.strategy],
    ['Confiança mínima exigida', String(input.project.merge.minimumConfidence)],
  ]));
  lines.push('');

  lines.push('## 2. Pull request');
  lines.push('');
  lines.push(...bulletList([
    ['Número', `#${String(input.pr.number)}`],
    ['Título', input.pr.title],
    ['URL', input.pr.url],
    ['Estado', input.pr.state],
    ['Rascunho', input.pr.isDraft ? 'sim' : 'não'],
    ['Head SHA', input.pr.headSha],
    ['Base SHA', input.pr.baseSha ?? '(desconhecido)'],
    ['Mesclável', input.pr.mergeable],
    ['Estado de merge', input.pr.mergeStateStatus ?? '(desconhecido)'],
    ['Decisão de revisão humana', input.pr.reviewDecision ?? '(nenhuma)'],
    ['Threads não resolvidas', String(input.pr.unresolvedThreadCount)],
    ['Já mesclado', input.pr.merged ? 'sim' : 'não'],
  ]));
  lines.push('');

  lines.push('## 3. Prompts da execução');
  lines.push('');
  if (input.run.prompts.length === 0) {
    lines.push('Nenhum prompt registrado nesta execução.');
  } else {
    lines.push('| Prompt | Status | Tentativas | Veredito | Bloqueios | Commit |');
    lines.push('| --- | --- | --- | --- | --- | --- |');
    for (const progress of input.run.prompts) {
      lines.push(
        `| ${tableCell(progress.promptId)} | ${progress.status} | ` +
          `${String(progress.attempts)} | ${progress.lastVerdict ?? '—'} | ` +
          `${String(progress.blockingIssueCount)} | ${progress.commitSha ?? '—'} |`,
      );
    }
  }
  lines.push('');

  lines.push('## 4. Checks de CI');
  lines.push('');
  lines.push(...checksSection(input.checks, headSha));
  lines.push('');

  lines.push('## 5. Testes locais finais (autoridade: OrqPEG)');
  lines.push('');
  if (input.finalTests) {
    lines.push(...testsSection(input.finalTests));
  } else {
    lines.push('**Nenhuma execução final de testes locais foi registrada.**');
  }
  lines.push('');

  lines.push('## 6. Commits da branch');
  lines.push('');
  lines.push(...fencedBlock(safeText(input.commitLog, '(sem commits listados)'), 'text'));
  lines.push('');

  lines.push('## 7. Resumo do diff contra a base (`git diff --stat`)');
  lines.push('');
  lines.push(...fencedBlock(safeText(input.diffStat, '(sem diferenças)'), 'text'));
  lines.push('');

  lines.push('## 8. Patch completo da branch');
  lines.push('');
  lines.push(...patchSection(input.diffPatch));
  lines.push('');

  lines.push('## 9. Formato obrigatório da resposta');
  lines.push('');
  lines.push(...mergeReviewResponseSpec(headSha));

  return lines.join('\n');
}

/* ------------------------------------------------------------------------- */
/* Seções reutilizadas                                                        */
/* ------------------------------------------------------------------------- */

function patchSection(patch: string): string[] {
  const source = typeof patch === 'string' ? patch : '';
  const lines: string[] = [];

  if (source.trim().length === 0) {
    lines.push('**O patch está vazio: nenhuma diferença de código foi produzida.**');
    return lines;
  }

  if (source.length > MAX_PATCH_CHARS) {
    const kept = source.slice(0, MAX_PATCH_CHARS);
    lines.push(
      `> **AVISO DE CORTE:** o patch tem ${String(source.length)} caracteres e ` +
        `ultrapassa o limite de ${String(MAX_PATCH_CHARS)} caracteres deste pacote. ` +
        `Foram incluídos apenas os primeiros ${String(kept.length)} caracteres; ` +
        `${String(source.length - kept.length)} caracteres foram omitidos. ` +
        'A revisão está incompleta por este motivo — se o trecho omitido for ' +
        'relevante para o veredito, registre isso como problema bloqueante e peça ' +
        'a divisão da entrega em partes menores.',
    );
    lines.push('');
    lines.push(...fencedBlock(kept, 'diff'));
    lines.push('');
    lines.push(
      `> Fim do trecho incluído. Repetindo o aviso: ${String(source.length - kept.length)} ` +
        'caracteres do patch foram cortados por limite de tamanho.',
    );
    return lines;
  }

  lines.push(`Tamanho do patch: ${String(source.length)} caracteres (íntegro, sem cortes).`);
  lines.push('');
  lines.push(...fencedBlock(source, 'diff'));
  return lines;
}

function testsSection(tests: TestSuiteResult): string[] {
  const lines: string[] = [];

  lines.push(...bulletList([
    ['Status agregado', describeTestStatus(tests.status)],
    ['Aprovado pelo OrqPEG', tests.passed ? 'SIM' : 'NÃO'],
    ['Início', tests.startedAt],
    ['Fim', tests.finishedAt],
    ['Duração', formatDuration(tests.durationMs)],
    ['Comandos executados', String(tests.commands.length)],
    [
      'Comandos que não passaram',
      tests.failedCommands.length === 0 ? 'nenhum' : tests.failedCommands.join(', '),
    ],
  ]));
  lines.push('');

  if (tests.commands.length === 0) {
    lines.push('Nenhum comando de teste está configurado para este projeto.');
    return lines;
  }

  for (const command of tests.commands) {
    lines.push(...testCommandSection(command));
  }
  return lines;
}

function testCommandSection(command: TestCommandResult): string[] {
  const lines: string[] = [];
  lines.push(`### \`${command.command}\` — ${describeTestStatus(command.status)}`);
  lines.push('');
  lines.push(...bulletList([
    ['Diretório', command.cwd],
    ['Código de saída', command.exitCode === null ? '(nenhum)' : String(command.exitCode)],
    ['Início', command.startedAt],
    ['Fim', command.finishedAt],
    ['Duração', formatDuration(command.durationMs)],
  ]));
  lines.push('');

  const stdout = tailOf(command.stdout, TEST_OUTPUT_TAIL_CHARS);
  const stderr = tailOf(command.stderr, TEST_OUTPUT_TAIL_CHARS);

  lines.push('Saída padrão (trecho final):');
  lines.push('');
  lines.push(...fencedBlock(stdout.text.length > 0 ? stdout.text : '(vazia)', 'text'));
  if (stdout.truncated) {
    lines.push('');
    lines.push(
      `> Trecho final de ${String(TEST_OUTPUT_TAIL_CHARS)} caracteres. A saída ` +
        `completa tem ${String(stdout.originalLength)} caracteres.`,
    );
  }
  lines.push('');

  lines.push('Saída de erro (trecho final):');
  lines.push('');
  lines.push(...fencedBlock(stderr.text.length > 0 ? stderr.text : '(vazia)', 'text'));
  if (stderr.truncated) {
    lines.push('');
    lines.push(
      `> Trecho final de ${String(TEST_OUTPUT_TAIL_CHARS)} caracteres. A saída ` +
        `completa tem ${String(stderr.originalLength)} caracteres.`,
    );
  }
  lines.push('');
  return lines;
}

function checksSection(checks: ChecksSummary | null, headSha: string): string[] {
  const lines: string[] = [];

  if (!checks) {
    lines.push('**Nenhum resumo de checks foi coletado para este head SHA.**');
    return lines;
  }

  lines.push(...bulletList([
    ['Head SHA dos checks', checks.headSha],
    [
      'Confere com o head auditado',
      sameSha(checks.headSha, headSha) ? 'SIM' : 'NÃO — checks de outro commit',
    ],
    ['Total', String(checks.total)],
    ['Sucesso', String(checks.passed)],
    ['Falha', String(checks.failed)],
    ['Pendentes', String(checks.pending)],
    ['Ignorados', String(checks.skipped)],
    ['Todos os obrigatórios passaram', checks.allRequiredPassed ? 'SIM' : 'NÃO'],
    ['Algum obrigatório pendente', checks.anyRequiredPending ? 'SIM' : 'NÃO'],
    ['Algum obrigatório falhou', checks.anyRequiredFailed ? 'SIM' : 'NÃO'],
    ['Algum obrigatório ignorado', checks.anyRequiredSkipped ? 'SIM' : 'NÃO'],
  ]));
  lines.push('');

  if (checks.runs.length === 0) {
    lines.push('Nenhum check individual reportado.');
    return lines;
  }

  lines.push('| Check | Obrigatório | Estado | Conclusão | Workflow |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const run of checks.runs) {
    lines.push(
      `| ${tableCell(run.name)} | ${run.required ? 'sim' : 'não'} | ${run.status} | ` +
        `${run.conclusion} | ${tableCell(run.workflowName ?? '—')} |`,
    );
  }
  return lines;
}

function previousReviewSection(review: PromptReview): string[] {
  const lines: string[] = [];

  lines.push(...bulletList([
    ['Veredito anterior', review.verdict],
    ['Confiança', String(review.confidence)],
    ['Atendia aos requisitos', review.meetsPromptRequirements ? 'sim' : 'não'],
    ['Dentro do escopo', review.scopeAssessment.withinScope ? 'sim' : 'não'],
    ['Risco', `${review.riskAssessment.level} — ${review.riskAssessment.summary}`],
  ]));
  lines.push('');
  lines.push('Resumo anterior:');
  lines.push('');
  lines.push(...fencedBlock(safeText(review.summary, '(sem resumo)'), 'text'));
  lines.push('');

  lines.push('### Problemas bloqueantes apontados anteriormente');
  lines.push('');
  lines.push(...issueList(review.blockingIssues, 'Nenhum problema bloqueante foi apontado.'));
  lines.push('');

  lines.push('### Problemas não bloqueantes apontados anteriormente');
  lines.push('');
  lines.push(...issueList(review.nonBlockingIssues, 'Nenhum problema não bloqueante foi apontado.'));
  lines.push('');

  lines.push('### Ações exigidas anteriormente');
  lines.push('');
  lines.push(...checklist(review.requiredActions, 'Nenhuma ação foi exigida.'));
  lines.push('');
  lines.push(
    'Verifique explicitamente se cada ponto acima foi resolvido nesta nova tentativa.',
  );
  return lines;
}

function issueList(
  issues: readonly ReviewIssue[] | null | undefined,
  emptyMessage: string,
): string[] {
  if (!issues || issues.length === 0) return [emptyMessage];
  const lines: string[] = [];
  for (const issue of issues) {
    const line = typeof issue.line === 'number' ? `:${String(issue.line)}` : '';
    const local = hasText(issue.file) ? ` (\`${issue.file}${line}\`)` : '';
    lines.push(`- **[${issue.severity}] ${sanitizeInline(issue.title)}**${local}`);
    lines.push(`  - ${sanitizeInline(issue.description)}`);
    if (hasText(issue.suggestion)) {
      lines.push(`  - Sugestão: ${sanitizeInline(issue.suggestion)}`);
    }
  }
  return lines;
}

function hasText(value: string | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function promptReviewResponseSpec(): string[] {
  return [
    'Responda com **um único objeto JSON**, sem texto antes ou depois, dentro de ' +
      'um bloco cercado por três crases marcado como `json`. O objeto deve conter ' +
      'exatamente estes campos:',
    '',
    '- `verdict`: `"APPROVED"`, `"CHANGES_REQUESTED"` ou `"BLOCKED"`.',
    '- `summary`: texto curto explicando o veredito.',
    '- `confidence`: número entre 0 e 1.',
    '- `meetsPromptRequirements`: booleano.',
    '- `blockingIssues`: lista de problemas que impedem a aprovação.',
    '- `nonBlockingIssues`: lista de problemas que não impedem a aprovação.',
    '- `requiredActions`: lista de textos com as correções exigidas.',
    '- `scopeAssessment`: `{ "withinScope": booleano, "unexpectedChanges": [texto] }`.',
    '- `testsAssessment`: `{ "localTestsPassed": booleano, "coverageAcceptable": booleano }`.',
    '- `riskAssessment`: `{ "level": "low"|"medium"|"high"|"critical", "summary": texto }`.',
    '',
    'Cada item de `blockingIssues` e `nonBlockingIssues` é um objeto com ' +
      '`severity` (`"blocking"`, `"major"`, `"minor"` ou `"info"`), `title`, ' +
      '`description` e, opcionalmente, `file`, `line` e `suggestion`.',
    '',
    'Regras invioláveis:',
    '',
    '- `verdict` só pode ser `"APPROVED"` se `blockingIssues` estiver vazia.',
    '- `localTestsPassed` deve refletir o resultado real informado na seção 7; ' +
      'não invente resultado de teste.',
    '- Se algo essencial estiver faltando no pacote, use `"BLOCKED"` e explique ' +
      'em `requiredActions`.',
  ];
}

function mergeReviewResponseSpec(headSha: string): string[] {
  return [
    'Responda com **um único objeto JSON**, sem texto antes ou depois, dentro de ' +
      'um bloco cercado por três crases marcado como `json`. O objeto deve conter ' +
      'exatamente estes campos:',
    '',
    '- `verdict`: `"APPROVED_FOR_MERGE"`, `"CHANGES_REQUIRED"` ou `"BLOCKED"`.',
    `- \`reviewedHeadSha\`: obrigatoriamente \`"${headSha}"\`.`,
    '- `summary`: texto curto explicando o veredito.',
    '- `confidence`: número entre 0 e 1.',
    '- `blockingIssues`: lista de problemas que impedem o merge.',
    '- `nonBlockingIssues`: lista de problemas que não impedem o merge.',
    '- `requiredActions`: lista de textos com as correções exigidas.',
    '- `riskAssessment`: `{ "level": "low"|"medium"|"high"|"critical", "summary": texto }`.',
    '- `testsAssessment`: `{ "localTestsPassed": booleano, "ciPassed": booleano, ' +
      '"coverageAcceptable": booleano }`.',
    '- `scopeAssessment`: `{ "withinScope": booleano, "unexpectedChanges": [texto] }`.',
    '',
    'Cada item de `blockingIssues` e `nonBlockingIssues` é um objeto com ' +
      '`severity` (`"blocking"`, `"major"`, `"minor"` ou `"info"`), `title`, ' +
      '`description` e, opcionalmente, `file`, `line` e `suggestion`.',
    '',
    'Regras invioláveis:',
    '',
    `- \`reviewedHeadSha\` deve ser exatamente \`${headSha}\`. O OrqPEG rejeita a ` +
      'auditoria se o SHA divergir, porque isso significaria auditoria de outro código.',
    '- `verdict` só pode ser `"APPROVED_FOR_MERGE"` se `blockingIssues` estiver vazia.',
    '- `localTestsPassed` e `ciPassed` devem refletir os dados reais das seções 4 e 5.',
    '- Na dúvida, recuse: um merge indevido é muito mais caro que uma rodada extra.',
  ];
}

/* ------------------------------------------------------------------------- */
/* Formatação                                                                 */
/* ------------------------------------------------------------------------- */

function bulletList(pairs: ReadonlyArray<readonly [string, string]>): string[] {
  return pairs.map(([label, value]) => `- **${label}:** ${sanitizeInline(value)}`);
}

function checklist(items: readonly string[], emptyMessage: string): string[] {
  if (items.length === 0) {
    return emptyMessage.length > 0 ? [emptyMessage] : ['(nada declarado)'];
  }
  return items.map((item) => `- ${sanitizeInline(item)}`);
}

/** Sub-bloco `**Título:**` + lista, omitindo o bloco quando não há itens. */
function listBlock(title: string, items: readonly string[]): string[] {
  if (items.length === 0) return [`**${title}:** (nada declarado)`, ''];
  return [`**${title}:**`, '', ...checklist(items, ''), ''];
}

/**
 * Cerca um bloco de texto com crases suficientes para nunca ser fechado antes da
 * hora: o conteúdo pode conter blocos de código (o patch quase sempre contém).
 */
function fencedBlock(content: string, language: string): string[] {
  const fence = '`'.repeat(Math.max(3, longestBacktickRun(content) + 1));
  return [`${fence}${language}`, content, fence];
}

function longestBacktickRun(content: string): number {
  let longest = 0;
  let current = 0;
  for (let i = 0; i < content.length; i += 1) {
    if (content.charAt(i) === '`') {
      current += 1;
      if (current > longest) longest = current;
    } else {
      current = 0;
    }
  }
  return longest;
}

function tailOf(
  value: string,
  limit: number,
): { text: string; truncated: boolean; originalLength: number } {
  const source = typeof value === 'string' ? value : '';
  if (source.length <= limit) {
    return { text: source, truncated: false, originalLength: source.length };
  }
  return {
    text: source.slice(source.length - limit),
    truncated: true,
    originalLength: source.length,
  };
}

function safeText(value: string, fallback: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) return fallback;
  return value;
}

/** Normaliza um texto para uso em linha: sem quebras e sem segredos. */
function sanitizeInline(value: string): string {
  const text = typeof value === 'string' ? value : '';
  return redactText(text.replace(/\r?\n/g, ' ')).trim();
}

function tableCell(value: string): string {
  return sanitizeInline(value).split('|').join('\\|');
}

function describeTestStatus(status: TestSuiteResult['status']): string {
  switch (status) {
    case 'PASSED':
      return 'PASSED (passou)';
    case 'FAILED':
      return 'FAILED (falhou)';
    case 'TIMEOUT':
      return 'TIMEOUT (tempo esgotado)';
    case 'INTERRUPTED':
      return 'INTERRUPTED (interrompido)';
    case 'COMMAND_NOT_FOUND':
      return 'COMMAND_NOT_FOUND (comando não encontrado)';
    case 'NOT_RUN':
      return 'NOT_RUN (não executado)';
    default:
      return String(status);
  }
}

function sameSha(a: string, b: string): boolean {
  const left = typeof a === 'string' ? a.trim().toLowerCase() : '';
  const right = typeof b === 'string' ? b.trim().toLowerCase() : '';
  if (left.length === 0 || right.length === 0) return false;
  if (left === right) return true;
  const shorter = left.length < right.length ? left : right;
  const longer = left.length < right.length ? right : left;
  return shorter.length >= 7 && longer.startsWith(shorter);
}
