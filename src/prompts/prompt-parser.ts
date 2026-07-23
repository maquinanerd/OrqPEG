import * as path from 'node:path';
import { toSlug } from '../projects/slug';

/**
 * Parser dos prompts em Markdown.
 *
 * O formato canônico é o `TEMPLATE-PROMPT.md` do produto, com seções em
 * português. O parser é deliberadamente tolerante:
 *
 *  - aceita `#` ou `##` (até `######`) nos títulos;
 *  - aceita títulos com ou sem acento e com numeração ("2. Objetivo");
 *  - aceita itens com `-`, `*`, `+`, `1.` e caixas de seleção `[ ]`;
 *  - ignora blocos de código cercados por crases;
 *  - quando o arquivo não segue o template, nada falha: o conteúdo inteiro vira
 *    `rawBody` e também `objective`, e as listas ficam vazias.
 *
 * A seção "Evidências finais exigidas" é reconhecida para não contaminar a
 * seção anterior, mas não possui campo próprio em `ParsedPrompt`: seu conteúdo
 * permanece disponível em `rawBody`.
 */

export interface ParsedPrompt {
  /** Identificador estável, sempre em formato de slug. */
  id: string;
  name: string;
  objective: string;
  scope: string[];
  outOfScope: string[];
  allowedAreas: string[];
  forbiddenAreas: string[];
  functionalRequirements: string[];
  technicalRequirements: string[];
  acceptanceCriteria: string[];
  requiredTests: string[];
  restrictions: string[];
  dependencies: string[];
  /** Conteúdo integral do arquivo, com quebras de linha normalizadas. */
  rawBody: string;
}

type SectionKey =
  | 'identification'
  | 'objective'
  | 'context'
  | 'scope'
  | 'outOfScope'
  | 'allowedAreas'
  | 'forbiddenAreas'
  | 'functionalRequirements'
  | 'technicalRequirements'
  | 'acceptanceCriteria'
  | 'requiredTests'
  | 'restrictions'
  | 'dependencies'
  | 'evidence'
  | 'other';

/**
 * Títulos aceitos, já normalizados (minúsculos, sem acento e sem pontuação).
 * A comparação é por prefixo, então "Escopo obrigatório (o que fazer)" também
 * é reconhecido.
 */
const HEADING_ALIASES: ReadonlyArray<readonly [string, SectionKey]> = [
  ['identificacao', 'identification'],
  ['objetivo', 'objective'],
  ['objetivos', 'objective'],
  ['contexto', 'context'],
  ['escopo obrigatorio', 'scope'],
  ['escopo do trabalho', 'scope'],
  ['escopo', 'scope'],
  ['fora do escopo', 'outOfScope'],
  ['fora de escopo', 'outOfScope'],
  ['areas permitidas', 'allowedAreas'],
  ['arquivos permitidos', 'allowedAreas'],
  ['areas proibidas', 'forbiddenAreas'],
  ['arquivos proibidos', 'forbiddenAreas'],
  ['requisitos funcionais', 'functionalRequirements'],
  ['requisitos tecnicos', 'technicalRequirements'],
  ['criterios de aceitacao', 'acceptanceCriteria'],
  ['criterios de aceite', 'acceptanceCriteria'],
  ['testes obrigatorios', 'requiredTests'],
  ['testes exigidos', 'requiredTests'],
  ['testes', 'requiredTests'],
  ['restricoes', 'restrictions'],
  ['limitacoes', 'restrictions'],
  ['dependencias', 'dependencies'],
  ['pre requisitos', 'dependencies'],
  ['prerequisitos', 'dependencies'],
  ['evidencias finais exigidas', 'evidence'],
  ['evidencias finais', 'evidence'],
  ['evidencias', 'evidence'],
];

/** Aliases ordenados do mais específico para o mais genérico. */
const SORTED_ALIASES = [...HEADING_ALIASES].sort((a, b) => b[0].length - a[0].length);

const ID_LABELS: readonly string[] = ['id', 'identificador', 'prompt id', 'id do prompt'];
const NAME_LABELS: readonly string[] = ['nome', 'name', 'titulo', 'title', 'nome do prompt'];

const COMBINING_MARKS = new RegExp('[\\u0300-\\u036f]', 'g');
const HEADING_LINE = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/;
const FENCE_LINE = /^\s*(?:```|~~~)/;
const LIST_ITEM = /^(?:[-*+]|\d+[.)])\s+(.*)$/;

export function parsePrompt(fileName: string, content: string): ParsedPrompt {
  const normalizedContent = content.replace(/\r\n?/g, '\n');
  const lines = normalizedContent.split('\n');
  const buckets = collectSections(lines);

  const rawId = findLabeledValue(lines, ID_LABELS);
  const rawName = findLabeledValue(lines, NAME_LABELS);
  const fileBase = path.basename(fileName).replace(/\.[^.]+$/, '');

  const id = firstNonEmpty(
    rawId === null ? '' : toSlug(rawId),
    toSlug(fileBase),
    'prompt',
  );
  const name = firstNonEmpty(
    rawName === null ? '' : rawName.trim(),
    deriveNameFromFileName(fileName),
    id,
  );

  const objective = firstNonEmpty(
    joinParagraph(buckets.get('objective')),
    joinParagraph(buckets.get('other')),
    normalizedContent.trim(),
  );

  return {
    id,
    name,
    objective,
    scope: extractItems(buckets.get('scope')),
    outOfScope: extractItems(buckets.get('outOfScope')),
    allowedAreas: extractItems(buckets.get('allowedAreas')),
    forbiddenAreas: extractItems(buckets.get('forbiddenAreas')),
    functionalRequirements: extractItems(buckets.get('functionalRequirements')),
    technicalRequirements: extractItems(buckets.get('technicalRequirements')),
    acceptanceCriteria: extractItems(buckets.get('acceptanceCriteria')),
    requiredTests: extractItems(buckets.get('requiredTests')),
    restrictions: extractItems(buckets.get('restrictions')),
    dependencies: extractItems(buckets.get('dependencies')),
    rawBody: normalizedContent.trim(),
  };
}

/** Distribui as linhas do arquivo entre as seções reconhecidas. */
function collectSections(lines: readonly string[]): Map<SectionKey, string[]> {
  const buckets = new Map<SectionKey, string[]>();
  let current: SectionKey = 'other';
  let insideFence = false;

  for (const line of lines) {
    if (FENCE_LINE.test(line)) {
      insideFence = !insideFence;
      appendTo(buckets, current, line);
      continue;
    }

    if (!insideFence) {
      const heading = HEADING_LINE.exec(line);
      const title = heading?.[2];
      if (title !== undefined) {
        current = resolveSection(normalizeHeading(title));
        continue;
      }
    }

    appendTo(buckets, current, line);
  }

  return buckets;
}

function appendTo(buckets: Map<SectionKey, string[]>, key: SectionKey, line: string): void {
  const existing = buckets.get(key);
  if (existing === undefined) {
    buckets.set(key, [line]);
    return;
  }
  existing.push(line);
}

function resolveSection(normalizedTitle: string): SectionKey {
  if (normalizedTitle.length === 0) return 'other';
  for (const [alias, key] of SORTED_ALIASES) {
    if (normalizedTitle === alias || normalizedTitle.startsWith(`${alias} `)) return key;
  }
  return 'other';
}

/** Minúsculas, sem acento, sem marcação e sem numeração inicial. */
function normalizeHeading(value: string): string {
  return value
    .normalize('NFD')
    .replace(COMBINING_MARKS, '')
    .toLowerCase()
    .replace(/[*_`~#]/g, ' ')
    .replace(/^\s*\d+[.)]\s*/, '')
    .replace(/[^a-z0-9\s/-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Extrai os itens de lista de uma seção; sem itens, usa as linhas de texto. */
function extractItems(lines: readonly string[] | undefined): string[] {
  if (lines === undefined) return [];

  const items: string[] = [];
  const fallback: string[] = [];
  let insideFence = false;

  for (const line of lines) {
    if (FENCE_LINE.test(line)) {
      insideFence = !insideFence;
      continue;
    }
    if (insideFence) continue;

    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    if (/^[-*_]{3,}$/.test(trimmed)) continue; // separador horizontal

    const bullet = LIST_ITEM.exec(trimmed);
    if (bullet !== null) {
      const text = cleanItem(bullet[1] ?? '');
      if (text.length > 0) items.push(text);
      continue;
    }

    const plain = cleanItem(trimmed);
    if (plain.length > 0) fallback.push(plain);
  }

  return items.length > 0 ? items : fallback;
}

function cleanItem(value: string): string {
  const withoutCheckbox = value.replace(/^\[[ xX]\]\s*/, '').trim();
  const withoutBold = /^\*\*(.+)\*\*$/.exec(withoutCheckbox);
  return (withoutBold?.[1] ?? withoutCheckbox).trim();
}

/** Junta as linhas de uma seção em texto corrido, preservando parágrafos. */
function joinParagraph(lines: readonly string[] | undefined): string {
  if (lines === undefined) return '';
  const kept: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      if (kept.length > 0 && kept[kept.length - 1] !== '') kept.push('');
      continue;
    }
    kept.push(trimmed);
  }
  while (kept.length > 0 && kept[kept.length - 1] === '') kept.pop();
  return kept.join('\n').trim();
}

/** Procura linhas do tipo `ID: valor` ou `**Nome:** valor` no arquivo inteiro. */
function findLabeledValue(lines: readonly string[], labels: readonly string[]): string | null {
  for (const line of lines) {
    const stripped = line
      .replace(/[*_`>#]/g, '')
      .replace(/^\s*(?:[-+]|\d+[.)])\s*/, '')
      .trim();
    const separator = stripped.indexOf(':');
    if (separator <= 0) continue;

    const label = normalizeHeading(stripped.slice(0, separator));
    if (!labels.includes(label)) continue;

    const value = stripped.slice(separator + 1).trim();
    if (value.length > 0) return value;
  }
  return null;
}

/** "10-refatorar-modulo.md" → "Refatorar modulo". */
function deriveNameFromFileName(fileName: string): string {
  const base = path.basename(fileName).replace(/\.[^.]+$/, '');
  const withoutOrder = base.replace(/^\s*\d+\s*[-_.)]?\s*/, '');
  const source = withoutOrder.length > 0 ? withoutOrder : base;
  const spaced = source.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (spaced.length === 0) return base.trim();
  return `${spaced.charAt(0).toUpperCase()}${spaced.slice(1)}`;
}

function firstNonEmpty(...candidates: string[]): string {
  for (const candidate of candidates) {
    if (candidate.length > 0) return candidate;
  }
  return '';
}
