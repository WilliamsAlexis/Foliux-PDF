import { PDFDocument } from 'pdf-lib';
import {
  planSplit,
  type Annotation,
  type FormFieldInfo,
  type PageOp,
  type SplitPlan,
} from '@foliux-pdf/core';
import {
  mayContainFoliuxAnnotations,
  readAnnotations,
  stripFoliuxAnnotations,
  writeAnnotations,
} from './annotation-codec';
import { applyPageOp, loadPdf, savePdf } from './page-ops';
import { drawPermanentItems } from './permanent';
import { pruneUnreachable } from './prune';
import { redactPages, type RedactedPageInput } from './redaction';

export { FOLIUX_MARKER, toWinAnsi, wrapText } from './annotation-codec';
export { fillTokens } from './decorations';
export * from './geometry';
export { inspectMetadata } from './metadata';
export { listFormFields, mayContainForm } from './forms';
export { convertToPdfA, type PdfAIssue, type PdfAResult } from './pdfa';
export { pruneUnreachable } from './prune';

const PRODUCER = 'Foliux PDF';

/** Abre el documento e incorpora el texto/imágenes permanentes y las anotaciones. */
async function prepare(
  data: Uint8Array,
  annotations: readonly Annotation[],
  name?: string,
): Promise<PDFDocument> {
  const doc = await loadPdf(data, name);
  await drawPermanentItems(doc, annotations);
  await writeAnnotations(doc, annotations);
  return doc;
}

/**
 * Prepara un PDF recién leído para editarlo: separa las anotaciones que Foliux guardó antes
 * (para poder editarlas) y devuelve el documento sin ellas. Si no hay o algo falla, no toca nada.
 */
export async function openForEditing(
  data: Uint8Array,
): Promise<{ data: Uint8Array; annotations: Annotation[]; recovered: boolean }> {
  if (!mayContainFoliuxAnnotations(data)) return { data, annotations: [], recovered: false };
  try {
    const doc = await loadPdf(data);
    const annotations = readAnnotations(doc);
    if (annotations.length === 0) return { data, annotations: [], recovered: false };
    stripFoliuxAnnotations(doc);
    return { data: await savePdf(doc), annotations, recovered: true };
  } catch {
    // Archivo que pdf-lib no puede procesar: se muestra tal cual (sin poder editar sus anotaciones).
    return { data, annotations: [], recovered: false };
  }
}

/** Devuelve el PDF con todo incorporado (anotaciones y contenido permanente), listo para guardar. */
export async function bakeAnnotations(
  data: Uint8Array,
  annotations: readonly Annotation[],
  name?: string,
): Promise<Uint8Array> {
  return savePdf(await prepare(data, annotations, name));
}

/**
 * Aplica una operación de páginas conservando las anotaciones: se incorporan al documento,
 * se opera y se vuelven a leer (así siguen a su página y se adaptan a los giros).
 * El texto y las imágenes permanentes pasan a formar parte del contenido de las páginas.
 */
export async function transformPdf(
  data: Uint8Array,
  annotations: readonly Annotation[],
  op: PageOp,
  loadExternal: (path: string) => Promise<{ data: Uint8Array; name: string }>,
): Promise<{ data: Uint8Array; annotations: Annotation[] }> {
  const doc = await prepare(data, annotations);
  await applyPageOp(doc, op, loadExternal);
  const result = readAnnotations(doc);
  stripFoliuxAnnotations(doc);
  return { data: await savePdf(doc), annotations: result };
}

async function copyPagesToNew(source: PDFDocument, pages: readonly number[]): Promise<Uint8Array> {
  const total = source.getPageCount();
  const indices = [...new Set(pages)].sort((a, b) => a - b).map((p) => p - 1);
  if (indices.some((i) => i < 0 || i >= total)) throw new RangeError('Página fuera de rango');

  const output = await PDFDocument.create({ updateMetadata: false });
  output.setProducer(PRODUCER);
  for (const page of await output.copyPages(source, indices)) output.addPage(page);
  return savePdf(output);
}

/** Crea un PDF nuevo solo con las páginas indicadas (con sus anotaciones incorporadas). */
export async function extractPages(
  data: Uint8Array,
  annotations: readonly Annotation[],
  pages: readonly number[],
): Promise<Uint8Array> {
  return copyPagesToNew(await prepare(data, annotations), pages);
}

/** Divide un documento en varios PDFs según el plan. Devuelve un archivo por grupo de páginas. */
export async function splitPdf(
  data: Uint8Array,
  annotations: readonly Annotation[],
  plan: SplitPlan,
): Promise<{ pages: number[]; data: Uint8Array }[]> {
  const source = await prepare(data, annotations);
  const groups = planSplit(source.getPageCount(), plan);
  const files: { pages: number[]; data: Uint8Array }[] = [];
  for (const pages of groups) files.push({ pages, data: await copyPagesToNew(source, pages) });
  return files;
}

/**
 * Copia optimizada sin pérdida: se reescribe el documento agrupando los objetos en flujos comprimidos.
 * No recomprime ni reduce imágenes, así que el ahorro depende de cuántos objetos pequeños tenga el PDF.
 * Las anotaciones quedan incorporadas (ya no se podrán editar al reabrir la copia).
 */
/** Crea un PDF en blanco: `pages` páginas del tamaño indicado (puntos). */
export async function createBlankPdf(spec: {
  width: number;
  height: number;
  pages: number;
}): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  doc.setProducer('Foliux PDF');
  doc.setCreator('Foliux PDF');
  doc.setCreationDate(new Date());
  for (let i = 0; i < spec.pages; i++) doc.addPage([spec.width, spec.height]);
  return savePdf(doc);
}

export async function optimizePdf(
  data: Uint8Array,
  annotations: readonly Annotation[],
): Promise<Uint8Array> {
  const doc = await prepare(data, annotations);
  doc.setProducer(PRODUCER);
  pruneUnreachable(doc);
  return doc.save({ useObjectStreams: true });
}

/** Une varios PDFs, en el orden recibido, en uno nuevo. */
export async function mergePdfs(
  files: readonly { data: Uint8Array; name: string }[],
): Promise<Uint8Array> {
  const output = await PDFDocument.create({ updateMetadata: false });
  output.setProducer(PRODUCER);
  for (const file of files) {
    const source = await loadPdf(file.data, file.name);
    for (const page of await output.copyPages(source, source.getPageIndices()))
      output.addPage(page);
  }
  return savePdf(output);
}

/**
 * Redacta de forma permanente las páginas indicadas (ver redaction.ts). El texto y las imágenes
 * pendientes se incorporan antes; las marcas de redacción se consumen.
 */
export async function redactDocument(
  data: Uint8Array,
  annotations: readonly Annotation[],
  pages: readonly RedactedPageInput[],
): Promise<{ data: Uint8Array; annotations: Annotation[] }> {
  const doc = await loadPdf(data);
  await drawPermanentItems(doc, annotations);
  const remaining = await redactPages(doc, pages, annotations);
  await writeAnnotations(doc, remaining);
  const result = readAnnotations(doc);
  stripFoliuxAnnotations(doc);
  return { data: await savePdf(doc), annotations: result };
}

export type { RedactedPageInput };

/** Campos de formulario del documento, con su posición en cada página. */
export async function readFormFields(data: Uint8Array): Promise<FormFieldInfo[]> {
  const { listFormFields, mayContainForm } = await import('./forms');
  if (!mayContainForm(data)) return [];
  return listFormFields(await loadPdf(data));
}
