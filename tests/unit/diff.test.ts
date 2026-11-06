import { describe, expect, it } from 'vitest';
import {
  DiffTooLargeError,
  compareTokens,
  diffSequences,
  type DiffHunk,
  type DiffToken,
} from '@foliux-pdf/core';

const words = (text: string) => (text === '' ? [] : text.split(' '));

/** Aplica los bloques a `a` y comprueba que se obtiene `b` (la propiedad que define un diff correcto). */
function apply(a: string[], b: string[], hunks: DiffHunk[]): string[] {
  const result: string[] = [];
  let cursor = 0;
  for (const h of hunks) {
    result.push(...a.slice(cursor, h.aStart), ...b.slice(h.bStart, h.bEnd));
    cursor = h.aEnd;
  }
  result.push(...a.slice(cursor));
  return result;
}

describe('diffSequences', () => {
  it('sin diferencias no devuelve bloques', () => {
    expect(diffSequences(words('a b c'), words('a b c'))).toEqual([]);
    expect(diffSequences([], [])).toEqual([]);
  });

  it('detecta inserciones, borrados y sustituciones', () => {
    expect(diffSequences(words('a b c'), words('a b x c'))).toEqual([
      { aStart: 2, aEnd: 2, bStart: 2, bEnd: 3 },
    ]);
    expect(diffSequences(words('a b c d'), words('a d'))).toEqual([
      { aStart: 1, aEnd: 3, bStart: 1, bEnd: 1 },
    ]);
    expect(diffSequences(words('a b c'), words('a X c'))).toEqual([
      { aStart: 1, aEnd: 2, bStart: 1, bEnd: 2 },
    ]);
    expect(diffSequences([], words('a b'))).toEqual([{ aStart: 0, aEnd: 0, bStart: 0, bEnd: 2 }]);
    expect(diffSequences(words('a b'), [])).toEqual([{ aStart: 0, aEnd: 2, bStart: 0, bEnd: 0 }]);
  });

  it('aplicar el diff a A siempre reproduce B (casos mezclados y aleatorios)', () => {
    const cases: [string, string][] = [
      [
        'el contrato se firma el lunes en Madrid',
        'el contrato se firmará el martes en Barcelona ciudad',
      ],
      ['uno dos tres cuatro cinco', 'cinco cuatro tres dos uno'],
      ['a a a a a', 'a a b a a a'],
    ];
    for (const [x, y] of cases) {
      const a = words(x);
      const b = words(y);
      expect(apply(a, b, diffSequences(a, b))).toEqual(b);
    }
    // Pruebas pseudoaleatorias con una semilla fija
    let seed = 42;
    const random = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
    const vocabulary = ['x', 'y', 'z', 'w', 'q'];
    for (let round = 0; round < 60; round++) {
      const a = Array.from(
        { length: Math.floor(random() * 30) },
        () => vocabulary[Math.floor(random() * 5)]!,
      );
      const b = Array.from(
        { length: Math.floor(random() * 30) },
        () => vocabulary[Math.floor(random() * 5)]!,
      );
      expect(apply(a, b, diffSequences(a, b))).toEqual(b);
    }
  });

  it('es rápido con documentos grandes que cambian poco', () => {
    const a = Array.from({ length: 60_000 }, (_, i) => `w${i}`);
    const b = [...a];
    b[100] = 'cambiada';
    b.splice(30_000, 0, 'nueva');
    b.splice(50_000, 5);
    const started = Date.now();
    const hunks = diffSequences(a, b);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(apply(a, b, hunks)).toEqual(b);
    expect(hunks).toHaveLength(3);
  });

  it('se rinde con un aviso si los documentos no tienen nada que ver', () => {
    const a = Array.from({ length: 4000 }, (_, i) => `a${i}`);
    const b = Array.from({ length: 4000 }, (_, i) => `b${i}`);
    expect(() => diffSequences(a, b)).toThrow(DiffTooLargeError);
    expect(() => diffSequences(a, b)).toThrow(/demasiado distintos/);
  });
});

describe('compareTokens', () => {
  const token = (text: string, page: number, x: number, y = 10): DiffToken => ({
    text,
    page,
    x,
    y,
    width: 30,
    height: 12,
  });

  it('describe cada cambio con su texto y su posición en cada versión', () => {
    const a = [
      token('Pagar', 1, 10),
      token('100', 1, 50),
      token('euros', 1, 90),
      token('hoy', 2, 10),
    ];
    const b = [
      token('Pagar', 1, 10),
      token('250', 1, 50),
      token('euros', 1, 90),
      token('hoy', 2, 10),
      token('mismo', 2, 50),
    ];
    const changes = compareTokens(a, b);
    expect(changes).toHaveLength(2);

    expect(changes[0]).toMatchObject({ kind: 'changed', textA: '100', textB: '250' });
    expect(changes[0]!.a[0]).toMatchObject({ page: 1 });
    expect(changes[0]!.b[0]!.rects[0]).toMatchObject({ x: 50 });

    expect(changes[1]).toMatchObject({ kind: 'added', textA: '', textB: 'mismo' });
    expect(changes[1]!.a).toEqual([]);
    expect(changes[1]!.b[0]!.page).toBe(2);
  });

  it('un cambio que cruza páginas se reparte por página', () => {
    const a = [token('fin', 1, 10), token('inicio', 2, 10)];
    const b = [token('otra', 1, 10), token('cosa', 2, 10)];
    const [change] = compareTokens(a, b);
    expect(change!.a.map((p) => p.page)).toEqual([1, 2]);
  });
});
