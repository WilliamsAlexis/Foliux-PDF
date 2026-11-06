import { create } from 'zustand';
import type { Protection } from '@foliux-pdf/core';
import { pdfEngine } from './engine';
import { findScannedPages, ocrPages } from './ocr';
import { isAbortError } from './utils';

/**
 * Procesamiento por lotes: aplica una acción a muchos PDFs y guarda los resultados (con sufijo) en una carpeta,
 * sin tocar los originales. Se puede cancelar entre archivos y dentro del OCR.
 */

export type BatchAction = 'ocr' | 'optimize' | 'pdfa' | 'clean-metadata' | 'watermark' | 'protect';

export interface BatchOptions {
  action: BatchAction;
  folder: string;
  languages: string[];
  dpi: number;
  watermarkText: string;
  protection: Protection | null;
}

export interface BatchItem {
  path: string;
  name: string;
  status: 'pending' | 'running' | 'done' | 'failed' | 'skipped';
  message: string;
}

interface BatchState {
  running: boolean;
  items: BatchItem[];
  current: number;
  /** Avance dentro del archivo actual (0 a 1), p. ej. el OCR página a página. */
  fraction: number;
  abort: AbortController | null;
  set: (patch: Partial<Omit<BatchState, 'set'>>) => void;
}

export const useBatch = create<BatchState>((set) => ({
  running: false,
  items: [],
  current: -1,
  fraction: 0,
  abort: null,
  set: (patch) => set(patch),
}));

const SUFFIX: Record<BatchAction, string> = {
  ocr: 'OCR',
  optimize: 'optimizado',
  pdfa: 'archivo',
  'clean-metadata': 'sin metadatos',
  watermark: 'marca de agua',
  protect: 'protegido',
};

export function setBatchFiles(paths: string[]): void {
  useBatch.getState().set({
    items: paths.map((path) => ({
      path,
      name: path.split(/[\\/]/).pop() ?? path,
      status: 'pending',
      message: '',
    })),
    current: -1,
    fraction: 0,
  });
}

export function cancelBatch(): void {
  useBatch.getState().abort?.abort();
}

function update(index: number, patch: Partial<BatchItem>): void {
  const { items, set } = useBatch.getState();
  set({ items: items.map((item, i) => (i === index ? { ...item, ...patch } : item)) });
}

/** Procesa un archivo y devuelve el resultado y una nota. */
async function processFile(
  path: string,
  options: BatchOptions,
  signal: AbortSignal,
): Promise<{ data: Uint8Array; note: string } | null> {
  // Los PDF protegidos con contraseña no se pueden abrir sin pedirla: en un lote se omiten.
  const file = await window.foliux.readPdf(path);
  if (options.action === 'ocr') {
    const doc = await pdfEngine.load(file.data);
    try {
      const sizes = await doc.getPageSizes();
      const pages = await findScannedPages(doc, signal);
      if (pages.length === 0) return null; // ya tenía texto
      const results = await ocrPages(
        doc,
        sizes,
        pages,
        { languages: options.languages, dpi: options.dpi },
        signal,
        (done, fraction) => useBatch.getState().set({ fraction: (done + fraction) / pages.length }),
      );
      const withText = results.filter((r) => r.words.length > 0);
      if (withText.length === 0) return null;
      const out = await window.foliux.pdf.transform({
        data: file.data,
        annotations: file.annotations,
        op: { type: 'ocrText', pages: withText },
      });
      // Se incorporan al archivo las anotaciones que ya tenía (el OCR las devuelve aparte).
      const baked = await window.foliux.pdf.process({
        data: out.data,
        annotations: out.annotations,
        action: 'bake',
      });
      return { data: baked.data, note: `${withText.length} página(s) reconocida(s)` };
    } finally {
      await doc.destroy().catch(() => undefined);
    }
  }
  return window.foliux.pdf.process({
    data: file.data,
    annotations: file.annotations,
    action: options.action,
    protection: options.protection,
    watermarkText: options.watermarkText,
  });
}

/** Procesa todos los archivos de la lista. */
export async function runBatch(options: BatchOptions): Promise<void> {
  const store = useBatch.getState();
  if (store.running) return;
  const controller = new AbortController();
  store.set({ running: true, abort: controller, current: -1, fraction: 0 });

  for (const [index, item] of useBatch.getState().items.entries()) {
    if (controller.signal.aborted) break;
    useBatch.getState().set({ current: index, fraction: 0 });
    update(index, { status: 'running', message: '' });
    try {
      const result = await processFile(item.path, options, controller.signal);
      if (!result) {
        update(index, {
          status: 'skipped',
          message: 'Nada que hacer (ya tenía texto o no hubo resultado).',
        });
        continue;
      }
      const baseName = item.name.replace(/\.pdf$/i, '');
      await window.foliux.pdf.writeCopy({
        data: result.data,
        folder: options.folder,
        name: `${baseName} (${SUFFIX[options.action]}).pdf`,
      });
      update(index, { status: 'done', message: result.note });
    } catch (error) {
      if (isAbortError(error) || controller.signal.aborted) {
        update(index, { status: 'pending', message: '' });
        break;
      }
      const code = (error as { code?: string }).code;
      update(index, {
        status: code === 'PASSWORD_REQUIRED' ? 'skipped' : 'failed',
        message:
          code === 'PASSWORD_REQUIRED'
            ? 'Protegido con contraseña: ábrelo individualmente.'
            : error instanceof Error
              ? error.message
              : String(error),
      });
    }
  }
  useBatch.getState().set({ running: false, abort: null, current: -1, fraction: 0 });
}
