import * as path from 'node:path';
import type { Result } from '../types';
import { fail, ok } from '../utils/errors';
import { isInside } from '../utils/paths';

/**
 * Proteção contra path traversal e caminhos maliciosos.
 *
 * Usado em duas frentes:
 *  - servidor HTTP do painel, que só pode servir arquivos de `public/`;
 *  - identificadores vindos do usuário (slug de projeto, id de prompt, run id),
 *    que são usados para compor caminhos em `data/`.
 */

/**
 * Byte nulo e caracteres de controle: nunca aceitos em caminho algum.
 *
 * Implementado por código de caractere em vez de expressão regular para evitar
 * literais de controle no fonte, que são frágeis a reencodificação de arquivo.
 */
function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

const CONTROL_CHARS = { test: hasControlChars };

/** Metacaracteres inválidos em nomes de arquivo do Windows. */
const WINDOWS_INVALID_CHARS = /[<>:"|?*]/;

/** Nomes reservados do Windows que não podem ser usados como diretório/arquivo. */
const WINDOWS_RESERVED = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
]);

/**
 * Valida um identificador que será usado como nome de diretório.
 * Aceita apenas `[A-Za-z0-9._-]`, sem separadores, sem `..`, sem nomes reservados.
 */
export function validateIdentifier(value: string, label = 'identificador'): Result<string> {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return fail('PATH_UNSAFE', `${label} não pode ser vazio.`);
  }
  if (trimmed.length > 100) {
    return fail('PATH_UNSAFE', `${label} excede 100 caracteres.`, { length: trimmed.length });
  }
  if (CONTROL_CHARS.test(trimmed)) {
    return fail('PATH_UNSAFE', `${label} contém caracteres de controle.`);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(trimmed)) {
    return fail(
      'PATH_UNSAFE',
      `${label} inválido: use apenas letras, números, ponto, hífen e sublinhado, começando por letra ou número.`,
      { value: trimmed },
    );
  }
  if (trimmed.includes('..')) {
    return fail('PATH_UNSAFE', `${label} não pode conter "..".`, { value: trimmed });
  }
  const base = trimmed.split('.')[0] ?? trimmed;
  if (WINDOWS_RESERVED.has(base.toLowerCase())) {
    return fail('PATH_UNSAFE', `${label} usa um nome reservado do Windows.`, { value: trimmed });
  }
  if (trimmed.endsWith('.')) {
    return fail('PATH_UNSAFE', `${label} não pode terminar com ponto.`, { value: trimmed });
  }
  return ok(trimmed);
}

/**
 * Resolve com segurança um caminho relativo dentro de uma raiz.
 * Falha se o resultado escapar da raiz (traversal, absoluto, codificação dupla).
 */
export function resolveWithinRoot(root: string, relative: string): Result<string> {
  if (CONTROL_CHARS.test(relative)) {
    return fail('PATH_UNSAFE', 'Caminho contém caracteres de controle.', { relative });
  }
  const decoded = safeDecode(relative);
  if (decoded === null) {
    return fail('PATH_UNSAFE', 'Caminho com codificação inválida.', { relative });
  }
  if (CONTROL_CHARS.test(decoded)) {
    return fail('PATH_UNSAFE', 'Caminho decodificado contém caracteres de controle.', {
      relative,
    });
  }
  if (path.isAbsolute(decoded) || /^[A-Za-z]:/.test(decoded)) {
    return fail('PATH_UNSAFE', 'Caminho absoluto não é permitido.', { relative });
  }
  const normalized = decoded.replace(/\\/g, '/').replace(/^\/+/, '');
  if (WINDOWS_INVALID_CHARS.test(normalized)) {
    return fail('PATH_UNSAFE', 'Caminho contém caracteres inválidos.', { relative });
  }
  if (normalized.split('/').some((segment) => segment === '..')) {
    return fail('PATH_UNSAFE', 'Caminho tenta sair do diretório permitido.', { relative });
  }
  const resolved = path.resolve(root, normalized);
  if (!isInside(root, resolved)) {
    return fail('PATH_UNSAFE', 'Caminho resolvido fora da raiz permitida.', { relative, root });
  }
  return ok(resolved);
}

/** Valida que um caminho informado pelo usuário é absoluto e sintaticamente seguro. */
export function validateAbsolutePath(value: string, label = 'caminho'): Result<string> {
  const trimmed = value.trim().replace(/^"+|"+$/g, '');
  if (trimmed.length === 0) {
    return fail('PATH_UNSAFE', `${label} não pode ser vazio.`);
  }
  if (CONTROL_CHARS.test(trimmed)) {
    return fail('PATH_UNSAFE', `${label} contém caracteres de controle.`);
  }
  if (!path.isAbsolute(trimmed)) {
    return fail('PATH_UNSAFE', `${label} deve ser absoluto (ex.: E:\\Projetos\\MeuApp).`, {
      value: trimmed,
    });
  }
  return ok(path.resolve(trimmed));
}

function safeDecode(value: string): string | null {
  try {
    let current = value;
    // Decodifica no máximo duas vezes para neutralizar `%252e%252e`.
    for (let i = 0; i < 2; i += 1) {
      const next = decodeURIComponent(current);
      if (next === current) break;
      current = next;
    }
    return current;
  } catch {
    return null;
  }
}
