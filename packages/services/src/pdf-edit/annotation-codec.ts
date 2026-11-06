import {
  PDFDict,
  PDFHexString,
  PDFName,
  PDFString,
  StandardFonts,
  type PDFDocument,
  type PDFFont,
  type PDFImage,
  type PDFPage,
  type PDFRef,
} from 'pdf-lib';
import {
  AnnotationSchema,
  NOTE_SIZE,
  annotationBounds,
  isPermanent,
  mapAnnotation,
  type Annotation,
  type AnnotationOf,
  type FontFamily,
} from '@foliux-pdf/core';
import {
  applyMatrix,
  invertMatrix,
  normalizeRotation,
  transformRect,
  viewToUserMatrix,
  type Matrix,
  type PageBox,
} from './geometry';

/**
 * Escritura y lectura de anotaciones en el PDF.
 *
 * Cada anotación se guarda como una anotación PDF estándar (con su apariencia, para que la vean
 * Acrobat, el navegador, etc.) y además lleva en la clave /FoliuxData una copia del modelo, que
 * permite volver a editarla al reabrir el archivo, aunque se hayan girado o movido páginas.
 */

const FOLIUX_DATA = PDFName.of('FoliuxData');
const FOLIUX_PREFIX = 'foliux:';
const DATA_VERSION = 1;

/** Marca de texto que aparece en el archivo cuando contiene anotaciones de Foliux. */
export const FOLIUX_MARKER = 'FoliuxData';

// ---------------------------------------------------------------------------
// Utilidades de dibujo
// ---------------------------------------------------------------------------

export const num = (n: number): string => String(Math.round(n * 1000) / 1000);

function hexToRgb(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255];
}

const rgb = (hex: string): string => hexToRgb(hex).map(num).join(' ');

/** Caracteres de WinAnsi fuera de Latin-1 (0x80-0x9F) que sí se pueden escribir con Helvetica. */
const WIN_ANSI_EXTRA: Record<string, number> = {
  '€': 0x80,
  '‚': 0x82,
  '„': 0x84,
  '…': 0x85,
  '†': 0x86,
  '‡': 0x87,
  '‰': 0x89,
  '‹': 0x8b,
  '‘': 0x91,
  '’': 0x92,
  '“': 0x93,
  '”': 0x94,
  '•': 0x95,
  '–': 0x96,
  '—': 0x97,
  '™': 0x99,
  '›': 0x9b,
};

/** Deja solo caracteres que Helvetica (WinAnsi) puede representar; el resto pasa a «?». */
export function toWinAnsi(text: string): string {
  let out = '';
  for (const char of text.replace(/\r\n?/g, '\n')) {
    const code = char.charCodeAt(0);
    if (char === '\n') out += char;
    else if (code < 32) continue;
    else if (code <= 0xff && !(code >= 0x80 && code <= 0x9f)) out += char;
    else if (WIN_ANSI_EXTRA[char] !== undefined) out += char;
    else out += '?';
  }
  return out;
}

/** Texto como literal PDF `( ... )` en ASCII puro (los caracteres no ASCII van en octal). */
export function pdfStringLiteral(text: string): string {
  let out = '(';
  for (const char of text) {
    const code = WIN_ANSI_EXTRA[char] ?? char.charCodeAt(0);
    if (char === '\\' || char === '(' || char === ')') out += `\\${char}`;
    else if (code < 32 || code > 126) out += `\\${code.toString(8).padStart(3, '0')}`;
    else out += char;
  }
  return `${out})`;
}

/** Divide el texto en líneas que caben en `maxWidth` (respeta los saltos de línea del usuario). */
export function wrapText(
  text: string,
  measure: (line: string) => number,
  maxWidth: number,
): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    let current = '';
    for (const word of paragraph.split(/(?<= )/)) {
      const candidate = current + word;
      if (current !== '' && measure(candidate.trimEnd()) > maxWidth) {
        lines.push(current.trimEnd());
        current = word;
      } else {
        current = candidate;
      }
    }
    lines.push(current.trimEnd());
  }
  return lines;
}

/**
 * Dónde se dibuja: la apariencia (AP) de una anotación o directamente la página.
 * Quien implementa el contexto registra la fuente o la imagen en los recursos que correspondan
 * y devuelve el nombre con el que el contenido debe referirse a ella.
 */
export interface DrawContext {
  font(
    family: FontFamily,
    bold: boolean,
    italic: boolean,
  ): Promise<{ name: string; font: PDFFont }>;
  image(annotation: AnnotationOf<'image'>): Promise<{ name: string }>;
}

export interface Drawing {
  /** Contenido, en coordenadas de vista (y hacia abajo). */
  content: string;
  blend?: 'Multiply';
}

const STANDARD_FONTS: Record<FontFamily, [string, string, string, string]> = {
  sans: ['Helvetica', 'HelveticaBold', 'HelveticaOblique', 'HelveticaBoldOblique'],
  serif: ['TimesRoman', 'TimesRomanBold', 'TimesRomanItalic', 'TimesRomanBoldItalic'],
  mono: ['Courier', 'CourierBold', 'CourierOblique', 'CourierBoldOblique'],
};

/** Fuentes e imágenes ya incrustadas en un documento, para no repetirlas. */
export function createResourceCache(doc: PDFDocument) {
  const fonts = new Map<string, Promise<PDFFont>>();
  const images = new Map<string, Promise<PDFImage>>();
  return {
    fontName: (family: FontFamily, bold: boolean, italic: boolean) =>
      `Fl${family}${bold ? 'B' : ''}${italic ? 'I' : ''}`,
    font(family: FontFamily, bold: boolean, italic: boolean): Promise<PDFFont> {
      const key = `${family}${bold}${italic}`;
      let font = fonts.get(key);
      if (!font) {
        const variant = STANDARD_FONTS[family][(bold ? 1 : 0) + (italic ? 2 : 0)];
        font = doc.embedFont(StandardFonts[variant as keyof typeof StandardFonts]);
        fonts.set(key, font);
      }
      return font;
    },
    imageName: (annotation: AnnotationOf<'image'>) =>
      `Im${annotation.id.replace(/[^A-Za-z0-9]/g, '')}`,
    image(annotation: AnnotationOf<'image'>): Promise<PDFImage> {
      let image = images.get(annotation.id);
      if (!image) {
        const base64 = annotation.src.slice(annotation.src.indexOf(',') + 1);
        const bytes = Buffer.from(base64, 'base64');
        image = annotation.format === 'png' ? doc.embedPng(bytes) : doc.embedJpg(bytes);
        images.set(annotation.id, image);
      }
      return image;
    },
  };
}

export type ResourceCache = ReturnType<typeof createResourceCache>;

/** Elipse como cuatro curvas de Bézier. */
function ellipsePath(x: number, y: number, w: number, h: number): string {
  const k = 0.5523;
  const cx = x + w / 2;
  const cy = y + h / 2;
  const rx = w / 2;
  const ry = h / 2;
  return [
    `${num(cx + rx)} ${num(cy)} m`,
    `${num(cx + rx)} ${num(cy + ry * k)} ${num(cx + rx * k)} ${num(cy + ry)} ${num(cx)} ${num(cy + ry)} c`,
    `${num(cx - rx * k)} ${num(cy + ry)} ${num(cx - rx)} ${num(cy + ry * k)} ${num(cx - rx)} ${num(cy)} c`,
    `${num(cx - rx)} ${num(cy - ry * k)} ${num(cx - rx * k)} ${num(cy - ry)} ${num(cx)} ${num(cy - ry)} c`,
    `${num(cx + rx * k)} ${num(cy - ry)} ${num(cx + rx)} ${num(cy - ry * k)} ${num(cx + rx)} ${num(cy)} c`,
    'h',
  ].join(' ');
}

export async function draw(a: Annotation, ctx: DrawContext): Promise<Drawing> {
  const color = rgb(a.color);
  switch (a.kind) {
    case 'highlight':
      return {
        blend: 'Multiply',
        content: `${color} rg ${a.rects
          .map((r) => `${num(r.x)} ${num(r.y)} ${num(r.width)} ${num(r.height)} re f`)
          .join(' ')}`,
      };
    case 'underline':
    case 'strikeout': {
      const parts = a.rects.map((r) => {
        const thickness = Math.min(2.5, Math.max(0.75, r.height * 0.07));
        const y = a.kind === 'underline' ? r.y + r.height - thickness : r.y + r.height * 0.55;
        return `${num(thickness)} w ${num(r.x)} ${num(y)} m ${num(r.x + r.width)} ${num(y)} l S`;
      });
      return { content: `${color} RG ${parts.join(' ')}` };
    }
    case 'ink':
      return {
        content:
          `${color} RG ${num(a.strokeWidth)} w 1 J 1 j ` +
          a.strokes
            .map((stroke) => {
              const [first, ...rest] = stroke;
              if (!first) return '';
              const points = rest.length === 0 ? [first] : rest;
              return `${num(first.x)} ${num(first.y)} m ${points
                .map((p) => `${num(p.x)} ${num(p.y)} l`)
                .join(' ')} S`;
            })
            .join(' '),
      };
    case 'rect': {
      const half = a.strokeWidth / 2;
      const r = a.rect;
      return {
        content: `${color} RG ${num(a.strokeWidth)} w ${num(r.x + half)} ${num(r.y + half)} ${num(
          Math.max(0, r.width - a.strokeWidth),
        )} ${num(Math.max(0, r.height - a.strokeWidth))} re S`,
      };
    }
    case 'ellipse': {
      const half = a.strokeWidth / 2;
      const r = a.rect;
      return {
        content: `${color} RG ${num(a.strokeWidth)} w ${ellipsePath(
          r.x + half,
          r.y + half,
          Math.max(0, r.width - a.strokeWidth),
          Math.max(0, r.height - a.strokeWidth),
        )} S`,
      };
    }
    case 'line':
      return {
        content: `${color} RG ${num(a.strokeWidth)} w 1 J ${num(a.from.x)} ${num(a.from.y)} m ${num(a.to.x)} ${num(a.to.y)} l S`,
      };
    case 'arrow': {
      const dx = a.to.x - a.from.x;
      const dy = a.to.y - a.from.y;
      const length = Math.hypot(dx, dy) || 1;
      const ux = dx / length;
      const uy = dy / length;
      const head = Math.min(length, Math.max(8, a.strokeWidth * 4));
      const angle = (28 * Math.PI) / 180;
      const wing = (sign: number) => {
        const cos = Math.cos(angle * sign);
        const sin = Math.sin(angle * sign);
        return {
          x: a.to.x - head * (ux * cos - uy * sin),
          y: a.to.y - head * (ux * sin + uy * cos),
        };
      };
      const left = wing(1);
      const right = wing(-1);
      const base = { x: a.to.x - ux * head * 0.8, y: a.to.y - uy * head * 0.8 };
      return {
        content:
          `${color} RG ${color} rg ${num(a.strokeWidth)} w 1 J 1 j ` +
          `${num(a.from.x)} ${num(a.from.y)} m ${num(base.x)} ${num(base.y)} l S ` +
          `${num(a.to.x)} ${num(a.to.y)} m ${num(left.x)} ${num(left.y)} l ${num(right.x)} ${num(right.y)} l h f`,
      };
    }
    case 'note': {
      const { x, y } = a.at;
      const s = NOTE_SIZE;
      const line = (i: number) =>
        `${num(x + s * 0.22)} ${num(y + s * (0.3 + i * 0.2))} m ${num(x + s * 0.78)} ${num(y + s * (0.3 + i * 0.2))} l S`;
      return {
        content:
          `${color} rg 0.25 0.25 0.25 RG 1 w ${num(x + 0.5)} ${num(y + 0.5)} ${num(s - 1)} ${num(s - 1)} re B ` +
          `0.25 0.25 0.25 RG 1 w ${line(0)} ${line(1)} ${line(2)}`,
      };
    }
    case 'text': {
      const { name, font } = await ctx.font(a.font, a.bold, a.italic);
      const text = toWinAnsi(a.text);
      const pad = 2;
      const lines = a.nowrap
        ? text.split('\n')
        : wrapText(
            text,
            (line) => font.widthOfTextAtSize(line, a.fontSize),
            Math.max(1, a.rect.width - 2 * pad),
          );
      const lineHeight = a.fontSize * 1.2;
      const body = lines
        .map((line, i) => {
          const width = font.widthOfTextAtSize(line, a.fontSize);
          const x =
            a.align === 'center'
              ? a.rect.x + (a.rect.width - width) / 2
              : a.align === 'right'
                ? a.rect.x + a.rect.width - pad - width
                : a.rect.x + pad;
          const y = a.rect.y + pad + a.fontSize * 0.88 + i * lineHeight;
          return `BT /${name} ${num(a.fontSize)} Tf 1 0 0 -1 ${num(x)} ${num(y)} Tm ${pdfStringLiteral(line)} Tj ET`;
        })
        .join(' ');
      const background = a.background
        ? `${rgb(a.background)} rg ${num(a.rect.x)} ${num(a.rect.y)} ${num(a.rect.width)} ${num(a.rect.height)} re f `
        : '';
      const content = `${background}${color} rg ${body}`;
      if (a.angle === 0) return { content };
      // Giro alrededor del centro del cuadro (en la vista, con y hacia abajo, un ángulo positivo es horario).
      const cx = a.rect.x + a.rect.width / 2;
      const cy = a.rect.y + a.rect.height / 2;
      const rad = (a.angle * Math.PI) / 180;
      const [cos, sin] = [Math.cos(rad), Math.sin(rad)];
      return {
        content: `q 1 0 0 1 ${num(cx)} ${num(cy)} cm ${num(cos)} ${num(sin)} ${num(-sin)} ${num(cos)} 0 0 cm 1 0 0 1 ${num(-cx)} ${num(-cy)} cm ${content} Q`,
      };
    }
    case 'redact': {
      const r = a.rect;
      return {
        content: `${color} rg ${color} RG 1.5 w ${num(r.x)} ${num(r.y)} ${num(r.width)} ${num(r.height)} re B`,
      };
    }
    case 'image': {
      const { name } = await ctx.image(a);
      const r = a.rect;
      // Dentro de la vista (y hacia abajo) la imagen se dibuja con la y invertida para que salga derecha.
      return {
        content: `q ${num(r.width)} 0 0 ${num(-r.height)} ${num(r.x)} ${num(r.y + r.height)} cm /${name} Do Q`,
      };
    }
    case 'freetext': {
      const { name: fontName, font } = await ctx.font('sans', false, false);
      const text = toWinAnsi(a.text);
      const pad = 2;
      const lines = wrapText(
        text,
        (line) => font.widthOfTextAtSize(line, a.fontSize),
        Math.max(1, a.rect.width - 2 * pad),
      );
      const lineHeight = a.fontSize * 1.2;
      const body = lines
        .map(
          (line, i) =>
            `BT /${fontName} ${num(a.fontSize)} Tf 1 0 0 -1 ${num(a.rect.x + pad)} ${num(
              a.rect.y + pad + a.fontSize * 0.88 + i * lineHeight,
            )} Tm ${pdfStringLiteral(line)} Tj ET`,
        )
        .join(' ');
      return { content: `${color} rg ${body}` };
    }
  }
}

// ---------------------------------------------------------------------------
// Geometría de página
// ---------------------------------------------------------------------------

export interface PageGeometry {
  rotation: 0 | 90 | 180 | 270;
  box: PageBox;
  /** vista → usuario */
  matrix: Matrix;
}

export function pageGeometry(page: PDFPage): PageGeometry {
  const rotation = normalizeRotation(page.getRotation().angle);
  const crop = page.getCropBox();
  const box = { x: crop.x, y: crop.y, width: crop.width, height: crop.height };
  return { rotation, box, matrix: viewToUserMatrix(rotation, box) };
}

// ---------------------------------------------------------------------------
// Escritura
// ---------------------------------------------------------------------------

const SUBTYPES: Record<Annotation['kind'], string> = {
  highlight: 'Highlight',
  underline: 'Underline',
  strikeout: 'StrikeOut',
  ink: 'Ink',
  rect: 'Square',
  ellipse: 'Circle',
  line: 'Line',
  arrow: 'Line',
  note: 'Text',
  freetext: 'FreeText',
  // El contenido permanente no se guarda como anotación; se incluyen por completitud del tipo.
  text: 'Stamp',
  image: 'Stamp',
  // Se ve como un recuadro rojo semitransparente en cualquier lector.
  redact: 'Square',
};

/** Reemplaza las anotaciones de Foliux del documento por las indicadas. */
export async function writeAnnotations(
  doc: PDFDocument,
  annotations: readonly Annotation[],
): Promise<void> {
  stripFoliuxAnnotations(doc);
  // El texto y las imágenes permanentes no se guardan como anotaciones (ver permanent.ts).
  const editable = annotations.filter((a) => !isPermanent(a));
  if (editable.length === 0) return;

  const pages = doc.getPages();
  const cache = createResourceCache(doc);
  // Recursos que usa la apariencia que se está construyendo.
  let usedFonts: Record<string, PDFRef> = {};
  const ctx: DrawContext = {
    async font(family, bold, italic) {
      const font = await cache.font(family, bold, italic);
      const name = cache.fontName(family, bold, italic);
      usedFonts[name] = font.ref;
      return { name, font };
    },
    async image() {
      throw new Error('Las imágenes no se guardan como anotaciones.');
    },
  };
  const context = doc.context;

  for (const annotation of editable) {
    const page = pages[annotation.page - 1];
    if (!page) continue;
    usedFonts = {};
    const geometry = pageGeometry(page);
    const m = geometry.matrix;
    const drawing = await draw(annotation, ctx);

    // Rectángulo de la anotación en el espacio del PDF.
    const bounds = transformRect(m, annotationBounds(annotation));
    const rect = [bounds.x, bounds.y, bounds.x + bounds.width, bounds.y + bounds.height];

    const resources: Record<string, unknown> = {
      ExtGState: {
        GS: {
          Type: 'ExtGState',
          ca: annotation.opacity,
          CA: annotation.opacity,
          ...(drawing.blend ? { BM: drawing.blend } : {}),
        },
      },
    };
    if (Object.keys(usedFonts).length > 0) resources.Font = usedFonts;

    const content = `q /GS gs ${m.map(num).join(' ')} cm ${drawing.content} Q`;
    const appearance = context.register(
      context.stream(content, {
        Type: 'XObject',
        Subtype: 'Form',
        BBox: rect,
        Resources: resources as never,
      }),
    );

    const [r, g, b] = hexToRgb(annotation.color);
    const entries: Record<string, unknown> = {
      Type: 'Annot',
      Subtype: SUBTYPES[annotation.kind],
      Rect: rect,
      F: 4,
      C: [r, g, b],
      CA: annotation.opacity,
      T: PDFString.of('Foliux'),
      NM: PDFString.of(`${FOLIUX_PREFIX}${annotation.id}`),
      Contents: PDFHexString.fromText(annotation.text),
      AP: { N: appearance },
      FoliuxData: PDFHexString.fromText(
        JSON.stringify({ v: DATA_VERSION, rot: geometry.rotation, a: annotation }),
      ),
    };

    switch (annotation.kind) {
      case 'highlight':
      case 'underline':
      case 'strikeout':
        entries.QuadPoints = annotation.rects.flatMap((q) => {
          const tl = applyMatrix(m, { x: q.x, y: q.y });
          const tr = applyMatrix(m, { x: q.x + q.width, y: q.y });
          const bl = applyMatrix(m, { x: q.x, y: q.y + q.height });
          const br = applyMatrix(m, { x: q.x + q.width, y: q.y + q.height });
          return [tl.x, tl.y, tr.x, tr.y, bl.x, bl.y, br.x, br.y];
        });
        break;
      case 'ink':
        entries.InkList = annotation.strokes.map((s) =>
          s.flatMap((p) => {
            const u = applyMatrix(m, p);
            return [u.x, u.y];
          }),
        );
        entries.BS = { W: annotation.strokeWidth };
        break;
      case 'rect':
      case 'ellipse':
        entries.BS = { W: annotation.strokeWidth };
        break;
      case 'line':
      case 'arrow': {
        const from = applyMatrix(m, annotation.from);
        const to = applyMatrix(m, annotation.to);
        entries.L = [from.x, from.y, to.x, to.y];
        entries.LE = ['None', annotation.kind === 'arrow' ? 'ClosedArrow' : 'None'];
        entries.BS = { W: annotation.strokeWidth };
        break;
      }
      case 'note':
        entries.Name = 'Comment';
        entries.Open = false;
        break;
      case 'freetext':
        entries.DA = PDFString.of(
          `${rgb(annotation.color)} rg /Helv ${num(annotation.fontSize)} Tf`,
        );
        entries.Q = 0;
        break;
    }

    const ref = context.register(context.obj(entries as never));
    page.node.addAnnot(ref);
  }
}

// ---------------------------------------------------------------------------
// Lectura y borrado
// ---------------------------------------------------------------------------

/** ¿Hay anotaciones de Foliux en estos bytes? Búsqueda rápida sin abrir el documento. */
export function mayContainFoliuxAnnotations(data: Uint8Array): boolean {
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength).includes(FOLIUX_MARKER);
}

function decodeText(value: unknown): string | undefined {
  return value instanceof PDFHexString || value instanceof PDFString
    ? value.decodeText()
    : undefined;
}

/** Recorre las anotaciones de Foliux de cada página (de la última a la primera). */
function eachFoliuxAnnotation(
  doc: PDFDocument,
  visit: (info: { page: PDFPage; pageNumber: number; dict: PDFDict; remove: () => void }) => void,
): void {
  doc.getPages().forEach((page, pageIndex) => {
    const annots = page.node.Annots();
    if (!annots) return;
    for (let i = annots.size() - 1; i >= 0; i--) {
      const dict = annots.lookupMaybe(i, PDFDict);
      if (!dict?.has(FOLIUX_DATA)) continue;
      visit({ page, pageNumber: pageIndex + 1, dict, remove: () => annots.remove(i) });
    }
  });
}

/** Quita del documento todas las anotaciones creadas por Foliux. Devuelve cuántas quitó. */
export function stripFoliuxAnnotations(doc: PDFDocument): number {
  let removed = 0;
  eachFoliuxAnnotation(doc, ({ remove }) => {
    remove();
    removed += 1;
  });
  return removed;
}

/** Lee las anotaciones de Foliux del documento, adaptadas a la rotación actual de cada página. */
export function readAnnotations(doc: PDFDocument): Annotation[] {
  const found: Annotation[] = [];
  eachFoliuxAnnotation(doc, ({ page, pageNumber, dict }) => {
    const text = decodeText(dict.lookup(FOLIUX_DATA));
    if (!text) return;
    try {
      const payload = JSON.parse(text) as { v?: number; rot?: number; a?: unknown };
      const parsed = AnnotationSchema.safeParse(payload.a);
      if (!parsed.success) return;

      let annotation: Annotation = { ...parsed.data, page: pageNumber };
      const geometry = pageGeometry(page);
      const savedRotation = normalizeRotation(payload.rot ?? geometry.rotation);
      if (savedRotation !== geometry.rotation) {
        // La página se giró desde que se guardó: se reubica la anotación en la nueva vista.
        const toUser = viewToUserMatrix(savedRotation, geometry.box);
        const toView = invertMatrix(geometry.matrix);
        annotation = mapAnnotation(annotation, (p) => applyMatrix(toView, applyMatrix(toUser, p)));
      }
      found.push(annotation);
    } catch {
      // Datos dañados: se ignora la anotación (el dibujo del PDF sigue ahí).
    }
  });

  // Orden estable (página y orden de creación) y sin identificadores repetidos
  // (pasa al duplicar páginas o al insertar el mismo archivo dos veces).
  found.sort((a, b) => a.page - b.page || a.createdAt - b.createdAt);
  const seen = new Set<string>();
  return found.map((annotation, index) => {
    if (!seen.has(annotation.id)) {
      seen.add(annotation.id);
      return annotation;
    }
    const id = `${annotation.id}-${index}`;
    seen.add(id);
    return { ...annotation, id };
  });
}
