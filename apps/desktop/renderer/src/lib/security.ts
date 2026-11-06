import { toast } from 'sonner';
import type { AnnotationOf, MetadataReport, PageWord, Protection, Rect } from '@foliux-pdf/core';
import i18n from '@/i18n';
import { getActiveTab } from '@/store/docs';
import { useJob } from '@/store/job';
import { notifyError } from './notify';
import { isAbortError } from './utils';
import {
  addAnnotations,
  afterDocumentSwap,
  commitChange,
  createAnnotation,
  docFields,
  hasPendingContent,
  loadDocument,
  patchTab,
  runPageOp,
  tabOf,
} from './edit';

/** Contraseñas y permisos, metadatos y redacción permanente. */

// ---------------------------------------------------------------------------
// Protección
// ---------------------------------------------------------------------------

/** Fija (o quita, con null) la protección con la que se guardará el documento. */
export function setProtection(tabId: string, protection: Protection | null): void {
  patchTab(tabId, () => ({ protection }));
  toast.success(protection ? i18n.t('security.willProtect') : i18n.t('security.willUnprotect'));
}

// ---------------------------------------------------------------------------
// Metadatos
// ---------------------------------------------------------------------------

export async function loadMetadata(): Promise<MetadataReport | null> {
  const tab = getActiveTab();
  if (!tab) return null;
  try {
    return await window.foliux.pdf.metadata({ data: tab.data });
  } catch (error) {
    notifyError(i18n.t('errors.pageOpFailed'), error);
    return null;
  }
}

export interface CleanOptions {
  info: boolean;
  xmp: boolean;
  thumbnails: boolean;
  attachments: boolean;
  javascript: boolean;
}

export function cleanMetadata(options: CleanOptions): Promise<boolean> {
  return runPageOp({ type: 'cleanMetadata', ...options });
}

// ---------------------------------------------------------------------------
// Redacción
// ---------------------------------------------------------------------------

/** Máximo de píxeles de la imagen de una página redactada (por encima, el navegador falla). */
const MAX_PIXELS = 36_000_000;

const intersects = (word: PageWord, rect: Rect, pad: number): boolean =>
  word.x < rect.x + rect.width + pad &&
  word.x + word.width > rect.x - pad &&
  word.y < rect.y + rect.height + pad &&
  word.y + word.height > rect.y - pad;

export function redactionMarkCount(): number {
  return getActiveTab()?.annotations.filter((a) => a.kind === 'redact').length ?? 0;
}

/** Marca como «a redactar» todos los resultados de la búsqueda actual. */
export function markSearchResultsForRedaction(): number {
  const tab = getActiveTab();
  if (!tab || tab.busy) return 0;
  const marks = tab.search.hits.flatMap((hit) =>
    hit.rects.map((r) =>
      createAnnotation('redact', hit.pageNumber, {
        rect: { x: r.x - 1, y: r.y - 1, width: r.width + 2, height: r.height + 2 },
      }),
    ),
  );
  if (marks.length > 0) addAnnotations(tab.id, marks);
  toast.success(i18n.t('redact.marked', { count: marks.length }));
  return marks.length;
}

function canvasToBytes(canvas: HTMLCanvasElement, format: 'png' | 'jpeg'): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) return reject(new Error(i18n.t('errors.imageFailed')));
        void blob.arrayBuffer().then((buffer) => resolve(new Uint8Array(buffer)));
      },
      format === 'png' ? 'image/png' : 'image/jpeg',
      0.9,
    );
  });
}

export interface RedactOptions {
  /** Resolución de las páginas redactadas. */
  dpi: number;
  format: 'png' | 'jpeg';
  /** Limpiar también los metadatos al terminar. */
  cleanMetadata: boolean;
}

/**
 * Aplica las marcas de redacción: cada página con marcas se dibuja con las zonas en negro y sustituye a la
 * original (ver redaction.ts en los servicios). Muestra el avance y se puede cancelar.
 */
export async function redactMarked(options: RedactOptions): Promise<boolean> {
  let tab = getActiveTab();
  if (!tab || tab.busy) return false;
  const tabId = tab.id;
  if (!tab.annotations.some((a) => a.kind === 'redact')) {
    toast.info(i18n.t('redact.none'));
    return false;
  }

  // El texto y las imágenes pendientes pasan primero a las páginas (si no, no saldrían en la imagen).
  if (hasPendingContent(tab)) {
    if (!(await runPageOp({ type: 'applyEdits' }, {}, tabId))) return false;
    tab = tabOf(tabId);
    if (!tab) return false;
  }

  const marks = tab.annotations.filter((a): a is AnnotationOf<'redact'> => a.kind === 'redact');
  const pages = [...new Set(marks.map((m) => m.page))].sort((a, b) => a - b);
  const controller = new AbortController();
  useJob.getState().setCancel(() => controller.abort());

  try {
    const inputs = [];
    for (const [index, pageNumber] of pages.entries()) {
      patchTab(tabId, () => ({
        busy: i18n.t('busy.redacting', { done: index, total: pages.length }),
      }));
      const size = tab.sizes[pageNumber - 1];
      if (!size) continue;
      const pageMarks = marks.filter((m) => m.page === pageNumber);

      // Resolución pedida, sin pasar del máximo de píxeles que admite un canvas.
      const scale = Math.min(options.dpi / 72, Math.sqrt(MAX_PIXELS / (size.width * size.height)));
      const canvas = await tab.doc.renderPage(pageNumber, {
        scale,
        outputScale: 1,
        signal: controller.signal,
      });
      const k = canvas.width / size.width;
      const context = canvas.getContext('2d');
      if (!context) throw new Error(i18n.t('errors.imageFailed'));
      context.fillStyle = '#000000';
      for (const mark of pageMarks) {
        // Un punto de margen por lado para tapar los bordes suavizados de las letras.
        context.fillRect(
          (mark.rect.x - 1) * k,
          (mark.rect.y - 1) * k,
          (mark.rect.width + 2) * k,
          (mark.rect.height + 2) * k,
        );
      }

      const words = (await tab.doc.getWords(pageNumber)).filter(
        (word) => !pageMarks.some((mark) => intersects(word, mark.rect, 1)),
      );
      inputs.push({
        page: pageNumber,
        image: await canvasToBytes(canvas, options.format),
        format: options.format,
        words,
      });
      if (controller.signal.aborted) throw new DOMException('Cancelado', 'AbortError');
    }

    patchTab(tabId, () => ({ busy: i18n.t('busy.redactingSaving') }));
    const result = await window.foliux.pdf.redact({
      data: tab.data,
      annotations: tab.annotations,
      pages: inputs,
    });
    const loaded = await loadDocument(result.data);
    if (!tabOf(tabId)) {
      void loaded.doc.destroy().catch(() => undefined);
      return false;
    }
    const oldDoc = tab.doc;
    commitChange(tabId, () => ({
      ...docFields(loaded),
      data: result.data,
      annotations: result.annotations,
      selectedAnnotationId: null,
      pageSelection: [],
      busy: null,
    }));
    afterDocumentSwap(tabId, oldDoc, loaded);
    toast.success(i18n.t('redact.done', { count: pages.length }));

    if (options.cleanMetadata) {
      await cleanMetadata({
        info: true,
        xmp: true,
        thumbnails: true,
        attachments: true,
        javascript: true,
      });
    }
    return true;
  } catch (error) {
    patchTab(tabId, () => ({ busy: null }));
    if (isAbortError(error)) toast.info(i18n.t('redact.cancelled'));
    else notifyError(i18n.t('errors.redactFailed'), error);
    return false;
  } finally {
    useJob.getState().setCancel(null);
  }
}
