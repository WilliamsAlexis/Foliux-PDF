import { toast } from 'sonner';
import { createWorker, type Worker } from 'tesseract.js';
import type { IPdfDocument, PageSize, PageWord } from '@foliux-pdf/core';
import i18n from '@/i18n';
import { getActiveTab } from '@/store/docs';
import { useJob } from '@/store/job';
import { notifyError } from './notify';
import { isAbortError } from './utils';
import { hasPendingContent, patchTab, runPageOp, tabOf } from './edit';
import { renderPageCanvas, tick } from './raster';

/**
 * OCR con Tesseract.js (Apache 2.0). El motor y los datos de idioma son archivos de la propia aplicación
 * (carpeta tesseract/), no se descarga nada. El resultado se añade a cada página como texto invisible: el
 * escaneo se queda como está, pero el documento pasa a ser buscable y copiable.
 */

export const OCR_LANGUAGES = [
  { code: 'spa', label: 'Español' },
  { code: 'eng', label: 'English' },
] as const;

/** Una palabra con menos confianza que esto (de 0 a 100) se descarta: suele ser ruido del escaneo. */
const MIN_CONFIDENCE = 35;

const asset = (name: string) => new URL(`./tesseract/${name}`, document.baseURI).href;

export async function createOcrWorker(
  languages: string[],
  onProgress?: (fraction: number) => void,
): Promise<Worker> {
  return createWorker(languages, 1, {
    workerPath: asset('worker.min.js'),
    corePath: asset(''),
    langPath: asset(''),
    gzip: true,
    cacheMethod: 'none',
    workerBlobURL: false,
    logger: (message) => {
      if (message.status === 'recognizing text') onProgress?.(message.progress);
    },
  });
}

/** Reconoce el texto de una imagen y lo devuelve como palabras con su posición en píxeles. */
export async function recognizeWords(
  worker: Worker,
  image: HTMLCanvasElement,
): Promise<{ text: string; x: number; y: number; width: number; height: number }[]> {
  const result = await worker.recognize(image, {}, { blocks: true });
  const data = result.data as unknown as {
    words?: { text: string; confidence: number; bbox: Box }[];
    blocks?: {
      paragraphs: { lines: { words: { text: string; confidence: number; bbox: Box }[] }[] }[];
    }[];
  };
  type Box = { x0: number; y0: number; x1: number; y1: number };
  const words =
    data.words ??
    (data.blocks ?? []).flatMap((block) =>
      block.paragraphs.flatMap((paragraph) => paragraph.lines.flatMap((line) => line.words)),
    );
  return words
    .filter((word) => word.text.trim() !== '' && word.confidence >= MIN_CONFIDENCE)
    .map((word) => ({
      text: word.text,
      x: word.bbox.x0,
      y: word.bbox.y0,
      width: word.bbox.x1 - word.bbox.x0,
      height: word.bbox.y1 - word.bbox.y0,
    }));
}

/** Páginas con (casi) nada de texto: las que probablemente son un escaneo. */
export async function findScannedPages(doc: IPdfDocument, signal?: AbortSignal): Promise<number[]> {
  const scanned: number[] = [];
  for (let page = 1; page <= doc.numPages; page++) {
    if (signal?.aborted) throw new DOMException('Cancelado', 'AbortError');
    if ((await doc.getWords(page)).length < 5) scanned.push(page);
    if (page % 10 === 0) await tick();
  }
  return scanned;
}

export interface OcrOptions {
  /** 'scanned' = solo las páginas sin texto; 'all' = todas. */
  scope: 'scanned' | 'all';
  languages: string[];
  dpi: number;
}

/** OCR de las páginas de un documento (sin tocar nada: devuelve las palabras de cada página, en unidades de la vista). */
export async function ocrPages(
  doc: IPdfDocument,
  sizes: PageSize[],
  pages: number[],
  options: { languages: string[]; dpi: number },
  signal: AbortSignal,
  onProgress: (done: number, fraction: number) => void,
): Promise<{ page: number; words: PageWord[] }[]> {
  let current = 0;
  const worker = await createOcrWorker(options.languages, (fraction) =>
    onProgress(current, fraction),
  );
  const onAbort = () => void worker.terminate().catch(() => undefined);
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    const results: { page: number; words: PageWord[] }[] = [];
    for (const [index, pageNumber] of pages.entries()) {
      if (signal.aborted) throw new DOMException('Cancelado', 'AbortError');
      current = index;
      onProgress(index, 0);
      const size = sizes[pageNumber - 1];
      if (!size) continue;
      const { canvas, pixelsPerUnit } = await renderPageCanvas(
        doc,
        pageNumber,
        size,
        options.dpi,
        signal,
      );
      const words = await recognizeWords(worker, canvas);
      results.push({
        page: pageNumber,
        words: words.map((w) => ({
          text: w.text,
          x: w.x / pixelsPerUnit,
          y: w.y / pixelsPerUnit,
          width: w.width / pixelsPerUnit,
          height: w.height / pixelsPerUnit,
        })),
      });
      await tick();
    }
    return results;
  } catch (error) {
    if (signal.aborted) throw new DOMException('Cancelado', 'AbortError');
    throw error;
  } finally {
    signal.removeEventListener('abort', onAbort);
    await worker.terminate().catch(() => undefined);
  }
}

/** OCR del documento abierto: añade el texto reconocido a las páginas (se puede deshacer). */
export async function runOcr(options: OcrOptions): Promise<boolean> {
  let tab = getActiveTab();
  if (!tab || tab.busy) return false;
  const tabId = tab.id;

  // El texto y las imágenes pendientes pasan primero a las páginas.
  if (hasPendingContent(tab)) {
    if (!(await runPageOp({ type: 'applyEdits' }, {}, tabId))) return false;
    tab = tabOf(tabId);
    if (!tab) return false;
  }

  const controller = new AbortController();
  useJob.getState().setCancel(() => controller.abort());
  patchTab(tabId, () => ({ busy: i18n.t('busy.ocrPreparing') }));
  try {
    const pages =
      options.scope === 'all'
        ? Array.from({ length: tab.numPages }, (_, i) => i + 1)
        : await findScannedPages(tab.doc, controller.signal);
    if (pages.length === 0) {
      patchTab(tabId, () => ({ busy: null }));
      toast.info(i18n.t('ocr.nothingToDo'));
      return false;
    }

    const results = await ocrPages(
      tab.doc,
      tab.sizes,
      pages,
      { languages: options.languages, dpi: options.dpi },
      controller.signal,
      (done, fraction) =>
        patchTab(tabId, () => ({
          busy: i18n.t('busy.ocr', {
            done: done + 1,
            total: pages.length,
            percent: Math.round(fraction * 100),
          }),
        })),
    );

    const withText = results.filter((r) => r.words.length > 0);
    const wordCount = withText.reduce((total, r) => total + r.words.length, 0);
    patchTab(tabId, () => ({ busy: null }));
    if (withText.length === 0) {
      toast.warning(i18n.t('ocr.noText'));
      return false;
    }
    const ok = await runPageOp({ type: 'ocrText', pages: withText }, {}, tabId);
    if (ok) toast.success(i18n.t('ocr.done', { words: wordCount, pages: withText.length }));
    return ok;
  } catch (error) {
    patchTab(tabId, () => ({ busy: null }));
    if (isAbortError(error)) toast.info(i18n.t('ocr.cancelled'));
    else notifyError(i18n.t('errors.ocrFailed'), error);
    return false;
  } finally {
    useJob.getState().setCancel(null);
  }
}
