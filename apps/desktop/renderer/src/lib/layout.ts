import type { PageSize, ViewMode } from '@foliux-pdf/core';
import { clamp } from './utils';

/** Un punto PDF equivale a 96/72 píxeles CSS: así 100 % coincide con el tamaño habitual en pantalla. */
export const CSS_UNITS = 96 / 72;
export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 5;
export const ZOOM_STEPS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4, 5] as const;

export const PAGE_GAP = 12; // separación entre páginas (px)
export const VIEW_PADDING = 24; // margen del visor a cada lado (px)

export type ZoomMode = 'custom' | 'fit-width' | 'fit-page';

/** Páginas que se muestran a la vez: una, o dos (pareja 1-2, 3-4…) en doble página. */
export function pagesInView(page: number, numPages: number, mode: ViewMode): number[] {
  if (mode !== 'double') return [page];
  const first = page % 2 === 1 ? page : page - 1;
  return first + 1 <= numPages ? [first, first + 1] : [first];
}

/** Siguiente/anterior "paso" de navegación según el modo (en doble página se salta de dos en dos). */
export function stepPage(
  page: number,
  numPages: number,
  mode: ViewMode,
  direction: 1 | -1,
): number {
  const step = mode === 'double' ? 2 : 1;
  const base = mode === 'double' ? (page % 2 === 1 ? page : page - 1) : page;
  return clamp(base + direction * step, 1, numPages);
}

export interface ZoomInput {
  zoomMode: ZoomMode;
  /** Zoom manual (1 = 100 %). */
  customZoom: number;
  sizes: PageSize[];
  page: number;
  viewMode: ViewMode;
  /** Tamaño disponible del visor (px). */
  width: number;
  height: number;
}

/** Calcula el zoom real (1 = 100 %) según el modo: manual, ajustar al ancho o ajustar a la página. */
export function computeZoom(input: ZoomInput): number {
  const { zoomMode, customZoom, sizes, page, viewMode, width, height } = input;
  if (zoomMode === 'custom' || sizes.length === 0 || width <= 0 || height <= 0) {
    return clamp(customZoom, MIN_ZOOM, MAX_ZOOM);
  }

  const availableWidth = Math.max(100, width - VIEW_PADDING * 2 - 14); // 14 = barra de desplazamiento
  const availableHeight = Math.max(100, height - VIEW_PADDING * 2);

  const visible = pagesInView(page, sizes.length, viewMode)
    .map((p) => sizes[p - 1])
    .filter((s): s is PageSize => s !== undefined);
  const contentWidth =
    viewMode === 'continuous'
      ? Math.max(...sizes.map((s) => s.width))
      : visible.reduce((sum, s) => sum + s.width, 0) +
        (visible.length - 1) * (PAGE_GAP / CSS_UNITS);
  const contentHeight = Math.max(...visible.map((s) => s.height), 1);

  const byWidth = availableWidth / (contentWidth * CSS_UNITS);
  const byHeight = availableHeight / (contentHeight * CSS_UNITS);
  return clamp(
    zoomMode === 'fit-width' ? byWidth : Math.min(byWidth, byHeight),
    MIN_ZOOM,
    MAX_ZOOM,
  );
}

/** Siguiente nivel de zoom predefinido por encima o por debajo del actual. */
export function nextZoomStep(current: number, direction: 1 | -1): number {
  const epsilon = 0.001;
  if (direction === 1) return ZOOM_STEPS.find((z) => z > current + epsilon) ?? MAX_ZOOM;
  return [...ZOOM_STEPS].reverse().find((z) => z < current - epsilon) ?? MIN_ZOOM;
}

/** Posición vertical (px) donde empieza cada página en el modo continuo. */
export function computePageTops(sizes: PageSize[], pixelsPerUnit: number): number[] {
  const tops: number[] = [];
  let y = VIEW_PADDING;
  for (const size of sizes) {
    tops.push(y);
    y += Math.floor(size.height * pixelsPerUnit) + PAGE_GAP;
  }
  return tops;
}

/** Página (base 1) que contiene la posición vertical `y` en el modo continuo. */
export function pageAtOffset(tops: number[], y: number): number {
  let low = 0;
  let high = tops.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if ((tops[mid] ?? Infinity) <= y) low = mid;
    else high = mid - 1;
  }
  return low + 1;
}
