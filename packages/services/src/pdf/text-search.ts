/**
 * Lógica pura de búsqueda de texto (sin dependencias de PDF.js ni del DOM), fácil de probar.
 * La búsqueda ignora mayúsculas, acentos y la cantidad de espacios en blanco.
 */

export interface NormalizedText {
  /** Texto normalizado: sin acentos, en minúsculas y con los espacios colapsados. */
  text: string;
  /** Para cada carácter normalizado, posición de inicio del carácter original. */
  starts: number[];
  /** Para cada carácter normalizado, posición de fin (exclusiva) del carácter original. */
  ends: number[];
}

const MARKS = /\p{M}/gu;

export function normalizeForSearch(source: string): NormalizedText {
  let text = '';
  const starts: number[] = [];
  const ends: number[] = [];
  let lastWasSpace = true; // así se descartan los espacios iniciales

  let index = 0;
  for (const char of source) {
    const start = index;
    const end = index + char.length;
    index = end;

    if (/\s/u.test(char)) {
      if (lastWasSpace) continue;
      text += ' ';
      starts.push(start);
      ends.push(end);
      lastWasSpace = true;
      continue;
    }

    const normalized = char.normalize('NFD').replace(MARKS, '').toLowerCase();
    for (const unit of normalized) {
      text += unit;
      for (let i = 0; i < unit.length; i++) {
        starts.push(start);
        ends.push(end);
      }
    }
    if (normalized.length > 0) lastWasSpace = false;
  }

  // Quitar un posible espacio final
  if (text.endsWith(' ')) {
    text = text.slice(0, -1);
    starts.pop();
    ends.pop();
  }
  return { text, starts, ends };
}

export interface TextMatch {
  /** Rango [start, end) en el texto ORIGINAL. */
  start: number;
  end: number;
}

/** Busca todas las coincidencias de `query` en `source` y devuelve sus rangos en el texto original. */
export function findMatches(source: string, query: string, maxMatches = 10_000): TextMatch[] {
  const needle = normalizeForSearch(query).text;
  if (needle.length === 0) return [];

  const haystack = normalizeForSearch(source);
  const matches: TextMatch[] = [];
  let from = 0;

  while (matches.length < maxMatches) {
    const index = haystack.text.indexOf(needle, from);
    if (index < 0) break;
    const last = index + needle.length - 1;
    const start = haystack.starts[index];
    const end = haystack.ends[last];
    if (start !== undefined && end !== undefined) matches.push({ start, end });
    from = index + Math.max(1, needle.length);
  }
  return matches;
}

/** Fragmento de contexto alrededor de una coincidencia, en una sola línea. */
export function buildContext(
  source: string,
  match: TextMatch,
  radius = 36,
): { before: string; match: string; after: string } {
  const clean = (value: string) => value.replace(/\s+/g, ' ');
  const from = Math.max(0, match.start - radius);
  const to = Math.min(source.length, match.end + radius);
  return {
    before: (from > 0 ? '…' : '') + clean(source.slice(from, match.start)).trimStart(),
    match: clean(source.slice(match.start, match.end)),
    after: clean(source.slice(match.end, to)).trimEnd() + (to < source.length ? '…' : ''),
  };
}
