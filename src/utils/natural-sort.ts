/**
 * Ordenação natural.
 *
 * Garante que `2-etapa.md` venha antes de `10-etapa.md`, que por sua vez venha
 * antes de `20-etapa.md`. A comparação é feita por segmentos alternados de
 * dígitos e não-dígitos, com desempate insensível a maiúsculas e acentos.
 */

const SEGMENT = /(\d+)|(\D+)/g;

export function naturalCompare(a: string, b: string): number {
  const left = segments(a);
  const right = segments(b);
  const max = Math.max(left.length, right.length);

  for (let i = 0; i < max; i += 1) {
    const l = left[i];
    const r = right[i];
    if (l === undefined) return -1;
    if (r === undefined) return 1;

    if (typeof l === 'number' && typeof r === 'number') {
      if (l !== r) return l < r ? -1 : 1;
      continue;
    }
    const ls = String(l);
    const rs = String(r);
    if (ls === rs) continue;
    const cmp = ls.localeCompare(rs, 'pt-BR', { sensitivity: 'base', numeric: false });
    if (cmp !== 0) return cmp;
    if (ls < rs) return -1;
    if (ls > rs) return 1;
  }
  return 0;
}

function segments(value: string): Array<string | number> {
  const normalized = value.normalize('NFC');
  const result: Array<string | number> = [];
  SEGMENT.lastIndex = 0;
  let match: RegExpExecArray | null = SEGMENT.exec(normalized);
  while (match !== null) {
    if (match[1] !== undefined) {
      result.push(Number.parseInt(match[1], 10));
    } else if (match[2] !== undefined) {
      result.push(match[2].toLowerCase());
    }
    match = SEGMENT.exec(normalized);
  }
  return result;
}

/** Chave numérica de ordenação: prefixo numérico do nome, ou `Number.MAX_SAFE_INTEGER`. */
export function leadingNumber(value: string): number {
  const match = /^\s*(\d+)/.exec(value);
  if (!match || match[1] === undefined) return Number.MAX_SAFE_INTEGER;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
}

export function naturalSort<T>(items: readonly T[], key: (item: T) => string): T[] {
  return [...items].sort((a, b) => naturalCompare(key(a), key(b)));
}
