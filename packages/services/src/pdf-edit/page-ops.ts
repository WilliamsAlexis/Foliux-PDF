import { EncryptedPDFError, PDFDocument, degrees } from 'pdf-lib';
import { FoliuxError, type PageOp } from '@foliux-pdf/core';
import { normalizeRotation } from './geometry';
import { applyHeaderFooter, applyWatermark } from './decorations';
import { cleanMetadata } from './metadata';
import { addInvisibleText } from './ocr';
import { addFormField, deleteFormField, fillForm, flattenForm } from './forms';
import { pruneUnreachable } from './prune';

/** Abre un PDF con pdf-lib traduciendo los fallos a errores claros para el usuario. */
export async function loadPdf(data: Uint8Array, name = 'el documento'): Promise<PDFDocument> {
  try {
    return await PDFDocument.load(data, { updateMetadata: false });
  } catch (error) {
    if (error instanceof EncryptedPDFError) {
      throw new FoliuxError(
        'PDF_ENCRYPTED',
        `«${name}» está protegido con contraseña; todavía no se puede modificar.`,
        { cause: error },
      );
    }
    throw new FoliuxError('PDF_CORRUPT', `No se pudo procesar «${name}»: el PDF parece dañado.`, {
      cause: error,
    });
  }
}

/** Serializa sin flujos de objetos, para que las marcas de Foliux sean fáciles de localizar al reabrir. */
export function savePdf(doc: PDFDocument): Promise<Uint8Array> {
  // Se descartan los objetos que ya no se usan (páginas eliminadas, imágenes sustituidas, metadatos
  // borrados...): si no, seguirían dentro del archivo aunque no se vean.
  pruneUnreachable(doc);
  return doc.save({ useObjectStreams: false });
}

/**
 * pdf-lib (1.17) no invalida su lista de páginas al borrar una, y `getPages()` seguiría devolviendo
 * la página eliminada (con sus anotaciones). Se fuerza el recálculo.
 */
function invalidatePageCache(doc: PDFDocument): void {
  (doc as unknown as { pageCache?: { invalidate?: () => void } }).pageCache?.invalidate?.();
}

/** Páginas (base 1) → índices base 0 únicos y ordenados, validando el rango. */
function toIndices(pages: readonly number[], total: number): number[] {
  const unique = [...new Set(pages)].sort((a, b) => a - b);
  for (const page of unique) {
    if (page < 1 || page > total) {
      throw new FoliuxError(
        'INVALID_REQUEST',
        `La página ${page} no existe (el documento tiene ${total}).`,
      );
    }
  }
  return unique.map((p) => p - 1);
}

/**
 * Aplica una operación de páginas al documento (modifica `doc`).
 * `loadExternal` lee los bytes de otro PDF (para insertar páginas de un archivo).
 */
export async function applyPageOp(
  doc: PDFDocument,
  op: PageOp,
  loadExternal: (path: string) => Promise<{ data: Uint8Array; name: string }>,
): Promise<void> {
  const total = doc.getPageCount();

  switch (op.type) {
    case 'rotate': {
      const pages = doc.getPages();
      for (const index of toIndices(op.pages, total)) {
        const page = pages[index];
        if (page)
          page.setRotation(degrees(normalizeRotation(page.getRotation().angle + op.degrees)));
      }
      return;
    }

    case 'delete': {
      const indices = toIndices(op.pages, total);
      if (indices.length >= total) {
        throw new FoliuxError(
          'INVALID_REQUEST',
          'No se pueden borrar todas las páginas del documento.',
        );
      }
      for (const index of [...indices].reverse()) doc.removePage(index);
      invalidatePageCache(doc);
      return;
    }

    case 'reorder': {
      const sorted = [...op.order].sort((a, b) => a - b);
      const isPermutation = sorted.length === total && sorted.every((page, i) => page === i + 1);
      if (!isPermutation) {
        throw new FoliuxError('INVALID_REQUEST', 'El nuevo orden de páginas no es válido.');
      }
      const pages = doc.getPages();
      for (let i = total - 1; i >= 0; i--) doc.removePage(i);
      for (const page of op.order) {
        const original = pages[page - 1];
        if (original) doc.addPage(original);
      }
      return;
    }

    case 'duplicate': {
      for (const index of toIndices(op.pages, total).reverse()) {
        const [copy] = await doc.copyPages(doc, [index]);
        if (copy) doc.insertPage(index + 1, copy);
      }
      return;
    }

    case 'insertBlank': {
      if (op.after > total) {
        throw new FoliuxError('INVALID_REQUEST', `La página ${op.after} no existe.`);
      }
      // La página en blanco copia el tamaño y el giro de la página vecina (o A4 si no hay).
      const neighbour = doc.getPages()[Math.max(0, op.after - 1)];
      const size = neighbour ? neighbour.getSize() : { width: 595.28, height: 841.89 };
      const count = op.count ?? 1;
      for (let i = 0; i < count; i++) {
        const blank = doc.insertPage(op.after + i, [size.width, size.height]);
        if (neighbour) blank.setRotation(neighbour.getRotation());
      }
      return;
    }

    case 'ocrText':
      await addInvisibleText(doc, op.pages);
      return;

    case 'fillForm':
      await fillForm(doc, op.values);
      return;

    case 'addFormField':
      return addFormField(doc, op.field);

    case 'addFormFields':
      // Uno tras otro: cada alta ve los campos ya creados (y rechaza nombres repetidos).
      for (const field of op.fields) await addFormField(doc, field);
      return;

    case 'deleteFormField':
      return deleteFormField(doc, op.name);

    case 'flattenForm':
      return flattenForm(doc);

    case 'cleanMetadata':
      return cleanMetadata(doc, op);

    case 'applyEdits':
      // El texto y las imágenes pendientes ya se incorporaron antes de operar (ver transformPdf).
      return;

    case 'watermark':
      return applyWatermark(doc, op);

    case 'headerFooter':
      return applyHeaderFooter(doc, op);

    case 'insertFile': {
      if (op.after > total) {
        throw new FoliuxError('INVALID_REQUEST', `La página ${op.after} no existe.`);
      }
      const external = await loadExternal(op.path);
      const source = await loadPdf(external.data, external.name);
      const copied = await doc.copyPages(source, source.getPageIndices());
      copied.forEach((page, i) => doc.insertPage(op.after + i, page));
      return;
    }
  }
}
