import { z } from 'zod';

/** Crear un PDF desde cero: tamaños de papel habituales (en puntos, 1 pt = 1/72 de pulgada) y validación. */

export const PAGE_PRESETS = [
  { id: 'a4', label: 'A4 (210 × 297 mm)', width: 595.28, height: 841.89 },
  { id: 'a3', label: 'A3 (297 × 420 mm)', width: 841.89, height: 1190.55 },
  { id: 'a5', label: 'A5 (148 × 210 mm)', width: 419.53, height: 595.28 },
  { id: 'letter', label: 'Carta (8,5 × 11 in)', width: 612, height: 792 },
  { id: 'legal', label: 'Legal (8,5 × 14 in)', width: 612, height: 1008 },
] as const;
export type PagePresetId = (typeof PAGE_PRESETS)[number]['id'];

export const MIN_PAGE_POINTS = 72; // 1 pulgada
export const MAX_PAGE_POINTS = 14400; // límite de tamaño de página de PDF (200 pulgadas)
export const MAX_NEW_PAGES = 200;

export const NewDocumentSchema = z.object({
  width: z.number().min(MIN_PAGE_POINTS).max(MAX_PAGE_POINTS),
  height: z.number().min(MIN_PAGE_POINTS).max(MAX_PAGE_POINTS),
  pages: z.number().int().min(1).max(MAX_NEW_PAGES),
});
export type NewDocumentSpec = z.infer<typeof NewDocumentSchema>;

/** Tamaño de página de un papel estándar, en vertical u horizontal. */
export function pageSizeFor(
  preset: PagePresetId,
  orientation: 'portrait' | 'landscape',
): { width: number; height: number } {
  const found = PAGE_PRESETS.find((p) => p.id === preset) ?? PAGE_PRESETS[0];
  return orientation === 'portrait'
    ? { width: found.width, height: found.height }
    : { width: found.height, height: found.width };
}
