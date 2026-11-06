import { mergeLineRects, type AnnotationRect } from './annotations';
import type { PageWord } from './models';

/**
 * Comparación de dos versiones de un documento por palabras (algoritmo de Myers).
 * Compara TEXTO: no detecta cambios que sean solo de imágenes, gráficos o formato.
 */

/** Un bloque de cambio: `a[aStart, aEnd)` se sustituye por `b[bStart, bEnd)` (cualquiera puede estar vacío). */
export interface DiffHunk {
  aStart: number;
  aEnd: number;
  bStart: number;
  bEnd: number;
}

export class DiffTooLargeError extends Error {
  constructor(readonly limit: number) {
    super(
      `Los documentos son demasiado distintos para compararlos (más de ${limit} palabras de diferencia).`,
    );
    this.name = 'DiffTooLargeError';
  }
}

/** Máximo de ediciones antes de rendirse (la memoria crece con su cuadrado). */
export const DEFAULT_MAX_EDITS = 3000;

/** Diferencias entre dos secuencias de palabras. Lanza DiffTooLargeError si hay demasiadas. */
export function diffSequences(
  a: readonly string[],
  b: readonly string[],
  maxEdits = DEFAULT_MAX_EDITS,
): DiffHunk[] {
  // Lo común al principio y al final no necesita el algoritmo (y es lo habitual).
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const A = a.slice(start, endA);
  const B = b.slice(start, endB);
  const n = A.length;
  const m = B.length;
  if (n === 0 && m === 0) return [];

  const limit = Math.min(n + m, maxEdits);
  const offset = limit + 1;
  const v = new Int32Array(2 * limit + 3);
  const trace: Int32Array[] = [];

  let found = -1;
  for (let d = 0; d <= limit && found < 0; d++) {
    trace.push(v.slice(offset - d - 1, offset + d + 2)); // estado antes de este paso
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && (v[offset + k - 1] ?? 0) < (v[offset + k + 1] ?? 0))
          ? (v[offset + k + 1] ?? 0)
          : (v[offset + k - 1] ?? 0) + 1;
      let y = x - k;
      while (x < n && y < m && A[x] === B[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
  }
  if (found < 0) throw new DiffTooLargeError(maxEdits);

  // Marcar lo borrado de A y lo insertado en B recorriendo el camino hacia atrás.
  const deleted = new Uint8Array(n);
  const inserted = new Uint8Array(m);
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const snapshot = trace[d]!;
    const at = (k: number) => snapshot[k + d + 1] ?? 0; // snapshot[0] corresponde a k = -d - 1
    const k = x - y;
    const previousK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const previousX = at(previousK);
    const previousY = previousX - previousK;
    while (x > previousX && y > previousY) {
      x--;
      y--;
    }
    if (x === previousX) inserted[previousY] = 1;
    else deleted[previousX] = 1;
    x = previousX;
    y = previousY;
  }

  const hunks: DiffHunk[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && !deleted[i] && !inserted[j]) {
      i++;
      j++;
      continue;
    }
    const hunk = { aStart: i, aEnd: i, bStart: j, bEnd: j };
    while (i < n && deleted[i]) i++;
    while (j < m && inserted[j]) j++;
    hunk.aEnd = i;
    hunk.bEnd = j;
    if (hunk.aEnd === hunk.aStart && hunk.bEnd === hunk.bStart) break; // no debería ocurrir
    hunks.push({
      aStart: hunk.aStart + start,
      aEnd: hunk.aEnd + start,
      bStart: hunk.bStart + start,
      bEnd: hunk.bEnd + start,
    });
  }
  return hunks;
}

// ---------------------------------------------------------------------------
// Cambios con posición
// ---------------------------------------------------------------------------

/** Una palabra con la página en la que está. */
export interface DiffToken extends PageWord {
  page: number;
}

/** Zona de un cambio en una página. */
export interface ChangePiece {
  page: number;
  rects: AnnotationRect[];
}

export interface Change {
  /** Eliminado de la versión A, añadido en la B, o sustituido. */
  kind: 'removed' | 'added' | 'changed';
  textA: string;
  textB: string;
  /** Dónde estaba en A y dónde está en B. */
  a: ChangePiece[];
  b: ChangePiece[];
}

function pieces(tokens: readonly DiffToken[]): ChangePiece[] {
  const byPage = new Map<number, DiffToken[]>();
  for (const token of tokens) {
    const list = byPage.get(token.page);
    if (list) list.push(token);
    else byPage.set(token.page, [token]);
  }
  return [...byPage].map(([page, list]) => ({
    page,
    rects: mergeLineRects(list, { maxHeight: 400 }),
  }));
}

/** Convierte los bloques de diferencias en cambios con texto y posición en cada versión. */
export function buildChanges(
  tokensA: readonly DiffToken[],
  tokensB: readonly DiffToken[],
  hunks: readonly DiffHunk[],
): Change[] {
  return hunks.map((hunk) => {
    const a = tokensA.slice(hunk.aStart, hunk.aEnd);
    const b = tokensB.slice(hunk.bStart, hunk.bEnd);
    return {
      kind: a.length === 0 ? 'added' : b.length === 0 ? 'removed' : 'changed',
      textA: a.map((t) => t.text).join(' '),
      textB: b.map((t) => t.text).join(' '),
      a: pieces(a),
      b: pieces(b),
    };
  });
}

/** Compara dos listas de palabras (con su posición) y devuelve los cambios. */
export function compareTokens(
  tokensA: readonly DiffToken[],
  tokensB: readonly DiffToken[],
  maxEdits?: number,
): Change[] {
  const hunks = diffSequences(
    tokensA.map((t) => t.text),
    tokensB.map((t) => t.text),
    maxEdits,
  );
  return buildChanges(tokensA, tokensB, hunks);
}
