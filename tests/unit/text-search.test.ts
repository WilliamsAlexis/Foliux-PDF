import { describe, expect, it } from 'vitest';
import { buildContext, findMatches, normalizeForSearch } from '@foliux-pdf/services';

describe('normalizeForSearch', () => {
  it('quita acentos, pasa a minúsculas y colapsa espacios', () => {
    expect(normalizeForSearch('  Canción   ÁÉÍ\n  ').text).toBe('cancion aei');
  });

  it('mantiene la correspondencia con las posiciones originales', () => {
    const { text, starts, ends } = normalizeForSearch('Año');
    expect(text).toBe('ano');
    expect(starts).toEqual([0, 1, 2]);
    expect(ends).toEqual([1, 2, 3]);
  });
});

describe('findMatches', () => {
  it('encuentra coincidencias ignorando mayúsculas y acentos', () => {
    const source = 'La Canción y la cancion.';
    const matches = findMatches(source, 'CANCIÓN');
    expect(matches.map((m) => source.slice(m.start, m.end))).toEqual(['Canción', 'cancion']);
  });

  it('une palabras separadas por saltos de línea o varios espacios', () => {
    const source = 'hola\n  mundo';
    const [match] = findMatches(source, 'hola mundo');
    expect(match).toBeDefined();
    expect(source.slice(match!.start, match!.end)).toBe(source);
  });

  it('devuelve vacío si la consulta está vacía o no hay coincidencias', () => {
    expect(findMatches('texto', '   ')).toEqual([]);
    expect(findMatches('texto', 'zzz')).toEqual([]);
  });

  it('no se solapa consigo mismo y respeta el máximo', () => {
    expect(findMatches('aaaa', 'aa')).toHaveLength(2);
    expect(findMatches('a a a a a', 'a', 3)).toHaveLength(3);
  });
});

describe('buildContext', () => {
  it('añade puntos suspensivos cuando el texto continúa y deja una sola línea', () => {
    const source = `${'a'.repeat(100)}\nBUSCADO\n${'b'.repeat(100)}`;
    const start = source.indexOf('BUSCADO');
    const ctx = buildContext(source, { start, end: start + 7 });
    expect(ctx.match).toBe('BUSCADO');
    expect(ctx.before.startsWith('…')).toBe(true);
    expect(ctx.after.endsWith('…')).toBe(true);
    expect(`${ctx.before}${ctx.match}${ctx.after}`).not.toContain('\n');
  });
});
