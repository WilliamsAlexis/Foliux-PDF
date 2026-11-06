import { StandardFonts, type PDFDocument } from 'pdf-lib';
import { FoliuxError, type PageWord } from '@foliux-pdf/core';
import { num, pageGeometry } from './annotation-codec';
import { buildInvisibleText } from './redaction';

/**
 * Añade el texto reconocido por el OCR como texto invisible sobre cada página. La imagen del escaneo no se
 * toca: lo que cambia es que el documento pasa a poder buscarse y copiarse. No convierte la imagen en
 * texto editable de verdad (eso exigiría reconstruir la maquetación y las fuentes).
 *
 * @returns cuántas palabras se añadieron.
 */
export async function addInvisibleText(
  doc: PDFDocument,
  pages: readonly { page: number; words: PageWord[] }[],
): Promise<number> {
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const context = doc.context;
  let added = 0;

  for (const input of pages) {
    const page = doc.getPages()[input.page - 1];
    if (!page) throw new FoliuxError('INVALID_REQUEST', `La página ${input.page} no existe.`);
    const body = buildInvisibleText(input.words, 'FlOcrFont', font);
    if (body === '') continue;

    // El contenido anterior se encierra en q…Q para que su estado gráfico no afecte al texto nuevo.
    page.node.normalize();
    page.node.wrapContentStreams(
      context.register(context.stream('q')),
      context.register(context.stream('Q')),
    );
    const { Font } = page.node.normalizedEntries();
    const key = Font.uniqueKey('FlOcrFont');
    Font.set(key, font.ref);

    const matrix = pageGeometry(page).matrix.map(num).join(' ');
    const content = `q ${matrix} cm ${body.replaceAll('/FlOcrFont', `/${key.decodeText()}`)} Q`;
    page.node.addContentStream(context.register(context.stream(content)));
    added += input.words.length;
  }
  return added;
}
