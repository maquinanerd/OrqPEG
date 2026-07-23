/**
 * Slug de projeto.
 *
 * O slug é o identificador estável do projeto e vira nome de diretório em
 * `data/projects/<slug>`. Por isso é deliberadamente restritivo: apenas letras
 * minúsculas ASCII, dígitos e hífens simples. Acentos são reduzidos ao caractere
 * base (`Ação` → `acao`) para que caminhos continuem previsíveis no Windows,
 * independentemente da página de código do console.
 */

/** Comprimento máximo do slug, alinhado ao limite usado em nomes de branch. */
export const MAX_SLUG_LENGTH = 60;

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Marcas de combinação (acentos) produzidas pela normalização NFD.
 * Declarada por escape Unicode para não depender da codificação do arquivo.
 */
const COMBINING_MARKS = new RegExp('[\\u0300-\\u036f]', 'g');

/**
 * Converte texto livre em slug.
 *
 * Idempotente: `toSlug(toSlug(x)) === toSlug(x)`. Devolve string vazia quando a
 * entrada não possui nenhum caractere aproveitável — cabe a quem chama decidir
 * o que fazer nesse caso.
 */
export function toSlug(value: string): string {
  const withoutAccents = value.normalize('NFD').replace(COMBINING_MARKS, '');
  const hyphenated = withoutAccents.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const collapsed = hyphenated
    .replace(/-{2,}/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '');

  if (collapsed.length <= MAX_SLUG_LENGTH) return collapsed;
  // Corta no limite e remove um eventual hífen deixado pela truncagem.
  return collapsed.slice(0, MAX_SLUG_LENGTH).replace(/-+$/, '');
}

/** Verdadeiro quando o valor já é um slug canônico. */
export function isValidSlug(value: string): boolean {
  if (value.length === 0 || value.length > MAX_SLUG_LENGTH) return false;
  return SLUG_PATTERN.test(value);
}
