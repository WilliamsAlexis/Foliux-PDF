import type { PDFDocument, PDFName, PDFPage } from 'pdf-lib';
import { isPermanent, type Annotation } from '@foliux-pdf/core';
import {
  createResourceCache,
  draw,
  num,
  pageGeometry,
  type DrawContext,
  type ResourceCache,
} from './annotation-codec';

/**
 * Incorpora al contenido de las páginas el texto y las imágenes «permanentes». A diferencia de las
 * anotaciones, quedan dentro del propio contenido de la página: no se pueden mover ni borrar con
 * un lector, y cualquier programa las muestra igual.
 */
export async function drawPermanentItems(
  doc: PDFDocument,
  items: readonly Annotation[],
  cache: ResourceCache = createResourceCache(doc),
): Promise<void> {
  const permanent = items.filter(isPermanent);
  if (permanent.length === 0) return;

  const byPage = new Map<number, Annotation[]>();
  for (const item of permanent) {
    const list = byPage.get(item.page);
    if (list) list.push(item);
    else byPage.set(item.page, [item]);
  }

  const pages = doc.getPages();
  for (const [pageNumber, list] of byPage) {
    const page = pages[pageNumber - 1];
    if (page) await drawOnPage(doc, page, list, cache);
  }
}

async function drawOnPage(
  doc: PDFDocument,
  page: PDFPage,
  items: Annotation[],
  cache: ResourceCache,
): Promise<void> {
  const context = doc.context;

  // Se encierra el contenido previo en q…Q para que su estado gráfico no afecte a lo que se añade.
  page.node.normalize();
  page.node.wrapContentStreams(
    context.register(context.stream('q')),
    context.register(context.stream('Q')),
  );
  const { Font, XObject, ExtGState } = page.node.normalizedEntries();
  const m = pageGeometry(page).matrix;

  // Nombres únicos en la página (si ya hay recursos con el mismo nombre, no se pisan).
  const fontKeys = new Map<string, PDFName>();
  const imageKeys = new Map<string, PDFName>();
  const ctx: DrawContext = {
    async font(family, bold, italic) {
      const font = await cache.font(family, bold, italic);
      const base = cache.fontName(family, bold, italic);
      let key = fontKeys.get(base);
      if (!key) {
        key = Font.uniqueKey(base);
        Font.set(key, font.ref);
        fontKeys.set(base, key);
      }
      return { name: key.decodeText(), font };
    },
    async image(annotation) {
      const image = await cache.image(annotation);
      let key = imageKeys.get(annotation.id);
      if (!key) {
        key = XObject.uniqueKey(cache.imageName(annotation));
        XObject.set(key, image.ref);
        imageKeys.set(annotation.id, key);
      }
      return { name: key.decodeText() };
    },
  };

  for (const item of items) {
    const drawing = await draw(item, ctx);
    const gsKey = ExtGState.uniqueKey('FlGS');
    ExtGState.set(gsKey, context.obj({ Type: 'ExtGState', ca: item.opacity, CA: item.opacity }));
    const content = `q /${gsKey.decodeText()} gs ${m.map(num).join(' ')} cm ${drawing.content} Q`;
    page.node.addContentStream(context.register(context.stream(content)));
  }
}
