import { z } from 'zod';
import { FONT_FAMILIES } from './annotations';
import { FormValuesSchema, NewFormFieldSchema } from './forms';

/** Operaciones sobre las páginas de un documento. Las páginas se numeran desde 1. */
const pageNumbers = z.array(z.number().int().min(1)).min(1).max(100000);

const ColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const ImageSourceSchema = z.object({
  /** URL de datos (data:image/png;base64,...). */
  src: z.string().max(40_000_000),
  format: z.enum(['png', 'jpeg']),
});
const HeaderFooterLineSchema = z.object({
  left: z.string().max(300),
  center: z.string().max(300),
  right: z.string().max(300),
});

export const PageOpSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('rotate'),
    pages: pageNumbers,
    /** Giro en grados (sentido horario). */
    degrees: z.union([z.literal(90), z.literal(-90), z.literal(180)]),
  }),
  z.object({ type: z.literal('delete'), pages: pageNumbers }),
  /** Nuevo orden completo: `order[i]` es el número (antiguo) de la página que pasa a la posición i+1. */
  z.object({ type: z.literal('reorder'), order: pageNumbers }),
  /** Duplica cada página justo detrás de la original. */
  z.object({ type: z.literal('duplicate'), pages: pageNumbers }),
  /** Inserta páginas en blanco después de la página `after` (0 = al principio). */
  z.object({
    type: z.literal('insertBlank'),
    after: z.number().int().min(0),
    count: z.number().int().min(1).max(100).default(1),
  }),
  /** Añade texto invisible sobre las páginas (resultado del OCR): el escaneo pasa a ser buscable y copiable. */
  z.object({
    type: z.literal('ocrText'),
    pages: z
      .array(
        z.object({
          page: z.number().int().min(1),
          /** Palabras reconocidas, en unidades de la vista. */
          words: z
            .array(
              z.object({
                text: z.string().max(300),
                x: z.number().finite(),
                y: z.number().finite(),
                width: z.number().finite().min(0),
                height: z.number().finite().min(0),
              }),
            )
            .max(200000),
        }),
      )
      .min(1)
      .max(5000),
  }),
  /** Escribe en el PDF los valores de los campos del formulario. */
  z.object({ type: z.literal('fillForm'), values: FormValuesSchema }),
  /** Crea un campo de formulario nuevo. */
  z.object({ type: z.literal('addFormField'), field: NewFormFieldSchema }),
  z.object({
    type: z.literal('addFormFields'),
    fields: z.array(NewFormFieldSchema).min(1).max(300),
  }),
  z.object({ type: z.literal('deleteFormField'), name: z.string().min(1).max(300) }),
  /** Convierte los campos en contenido fijo de la página (ya no se pueden editar). */
  z.object({ type: z.literal('flattenForm') }),
  /** Borra metadatos y datos ocultos del documento. */
  z.object({
    type: z.literal('cleanMetadata'),
    info: z.boolean(),
    xmp: z.boolean(),
    thumbnails: z.boolean(),
    attachments: z.boolean(),
    javascript: z.boolean(),
  }),
  /** Incorpora a las páginas el texto y las imágenes pendientes (sin más cambios). */
  z.object({ type: z.literal('applyEdits') }),
  /** Marca de agua centrada, de texto o de imagen, en las páginas indicadas ("all", "odd", "even" o "1-3,5"). */
  z.object({
    type: z.literal('watermark'),
    text: z.string().max(500).optional(),
    image: ImageSourceSchema.optional(),
    fontSize: z.number().min(6).max(400),
    color: ColorSchema,
    opacity: z.number().min(0.02).max(1),
    /** Giro en grados (sentido horario). */
    angle: z.number().min(-90).max(90),
    /** Ancho de la imagen como fracción del ancho de la página. */
    imageWidth: z.number().min(0.05).max(1).default(0.5),
    pages: z.string().max(500),
  }),
  /** Encabezado y pie con marcadores {page}, {pages}, {date} y {file}. */
  z.object({
    type: z.literal('headerFooter'),
    header: HeaderFooterLineSchema,
    footer: HeaderFooterLineSchema,
    font: z.enum(FONT_FAMILIES),
    fontSize: z.number().min(4).max(72),
    color: ColorSchema,
    /** Distancia al borde de la página, en puntos. */
    margin: z.number().min(0).max(300),
    pages: z.string().max(500),
    /** Número que lleva la primera página del documento ({page}). */
    startNumber: z.number().int().min(0).max(100000).default(1),
    /** Nombre que sustituye a {file}. */
    fileName: z.string().max(255).default(''),
  }),
  /** Inserta todas las páginas de otro PDF después de la página `after`. */
  z.object({
    type: z.literal('insertFile'),
    after: z.number().int().min(0),
    path: z.string().min(1).max(4096),
  }),
]);

export type PageOp = z.input<typeof PageOpSchema>;

/**
 * Orden resultante al mover un conjunto de páginas para que empiecen en la posición `target`
 * (1 = al principio, total + 1 = al final), contada sobre el documento antes de moverlas.
 * Devuelve el nuevo orden completo (números antiguos de página) para la operación `reorder`.
 */
export function computeMoveOrder(
  total: number,
  moving: readonly number[],
  target: number,
): number[] {
  const moved = [...new Set(moving)].filter((p) => p >= 1 && p <= total).sort((a, b) => a - b);
  const movedSet = new Set(moved);
  const rest: number[] = [];
  for (let page = 1; page <= total; page++) if (!movedSet.has(page)) rest.push(page);

  // Cuántas de las páginas que quedan están antes del punto de inserción.
  const before = rest.filter((p) => p < target).length;
  return [...rest.slice(0, before), ...moved, ...rest.slice(before)];
}

/**
 * Interpreta un rango de páginas: "all", "odd", "even" o una lista como "1-3, 5, 8-" (base 1).
 * "8-" significa hasta el final y "-3" desde el principio. Devuelve páginas únicas y ordenadas.
 * Lanza un Error con un mensaje claro si el texto no es válido.
 */
export function parsePageRange(spec: string, total: number): number[] {
  const text = spec.trim().toLowerCase();
  const all = Array.from({ length: total }, (_, i) => i + 1);
  if (text === '' || text === 'all') return all;
  if (text === 'odd') return all.filter((p) => p % 2 === 1);
  if (text === 'even') return all.filter((p) => p % 2 === 0);

  const pages = new Set<number>();
  for (const part of text.split(/[,;]/)) {
    const item = part.trim();
    if (item === '') continue;
    const range = /^(\d*)\s*-\s*(\d*)$/.exec(item);
    const single = /^(\d+)$/.exec(item);
    if (!range && !single) {
      throw new Error(`El rango «${item}» no es válido. Usa por ejemplo 1-3, 5, 8-`);
    }
    const from = range ? (range[1] ? Number(range[1]) : 1) : Number(single![1]);
    const to = range ? (range[2] ? Number(range[2]) : total) : from;
    if (from < 1 || to < from || to > total) {
      throw new Error(`El rango «${item}» queda fuera del documento (1-${total}).`);
    }
    for (let page = from; page <= to; page++) pages.add(page);
  }
  return [...pages].sort((a, b) => a - b);
}

/** Cómo se divide un documento en varios archivos. */
export type SplitPlan =
  { mode: 'each' } | { mode: 'every'; every: number } | { mode: 'ranges'; ranges: string };

/** Grupos de páginas (base 1) que forman cada archivo resultante de dividir un documento. */
export function planSplit(total: number, plan: SplitPlan): number[][] {
  if (plan.mode === 'each') return Array.from({ length: total }, (_, i) => [i + 1]);
  if (plan.mode === 'every') {
    const size = Math.max(1, Math.floor(plan.every));
    const groups: number[][] = [];
    for (let start = 1; start <= total; start += size) {
      groups.push(Array.from({ length: Math.min(size, total - start + 1) }, (_, i) => start + i));
    }
    return groups;
  }
  const groups = plan.ranges
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .map((part) => parsePageRange(part, total));
  if (groups.length === 0) throw new Error('Indica al menos un rango, por ejemplo 1-3; 4-6');
  return groups;
}
