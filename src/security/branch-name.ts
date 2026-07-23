import type { Result } from '../types';
import { fail, ok } from '../utils/errors';

/**
 * Sanitização e validação de nomes de branch.
 *
 * Segue as regras de `git check-ref-format` e adiciona uma restrição extra: o
 * nome só pode conter `[A-Za-z0-9._/-]`. Isso elimina qualquer possibilidade de
 * um nome de branch ser interpretado como opção de linha de comando ou como
 * metacaractere de shell — mesmo que o `spawn` já use argumentos vetorizados.
 */

const ALLOWED = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

export function validateBranchName(name: string): Result<string> {
  const trimmed = name.trim();

  if (trimmed.length === 0) return fail('VALIDATION_FAILED', 'Nome de branch vazio.');
  if (trimmed.length > 200) {
    return fail('VALIDATION_FAILED', 'Nome de branch excede 200 caracteres.', {
      length: trimmed.length,
    });
  }
  for (let i = 0; i < trimmed.length; i += 1) {
    const code = trimmed.charCodeAt(i);
    if (code < 32 || code === 127) {
      return fail('VALIDATION_FAILED', 'Nome de branch contém caracteres de controle.');
    }
  }
  if (!ALLOWED.test(trimmed)) {
    return fail(
      'VALIDATION_FAILED',
      'Nome de branch inválido: use apenas letras, números, ponto, hífen, sublinhado e barra, começando por letra ou número.',
      { name: trimmed },
    );
  }
  if (trimmed.includes('..')) {
    return fail('VALIDATION_FAILED', 'Nome de branch não pode conter "..".', { name: trimmed });
  }
  if (trimmed.includes('//')) {
    return fail('VALIDATION_FAILED', 'Nome de branch não pode conter "//".', { name: trimmed });
  }
  if (trimmed.endsWith('/') || trimmed.endsWith('.') || trimmed.endsWith('.lock')) {
    return fail(
      'VALIDATION_FAILED',
      'Nome de branch não pode terminar com "/", "." ou ".lock".',
      { name: trimmed },
    );
  }
  if (trimmed.split('/').some((segment) => segment.length === 0 || segment.endsWith('.lock'))) {
    return fail('VALIDATION_FAILED', 'Segmento de branch inválido.', { name: trimmed });
  }
  if (trimmed === '@' || trimmed.includes('@{')) {
    return fail('VALIDATION_FAILED', 'Nome de branch não pode conter "@{" nem ser "@".', {
      name: trimmed,
    });
  }
  return ok(trimmed);
}

/** Converte texto livre em um segmento de branch seguro. */
export function slugifyForBranch(value: string): string {
  const normalized = value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return normalized.length > 0 ? normalized.slice(0, 60) : 'run';
}

/**
 * Monta o nome canônico de branch de execução do OrqPEG:
 * `orqpeg/<projeto>/run-<stamp>`.
 */
export function buildRunBranchName(projectId: string, stamp: string): Result<string> {
  const candidate = `orqpeg/${slugifyForBranch(projectId)}/run-${slugifyForBranch(stamp)}`;
  return validateBranchName(candidate);
}
