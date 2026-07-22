import * as path from 'node:path';
import type {
  IssueSeverity,
  MergeReview,
  MergeVerdict,
  PromptReview,
  Result,
  ReviewIssue,
  ReviewVerdict,
  RiskLevel,
} from '../types';
import type { JsonSchema } from '../config/schema-validator';
import { validateOrFail } from '../config/schema-validator';
import { validateIdentifier } from '../security/path-guard';
import { fail, ok } from '../utils/errors';
import { readJsonSync } from '../utils/fs-atomic';
import { ORQPEG_DIRS } from '../utils/paths';
import { redactText } from '../utils/redact';

/**
 * Extração e validação das revisões produzidas pelas IAs.
 *
 * As IAs escrevem texto; o OrqPEG só aceita decisão estruturada. Este módulo é a
 * fronteira: recupera o JSON da saída livre, valida contra o schema, normaliza
 * os campos com política de falha fechada (na dúvida, reprova) e devolve um
 * objeto tipado. Nada aqui lança exceção.
 */

/** Quantidade de caracteres da saída bruta guardada em mensagens de erro. */
const PREVIEW_CHARS = 400;

/** Menor comprimento aceito para um SHA abreviado. */
const MIN_ABBREVIATED_SHA = 7;

/* ------------------------------------------------------------------------- */
/* Extração do JSON                                                           */
/* ------------------------------------------------------------------------- */

/**
 * Recupera o objeto JSON de uma saída de IA.
 *
 * Estratégia, em ordem: (1) a saída inteira já é JSON; (2) há um bloco cercado
 * por três ou mais crases, opcionalmente marcado como `json`; (3) há um objeto
 * em algum ponto do texto — localizado por balanceamento de chaves que respeita
 * strings e escapes.
 */
export function extractJsonBlock(raw: string): Result<unknown> {
  const text = typeof raw === 'string' ? stripBom(raw).trim() : '';

  if (text.length === 0) {
    return fail('REVIEW_INVALID_JSON', 'A IA não devolveu nenhuma saída para interpretar.');
  }

  const direct = tryParse(text);
  if (direct !== null) return ok(direct.value);

  for (const block of fencedBlocks(text)) {
    const parsedBlock = tryParse(block.trim());
    if (parsedBlock !== null) return ok(parsedBlock.value);

    const balancedInBlock = firstBalancedObject(block);
    if (balancedInBlock !== null) return ok(balancedInBlock.value);
  }

  const balanced = firstBalancedObject(text);
  if (balanced !== null) return ok(balanced.value);

  return fail(
    'REVIEW_INVALID_JSON',
    'Não foi possível extrair um objeto JSON da resposta da IA.',
    { outputLength: text.length, preview: previewOf(text) },
  );
}

/* ------------------------------------------------------------------------- */
/* Revisão de prompt                                                          */
/* ------------------------------------------------------------------------- */

export function parsePromptReview(raw: string, schema: JsonSchema): Result<PromptReview> {
  const extracted = extractJsonBlock(raw);
  if (!extracted.ok) return extracted;

  const validated = validateOrFail<PromptReview>(
    extracted.value,
    schema,
    'A revisão de prompt devolvida pela IA',
  );
  if (!validated.ok) {
    return fail(
      'REVIEW_SCHEMA_MISMATCH',
      'A revisão devolvida pela IA não obedece ao schema de revisão de prompt.',
      { ...(validated.error.details ?? {}) },
    );
  }

  return ok(normalizePromptReview(extracted.value));
}

/* ------------------------------------------------------------------------- */
/* Auditoria de merge                                                         */
/* ------------------------------------------------------------------------- */

export function parseMergeReview(
  raw: string,
  schema: JsonSchema,
  expectedHeadSha: string,
): Result<MergeReview> {
  const extracted = extractJsonBlock(raw);
  if (!extracted.ok) return extracted;

  const validated = validateOrFail<MergeReview>(
    extracted.value,
    schema,
    'A auditoria de merge devolvida pela IA',
  );
  if (!validated.ok) {
    return fail(
      'REVIEW_SCHEMA_MISMATCH',
      'A auditoria devolvida pela IA não obedece ao schema de auditoria de merge.',
      { ...(validated.error.details ?? {}) },
    );
  }

  const review = normalizeMergeReview(extracted.value);

  if (!headShaMatches(review.reviewedHeadSha, expectedHeadSha)) {
    return fail(
      'REVIEW_SCHEMA_MISMATCH',
      'A auditoria revisou um SHA diferente do commit que seria integrado; ' +
        'o parecer é inválido e o merge não pode prosseguir.',
      {
        expectedHeadSha,
        reviewedHeadSha: review.reviewedHeadSha,
      },
    );
  }

  return ok(review);
}

/* ------------------------------------------------------------------------- */
/* Schemas                                                                    */
/* ------------------------------------------------------------------------- */

/** Carrega um schema de `<raiz>/schemas`. */
export function loadSchema(fileName: string): Result<JsonSchema> {
  const validatedName = validateIdentifier(fileName, 'nome do arquivo de schema');
  if (!validatedName.ok) return validatedName;

  const filePath = path.join(ORQPEG_DIRS.schemas(), validatedName.value);
  const read = readJsonSync<unknown>(filePath);
  if (!read.ok) {
    return fail(
      'SCHEMA_INVALID',
      `Não foi possível carregar o schema "${validatedName.value}".`,
      { filePath, reason: read.error.message },
    );
  }

  const record = asRecord(read.value);
  if (record === null) {
    return fail('SCHEMA_INVALID', `O schema "${validatedName.value}" não é um objeto JSON.`, {
      filePath,
    });
  }

  return ok(record as JsonSchema);
}

/* ------------------------------------------------------------------------- */
/* Decisões                                                                   */
/* ------------------------------------------------------------------------- */

/** Aprovação de prompt: veredito aprovado E nenhum problema bloqueante. */
export function reviewIsApproval(review: PromptReview): boolean {
  if (review.verdict !== 'APPROVED') return false;
  return Array.isArray(review.blockingIssues) && review.blockingIssues.length === 0;
}

/** Aprovação de merge: veredito, ausência de bloqueios e confiança suficiente. */
export function mergeReviewIsApproval(review: MergeReview, minimumConfidence: number): boolean {
  if (review.verdict !== 'APPROVED_FOR_MERGE') return false;
  if (!Array.isArray(review.blockingIssues) || review.blockingIssues.length > 0) return false;

  const threshold =
    typeof minimumConfidence === 'number' && Number.isFinite(minimumConfidence)
      ? minimumConfidence
      : 1;
  const confidence = review.confidence;
  if (typeof confidence !== 'number' || !Number.isFinite(confidence)) return false;

  return confidence >= threshold;
}

/* ------------------------------------------------------------------------- */
/* Normalização                                                               */
/* ------------------------------------------------------------------------- */

function normalizePromptReview(value: unknown): PromptReview {
  const record = asRecord(value) ?? {};
  const scope = asRecord(record['scopeAssessment']) ?? {};
  const tests = asRecord(record['testsAssessment']) ?? {};
  const risk = asRecord(record['riskAssessment']) ?? {};

  const verdict = record['verdict'];
  const level = risk['level'];

  return {
    verdict: isReviewVerdict(verdict) ? verdict : 'BLOCKED',
    summary: readText(record['summary']) ?? '(a IA não informou um resumo)',
    confidence: normalizeConfidence(record['confidence']),
    meetsPromptRequirements: record['meetsPromptRequirements'] === true,
    blockingIssues: normalizeIssues(record['blockingIssues'], 'blocking'),
    nonBlockingIssues: normalizeIssues(record['nonBlockingIssues'], 'info'),
    requiredActions: normalizeStringList(record['requiredActions']),
    scopeAssessment: {
      withinScope: scope['withinScope'] === true,
      unexpectedChanges: normalizeStringList(scope['unexpectedChanges']),
    },
    testsAssessment: {
      localTestsPassed: tests['localTestsPassed'] === true,
      coverageAcceptable: tests['coverageAcceptable'] === true,
    },
    riskAssessment: {
      level: isRiskLevel(level) ? level : 'high',
      summary: readText(risk['summary']) ?? '(a IA não informou o risco)',
    },
  };
}

function normalizeMergeReview(value: unknown): MergeReview {
  const record = asRecord(value) ?? {};
  const scope = asRecord(record['scopeAssessment']) ?? {};
  const tests = asRecord(record['testsAssessment']) ?? {};
  const risk = asRecord(record['riskAssessment']) ?? {};

  const verdict = record['verdict'];
  const level = risk['level'];

  return {
    verdict: isMergeVerdict(verdict) ? verdict : 'BLOCKED',
    reviewedHeadSha: readText(record['reviewedHeadSha']) ?? '',
    summary: readText(record['summary']) ?? '(a IA não informou um resumo)',
    confidence: normalizeConfidence(record['confidence']),
    blockingIssues: normalizeIssues(record['blockingIssues'], 'blocking'),
    nonBlockingIssues: normalizeIssues(record['nonBlockingIssues'], 'info'),
    requiredActions: normalizeStringList(record['requiredActions']),
    riskAssessment: {
      level: isRiskLevel(level) ? level : 'high',
      summary: readText(risk['summary']) ?? '(a IA não informou o risco)',
    },
    testsAssessment: {
      localTestsPassed: tests['localTestsPassed'] === true,
      ciPassed: tests['ciPassed'] === true,
      coverageAcceptable: tests['coverageAcceptable'] === true,
    },
    scopeAssessment: {
      withinScope: scope['withinScope'] === true,
      unexpectedChanges: normalizeStringList(scope['unexpectedChanges']),
    },
  };
}

/**
 * Confiança sempre em [0, 1].
 *
 * Valores entre 1 (exclusivo) e 100 são interpretados como porcentagem — é o
 * erro mais comum das IAs (`85` querendo dizer 85%). Qualquer outra coisa é
 * limitada ao intervalo; valores inválidos viram 0 (falha fechada).
 */
function normalizeConfidence(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  if (value <= 0) return 0;
  if (value <= 1) return value;
  if (value <= 100) return value / 100;
  return 1;
}

function normalizeStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    const items: string[] = [];
    for (const item of value as unknown[]) {
      const text = readText(item) ?? readText(asRecord(item)?.['text']);
      if (text !== null) items.push(text);
    }
    return items;
  }
  const single = readText(value);
  if (single === null) return [];
  return single
    .split('\n')
    .map((line) => line.replace(/^\s*[-*+]\s+/, '').trim())
    .filter((line) => line.length > 0);
}

function normalizeIssues(value: unknown, fallbackSeverity: IssueSeverity): ReviewIssue[] {
  if (!Array.isArray(value)) return [];

  const issues: ReviewIssue[] = [];
  for (const item of value as unknown[]) {
    const asText = readText(item);
    if (asText !== null) {
      issues.push({
        severity: fallbackSeverity,
        title: asText,
        description: asText,
      });
      continue;
    }

    const record = asRecord(item);
    if (record === null) continue;

    const severity = record['severity'];
    const file = readText(record['file']);
    const line = record['line'];
    const suggestion = readText(record['suggestion']);
    const title = readText(record['title']);
    const description = readText(record['description']);

    issues.push({
      severity: isIssueSeverity(severity) ? severity : fallbackSeverity,
      title: title ?? description ?? '(problema sem título)',
      description: description ?? title ?? '(problema sem descrição)',
      ...(file !== null ? { file } : {}),
      ...(typeof line === 'number' && Number.isFinite(line) ? { line: Math.trunc(line) } : {}),
      ...(suggestion !== null ? { suggestion } : {}),
    });
  }
  return issues;
}

/* ------------------------------------------------------------------------- */
/* Comparação de SHA                                                          */
/* ------------------------------------------------------------------------- */

const HEX_SHA = /^[0-9a-f]{7,64}$/;

/**
 * Compara o SHA auditado com o esperado.
 * Aceita SHA abreviado (mínimo de 7 caracteres) como prefixo do outro.
 */
function headShaMatches(reviewed: string, expected: string): boolean {
  const left = reviewed.trim().toLowerCase();
  const right = expected.trim().toLowerCase();

  if (left.length === 0 || right.length === 0) return false;
  if (!HEX_SHA.test(left)) return false;
  if (left === right) return true;
  if (right.startsWith(left)) return true;
  if (right.length >= MIN_ABBREVIATED_SHA && left.startsWith(right)) return true;
  return false;
}

/* ------------------------------------------------------------------------- */
/* Apoio                                                                      */
/* ------------------------------------------------------------------------- */

function tryParse(text: string): { value: unknown } | null {
  if (text.length === 0) return null;
  try {
    return { value: JSON.parse(text) as unknown };
  } catch {
    return null;
  }
}

/** Blocos cercados por três ou mais crases, com marcação de linguagem opcional. */
function fencedBlocks(text: string): string[] {
  const pattern = /(`{3,})[ \t]*[A-Za-z0-9_+.-]*[ \t]*\r?\n([\s\S]*?)\1/g;
  const blocks: string[] = [];
  let match: RegExpExecArray | null = pattern.exec(text);
  while (match !== null) {
    const body = match[2];
    if (body !== undefined && body.trim().length > 0) blocks.push(body);
    match = pattern.exec(text);
  }
  return blocks;
}

/**
 * Procura o primeiro objeto JSON válido do texto.
 * Cada `{` é candidato a início; o fim é a chave correspondente, encontrada por
 * balanceamento que ignora chaves dentro de strings e caracteres escapados.
 */
function firstBalancedObject(text: string): { value: unknown } | null {
  let from = text.indexOf('{');
  while (from !== -1) {
    const candidate = balancedSlice(text, from);
    if (candidate !== null) {
      const parsed = tryParse(candidate);
      if (parsed !== null) return parsed;
    }
    from = text.indexOf('{', from + 1);
  }
  return null;
}

function balancedSlice(text: string, start: number): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    const char = text.charAt(i);

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{') {
      depth += 1;
      continue;
    }
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
      if (depth < 0) return null;
    }
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isReviewVerdict(value: unknown): value is ReviewVerdict {
  return value === 'APPROVED' || value === 'CHANGES_REQUESTED' || value === 'BLOCKED';
}

function isMergeVerdict(value: unknown): value is MergeVerdict {
  return value === 'APPROVED_FOR_MERGE' || value === 'CHANGES_REQUIRED' || value === 'BLOCKED';
}

function isIssueSeverity(value: unknown): value is IssueSeverity {
  return value === 'blocking' || value === 'major' || value === 'minor' || value === 'info';
}

function isRiskLevel(value: unknown): value is RiskLevel {
  return value === 'low' || value === 'medium' || value === 'high' || value === 'critical';
}

function previewOf(text: string): string {
  const slice = text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS)}…` : text;
  return redactText(slice);
}

function stripBom(value: string): string {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}
