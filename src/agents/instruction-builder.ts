import * as path from 'node:path';

import type { ReviewIssue } from '../types';
import { fileExists, readTextSync } from '../utils/fs-atomic';
import { ORQPEG_DIRS } from '../utils/paths';

/**
 * Montagem das instruções enviadas aos agentes.
 *
 * Cada instrução nasce de um template em `templates/` com marcadores no formato
 * `{{NOME}}`. Quando o arquivo não existe em disco, usamos o texto embutido
 * equivalente — que é uma instrução completa e funcional, não um esboço.
 *
 * Princípios que todas as instruções seguem:
 *  - execução: proibir explicitamente commit, push, merge, troca de branch,
 *    rebase, reset destrutivo, deploy e avanço para o próximo prompt;
 *  - revisão/auditoria: exigir resposta em JSON puro aderente ao schema, sem
 *    nenhum texto fora do JSON.
 */

/* ------------------------------------------------------------------------- */
/* Entradas                                                                   */
/* ------------------------------------------------------------------------- */

export interface ClaudeExecutionInstructionInput {
  projectName: string;
  repositoryPath: string;
  workingDirectory: string;
  branchName: string;
  baseBranch: string;
  promptId: string;
  promptName: string;
  promptContent: string;
  promptIndex: number;
  promptTotal: number;
  attempt: number;
  maxAttempts: number;
  testCommands: readonly string[];
}

export interface ClaudeCorrectionInstructionInput {
  projectName: string;
  repositoryPath: string;
  workingDirectory: string;
  branchName: string;
  baseBranch: string;
  promptId: string;
  promptName: string;
  promptContent: string;
  attempt: number;
  maxAttempts: number;
  testCommands: readonly string[];
  /** Nome do revisor que pediu as mudanças (ex.: "Codex"). */
  reviewer: string;
  reviewSummary: string;
  requiredActions: readonly string[];
  blockingIssues: readonly ReviewIssue[];
  nonBlockingIssues?: readonly ReviewIssue[];
  /** Comandos de teste que falharam na tentativa anterior. */
  failedTestCommands?: readonly string[];
  testOutputExcerpt?: string;
}

export interface ClaudeMergeAuditInstructionInput {
  projectName: string;
  repositoryPath: string;
  workingDirectory: string;
  baseBranch: string;
  branchName: string;
  headSha: string;
  pullRequestNumber: number | null;
  pullRequestUrl: string | null;
  changedFiles: readonly string[];
  diffSummary: string;
  testsSummary: string;
  ciSummary: string;
  promptsSummary: string;
  minimumConfidence: number;
  /** Schema JSON (já serializado) que a resposta deve obedecer. */
  responseSchema?: string;
}

export interface CodexPromptReviewInstructionInput {
  projectName: string;
  repositoryPath: string;
  workingDirectory: string;
  branchName: string;
  promptId: string;
  promptName: string;
  promptContent: string;
  attempt: number;
  maxAttempts: number;
  changedFiles: readonly string[];
  diffSummary: string;
  testsSummary: string;
  /** Schema JSON (já serializado) que a resposta deve obedecer. */
  responseSchema?: string;
}

export interface CodexMergeAuditInstructionInput {
  projectName: string;
  repositoryPath: string;
  workingDirectory: string;
  baseBranch: string;
  branchName: string;
  headSha: string;
  pullRequestNumber: number | null;
  pullRequestUrl: string | null;
  changedFiles: readonly string[];
  diffSummary: string;
  testsSummary: string;
  ciSummary: string;
  promptsSummary: string;
  minimumConfidence: number;
  /** Schema JSON (já serializado) que a resposta deve obedecer. */
  responseSchema?: string;
}

/* ------------------------------------------------------------------------- */
/* Forma canônica das respostas JSON                                          */
/* ------------------------------------------------------------------------- */

/** Estrutura exata esperada em uma revisão de prompt (`PromptReview`). */
export const PROMPT_REVIEW_RESPONSE_SHAPE = [
  '{',
  '  "verdict": "APPROVED" | "CHANGES_REQUESTED" | "BLOCKED",',
  '  "summary": "resumo objetivo em português",',
  '  "confidence": 0.0,',
  '  "meetsPromptRequirements": true,',
  '  "blockingIssues": [',
  '    {',
  '      "severity": "blocking" | "major" | "minor" | "info",',
  '      "title": "título curto",',
  '      "description": "descrição objetiva",',
  '      "file": "caminho relativo (opcional)",',
  '      "line": 0,',
  '      "suggestion": "correção sugerida (opcional)"',
  '    }',
  '  ],',
  '  "nonBlockingIssues": [],',
  '  "requiredActions": ["ação obrigatória para aprovar"],',
  '  "scopeAssessment": { "withinScope": true, "unexpectedChanges": [] },',
  '  "testsAssessment": { "localTestsPassed": true, "coverageAcceptable": true },',
  '  "riskAssessment": {',
  '    "level": "low" | "medium" | "high" | "critical",',
  '    "summary": "por que este é o nível de risco"',
  '  }',
  '}',
].join('\n');

/** Estrutura exata esperada em uma auditoria de merge (`MergeReview`). */
export const MERGE_REVIEW_RESPONSE_SHAPE = [
  '{',
  '  "verdict": "APPROVED_FOR_MERGE" | "CHANGES_REQUIRED" | "BLOCKED",',
  '  "reviewedHeadSha": "sha completo do commit auditado",',
  '  "summary": "resumo objetivo em português",',
  '  "confidence": 0.0,',
  '  "blockingIssues": [',
  '    {',
  '      "severity": "blocking" | "major" | "minor" | "info",',
  '      "title": "título curto",',
  '      "description": "descrição objetiva",',
  '      "file": "caminho relativo (opcional)",',
  '      "line": 0,',
  '      "suggestion": "correção sugerida (opcional)"',
  '    }',
  '  ],',
  '  "nonBlockingIssues": [],',
  '  "requiredActions": ["ação obrigatória antes do merge"],',
  '  "riskAssessment": {',
  '    "level": "low" | "medium" | "high" | "critical",',
  '    "summary": "por que este é o nível de risco"',
  '  },',
  '  "testsAssessment": {',
  '    "localTestsPassed": true,',
  '    "ciPassed": true,',
  '    "coverageAcceptable": true',
  '  },',
  '  "scopeAssessment": { "withinScope": true, "unexpectedChanges": [] }',
  '}',
].join('\n');

/** Regras de formato repetidas em toda instrução que exige JSON. */
const JSON_ONLY_RULES = [
  '## Formato obrigatório da resposta',
  '',
  'Responda EXCLUSIVAMENTE com um único objeto JSON válido.',
  '',
  '- Nada antes e nada depois do JSON: sem saudação, sem explicação, sem markdown.',
  '- Sem cercas de código (```), sem comentários, sem vírgula sobrando.',
  '- Todos os campos do schema são obrigatórios; use lista vazia quando não houver itens.',
  '- `confidence` é um número entre 0 e 1 com duas casas decimais.',
  '- Textos dos campos em português do Brasil.',
  '- Se você não conseguir avaliar algo, diga isso no `summary` e reduza a `confidence`;',
  '  nunca invente resultado de teste, de CI ou de código que não leu.',
].join('\n');

/* ------------------------------------------------------------------------- */
/* Funções públicas                                                           */
/* ------------------------------------------------------------------------- */

export function buildClaudeExecutionInstruction(
  input: ClaudeExecutionInstructionInput,
): string {
  return render('CLAUDE-EXECUTION.md', CLAUDE_EXECUTION_FALLBACK, {
    PROJECT_NAME: input.projectName,
    REPOSITORY_PATH: input.repositoryPath,
    WORKING_DIRECTORY: input.workingDirectory,
    BRANCH_NAME: input.branchName,
    BASE_BRANCH: input.baseBranch,
    PROMPT_ID: input.promptId,
    PROMPT_NAME: input.promptName,
    PROMPT_INDEX: String(input.promptIndex),
    PROMPT_TOTAL: String(input.promptTotal),
    ATTEMPT: String(input.attempt),
    MAX_ATTEMPTS: String(input.maxAttempts),
    TEST_COMMANDS: formatList(input.testCommands, 'Nenhum comando de teste configurado.'),
    PROMPT_CONTENT: input.promptContent.trim(),
  });
}

export function buildClaudeCorrectionInstruction(
  input: ClaudeCorrectionInstructionInput,
): string {
  return render('CLAUDE-CORRECTION.md', CLAUDE_CORRECTION_FALLBACK, {
    PROJECT_NAME: input.projectName,
    REPOSITORY_PATH: input.repositoryPath,
    WORKING_DIRECTORY: input.workingDirectory,
    BRANCH_NAME: input.branchName,
    BASE_BRANCH: input.baseBranch,
    PROMPT_ID: input.promptId,
    PROMPT_NAME: input.promptName,
    ATTEMPT: String(input.attempt),
    MAX_ATTEMPTS: String(input.maxAttempts),
    REVIEWER: input.reviewer,
    REVIEW_SUMMARY: input.reviewSummary.trim(),
    REQUIRED_ACTIONS: formatList(input.requiredActions, 'Nenhuma ação obrigatória listada.'),
    BLOCKING_ISSUES: formatIssues(input.blockingIssues, 'Nenhum problema bloqueante listado.'),
    NON_BLOCKING_ISSUES: formatIssues(
      input.nonBlockingIssues ?? [],
      'Nenhum problema não bloqueante listado.',
    ),
    FAILED_TEST_COMMANDS: formatList(
      input.failedTestCommands ?? [],
      'Nenhum comando de teste falhou.',
    ),
    TEST_OUTPUT: textOrDefault(input.testOutputExcerpt, 'Sem saída de teste registrada.'),
    TEST_COMMANDS: formatList(input.testCommands, 'Nenhum comando de teste configurado.'),
    PROMPT_CONTENT: input.promptContent.trim(),
  });
}

export function buildClaudeMergeAuditInstruction(
  input: ClaudeMergeAuditInstructionInput,
): string {
  return render('CLAUDE-MERGE-AUDIT.md', CLAUDE_MERGE_AUDIT_FALLBACK, {
    PROJECT_NAME: input.projectName,
    REPOSITORY_PATH: input.repositoryPath,
    WORKING_DIRECTORY: input.workingDirectory,
    BASE_BRANCH: input.baseBranch,
    BRANCH_NAME: input.branchName,
    HEAD_SHA: input.headSha,
    PR_NUMBER: input.pullRequestNumber === null ? 'sem PR' : `#${String(input.pullRequestNumber)}`,
    PR_URL: textOrDefault(input.pullRequestUrl, 'sem URL de PR'),
    CHANGED_FILES: formatList(input.changedFiles, 'Nenhum arquivo alterado detectado.'),
    DIFF_SUMMARY: textOrDefault(input.diffSummary, 'Resumo de diff indisponível.'),
    TESTS_SUMMARY: textOrDefault(input.testsSummary, 'Resumo de testes indisponível.'),
    CI_SUMMARY: textOrDefault(input.ciSummary, 'Resumo de CI indisponível.'),
    PROMPTS_SUMMARY: textOrDefault(input.promptsSummary, 'Resumo de prompts indisponível.'),
    MINIMUM_CONFIDENCE: formatConfidence(input.minimumConfidence),
    RESPONSE_SCHEMA: textOrDefault(input.responseSchema, MERGE_REVIEW_RESPONSE_SHAPE),
    JSON_RULES: JSON_ONLY_RULES,
  });
}

export function buildCodexPromptReviewInstruction(
  input: CodexPromptReviewInstructionInput,
): string {
  return render('CODEX-PROMPT-REVIEW.md', CODEX_PROMPT_REVIEW_FALLBACK, {
    PROJECT_NAME: input.projectName,
    REPOSITORY_PATH: input.repositoryPath,
    WORKING_DIRECTORY: input.workingDirectory,
    BRANCH_NAME: input.branchName,
    PROMPT_ID: input.promptId,
    PROMPT_NAME: input.promptName,
    ATTEMPT: String(input.attempt),
    MAX_ATTEMPTS: String(input.maxAttempts),
    CHANGED_FILES: formatList(input.changedFiles, 'Nenhum arquivo alterado detectado.'),
    DIFF_SUMMARY: textOrDefault(input.diffSummary, 'Resumo de diff indisponível.'),
    TESTS_SUMMARY: textOrDefault(input.testsSummary, 'Resumo de testes indisponível.'),
    PROMPT_CONTENT: input.promptContent.trim(),
    RESPONSE_SCHEMA: textOrDefault(input.responseSchema, PROMPT_REVIEW_RESPONSE_SHAPE),
    JSON_RULES: JSON_ONLY_RULES,
  });
}

export function buildCodexMergeAuditInstruction(
  input: CodexMergeAuditInstructionInput,
): string {
  return render('CODEX-MERGE-AUDIT.md', CODEX_MERGE_AUDIT_FALLBACK, {
    PROJECT_NAME: input.projectName,
    REPOSITORY_PATH: input.repositoryPath,
    WORKING_DIRECTORY: input.workingDirectory,
    BASE_BRANCH: input.baseBranch,
    BRANCH_NAME: input.branchName,
    HEAD_SHA: input.headSha,
    PR_NUMBER: input.pullRequestNumber === null ? 'sem PR' : `#${String(input.pullRequestNumber)}`,
    PR_URL: textOrDefault(input.pullRequestUrl, 'sem URL de PR'),
    CHANGED_FILES: formatList(input.changedFiles, 'Nenhum arquivo alterado detectado.'),
    DIFF_SUMMARY: textOrDefault(input.diffSummary, 'Resumo de diff indisponível.'),
    TESTS_SUMMARY: textOrDefault(input.testsSummary, 'Resumo de testes indisponível.'),
    CI_SUMMARY: textOrDefault(input.ciSummary, 'Resumo de CI indisponível.'),
    PROMPTS_SUMMARY: textOrDefault(input.promptsSummary, 'Resumo de prompts indisponível.'),
    MINIMUM_CONFIDENCE: formatConfidence(input.minimumConfidence),
    RESPONSE_SCHEMA: textOrDefault(input.responseSchema, MERGE_REVIEW_RESPONSE_SHAPE),
    JSON_RULES: JSON_ONLY_RULES,
  });
}

/* ------------------------------------------------------------------------- */
/* Renderização                                                               */
/* ------------------------------------------------------------------------- */

type MarkerMap = Readonly<Record<string, string>>;

const MARKER = /\{\{([A-Z0-9_]+)\}\}/g;

export interface CiRepairInstructionInput {
  projectName: string;
  cycle: number;
  maxCycles: number;
  failedChecks: string[];
  checksSummary: string;
  testCommands: string[];
}

/**
 * Instrução do reparo de CI.
 *
 * Deliberadamente estreita: o executor corrige o que o CI reprovou e nada
 * mais. Um reparo que aproveita a viagem para refatorar amplia o diff que os
 * auditores já examinaram e invalida o trabalho aprovado — por isso o escopo
 * proibido é dito explicitamente, e não apenas subentendido.
 */
export function buildCiRepairInstruction(input: CiRepairInstructionInput): string {
  return render('CLAUDE-CI-REPAIR.md', CLAUDE_CI_REPAIR_FALLBACK, {
    PROJECT_NAME: input.projectName,
    CYCLE: String(input.cycle),
    MAX_CYCLES: String(input.maxCycles),
    FAILED_CHECKS: formatList(input.failedChecks, 'Nenhum check nomeado.'),
    CHECKS_SUMMARY: textOrDefault(input.checksSummary, 'Sem resumo de checks.'),
    TEST_COMMANDS: formatList(input.testCommands, 'Nenhum comando de teste configurado.'),
  });
}

const CLAUDE_CI_REPAIR_FALLBACK = [
  '# Reparo de CI — {{PROJECT_NAME}}',
  '',
  'O código já foi aprovado na revisão e commitado. O CI do GitHub reprovou.',
  'Sua tarefa é fazer o CI passar, sem nada além disso.',
  '',
  'Ciclo {{CYCLE}} de {{MAX_CYCLES}}. Este orçamento é fixo: esgotado, a execução',
  'para e passa para revisão humana.',
  '',
  '## Checks reprovados',
  '',
  '{{FAILED_CHECKS}}',
  '',
  '## Situação do CI',
  '',
  '{{CHECKS_SUMMARY}}',
  '',
  '## Antes de terminar',
  '',
  'Rode localmente e garanta que passam:',
  '',
  '{{TEST_COMMANDS}}',
  '',
  '## Escopo',
  '',
  'PERMITIDO: corrigir a causa da reprovação do CI.',
  '',
  'PROIBIDO: refatorar o que não está quebrado, renomear, reorganizar arquivos,',
  'alterar configuração de workflow para mascarar a falha, desabilitar teste,',
  'marcar teste como skip, ou ampliar o diff além do necessário.',
  '',
  'Se a causa estiver fora do repositório (credencial ausente, serviço externo',
  'indisponível, runner mal configurado), NÃO invente contorno: explique o que',
  'encontrou e pare. Uma parada honesta é melhor que um verde falso.',
].join('\n');

function render(templateFile: string, fallback: string, markers: MarkerMap): string {
  const template = loadTemplate(templateFile) ?? fallback;
  return `${applyMarkers(template, markers).trimEnd()}\n`;
}

/** Lê o template de `templates/`. Ausência ou falha de leitura devolve `null`. */
function loadTemplate(fileName: string): string | null {
  const filePath = path.join(ORQPEG_DIRS.templates(), fileName);
  if (!fileExists(filePath)) return null;
  const read = readTextSync(filePath);
  if (!read.ok) return null;
  const content = read.value.trim();
  return content.length > 0 ? content : null;
}

function applyMarkers(template: string, markers: MarkerMap): string {
  MARKER.lastIndex = 0;
  return template.replace(MARKER, (_match: string, name: string): string => {
    const value = markers[name];
    return value === undefined ? '(não informado)' : value;
  });
}

function formatList(items: readonly string[], emptyText: string): string {
  const cleaned = items.map((item) => item.trim()).filter((item) => item.length > 0);
  if (cleaned.length === 0) return emptyText;
  return cleaned.map((item) => `- ${item}`).join('\n');
}

function formatIssues(issues: readonly ReviewIssue[], emptyText: string): string {
  if (issues.length === 0) return emptyText;
  return issues
    .map((issue, index) => {
      const location =
        issue.file === undefined || issue.file.length === 0
          ? ''
          : ` (${issue.file}${issue.line === undefined ? '' : `:${String(issue.line)}`})`;
      const suggestion =
        issue.suggestion === undefined || issue.suggestion.trim().length === 0
          ? ''
          : `\n  Sugestão: ${issue.suggestion.trim()}`;
      return (
        `${String(index + 1)}. [${issue.severity}] ${issue.title}${location}\n` +
        `  ${issue.description.trim()}${suggestion}`
      );
    })
    .join('\n');
}

function textOrDefault(value: string | null | undefined, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

function formatConfidence(value: number): string {
  if (!Number.isFinite(value)) return '0,80';
  const clamped = Math.min(1, Math.max(0, value));
  return clamped.toFixed(2).replace('.', ',');
}

/* ------------------------------------------------------------------------- */
/* Templates embutidos (usados quando o arquivo não existe em disco)          */
/* ------------------------------------------------------------------------- */

const EXECUTION_PROHIBITIONS = [
  '## Proibições absolutas',
  '',
  'Você NÃO pode, em nenhuma hipótese:',
  '',
  '1. Executar `git commit` — o commit é feito pelo OrqPEG somente após a aprovação.',
  '2. Executar `git push` ou qualquer publicação remota.',
  '3. Executar `git merge`, `git rebase` ou `git cherry-pick`.',
  '4. Trocar de branch (`git checkout`, `git switch`) nem criar branch nova.',
  '5. Executar reset destrutivo (`git reset --hard`), `git clean` ou apagar arquivos não relacionados.',
  '6. Criar, alterar ou mesclar pull request (`gh pr create`, `gh pr merge`).',
  '7. Fazer deploy, publicar pacote ou disparar qualquer automação externa.',
  '8. Avançar para o próximo prompt da fila: implemente APENAS o prompt desta instrução e pare.',
  '9. Alterar arquivos de configuração do OrqPEG ou credenciais da máquina.',
  '',
  'Se você julgar que alguma dessas ações é necessária, NÃO a execute: descreva a necessidade',
  'no relatório final e encerre. O orquestrador decide.',
].join('\n');

const CLAUDE_EXECUTION_FALLBACK = [
  '# OrqPEG — execução de prompt',
  '',
  'Você é o agente executor do OrqPEG. Sua tarefa é implementar, no repositório abaixo,',
  'exatamente o que o prompt pede — nada além disso.',
  '',
  '## Contexto',
  '',
  '- Projeto: {{PROJECT_NAME}}',
  '- Repositório: {{REPOSITORY_PATH}}',
  '- Diretório de trabalho: {{WORKING_DIRECTORY}}',
  '- Branch de trabalho: {{BRANCH_NAME}} (criada a partir de {{BASE_BRANCH}})',
  '- Prompt: {{PROMPT_ID}} — {{PROMPT_NAME}} ({{PROMPT_INDEX}} de {{PROMPT_TOTAL}})',
  '- Tentativa: {{ATTEMPT}} de {{MAX_ATTEMPTS}}',
  '',
  '## Comandos de teste do projeto',
  '',
  '{{TEST_COMMANDS}}',
  '',
  'Rode os testes acima antes de encerrar e relate o resultado real. Não invente saída de teste.',
  '',
  EXECUTION_PROHIBITIONS,
  '',
  '## Como trabalhar',
  '',
  '1. Leia o código existente antes de alterar: siga os padrões já adotados no repositório.',
  '2. Faça a menor mudança que resolva o prompt por completo.',
  '3. Deixe o código compilando e os testes passando.',
  '4. Não deixe TODO, FIXME, stub, placeholder nem dado simulado no código de produção.',
  '5. Escreva comentários e mensagens ao usuário em português do Brasil.',
  '',
  '## Prompt a implementar',
  '',
  '{{PROMPT_CONTENT}}',
  '',
  '## Relatório final',
  '',
  'Ao terminar, responda em português com: (a) o que foi implementado, (b) a lista de arquivos',
  'criados/alterados, (c) os comandos de teste executados e o resultado real de cada um,',
  '(d) pendências ou riscos conhecidos. Depois pare — não continue para outro prompt.',
].join('\n');

const CLAUDE_CORRECTION_FALLBACK = [
  '# OrqPEG — correção após revisão',
  '',
  'A implementação anterior deste prompt foi revisada por {{REVIEWER}} e NÃO foi aprovada.',
  'Sua tarefa agora é corrigir os problemas apontados, sem reabrir o escopo.',
  '',
  '## Contexto',
  '',
  '- Projeto: {{PROJECT_NAME}}',
  '- Repositório: {{REPOSITORY_PATH}}',
  '- Diretório de trabalho: {{WORKING_DIRECTORY}}',
  '- Branch de trabalho: {{BRANCH_NAME}} (criada a partir de {{BASE_BRANCH}})',
  '- Prompt: {{PROMPT_ID}} — {{PROMPT_NAME}}',
  '- Tentativa: {{ATTEMPT}} de {{MAX_ATTEMPTS}}',
  '',
  '## Parecer da revisão',
  '',
  '{{REVIEW_SUMMARY}}',
  '',
  '## Ações obrigatórias',
  '',
  '{{REQUIRED_ACTIONS}}',
  '',
  '## Problemas bloqueantes',
  '',
  '{{BLOCKING_ISSUES}}',
  '',
  '## Problemas não bloqueantes',
  '',
  '{{NON_BLOCKING_ISSUES}}',
  '',
  '## Testes que falharam',
  '',
  '{{FAILED_TEST_COMMANDS}}',
  '',
  'Trecho da saída de teste:',
  '',
  '{{TEST_OUTPUT}}',
  '',
  '## Comandos de teste do projeto',
  '',
  '{{TEST_COMMANDS}}',
  '',
  EXECUTION_PROHIBITIONS,
  '',
  '## Como corrigir',
  '',
  '1. Resolva TODOS os problemas bloqueantes e todas as ações obrigatórias.',
  '2. Não altere nada fora do escopo do prompt para "melhorar de passagem".',
  '3. Rode os comandos de teste e confirme que passam antes de encerrar.',
  '4. Se discordar de um apontamento, corrija mesmo assim ou explique tecnicamente no relatório;',
  '   nunca ignore em silêncio.',
  '',
  '## Prompt original (referência de escopo)',
  '',
  '{{PROMPT_CONTENT}}',
  '',
  '## Relatório final',
  '',
  'Responda em português listando: cada problema apontado e como foi resolvido, os arquivos',
  'alterados nesta correção, e o resultado real dos testes. Depois pare.',
].join('\n');

const CLAUDE_MERGE_AUDIT_FALLBACK = [
  '# OrqPEG — auditoria final de merge (Claude)',
  '',
  'Você é auditor SOMENTE LEITURA. Não edite, não crie e não apague nada; não execute',
  'comandos que alterem o repositório. Sua função é decidir se este trabalho pode ser',
  'mesclado na branch base.',
  '',
  '## Contexto',
  '',
  '- Projeto: {{PROJECT_NAME}}',
  '- Repositório: {{REPOSITORY_PATH}}',
  '- Diretório de trabalho: {{WORKING_DIRECTORY}}',
  '- Branch auditada: {{BRANCH_NAME}} → base {{BASE_BRANCH}}',
  '- HEAD auditado: {{HEAD_SHA}}',
  '- Pull request: {{PR_NUMBER}} ({{PR_URL}})',
  '- Confiança mínima exigida para aprovar: {{MINIMUM_CONFIDENCE}}',
  '',
  '## Prompts executados',
  '',
  '{{PROMPTS_SUMMARY}}',
  '',
  '## Arquivos alterados',
  '',
  '{{CHANGED_FILES}}',
  '',
  '## Resumo do diff',
  '',
  '{{DIFF_SUMMARY}}',
  '',
  '## Testes locais',
  '',
  '{{TESTS_SUMMARY}}',
  '',
  '## Integração contínua',
  '',
  '{{CI_SUMMARY}}',
  '',
  '## O que avaliar',
  '',
  '1. O conjunto entrega o que os prompts pediram, sem escopo extra não solicitado.',
  '2. Correção do código: erros de lógica, casos de borda, condições de corrida, vazamentos.',
  '3. Segurança: injeção de comando, path traversal, segredo em código, permissão excessiva.',
  '4. Qualidade: código morto, TODO/FIXME, stub, placeholder, dado simulado em produção.',
  '5. Testes: cobrem o comportamento novo? Passaram de verdade?',
  '6. Risco de regressão na branch base.',
  '',
  'Use `reviewedHeadSha` exatamente igual a {{HEAD_SHA}}. Se você auditou outro commit,',
  'informe o SHA real que leu — a divergência bloqueia o merge, e isso é o comportamento correto.',
  'Só use "APPROVED_FOR_MERGE" se não houver nenhum problema bloqueante.',
  '',
  '{{JSON_RULES}}',
  '',
  '## Schema da resposta',
  '',
  '{{RESPONSE_SCHEMA}}',
].join('\n');

const CODEX_PROMPT_REVIEW_FALLBACK = [
  '# OrqPEG — revisão de prompt (Codex)',
  '',
  'Você é o revisor independente do OrqPEG e trabalha em modo SOMENTE LEITURA.',
  'Avalie se a implementação feita pelo agente executor cumpre o prompt abaixo.',
  'Não edite nada e não execute comandos que alterem o repositório.',
  '',
  '## Contexto',
  '',
  '- Projeto: {{PROJECT_NAME}}',
  '- Repositório: {{REPOSITORY_PATH}}',
  '- Diretório de trabalho: {{WORKING_DIRECTORY}}',
  '- Branch: {{BRANCH_NAME}}',
  '- Prompt: {{PROMPT_ID}} — {{PROMPT_NAME}}',
  '- Tentativa: {{ATTEMPT}} de {{MAX_ATTEMPTS}}',
  '',
  '## Arquivos alterados',
  '',
  '{{CHANGED_FILES}}',
  '',
  '## Resumo do diff',
  '',
  '{{DIFF_SUMMARY}}',
  '',
  '## Testes locais',
  '',
  '{{TESTS_SUMMARY}}',
  '',
  '## Prompt que deveria ter sido implementado',
  '',
  '{{PROMPT_CONTENT}}',
  '',
  '## Critérios de julgamento',
  '',
  '1. `meetsPromptRequirements`: o prompt foi cumprido por completo, sem faltar nada?',
  '2. Escopo: houve alteração não pedida? Liste em `scopeAssessment.unexpectedChanges`.',
  '3. Correção: erros de lógica, casos de borda, tipos frouxos, tratamento de erro ausente.',
  '4. Segurança: injeção de comando, path traversal, segredo exposto, dependência indevida.',
  '5. Qualidade: TODO, FIXME, stub, placeholder, função vazia, dado simulado em produção.',
  '6. Testes: passaram? cobrem o comportamento novo?',
  '',
  'Use "BLOCKED" quando houver risco grave ou impossibilidade de avaliar;',
  '"CHANGES_REQUESTED" quando houver qualquer problema bloqueante;',
  '"APPROVED" somente quando `blockingIssues` estiver vazio e o prompt tiver sido cumprido.',
  '',
  '{{JSON_RULES}}',
  '',
  '## Schema da resposta',
  '',
  '{{RESPONSE_SCHEMA}}',
].join('\n');

const CODEX_MERGE_AUDIT_FALLBACK = [
  '# OrqPEG — auditoria final de merge (Codex)',
  '',
  'Você é o SEGUNDO auditor independente. Trabalhe em modo SOMENTE LEITURA: não edite,',
  'não crie e não apague nada, e não execute comandos que alterem o repositório.',
  'Sua opinião é independente: não presuma que o outro auditor está certo.',
  '',
  '## Contexto',
  '',
  '- Projeto: {{PROJECT_NAME}}',
  '- Repositório: {{REPOSITORY_PATH}}',
  '- Diretório de trabalho: {{WORKING_DIRECTORY}}',
  '- Branch auditada: {{BRANCH_NAME}} → base {{BASE_BRANCH}}',
  '- HEAD auditado: {{HEAD_SHA}}',
  '- Pull request: {{PR_NUMBER}} ({{PR_URL}})',
  '- Confiança mínima exigida para aprovar: {{MINIMUM_CONFIDENCE}}',
  '',
  '## Prompts executados',
  '',
  '{{PROMPTS_SUMMARY}}',
  '',
  '## Arquivos alterados',
  '',
  '{{CHANGED_FILES}}',
  '',
  '## Resumo do diff',
  '',
  '{{DIFF_SUMMARY}}',
  '',
  '## Testes locais',
  '',
  '{{TESTS_SUMMARY}}',
  '',
  '## Integração contínua',
  '',
  '{{CI_SUMMARY}}',
  '',
  '## O que avaliar',
  '',
  '1. O conjunto entrega o que os prompts pediram, sem escopo extra não solicitado.',
  '2. Correção do código: erros de lógica, casos de borda, tratamento de erro, concorrência.',
  '3. Segurança: injeção de comando, path traversal, segredo em código, permissão excessiva.',
  '4. Qualidade: código morto, TODO/FIXME, stub, placeholder, dado simulado em produção.',
  '5. Testes e CI: passaram de fato? cobrem o comportamento novo?',
  '6. Risco de regressão na branch base.',
  '',
  'Use `reviewedHeadSha` exatamente igual a {{HEAD_SHA}}. Se você auditou outro commit,',
  'informe o SHA real que leu — a divergência bloqueia o merge, e isso é o comportamento correto.',
  'Só use "APPROVED_FOR_MERGE" se não houver nenhum problema bloqueante.',
  '',
  '{{JSON_RULES}}',
  '',
  '## Schema da resposta',
  '',
  '{{RESPONSE_SCHEMA}}',
].join('\n');
