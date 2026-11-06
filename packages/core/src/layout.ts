import type { PageWord } from './models';

/**
 * Reconstrucción de líneas, párrafos y tablas a partir de las palabras (con su posición) de una página.
 * Un PDF no guarda párrafos ni tablas, solo letras colocadas: esto es una aproximación heurística que
 * funciona bien con texto corrido y tablas sencillas, y peor con maquetaciones complejas.
 */

export interface TextLine {
  words: PageWord[];
  x: number;
  y: number;
  width: number;
  height: number;
  text: string;
}

const median = (values: readonly number[]): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
};

/**
 * Altura del texto «normal»: la que más texto tiene (no la mediana: con pocas líneas, un título grande
 * podría ser la mediana y todo lo demás parecería pequeño).
 */
export function bodyHeightOf(lines: readonly TextLine[]): number {
  const weight = new Map<number, number>();
  for (const line of lines) {
    const bucket = Math.round(line.height);
    weight.set(bucket, (weight.get(bucket) ?? 0) + line.text.length);
  }
  let best = 0;
  let bestWeight = -1;
  for (const [height, total] of weight) {
    if (total > bestWeight) {
      best = height;
      bestWeight = total;
    }
  }
  return best || median(lines.map((l) => l.height));
}

/** Agrupa las palabras en líneas (de arriba abajo, y de izquierda a derecha dentro de cada línea). */
export function groupLines(words: readonly PageWord[]): TextLine[] {
  const ordered = [...words]
    .filter((w) => w.text.trim() !== '')
    .sort((a, b) => a.y - b.y || a.x - b.x);
  const lines: PageWord[][] = [];

  for (const word of ordered) {
    // Se une a la última línea si se solapan verticalmente más de la mitad de la menor de las alturas.
    const line = lines[lines.length - 1];
    if (line) {
      const top = Math.min(...line.map((w) => w.y));
      const bottom = Math.max(...line.map((w) => w.y + w.height));
      const overlap = Math.min(bottom, word.y + word.height) - Math.max(top, word.y);
      if (overlap > 0.5 * Math.min(bottom - top, word.height)) {
        line.push(word);
        continue;
      }
    }
    lines.push([word]);
  }

  return lines.map((lineWords) => {
    const sorted = [...lineWords].sort((a, b) => a.x - b.x);
    const x = Math.min(...sorted.map((w) => w.x));
    const y = Math.min(...sorted.map((w) => w.y));
    return {
      words: sorted,
      x,
      y,
      width: Math.max(...sorted.map((w) => w.x + w.width)) - x,
      height: Math.max(...sorted.map((w) => w.y + w.height)) - y,
      text: sorted.map((w) => w.text).join(' '),
    };
  });
}

export interface Paragraph {
  text: string;
  /** Línea de mayor tamaño que el resto del texto: probablemente un título. */
  heading: boolean;
}

/** Une líneas consecutivas en párrafos y detecta títulos por su tamaño. */
export function buildParagraphs(lines: readonly TextLine[]): Paragraph[] {
  if (lines.length === 0) return [];
  const bodyHeight = bodyHeightOf(lines);
  const paragraphs: { lines: TextLine[] }[] = [];

  for (const line of lines) {
    const current = paragraphs[paragraphs.length - 1];
    const previous = current?.lines[current.lines.length - 1];
    if (current && previous) {
      const gap = line.y - (previous.y + previous.height);
      const isBigger = (l: TextLine) => l.height >= bodyHeight * 1.25;
      const sameBlock =
        gap <= bodyHeight * 0.9 &&
        isBigger(line) === isBigger(previous) &&
        Math.abs(line.x - previous.x) <= bodyHeight * 2.5;
      if (sameBlock) {
        current.lines.push(line);
        continue;
      }
    }
    paragraphs.push({ lines: [line] });
  }

  return paragraphs.map(({ lines: group }) => {
    // Palabras partidas con guion al final de línea se vuelven a unir.
    let text = group[0]?.text ?? '';
    for (const line of group.slice(1)) {
      text =
        /\w-$/.test(text) && /^[a-záéíóúñü]/.test(line.text)
          ? `${text.slice(0, -1)}${line.text}`
          : `${text} ${line.text}`;
    }
    const first = group[0]!;
    return {
      text,
      heading: group.length === 1 && first.height >= bodyHeight * 1.25 && text.length <= 120,
    };
  });
}

/**
 * Convierte las líneas en una tabla: cada línea se parte en celdas donde hay un hueco grande entre palabras
 * y las celdas se alinean en columnas por su posición horizontal. Si casi todas las líneas tienen una sola
 * celda, no hay tabla y se devuelve una columna con el texto de cada línea.
 */
export function buildTable(lines: readonly TextLine[]): string[][] {
  if (lines.length === 0) return [];
  const bodyHeight = bodyHeightOf(lines) || 10;
  const gapLimit = Math.max(bodyHeight * 1.2, 8);

  // 1) celdas de cada línea (texto y posición izquierda)
  const rows = lines.map((line) => {
    const cells: { text: string; x: number }[] = [];
    for (const word of line.words) {
      const last = cells[cells.length - 1];
      const previousWord = line.words[line.words.indexOf(word) - 1];
      const gap = previousWord ? word.x - (previousWord.x + previousWord.width) : 0;
      if (last && gap <= gapLimit) last.text += ` ${word.text}`;
      else cells.push({ text: word.text, x: word.x });
    }
    return cells;
  });

  const multiCell = rows.filter((cells) => cells.length > 1).length;
  if (multiCell / rows.length < 0.4)
    return rows.map((cells) => [cells.map((c) => c.text).join(' ')]);

  // 2) columnas: se agrupan las posiciones izquierdas de las celdas
  const lefts = rows.flatMap((cells) => cells.map((c) => c.x)).sort((a, b) => a - b);
  const tolerance = bodyHeight * 1.5;
  const columns: number[] = [];
  for (const x of lefts) {
    const last = columns[columns.length - 1];
    if (last === undefined || x - last > tolerance) columns.push(x);
  }

  // 3) cada celda va a la columna más cercana por la izquierda
  return rows.map((cells) => {
    const row = new Array<string>(columns.length).fill('');
    for (const cell of cells) {
      let best = 0;
      for (let i = 0; i < columns.length; i++)
        if (cell.x >= (columns[i] ?? 0) - tolerance / 2) best = i;
      row[best] = row[best] ? `${row[best]} ${cell.text}` : cell.text;
    }
    return row;
  });
}
