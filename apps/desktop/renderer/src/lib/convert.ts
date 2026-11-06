import { toast } from 'sonner';
import type { PageWord } from '@foliux-pdf/core';
import i18n from '@/i18n';
import { getActiveTab, type DocTab } from '@/store/docs';
import { useJob } from '@/store/job';
import { notifyError } from './notify';
import { openPdfPath, refreshRecent } from './actions';
import { flushForm, patchTab, tabOf } from './edit';
import { isAbortError } from './utils';
import { canvasToBytes, renderPageCanvas, tick } from './raster';

/** Conversión desde y hacia PDF: Word, Excel, PowerPoint, imágenes y PDF/A. */

const baseName = (tab: DocTab) => tab.name.replace(/\.pdf$/i, '');

/** Ejecuta un trabajo largo con progreso en la capa de «ocupado» y botón de cancelar. */
async function withJob<T>(
  tabId: string,
  label: (done: number, total: number) => string,
  work: (signal: AbortSignal, progress: (done: number, total: number) => void) => Promise<T>,
): Promise<T | null> {
  const controller = new AbortController();
  useJob.getState().setCancel(() => controller.abort());
  const progress = (done: number, total: number) =>
    patchTab(tabId, () => ({ busy: label(done, total) }));
  progress(0, 1);
  try {
    return await work(controller.signal, progress);
  } catch (error) {
    if (isAbortError(error)) toast.info(i18n.t('convert.cancelled'));
    else notifyError(i18n.t('errors.convertFailed'), error);
    return null;
  } finally {
    patchTab(tabId, () => ({ busy: null }));
    useJob.getState().setCancel(null);
  }
}

async function wordsOfAllPages(
  tab: DocTab,
  signal: AbortSignal,
  progress: (done: number, total: number) => void,
): Promise<{ words: PageWord[] }[]> {
  const pages: { words: PageWord[] }[] = [];
  for (let page = 1; page <= tab.numPages; page++) {
    if (signal.aborted) throw new DOMException('Cancelado', 'AbortError');
    pages.push({ words: await tab.doc.getWords(page) });
    progress(page, tab.numPages);
    if (page % 5 === 0) await tick();
  }
  return pages;
}

function offerOpen(path: string, name: string): void {
  toast.success(i18n.t('convert.created', { name }), {
    description: path,
  });
}

/** PDF → Word o Excel, a partir del texto de las páginas. */
export async function exportToOffice(format: 'docx' | 'xlsx'): Promise<boolean> {
  const tab = getActiveTab();
  if (!tab || tab.busy) return false;
  const saved = await withJob(
    tab.id,
    (done, total) => i18n.t('busy.extracting', { done, total }),
    async (signal, progress) => {
      const pages = await wordsOfAllPages(tab, signal, progress);
      const hasText = pages.some((page) => page.words.length > 0);
      if (!hasText) {
        toast.warning(i18n.t('convert.noText'));
        return null;
      }
      patchTab(tab.id, () => ({ busy: i18n.t('busy.converting') }));
      return window.foliux.pdf.toOffice({
        format,
        pages,
        suggestedName: `${baseName(tab)}.${format}`,
      });
    },
  );
  if (saved) offerOpen(saved.path, saved.name);
  return saved !== null;
}

/** PDF → PowerPoint: una diapositiva por página con su imagen y su texto en las notas. */
export async function exportToPresentation(dpi = 150): Promise<boolean> {
  const tab = getActiveTab();
  if (!tab || tab.busy) return false;
  const saved = await withJob(
    tab.id,
    (done, total) => i18n.t('busy.rendering', { done, total }),
    async (signal, progress) => {
      const pages = [];
      for (let page = 1; page <= tab.numPages; page++) {
        if (signal.aborted) throw new DOMException('Cancelado', 'AbortError');
        const size = tab.sizes[page - 1];
        if (!size) continue;
        const { canvas } = await renderPageCanvas(tab.doc, page, size, dpi, signal);
        const words = await tab.doc.getWords(page);
        pages.push({
          image: await canvasToBytes(canvas, 'png'),
          width: size.width,
          height: size.height,
          notes: words.map((w) => w.text).join(' '),
        });
        progress(page, tab.numPages);
      }
      patchTab(tab.id, () => ({ busy: i18n.t('busy.converting') }));
      return window.foliux.pdf.toPresentation({ pages, suggestedName: `${baseName(tab)}.pptx` });
    },
  );
  if (saved) offerOpen(saved.path, saved.name);
  return saved !== null;
}

/** PDF → imágenes (una por página, en una carpeta). */
export async function exportToImages(format: 'png' | 'jpeg', dpi: number): Promise<boolean> {
  const tab = getActiveTab();
  if (!tab || tab.busy) return false;
  const result = await withJob(
    tab.id,
    (done, total) => i18n.t('busy.rendering', { done, total }),
    async (signal, progress) => {
      const pages = [];
      for (let page = 1; page <= tab.numPages; page++) {
        if (signal.aborted) throw new DOMException('Cancelado', 'AbortError');
        const size = tab.sizes[page - 1];
        if (!size) continue;
        const { canvas } = await renderPageCanvas(tab.doc, page, size, dpi, signal);
        pages.push({ page, image: await canvasToBytes(canvas, format) });
        progress(page, tab.numPages);
      }
      return window.foliux.pdf.toImages({ pages, format, baseName: baseName(tab) });
    },
  );
  if (result)
    toast.success(i18n.t('convert.imagesDone', { count: result.count }), {
      description: result.folder,
    });
  return result !== null;
}

/** Imágenes → PDF nuevo. */
export async function importImages(): Promise<void> {
  try {
    const saved = await window.foliux.pdf.fromImages();
    if (saved) {
      toast.success(i18n.t('convert.created', { name: saved.name }), {
        action: { label: i18n.t('save.open'), onClick: () => void openPdfPath(saved.path) },
      });
      await refreshRecent();
    }
  } catch (error) {
    notifyError(i18n.t('errors.convertFailed'), error);
  }
}

/** Word, Excel o PowerPoint → PDF (necesita LibreOffice instalado). */
export async function importOffice(): Promise<void> {
  try {
    const saved = await window.foliux.pdf.fromOffice();
    if (saved) {
      toast.success(i18n.t('convert.created', { name: saved.name }), {
        action: { label: i18n.t('save.open'), onClick: () => void openPdfPath(saved.path) },
      });
      await refreshRecent();
    }
  } catch (error) {
    notifyError(i18n.t('errors.convertFailed'), error);
  }
}

export interface PdfAOutcome {
  name: string;
  issues: { code: string; message: string; blocking: boolean }[];
  fixed: string[];
}

/** Guarda una copia preparada para archivado (PDF/A, mejor esfuerzo) y devuelve el informe. */
export async function exportPdfA(): Promise<PdfAOutcome | null> {
  const tab = getActiveTab();
  if (!tab || tab.busy) return null;
  if (!(await flushForm(tab.id))) return null;
  const current = tabOf(tab.id);
  if (!current) return null;
  const result = await withJob(
    current.id,
    () => i18n.t('busy.pdfa'),
    () =>
      window.foliux.pdf.pdfa({
        data: current.data,
        annotations: current.annotations,
        suggestedName: `${baseName(current)} (archivo).pdf`,
      }),
  );
  if (!result) return null;
  await refreshRecent();
  return { name: result.name, issues: result.issues, fixed: result.fixed };
}
