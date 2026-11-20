import { toast } from 'sonner';
import type { PageImage, PageWord } from '@foliux-pdf/core';
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
export async function withJob<T>(
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

/** Opciones de una conversión (las elige el usuario en el cuadro de Convertir). */
export interface ConvertOptions {
  /** Páginas que se convierten (base 1). */
  pages: number[];
  /** Resolución de las páginas dibujadas (imágenes y PowerPoint). */
  dpi: number;
  /** Calidad del JPEG, de 0,5 a 1. */
  quality: number;
  /** Nombre del archivo, sin extensión (se propone en el diálogo de guardar). */
  fileName: string;
  /** Word: conservar las imágenes de las páginas. */
  includeImages: boolean;
}

export function defaultConvertOptions(tab: DocTab): ConvertOptions {
  return {
    pages: Array.from({ length: tab.numPages }, (_, i) => i + 1),
    dpi: 150,
    quality: 0.9,
    fileName: baseName(tab),
    includeImages: true,
  };
}

async function wordsOfPages(
  tab: DocTab,
  pages: readonly number[],
  signal: AbortSignal,
  progress: (done: number, total: number) => void,
): Promise<{ page: number; words: PageWord[] }[]> {
  const result: { page: number; words: PageWord[] }[] = [];
  for (const [index, page] of pages.entries()) {
    if (signal.aborted) throw new DOMException('Cancelado', 'AbortError');
    result.push({ page, words: await tab.doc.getWords(page) });
    progress(index + 1, pages.length);
    if (index % 5 === 4) await tick();
  }
  return result;
}

function offerOpen(path: string, name: string): void {
  toast.success(i18n.t('convert.created', { name }), {
    description: path,
  });
}

/** Evita nombres de archivo con caracteres que Windows no admite. */
const safeName = (name: string, fallback: string): string =>
  [...name]
    .map((ch) =>
      ch.charCodeAt(0) < 32 || '<>:"/|?*'.includes(ch) || ch === String.fromCharCode(92) ? '_' : ch,
    )
    .join('')
    .trim()
    .replace(/\.+$/, '') || fallback;

/** Imágenes que se conservan: ni iconos minúsculos ni una imagen que sea casi toda la página (un escaneo). */
const MIN_IMAGE_PT = 20;
const MAX_PAGE_COVERAGE = 0.8;
const MAX_IMAGES_PER_PAGE = 40;
const MAX_IMAGES_TOTAL = 300;
/** Resolución a la que se recorta cada imagen de la página. */
const IMAGE_DPI = 200;

/**
 * Recorta de la página dibujada las zonas donde el PDF coloca imágenes. Así se conserva cualquier tipo de imagen
 * (incluidas máscaras y degradados) con el aspecto que tiene en la página.
 */
async function imagesOfPage(
  tab: DocTab,
  page: number,
  signal: AbortSignal,
  budget: { left: number },
): Promise<PageImage[]> {
  const size = tab.sizes[page - 1];
  if (!size || budget.left <= 0) return [];
  const area = size.width * size.height;
  const rects = (await tab.doc.getImageRects(page))
    .filter(
      (r) =>
        r.width >= MIN_IMAGE_PT &&
        r.height >= MIN_IMAGE_PT &&
        r.width * r.height <= area * MAX_PAGE_COVERAGE,
    )
    // La misma imagen dibujada dos veces cuenta una sola vez
    .filter(
      (r, i, all) =>
        all.findIndex(
          (o) =>
            Math.abs(o.x - r.x) < 1 &&
            Math.abs(o.y - r.y) < 1 &&
            Math.abs(o.width - r.width) < 1 &&
            Math.abs(o.height - r.height) < 1,
        ) === i,
    )
    .slice(0, MAX_IMAGES_PER_PAGE);
  if (rects.length === 0) return [];

  const { canvas, pixelsPerUnit: k } = await renderPageCanvas(
    tab.doc,
    page,
    size,
    IMAGE_DPI,
    signal,
  );
  const images: PageImage[] = [];
  for (const rect of rects) {
    if (budget.left <= 0) break;
    const sx = Math.max(0, Math.floor(rect.x * k));
    const sy = Math.max(0, Math.floor(rect.y * k));
    const sw = Math.min(canvas.width - sx, Math.ceil(rect.width * k));
    const sh = Math.min(canvas.height - sy, Math.ceil(rect.height * k));
    if (sw < 4 || sh < 4) continue;
    const crop = document.createElement('canvas');
    crop.width = sw;
    crop.height = sh;
    const context = crop.getContext('2d');
    if (!context) continue;
    context.drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh);
    images.push({
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
      data: await canvasToBytes(crop, 'png'),
    });
    budget.left -= 1;
  }
  return images;
}

/** PDF → Word o Excel, a partir del texto de las páginas (Word conserva además las imágenes). */
export async function exportToOffice(
  format: 'docx' | 'xlsx',
  options: ConvertOptions,
): Promise<boolean> {
  const tab = getActiveTab();
  if (!tab || tab.busy) return false;
  const saved = await withJob(
    tab.id,
    (done, total) => i18n.t('busy.extracting', { done, total }),
    async (signal, progress) => {
      const pages = await wordsOfPages(tab, options.pages, signal, progress);
      const withImages: ({ page: number; words: PageWord[] } & {
        width?: number;
        height?: number;
        images?: PageImage[];
      })[] = pages;

      let imageCount = 0;
      if (format === 'docx') {
        const budget = { left: MAX_IMAGES_TOTAL };
        for (const [index, entry] of withImages.entries()) {
          if (signal.aborted) throw new DOMException('Cancelado', 'AbortError');
          const size = tab.sizes[entry.page - 1];
          if (size) {
            entry.width = size.width;
            entry.height = size.height;
          }
          if (options.includeImages) {
            entry.images = await imagesOfPage(tab, entry.page, signal, budget);
            imageCount += entry.images.length;
          }
          progress(index + 1, withImages.length);
          if (index % 3 === 2) await tick();
        }
        if (budget.left <= 0) toast.info(i18n.t('convert.imageLimit', { max: MAX_IMAGES_TOTAL }));
      }

      // Con imágenes basta: un documento solo de imágenes (sin texto) también se puede pasar a Word.
      if (!pages.some((page) => page.words.length > 0) && imageCount === 0) {
        toast.warning(i18n.t('convert.noText'));
        return null;
      }
      patchTab(tab.id, () => ({ busy: i18n.t('busy.converting') }));
      return window.foliux.pdf.toOffice({
        format,
        pages: withImages,
        suggestedName: `${safeName(options.fileName, baseName(tab))}.${format}`,
      });
    },
  );
  if (saved) offerOpen(saved.path, saved.name);
  return saved !== null;
}

/** PDF → texto plano (.txt) o página web (.html). */
export async function exportToText(
  format: 'txt' | 'html',
  options: ConvertOptions,
): Promise<boolean> {
  const tab = getActiveTab();
  if (!tab || tab.busy) return false;
  const saved = await withJob(
    tab.id,
    (done, total) => i18n.t('busy.extracting', { done, total }),
    async (signal, progress) => {
      const pages = await wordsOfPages(tab, options.pages, signal, progress);
      if (!pages.some((page) => page.words.length > 0)) {
        toast.warning(i18n.t('convert.noText'));
        return null;
      }
      patchTab(tab.id, () => ({ busy: i18n.t('busy.converting') }));
      const name = safeName(options.fileName, baseName(tab));
      return window.foliux.pdf.toText({
        format,
        title: name,
        pages,
        suggestedName: `${name}.${format}`,
      });
    },
  );
  if (saved) offerOpen(saved.path, saved.name);
  return saved !== null;
}

/** PDF → PowerPoint: una diapositiva por página con su imagen y su texto en las notas. */
export async function exportToPresentation(options: ConvertOptions): Promise<boolean> {
  const tab = getActiveTab();
  if (!tab || tab.busy) return false;
  const saved = await withJob(
    tab.id,
    (done, total) => i18n.t('busy.rendering', { done, total }),
    async (signal, progress) => {
      const pages = [];
      for (const [index, page] of options.pages.entries()) {
        if (signal.aborted) throw new DOMException('Cancelado', 'AbortError');
        const size = tab.sizes[page - 1];
        if (!size) continue;
        const { canvas } = await renderPageCanvas(tab.doc, page, size, options.dpi, signal);
        const words = await tab.doc.getWords(page);
        pages.push({
          image: await canvasToBytes(canvas, 'png'),
          width: size.width,
          height: size.height,
          notes: words.map((w) => w.text).join(' '),
        });
        progress(index + 1, options.pages.length);
      }
      patchTab(tab.id, () => ({ busy: i18n.t('busy.converting') }));
      return window.foliux.pdf.toPresentation({
        pages,
        suggestedName: `${safeName(options.fileName, baseName(tab))}.pptx`,
      });
    },
  );
  if (saved) offerOpen(saved.path, saved.name);
  return saved !== null;
}

/** PDF → imágenes (una por página, en una carpeta). */
export async function exportToImages(
  format: 'png' | 'jpeg',
  options: ConvertOptions,
): Promise<boolean> {
  const tab = getActiveTab();
  if (!tab || tab.busy) return false;
  const result = await withJob(
    tab.id,
    (done, total) => i18n.t('busy.rendering', { done, total }),
    async (signal, progress) => {
      const pages = [];
      for (const [index, page] of options.pages.entries()) {
        if (signal.aborted) throw new DOMException('Cancelado', 'AbortError');
        const size = tab.sizes[page - 1];
        if (!size) continue;
        const { canvas } = await renderPageCanvas(tab.doc, page, size, options.dpi, signal);
        pages.push({ page, image: await canvasToBytes(canvas, format, options.quality) });
        progress(index + 1, options.pages.length);
      }
      return window.foliux.pdf.toImages({
        pages,
        format,
        baseName: safeName(options.fileName, baseName(tab)),
      });
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
