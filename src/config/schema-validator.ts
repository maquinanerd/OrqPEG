import type { Result } from '../types';
import { fail, ok } from '../utils/errors';

/**
 * Validador de JSON Schema (subconjunto draft-07).
 *
 * Implementado internamente para manter a promessa de zero dependências de
 * runtime. Suporta os construtos efetivamente usados pelos schemas do OrqPEG:
 *
 *   type, enum, const, properties, required, additionalProperties, items,
 *   minItems, maxItems, minimum, maximum, minLength, maxLength, pattern,
 *   anyOf, oneOf, allOf, not, $ref (apenas #/definitions/<nome>), nullable
 *   via type: ["string", "null"].
 */

export interface JsonSchema {
  $schema?: string;
  $id?: string;
  title?: string;
  description?: string;
  type?: string | string[];
  enum?: unknown[];
  const?: unknown;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  multipleOf?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  format?: string;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  allOf?: JsonSchema[];
  not?: JsonSchema;
  definitions?: Record<string, JsonSchema>;
  $ref?: string;
  default?: unknown;
  [key: string]: unknown;
}

export interface ValidationIssue {
  path: string;
  message: string;
}

export interface ValidationOutcome {
  valid: boolean;
  issues: ValidationIssue[];
}

export function validateAgainstSchema(value: unknown, schema: JsonSchema): ValidationOutcome {
  const issues: ValidationIssue[] = [];
  walk(value, schema, '$', schema, issues, 0);
  return { valid: issues.length === 0, issues };
}

/** Variante que devolve `Result`, para uso direto nos pipelines do OrqPEG. */
export function validateOrFail<T>(
  value: unknown,
  schema: JsonSchema,
  label: string,
): Result<T> {
  const outcome = validateAgainstSchema(value, schema);
  if (outcome.valid) return ok(value as T);
  return fail('SCHEMA_INVALID', `${label} não obedece ao schema.`, {
    issues: outcome.issues.slice(0, 30),
    issueCount: outcome.issues.length,
  });
}

function walk(
  value: unknown,
  schema: JsonSchema,
  path: string,
  root: JsonSchema,
  issues: ValidationIssue[],
  depth: number,
): void {
  if (depth > 60) {
    issues.push({ path, message: 'Profundidade máxima de validação excedida.' });
    return;
  }

  if (typeof schema.$ref === 'string') {
    const resolved = resolveRef(schema.$ref, root);
    if (!resolved) {
      issues.push({ path, message: `Referência não resolvida: ${schema.$ref}` });
      return;
    }
    walk(value, resolved, path, root, issues, depth + 1);
    return;
  }

  if (schema.const !== undefined && !deepEqual(value, schema.const)) {
    issues.push({ path, message: `Esperado o valor constante ${JSON.stringify(schema.const)}.` });
  }

  if (Array.isArray(schema.enum) && !schema.enum.some((option) => deepEqual(option, value))) {
    issues.push({
      path,
      message: `Valor fora do conjunto permitido: ${schema.enum.map((e) => JSON.stringify(e)).join(', ')}.`,
    });
  }

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => matchesType(value, t))) {
      issues.push({
        path,
        message: `Tipo inválido: esperado ${types.join(' | ')}, recebido ${describeType(value)}.`,
      });
      return; // demais checagens dependem do tipo correto
    }
  }

  if (typeof value === 'string') validateString(value, schema, path, issues);
  if (typeof value === 'number') validateNumber(value, schema, path, issues);
  if (Array.isArray(value)) validateArray(value, schema, path, root, issues, depth);
  if (isPlainObject(value)) validateObject(value, schema, path, root, issues, depth);

  if (Array.isArray(schema.allOf)) {
    for (const sub of schema.allOf) walk(value, sub, path, root, issues, depth + 1);
  }

  if (Array.isArray(schema.anyOf)) {
    const anyValid = schema.anyOf.some((sub) => isValid(value, sub, root, depth + 1));
    if (!anyValid) {
      issues.push({ path, message: 'Valor não satisfaz nenhuma das alternativas de "anyOf".' });
    }
  }

  if (Array.isArray(schema.oneOf)) {
    const matches = schema.oneOf.filter((sub) => isValid(value, sub, root, depth + 1)).length;
    if (matches !== 1) {
      issues.push({
        path,
        message: `Valor deveria satisfazer exatamente uma alternativa de "oneOf" (satisfez ${matches}).`,
      });
    }
  }

  if (schema.not !== undefined && isValid(value, schema.not, root, depth + 1)) {
    issues.push({ path, message: 'Valor satisfaz a restrição "not".' });
  }
}

function validateString(
  value: string,
  schema: JsonSchema,
  path: string,
  issues: ValidationIssue[],
): void {
  if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
    issues.push({ path, message: `Comprimento mínimo é ${schema.minLength}.` });
  }
  if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) {
    issues.push({ path, message: `Comprimento máximo é ${schema.maxLength}.` });
  }
  if (typeof schema.pattern === 'string') {
    let regex: RegExp;
    try {
      regex = new RegExp(schema.pattern);
    } catch {
      issues.push({ path, message: `Padrão inválido no schema: ${schema.pattern}` });
      return;
    }
    if (!regex.test(value)) {
      issues.push({ path, message: `Valor não corresponde ao padrão ${schema.pattern}.` });
    }
  }
}

function validateNumber(
  value: number,
  schema: JsonSchema,
  path: string,
  issues: ValidationIssue[],
): void {
  if (typeof schema.minimum === 'number' && value < schema.minimum) {
    issues.push({ path, message: `Valor mínimo é ${schema.minimum}.` });
  }
  if (typeof schema.maximum === 'number' && value > schema.maximum) {
    issues.push({ path, message: `Valor máximo é ${schema.maximum}.` });
  }
  if (typeof schema.exclusiveMinimum === 'number' && value <= schema.exclusiveMinimum) {
    issues.push({ path, message: `Valor deve ser maior que ${schema.exclusiveMinimum}.` });
  }
  if (typeof schema.exclusiveMaximum === 'number' && value >= schema.exclusiveMaximum) {
    issues.push({ path, message: `Valor deve ser menor que ${schema.exclusiveMaximum}.` });
  }
  if (typeof schema.multipleOf === 'number' && schema.multipleOf > 0) {
    const ratio = value / schema.multipleOf;
    if (Math.abs(ratio - Math.round(ratio)) > 1e-9) {
      issues.push({ path, message: `Valor deve ser múltiplo de ${schema.multipleOf}.` });
    }
  }
}

function validateArray(
  value: unknown[],
  schema: JsonSchema,
  path: string,
  root: JsonSchema,
  issues: ValidationIssue[],
  depth: number,
): void {
  if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
    issues.push({ path, message: `Mínimo de ${schema.minItems} itens.` });
  }
  if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
    issues.push({ path, message: `Máximo de ${schema.maxItems} itens.` });
  }
  if (schema.uniqueItems === true) {
    const seen = new Set<string>();
    for (const item of value) {
      const key = stableKey(item);
      if (seen.has(key)) {
        issues.push({ path, message: 'Itens do array devem ser únicos.' });
        break;
      }
      seen.add(key);
    }
  }
  if (schema.items) {
    value.forEach((item, index) => {
      walk(item, schema.items as JsonSchema, `${path}[${index}]`, root, issues, depth + 1);
    });
  }
}

function validateObject(
  value: Record<string, unknown>,
  schema: JsonSchema,
  path: string,
  root: JsonSchema,
  issues: ValidationIssue[],
  depth: number,
): void {
  if (Array.isArray(schema.required)) {
    for (const key of schema.required) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) {
        issues.push({ path: `${path}.${key}`, message: 'Propriedade obrigatória ausente.' });
      }
    }
  }

  const properties = schema.properties ?? {};
  for (const [key, subSchema] of Object.entries(properties)) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      walk(value[key], subSchema, `${path}.${key}`, root, issues, depth + 1);
    }
  }

  if (schema.additionalProperties === false) {
    const known = new Set(Object.keys(properties));
    for (const key of Object.keys(value)) {
      if (!known.has(key)) {
        issues.push({ path: `${path}.${key}`, message: 'Propriedade adicional não permitida.' });
      }
    }
  } else if (isPlainObject(schema.additionalProperties)) {
    const known = new Set(Object.keys(properties));
    const extraSchema = schema.additionalProperties as JsonSchema;
    for (const key of Object.keys(value)) {
      if (!known.has(key)) {
        walk(value[key], extraSchema, `${path}.${key}`, root, issues, depth + 1);
      }
    }
  }
}

function isValid(value: unknown, schema: JsonSchema, root: JsonSchema, depth: number): boolean {
  const issues: ValidationIssue[] = [];
  walk(value, schema, '$', root, issues, depth);
  return issues.length === 0;
}

function resolveRef(ref: string, root: JsonSchema): JsonSchema | null {
  if (!ref.startsWith('#/')) return null;
  const segments = ref.slice(2).split('/');
  let current: unknown = root;
  for (const segment of segments) {
    const key = segment.replace(/~1/g, '/').replace(/~0/g, '~');
    if (!isPlainObject(current)) return null;
    current = (current as Record<string, unknown>)[key];
  }
  return isPlainObject(current) ? (current as JsonSchema) : null;
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'object':
      return isPlainObject(value);
    case 'array':
      return Array.isArray(value);
    case 'null':
      return value === null;
    default:
      return false;
  }
}

function describeType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => deepEqual(item, b[index]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every((key) => deepEqual(a[key], b[key]));
  }
  return false;
}

function stableKey(value: unknown): string {
  try {
    return JSON.stringify(value, Object.keys(value as object).sort());
  } catch {
    return String(value);
  }
}
