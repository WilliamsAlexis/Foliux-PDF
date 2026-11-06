import type { PDFDocument } from 'pdf-lib';
import {
  FoliuxError,
  newAnnotationId,
  parsePageRange,
  type Annotation,
  type AnnotationOf,
  type PageOp,
} from '@foliux-pdf/core';
import { createResourceCache, pageGeometry, toWinAnsi } from './annotation-codec';
import { viewSize } from './geometry';
import { drawPermanentItems } from './permanent';

type WatermarkOp = Extract<PageOp, { type: 'watermark' }>;
type HeaderFooterOp = Extract<PageOp, { type: 'headerFooter' }>;

const LINE_HEIGHT = 1.2;
const PADDING = 2;

function pagesFromRange(spec: string, total: number): number[] {
  try {
    return parsePageRange(spec, total);
  } catch (error) {
    throw new FoliuxError('INVALID_REQUEST', (error as Error).message);
  }
}

/** Valores comunes de un elemento de texto nuevo. */
function baseText(page: number, color: string, opacity: number) {
  return {
    id: newAnnotationId(),
    page,
    color,
    opacity,
    createdAt: Date.now(),
    background: null,
  };
}

/** Marca de agua centrada, de texto o de imagen, en las páginas indicadas. */
export async function applyWatermark(doc: PDFDocument, op: WatermarkOp): Promise<void> {
  const text = (op.text ?? '').trim();
  if (text === '' && !op.image) {
    throw new FoliuxError(
      'INVALID_REQUEST',
      'Escribe un texto o elige una imagen para la marca de agua.',
    );
  }
  const pages = pagesFromRange(op.pages, doc.getPageCount());
  const cache = createResourceCache(doc);
  const items: Annotation[] = [];
  // Una sola imagen incrustada se reutiliza en todas las páginas (misma clave en la caché).
  const imageId = newAnnotationId();

  const font = await cache.font('sans', true, false);
  const safeText = toWinAnsi(text);
  const lines = safeText.split('\n');
  const textWidth = Math.max(...lines.map((line) => font.widthOfTextAtSize(line, op.fontSize)));
  const textHeight = lines.length * op.fontSize * LINE_HEIGHT;

  for (const pageNumber of pages) {
    const page = doc.getPages()[pageNumber - 1];
    if (!page) continue;
    const geometry = pageGeometry(page);
    const view = viewSize(geometry.rotation, geometry.box);

    if (op.image) {
      const probe: AnnotationOf<'image'> = {
        ...baseText(pageNumber, '#000000', op.opacity),
        id: imageId,
        kind: 'image',
        text: '',
        rect: { x: 0, y: 0, width: 1, height: 1 },
        src: op.image.src,
        format: op.image.format,
      };
      const image = await cache.image(probe);
      const width = view.width * (op.imageWidth ?? 0.5);
      const height = width * (image.height / image.width);
      items.push({
        ...probe,
        rect: { x: (view.width - width) / 2, y: (view.height - height) / 2, width, height },
      });
    }
    if (text !== '') {
      // Si la marca (girada) no cabe en la página, se reduce lo justo para que se vea entera.
      const rad = (op.angle * Math.PI) / 180;
      const [cos, sin] = [Math.abs(Math.cos(rad)), Math.abs(Math.sin(rad))];
      const boxW = textWidth + 2 * PADDING + 2;
      const boxH = textHeight + 2 * PADDING;
      const extentW = boxW * cos + boxH * sin;
      const extentH = boxW * sin + boxH * cos;
      const fit = Math.min(1, (view.width * 0.94) / extentW, (view.height * 0.94) / extentH);
      const width = boxW * fit;
      const height = boxH * fit;
      items.push({
        ...baseText(pageNumber, op.color, op.opacity),
        kind: 'text',
        text: safeText,
        rect: {
          x: (view.width - width) / 2,
          y: (view.height - height) / 2,
          width,
          height,
        },
        fontSize: op.fontSize * fit,
        font: 'sans',
        bold: true,
        italic: false,
        align: 'center',
        angle: op.angle,
        nowrap: true,
      });
    }
  }
  await drawPermanentItems(doc, items, cache);
}

/** Sustituye los marcadores {page}, {pages}, {date} y {file} de un texto de encabezado o pie. */
export function fillTokens(
  template: string,
  values: { page: number; pages: number; date: string; file: string },
): string {
  return template
    .replace(/\{page\}/gi, String(values.page))
    .replace(/\{pages\}/gi, String(values.pages))
    .replace(/\{date\}/gi, values.date)
    .replace(/\{file\}/gi, values.file);
}

/** Encabezado y pie de página (izquierda, centro y derecha) en las páginas indicadas. */
export async function applyHeaderFooter(doc: PDFDocument, op: HeaderFooterOp): Promise<void> {
  const total = doc.getPageCount();
  const pages = pagesFromRange(op.pages, total);
  const cache = createResourceCache(doc);
  const date = new Date().toLocaleDateString('es-ES');
  const items: Annotation[] = [];
  const boxHeight = op.fontSize * LINE_HEIGHT + 2 * PADDING;

  for (const pageNumber of pages) {
    const page = doc.getPages()[pageNumber - 1];
    if (!page) continue;
    const geometry = pageGeometry(page);
    const view = viewSize(geometry.rotation, geometry.box);
    const values = {
      page: pageNumber - 1 + (op.startNumber ?? 1),
      pages: total,
      date,
      file: op.fileName ?? '',
    };

    const regions = [
      { y: op.margin, line: op.header },
      { y: view.height - op.margin - boxHeight, line: op.footer },
    ] as const;
    for (const { y, line } of regions) {
      for (const align of ['left', 'center', 'right'] as const) {
        const template = line[align];
        if (template.trim() === '') continue;
        items.push({
          ...baseText(pageNumber, op.color, 1),
          kind: 'text',
          text: toWinAnsi(fillTokens(template, values)),
          rect: {
            x: op.margin,
            y,
            width: Math.max(1, view.width - 2 * op.margin),
            height: boxHeight,
          },
          fontSize: op.fontSize,
          font: op.font,
          bold: false,
          italic: false,
          align,
          angle: 0,
          nowrap: true,
        });
      }
    }
  }
  await drawPermanentItems(doc, items, cache);
}
