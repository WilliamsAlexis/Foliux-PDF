import { describe, expect, it } from 'vitest';
import { buildParagraphs, buildTable, groupLines, type PageWord } from '@foliux-pdf/core';

/** Palabra de 8 de alto; ancho proporcional al texto. */
const word = (text: string, x: number, y: number, height = 8): PageWord => ({
  text,
  x,
  y,
  width: text.length * (height * 0.55),
  height,
});

describe('groupLines', () => {
  it('agrupa por líneas aunque las palabras vengan desordenadas y con pequeñas diferencias de altura', () => {
    const lines = groupLines([
      word('mundo', 40, 10.5),
      word('Hola', 10, 10),
      word('Segunda', 10, 30),
      word('línea', 50, 29.5),
    ]);
    expect(lines.map((l) => l.text)).toEqual(['Hola mundo', 'Segunda línea']);
    expect(lines[0]).toMatchObject({ x: 10, y: 10 });
  });

  it('ignora palabras vacías', () => {
    expect(groupLines([word(' ', 0, 0), word('a', 5, 0)]).map((l) => l.text)).toEqual(['a']);
  });
});

describe('buildParagraphs', () => {
  it('une las líneas pegadas y separa por huecos grandes', () => {
    const lines = groupLines([
      word('Uno', 10, 10),
      word('dos', 10, 20),
      word('Tres', 10, 60), // hueco grande: otro párrafo
    ]);
    expect(buildParagraphs(lines).map((p) => p.text)).toEqual(['Uno dos', 'Tres']);
  });

  it('detecta un título por su tamaño y lo separa del texto', () => {
    const lines = groupLines([
      word('Capítulo', 10, 10, 16),
      word('Texto', 10, 32, 8),
      word('normal', 10, 42, 8),
      word('más', 10, 52, 8),
    ]);
    const paragraphs = buildParagraphs(lines);
    expect(paragraphs[0]).toEqual({ text: 'Capítulo', heading: true });
    expect(paragraphs[1]).toEqual({ text: 'Texto normal más', heading: false });
  });

  it('une una palabra partida con guion al final de línea', () => {
    const lines = groupLines([word('informa-', 10, 10), word('ción', 10, 20)]);
    expect(buildParagraphs(lines)[0]!.text).toBe('información');
  });
});

describe('buildTable', () => {
  it('reconstruye filas y columnas a partir de los huecos y las posiciones', () => {
    const lines = groupLines([
      word('Producto', 10, 10),
      word('Cantidad', 100, 10),
      word('Precio', 180, 10),
      word('Lápiz', 10, 25),
      word('10', 100, 25),
      word('0,50', 180, 25),
      word('Cuaderno grande', 10, 40),
      word('3', 100, 40),
      word('2,10', 180, 40),
    ]);
    expect(buildTable(lines)).toEqual([
      ['Producto', 'Cantidad', 'Precio'],
      ['Lápiz', '10', '0,50'],
      ['Cuaderno grande', '3', '2,10'],
    ]);
  });

  it('una celda vacía deja su hueco en la columna', () => {
    const lines = groupLines([
      word('A', 10, 10),
      word('B', 100, 10),
      word('C', 190, 10),
      word('x', 10, 25),
      word('z', 190, 25),
    ]);
    expect(buildTable(lines)[1]).toEqual(['x', '', 'z']);
  });

  it('el texto corrido (sin columnas) no se convierte en tabla: una columna por línea', () => {
    const lines = groupLines([word('Esto', 10, 10), word('es', 30, 10), word('texto', 10, 25)]);
    expect(buildTable(lines)).toEqual([['Esto es'], ['texto']]);
  });
});
