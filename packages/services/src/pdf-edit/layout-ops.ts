import { PDFArray, PDFName, PDFString, type PDFDocument, type PDFPage } from 'pdf-lib';
import { FoliuxError, type Rect } from '@foliux-pdf/core';
import { transformRect, viewSize, viewToUserMatrix } from './geometry';

/** Recortar páginas y añadir enlaces: operaciones que cambian el «marco» de la página o le suman una zona pulsable. */

const MIN_CROP = 20; // puntos: por debajo, la página no se vería

function boxOf(page: PDFPage) {
  const { x, y, width, height } = page.getCropBox();
  return { x, y, width, height };
}

/** Pasa un rectángulo de la vista (con la rotación aplicada) al espacio del PDF. */
function toUserRect(page: PDFPage, rect: Rect): Rect {
  const box = boxOf(page);
  return transformRect(viewToUserMatrix(page.getRotation().angle, box), rect);
}

/**
 * Recorta páginas: reduce el área visible (CropBox). Importante: el contenido fuera del recorte NO se
 * borra, solo deja de verse; para eliminarlo de verdad hace falta la redacción.
 *
 * Con `allPages`, los márgenes que deja el recorte dibujado se aplican a todas las páginas.
 */
export function cropPages(
  doc: PDFDocument,
  op: { page: number; rect: Rect; allPages?: boolean },
): void {
  const pages = doc.getPages();
  const source = pages[op.page - 1];
  if (!source) throw new FoliuxError('INVALID_REQUEST', `La página ${op.page} no existe.`);

  const full = viewSize(source.getRotation().angle, boxOf(source));
  const insets = {
    left: Math.max(0, op.rect.x),
    top: Math.max(0, op.rect.y),
    right: Math.max(0, full.width - (op.rect.x + op.rect.width)),
    bottom: Math.max(0, full.height - (op.rect.y + op.rect.height)),
  };

  const targets = op.allPages ? pages : [source];
  for (const page of targets) {
    const size = viewSize(page.getRotation().angle, boxOf(page));
    const view: Rect =
      page === source
        ? {
            x: Math.max(0, op.rect.x),
            y: Math.max(0, op.rect.y),
            width: Math.min(op.rect.width, size.width - Math.max(0, op.rect.x)),
            height: Math.min(op.rect.height, size.height - Math.max(0, op.rect.y)),
          }
        : {
            x: insets.left,
            y: insets.top,
            width: size.width - insets.left - insets.right,
            height: size.height - insets.top - insets.bottom,
          };
    if (view.width < MIN_CROP || view.height < MIN_CROP) {
      throw new FoliuxError(
        'INVALID_REQUEST',
        'El recorte deja una página demasiado pequeña. Elige una zona más grande.',
      );
    }
    const user = toUserRect(page, view);
    page.setCropBox(user.x, user.y, user.width, user.height);
  }
}

/** Direcciones permitidas en un enlace: web y correo (nunca file:, javascript: ni otros esquemas). */
export function isSafeLinkUrl(url: string): boolean {
  return /^(https?:\/\/[^\s]+|mailto:[^\s]+)$/i.test(url) && url.length <= 2000;
}

/** Añade una zona pulsable que abre una dirección web/correo o salta a otra página del documento. */
export function addLink(
  doc: PDFDocument,
  op: { page: number; rect: Rect; url?: string; targetPage?: number },
): void {
  const pages = doc.getPages();
  const page = pages[op.page - 1];
  if (!page) throw new FoliuxError('INVALID_REQUEST', `La página ${op.page} no existe.`);

  const user = toUserRect(page, op.rect);
  const entries: Record<string, unknown> = {
    Type: 'Annot',
    Subtype: 'Link',
    Rect: [user.x, user.y, user.x + user.width, user.y + user.height],
    Border: [0, 0, 0],
    F: 4, // imprimible
  };

  if (op.url !== undefined) {
    if (!isSafeLinkUrl(op.url)) {
      throw new FoliuxError(
        'INVALID_REQUEST',
        'La dirección debe empezar por http://, https:// o mailto:.',
      );
    }
    entries.A = doc.context.obj({
      Type: 'Action',
      S: 'URI',
      URI: PDFString.of(op.url),
    });
  } else if (op.targetPage !== undefined) {
    const target = pages[op.targetPage - 1];
    if (!target) {
      throw new FoliuxError('INVALID_REQUEST', `La página ${op.targetPage} no existe.`);
    }
    entries.Dest = PDFArray.withContext(doc.context);
    (entries.Dest as PDFArray).push(target.ref);
    (entries.Dest as PDFArray).push(PDFName.of('Fit'));
  } else {
    throw new FoliuxError('INVALID_REQUEST', 'El enlace necesita una dirección o una página.');
  }

  const ref = doc.context.register(doc.context.obj(entries as never));
  page.node.addAnnot(ref);
}
