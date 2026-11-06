import type { AnnotationPoint, AnnotationRect } from '@foliux-pdf/core';

/**
 * Transformaciones entre el espacio "vista" (origen arriba-izquierda, y hacia abajo, con la
 * rotación de la página aplicada: el que usan el visor y el modelo de anotaciones) y el espacio
 * "usuario" del PDF (origen abajo-izquierda del CropBox, y hacia arriba, sin rotación).
 *
 * Matriz afín [a b c d e f]:  x' = a·x + c·y + e   ;   y' = b·x + d·y + f   (igual que `cm` en PDF).
 */
export type Matrix = readonly [number, number, number, number, number, number];

export interface PageBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Normaliza un ángulo de rotación de página a 0, 90, 180 o 270. */
export function normalizeRotation(angle: number): 0 | 90 | 180 | 270 {
  const value = (((Math.round(angle / 90) * 90) % 360) + 360) % 360;
  return value as 0 | 90 | 180 | 270;
}

/** Matriz que lleva un punto de la vista al espacio usuario del PDF. */
export function viewToUserMatrix(rotation: number, box: PageBox): Matrix {
  const { x: cx, y: cy, width: cw, height: ch } = box;
  switch (normalizeRotation(rotation)) {
    case 0:
      return [1, 0, 0, -1, cx, cy + ch];
    case 90:
      return [0, 1, 1, 0, cx, cy];
    case 180:
      return [-1, 0, 0, 1, cx + cw, cy];
    case 270:
      return [0, -1, -1, 0, cx + cw, cy + ch];
  }
}

/** Tamaño de la página en la vista (con la rotación aplicada). */
export function viewSize(rotation: number, box: PageBox): { width: number; height: number } {
  const swapped = normalizeRotation(rotation) % 180 !== 0;
  return swapped
    ? { width: box.height, height: box.width }
    : { width: box.width, height: box.height };
}

export function applyMatrix(m: Matrix, p: AnnotationPoint): AnnotationPoint {
  return { x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] };
}

export function invertMatrix(m: Matrix): Matrix {
  const det = m[0] * m[3] - m[1] * m[2];
  if (det === 0) throw new Error('Matriz no invertible');
  const a = m[3] / det;
  const b = -m[1] / det;
  const c = -m[2] / det;
  const d = m[0] / det;
  return [a, b, c, d, -(a * m[4] + c * m[5]), -(b * m[4] + d * m[5])];
}

/** Rectángulo (en espacio de salida) que contiene al rectángulo transformado. */
export function transformRect(m: Matrix, rect: AnnotationRect): AnnotationRect {
  const p1 = applyMatrix(m, { x: rect.x, y: rect.y });
  const p2 = applyMatrix(m, { x: rect.x + rect.width, y: rect.y + rect.height });
  return {
    x: Math.min(p1.x, p2.x),
    y: Math.min(p1.y, p2.y),
    width: Math.abs(p1.x - p2.x),
    height: Math.abs(p1.y - p2.y),
  };
}
