import { z } from 'zod';

/**
 * Modelo de anotaciones. Todas las coordenadas están en unidades PDF a escala 1 con origen
 * arriba-izquierda, ya con la rotación de la página aplicada (el mismo sistema que usan el visor
 * y los resultados de búsqueda). Al guardar se convierten al espacio del PDF.
 */

export const ANNOTATION_KINDS = [
  'highlight',
  'underline',
  'strikeout',
  'ink',
  'rect',
  'ellipse',
  'line',
  'arrow',
  'note',
  'freetext',
  // Contenido permanente: se incorpora a la página (no es una anotación PDF).
  'text',
  'image',
  // Zona marcada para redactar (eliminar de verdad al aplicar la redacción).
  'redact',
] as const;
export type AnnotationKind = (typeof ANNOTATION_KINDS)[number];

/** Tipos que se incorporan al contenido de la página al aplicar los cambios (no se guardan como anotaciones). */
export const PERMANENT_KINDS = ['text', 'image'] as const;

export const FONT_FAMILIES = ['sans', 'serif', 'mono'] as const;
export type FontFamily = (typeof FONT_FAMILIES)[number];

/** Tamaño (en unidades PDF) del icono de una nota. */
export const NOTE_SIZE = 22;

const finite = z.number().finite();
const RectSchema = z.object({
  x: finite,
  y: finite,
  width: finite.min(0),
  height: finite.min(0),
});
const PointSchema = z.object({ x: finite, y: finite });

const baseShape = {
  id: z.string().min(1).max(64),
  /** Página (base 1). */
  page: z.number().int().min(1),
  /** Color en formato #rrggbb. */
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  opacity: z.number().min(0).max(1),
  /** Texto asociado (comentario del resaltado, contenido de la nota o del cuadro de texto). */
  text: z.string().max(20000),
  createdAt: z.number(),
};

function markup<K extends 'highlight' | 'underline' | 'strikeout'>(kind: K) {
  return z.object({
    ...baseShape,
    kind: z.literal(kind),
    rects: z.array(RectSchema).min(1).max(2000),
  });
}

export const AnnotationSchema = z.discriminatedUnion('kind', [
  markup('highlight'),
  markup('underline'),
  markup('strikeout'),
  z.object({
    ...baseShape,
    kind: z.literal('ink'),
    strokes: z.array(z.array(PointSchema).min(1).max(20000)).min(1).max(500),
    strokeWidth: z.number().min(0.25).max(50),
  }),
  z.object({
    ...baseShape,
    kind: z.literal('rect'),
    rect: RectSchema,
    strokeWidth: z.number().min(0.25).max(50),
  }),
  z.object({
    ...baseShape,
    kind: z.literal('ellipse'),
    rect: RectSchema,
    strokeWidth: z.number().min(0.25).max(50),
  }),
  z.object({
    ...baseShape,
    kind: z.literal('line'),
    from: PointSchema,
    to: PointSchema,
    strokeWidth: z.number().min(0.25).max(50),
  }),
  z.object({
    ...baseShape,
    kind: z.literal('arrow'),
    from: PointSchema,
    to: PointSchema,
    strokeWidth: z.number().min(0.25).max(50),
  }),
  z.object({ ...baseShape, kind: z.literal('note'), at: PointSchema }),
  z.object({
    ...baseShape,
    kind: z.literal('freetext'),
    rect: RectSchema,
    fontSize: z.number().min(4).max(144),
  }),
  z.object({ ...baseShape, kind: z.literal('redact'), rect: RectSchema }),
  // --- Contenido permanente ---
  z.object({
    ...baseShape,
    kind: z.literal('text'),
    rect: RectSchema,
    fontSize: z.number().min(4).max(400),
    font: z.enum(FONT_FAMILIES),
    bold: z.boolean(),
    italic: z.boolean(),
    align: z.enum(['left', 'center', 'right']),
    /** Giro en grados (sentido horario) alrededor del centro del cuadro. */
    angle: z.number().min(-360).max(360),
    /** Si no es null, se pinta un rectángulo de este color detrás (sirve para tapar el texto original). */
    background: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .nullable(),
    /** Una sola línea sin ajustar al ancho del cuadro (para reemplazar texto existente). */
    nowrap: z.boolean(),
  }),
  z.object({
    ...baseShape,
    kind: z.literal('image'),
    rect: RectSchema,
    /** Imagen como URL de datos (data:image/png;base64,...). */
    src: z.string().max(40_000_000),
    format: z.enum(['png', 'jpeg']),
  }),
]);

export type Annotation = z.infer<typeof AnnotationSchema>;
export type AnnotationOf<K extends AnnotationKind> = Extract<Annotation, { kind: K }>;

export const AnnotationListSchema = z.array(AnnotationSchema).max(20000);

export interface AnnotationPoint {
  x: number;
  y: number;
}
export interface AnnotationRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

let idCounter = 0;

/** Identificador único para una anotación nueva. */
export function newAnnotationId(): string {
  idCounter += 1;
  const random = Math.random().toString(36).slice(2, 8);
  return `a${Date.now().toString(36)}${idCounter.toString(36)}${random}`;
}

export const HIGHLIGHT_COLORS = ['#ffd400', '#7bd88f', '#6bc5ff', '#ff9ecb', '#ffa94d'] as const;
export const INK_COLORS = ['#e03131', '#1971c2', '#2f9e44', '#f08c00', '#212529'] as const;

/** Valores por defecto de cada herramienta. */
export const ANNOTATION_DEFAULTS: Record<
  AnnotationKind,
  { color: string; opacity: number; strokeWidth: number }
> = {
  highlight: { color: '#ffd400', opacity: 0.45, strokeWidth: 0 },
  underline: { color: '#e03131', opacity: 1, strokeWidth: 0 },
  strikeout: { color: '#e03131', opacity: 1, strokeWidth: 0 },
  ink: { color: '#e03131', opacity: 1, strokeWidth: 2 },
  rect: { color: '#e03131', opacity: 1, strokeWidth: 2 },
  ellipse: { color: '#e03131', opacity: 1, strokeWidth: 2 },
  line: { color: '#e03131', opacity: 1, strokeWidth: 2 },
  arrow: { color: '#e03131', opacity: 1, strokeWidth: 2 },
  note: { color: '#ffd43b', opacity: 1, strokeWidth: 0 },
  freetext: { color: '#212529', opacity: 1, strokeWidth: 0 },
  text: { color: '#000000', opacity: 1, strokeWidth: 0 },
  image: { color: '#000000', opacity: 1, strokeWidth: 0 },
  redact: { color: '#e03131', opacity: 0.3, strokeWidth: 0 },
};

/** Anotaciones que se crean seleccionando texto. */
export function isTextMarkup(
  a: Annotation,
): a is AnnotationOf<'highlight' | 'underline' | 'strikeout'> {
  return a.kind === 'highlight' || a.kind === 'underline' || a.kind === 'strikeout';
}

/** Normaliza un rectángulo definido por dos esquinas cualesquiera. */
export function rectFromPoints(a: AnnotationPoint, b: AnnotationPoint): AnnotationRect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(a.x - b.x),
    height: Math.abs(a.y - b.y),
  };
}

/**
 * Aplica una transformación a todos los puntos de la anotación (mover, girar la página...).
 * Los rectángulos se recalculan a partir de sus esquinas transformadas.
 */
export function mapAnnotation(
  annotation: Annotation,
  map: (point: AnnotationPoint) => AnnotationPoint,
): Annotation {
  const mapRect = (r: AnnotationRect): AnnotationRect => {
    const p1 = map({ x: r.x, y: r.y });
    const p2 = map({ x: r.x + r.width, y: r.y + r.height });
    return rectFromPoints(p1, p2);
  };
  switch (annotation.kind) {
    case 'highlight':
    case 'underline':
    case 'strikeout':
      return { ...annotation, rects: annotation.rects.map(mapRect) };
    case 'ink':
      return { ...annotation, strokes: annotation.strokes.map((s) => s.map(map)) };
    case 'rect':
    case 'ellipse':
    case 'freetext':
    case 'text':
    case 'image':
    case 'redact':
      return { ...annotation, rect: mapRect(annotation.rect) };
    case 'line':
    case 'arrow':
      return { ...annotation, from: map(annotation.from), to: map(annotation.to) };
    case 'note': {
      const box = mapRect({
        x: annotation.at.x,
        y: annotation.at.y,
        width: NOTE_SIZE,
        height: NOTE_SIZE,
      });
      return { ...annotation, at: { x: box.x, y: box.y } };
    }
  }
}

export function translateAnnotation(annotation: Annotation, dx: number, dy: number): Annotation {
  return mapAnnotation(annotation, (p) => ({ x: p.x + dx, y: p.y + dy }));
}

/** Rectángulo que contiene toda la anotación (incluido el grosor del trazo). */
export function annotationBounds(annotation: Annotation): AnnotationRect {
  const union = (rects: AnnotationRect[]): AnnotationRect => {
    const x1 = Math.min(...rects.map((r) => r.x));
    const y1 = Math.min(...rects.map((r) => r.y));
    const x2 = Math.max(...rects.map((r) => r.x + r.width));
    const y2 = Math.max(...rects.map((r) => r.y + r.height));
    return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
  };
  const pad = (r: AnnotationRect, amount: number): AnnotationRect => ({
    x: r.x - amount,
    y: r.y - amount,
    width: r.width + 2 * amount,
    height: r.height + 2 * amount,
  });
  switch (annotation.kind) {
    case 'highlight':
    case 'underline':
    case 'strikeout':
      return pad(union(annotation.rects), 1);
    case 'ink': {
      const points = annotation.strokes.flat();
      const xs = points.map((p) => p.x);
      const ys = points.map((p) => p.y);
      const x = Math.min(...xs);
      const y = Math.min(...ys);
      return pad(
        { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y },
        annotation.strokeWidth,
      );
    }
    case 'rect':
    case 'ellipse':
      return pad(annotation.rect, annotation.strokeWidth);
    case 'freetext':
    case 'text':
    case 'image':
    case 'redact':
      return annotation.rect;
    case 'line':
      return pad(rectFromPoints(annotation.from, annotation.to), annotation.strokeWidth);
    case 'arrow':
      return pad(
        rectFromPoints(annotation.from, annotation.to),
        Math.max(8, annotation.strokeWidth * 4),
      );
    case 'note':
      return { x: annotation.at.x, y: annotation.at.y, width: NOTE_SIZE, height: NOTE_SIZE };
  }
}

/** Ordena el contenido de una lista de anotaciones por página y posición (para el panel lateral). */
export function sortAnnotations(list: readonly Annotation[]): Annotation[] {
  return [...list].sort((a, b) => {
    if (a.page !== b.page) return a.page - b.page;
    const ra = annotationBounds(a);
    const rb = annotationBounds(b);
    return ra.y - rb.y || ra.x - rb.x;
  });
}

/**
 * Convierte los rectángulos que devuelve una selección de texto (uno por fragmento de texto) en
 * un rectángulo por línea: los que están en la misma línea y se tocan se fusionan, y los
 * absurdamente grandes (contenedores) se descartan.
 */
export function mergeLineRects(
  rects: readonly AnnotationRect[],
  options: { maxHeight?: number } = {},
): AnnotationRect[] {
  const maxHeight = options.maxHeight ?? 200;
  const valid = rects
    .filter((r) => r.width >= 0.5 && r.height >= 1 && r.height <= maxHeight)
    .sort((a, b) => a.y - b.y);

  // 1) Agrupar por línea: un fragmento pertenece a una línea si se solapa verticalmente con ella.
  const rows: AnnotationRect[][] = [];
  for (const rect of valid) {
    const row = rows.find((candidate) => {
      const top = Math.min(...candidate.map((r) => r.y));
      const bottom = Math.max(...candidate.map((r) => r.y + r.height));
      const overlap = Math.min(bottom, rect.y + rect.height) - Math.max(top, rect.y);
      return overlap > 0.5 * Math.min(bottom - top, rect.height);
    });
    if (row) row.push(rect);
    else rows.push([rect]);
  }

  // 2) En cada línea, de izquierda a derecha, fusionar los fragmentos que se tocan o casi (≤ ~1 carácter).
  const merged: AnnotationRect[] = [];
  for (const row of rows) {
    row.sort((a, b) => a.x - b.x);
    let current: AnnotationRect | null = null;
    for (const rect of row) {
      if (
        current &&
        rect.x - (current.x + current.width) <= Math.max(current.height, rect.height) * 0.6
      ) {
        const x2 = Math.max(current.x + current.width, rect.x + rect.width);
        const y1 = Math.min(current.y, rect.y);
        const y2 = Math.max(current.y + current.height, rect.y + rect.height);
        current = { x: current.x, y: y1, width: x2 - current.x, height: y2 - y1 };
      } else {
        if (current) merged.push(current);
        current = { ...rect };
      }
    }
    if (current) merged.push(current);
  }
  return merged.sort((a, b) => a.y - b.y || a.x - b.x);
}

// ---------------------------------------------------------------------------
// Detección de clics
// ---------------------------------------------------------------------------

function distanceToSegment(p: AnnotationPoint, a: AnnotationPoint, b: AnnotationPoint): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  const t =
    lengthSquared === 0
      ? 0
      : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSquared));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

const inRect = (p: AnnotationPoint, r: AnnotationRect, margin = 0): boolean =>
  p.x >= r.x - margin &&
  p.x <= r.x + r.width + margin &&
  p.y >= r.y - margin &&
  p.y <= r.y + r.height + margin;

/**
 * ¿Está el punto sobre la anotación? Las figuras huecas solo responden en el borde (para no tapar
 * el texto que hay dentro), con `tolerance` unidades de margen.
 */
export function hitTestAnnotation(
  annotation: Annotation,
  point: AnnotationPoint,
  tolerance = 4,
): boolean {
  switch (annotation.kind) {
    case 'highlight':
    case 'underline':
    case 'strikeout':
      return annotation.rects.some((r) => inRect(point, r, 1));
    case 'note':
      return inRect(point, annotationBounds(annotation));
    case 'freetext':
    case 'text':
    case 'image':
    case 'redact':
      return inRect(point, annotation.rect);
    case 'rect': {
      const reach = tolerance + annotation.strokeWidth / 2;
      const { x, y, width, height } = annotation.rect;
      const outer = inRect(point, annotation.rect, reach);
      const inner =
        point.x > x + reach &&
        point.x < x + width - reach &&
        point.y > y + reach &&
        point.y < y + height - reach;
      return outer && !inner;
    }
    case 'ellipse': {
      const { x, y, width, height } = annotation.rect;
      const rx = width / 2;
      const ry = height / 2;
      if (rx === 0 || ry === 0) return false;
      const radial = Math.hypot((point.x - (x + rx)) / rx, (point.y - (y + ry)) / ry);
      return Math.abs(radial - 1) * Math.min(rx, ry) <= tolerance + annotation.strokeWidth / 2;
    }
    case 'line':
    case 'arrow':
      return (
        distanceToSegment(point, annotation.from, annotation.to) <=
        tolerance + annotation.strokeWidth / 2
      );
    case 'ink':
      return annotation.strokes.some((stroke) =>
        stroke.length === 1
          ? Math.hypot(point.x - stroke[0]!.x, point.y - stroke[0]!.y) <=
            tolerance + annotation.strokeWidth
          : stroke.some(
              (p, i) =>
                i > 0 &&
                distanceToSegment(point, stroke[i - 1]!, p) <=
                  tolerance + annotation.strokeWidth / 2,
            ),
      );
  }
}

/** La anotación más arriba (la última de la lista) que está bajo el punto, si hay alguna. */
export function annotationAt(
  annotations: readonly Annotation[],
  page: number,
  point: AnnotationPoint,
  tolerance = 4,
): Annotation | undefined {
  for (let i = annotations.length - 1; i >= 0; i--) {
    const candidate = annotations[i];
    if (candidate && candidate.page === page && hitTestAnnotation(candidate, point, tolerance)) {
      return candidate;
    }
  }
  return undefined;
}

/** ¿Es contenido permanente (texto o imagen que se incorpora a la página)? */
export function isPermanent(
  annotation: Annotation,
): annotation is AnnotationOf<(typeof PERMANENT_KINDS)[number]> {
  return annotation.kind === 'text' || annotation.kind === 'image';
}
