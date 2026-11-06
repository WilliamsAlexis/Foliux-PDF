import { PDFArray, PDFDict, PDFHexString, PDFName, PDFString, type PDFDocument } from 'pdf-lib';
import type { MetadataReport, PageOp } from '@foliux-pdf/core';
import { loadPdf } from './page-ops';

type CleanOp = Extract<PageOp, { type: 'cleanMetadata' }>;

const name = PDFName.of;

function text(value: unknown): string {
  return value instanceof PDFHexString || value instanceof PDFString ? value.decodeText() : '';
}

/** Nombres de un árbol de nombres (/Names y /Kids), como el de los archivos adjuntos. */
function collectNameTree(node: PDFDict | undefined, depth = 0): { key: string; value: unknown }[] {
  if (!node || depth > 20) return [];
  const found: { key: string; value: unknown }[] = [];
  const names = node.lookupMaybe(name('Names'), PDFArray);
  if (names) {
    for (let i = 0; i + 1 < names.size(); i += 2) {
      found.push({ key: text(names.lookup(i)), value: names.lookup(i + 1) });
    }
  }
  const kids = node.lookupMaybe(name('Kids'), PDFArray);
  if (kids) {
    for (let i = 0; i < kids.size(); i++) {
      found.push(...collectNameTree(kids.lookupMaybe(i, PDFDict), depth + 1));
    }
  }
  return found;
}

function namesDict(doc: PDFDocument): PDFDict | undefined {
  return doc.catalog.lookupMaybe(name('Names'), PDFDict);
}

function isJavaScriptAction(action: unknown): boolean {
  return action instanceof PDFDict && action.lookup(name('S'))?.toString() === '/JavaScript';
}

/** Qué metadatos y datos ocultos contiene el documento. */
export function inspectDocument(doc: PDFDocument): MetadataReport {
  const names = namesDict(doc);
  const attachments = collectNameTree(names?.lookupMaybe(name('EmbeddedFiles'), PDFDict)).map(
    (entry) => entry.key,
  );
  const hasJavaScript =
    names?.has(name('JavaScript')) === true ||
    isJavaScriptAction(doc.catalog.lookup(name('OpenAction'))) ||
    doc.catalog.has(name('AA'));

  return {
    title: doc.getTitle() ?? '',
    author: doc.getAuthor() ?? '',
    subject: doc.getSubject() ?? '',
    keywords: doc.getKeywords() ?? '',
    creator: doc.getCreator() ?? '',
    producer: doc.getProducer() ?? '',
    created: doc.getCreationDate()?.toISOString() ?? '',
    modified: doc.getModificationDate()?.toISOString() ?? '',
    hasXmp: doc.catalog.has(name('Metadata')),
    thumbnails: doc.getPages().filter((page) => page.node.has(name('Thumb'))).length,
    attachments,
    hasJavaScript,
  };
}

export async function inspectMetadata(data: Uint8Array): Promise<MetadataReport> {
  return inspectDocument(await loadPdf(data));
}

/** Borra los metadatos y datos ocultos que se indiquen. Los objetos sueltos los descarta la poda al guardar. */
export function cleanMetadata(doc: PDFDocument, op: CleanOp): void {
  const context = doc.context;

  if (op.info) {
    // Un diccionario de información vacío: ni título, autor, programa, fechas ni palabras clave.
    context.trailerInfo.Info = context.register(context.obj({}));
  }

  if (op.xmp) {
    doc.catalog.delete(name('Metadata'));
    for (const page of doc.getPages()) page.node.delete(name('Metadata'));
  }

  if (op.thumbnails) {
    for (const page of doc.getPages()) page.node.delete(name('Thumb'));
  }

  const names = namesDict(doc);
  if (op.attachments) {
    names?.delete(name('EmbeddedFiles'));
    // «Archivos asociados» (/AF): otra vía por la que un adjunto sigue alcanzable desde el documento.
    doc.catalog.delete(name('AF'));
    for (const page of doc.getPages()) page.node.delete(name('AF'));
    // Anotaciones de tipo «archivo adjunto» (el clip de papel): se quitan de las páginas.
    for (const page of doc.getPages()) {
      const annots = page.node.Annots();
      if (!annots) continue;
      for (let i = annots.size() - 1; i >= 0; i--) {
        const annotation = annots.lookupMaybe(i, PDFDict);
        if (annotation?.lookup(name('Subtype'))?.toString() === '/FileAttachment') annots.remove(i);
      }
    }
  }

  if (op.javascript) {
    names?.delete(name('JavaScript'));
    if (isJavaScriptAction(doc.catalog.lookup(name('OpenAction')))) {
      doc.catalog.delete(name('OpenAction'));
    }
    doc.catalog.delete(name('AA'));
    for (const page of doc.getPages()) {
      page.node.delete(name('AA'));
      const annots = page.node.Annots();
      if (!annots) continue;
      for (let i = 0; i < annots.size(); i++) {
        const annotation = annots.lookupMaybe(i, PDFDict);
        if (!annotation) continue;
        annotation.delete(name('AA'));
        if (isJavaScriptAction(annotation.lookup(name('A')))) annotation.delete(name('A'));
      }
    }
  }
}
