import { toast } from 'sonner';
import {
  ANNOTATION_DEFAULTS,
  isPermanent,
  computeMoveOrder,
  mergeLineRects,
  newAnnotationId,
  translateAnnotation,
  type Annotation,
  type AnnotationKind,
  type AnnotationOf,
  type FontFamily,
  type Rect,
  type PageOp,
  type PageSize,
  type IPdfDocument,
} from '@foliux-pdf/core';
import i18n from '@/i18n';
import { pdfEngine } from './engine';
import { notifyError } from './notify';
import { openPdfPath, refreshRecent } from './actions';
import { clamp } from './utils';
import { getActiveTab, isDirty, useDocs, type DocTab, type Snapshot } from '@/store/docs';
import { useUi } from '@/store/ui';

/**
 * Edición del documento: anotaciones, historial (deshacer/rehacer), operaciones de página y guardado.
 * Todo cambio que el usuario puede deshacer pasa por `commitChange`, que guarda el estado anterior.
 */

const HISTORY_LIMIT = 50;

export const tabOf = (id: string): DocTab | undefined =>
  useDocs.getState().tabs.find((t) => t.id === id);

export function patchTab(id: string, patch: (tab: DocTab) => Partial<DocTab>): void {
  useDocs.setState((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, ...patch(t) } : t)) }));
}

/** Memoria máxima que puede ocupar el historial con versiones distintas del documento. */
const HISTORY_MAX_BYTES = 300 * 1024 * 1024;

/** Recorta el historial por antigüedad: por número de entradas y por bytes de documentos distintos. */
function trimHistory(history: Snapshot[], current: Uint8Array): Snapshot[] {
  let trimmed = history.slice(-HISTORY_LIMIT);
  const bytes = () => {
    const unique = new Set<Uint8Array>([current, ...trimmed.map((entry) => entry.data)]);
    let total = 0;
    for (const data of unique) total += data.byteLength;
    return total;
  };
  while (trimmed.length > 1 && bytes() > HISTORY_MAX_BYTES) trimmed = trimmed.slice(1);
  return trimmed;
}

/** Aplica un cambio guardando antes el estado actual en el historial y vaciando el «rehacer». */
export function commitChange(id: string, change: (tab: DocTab) => Partial<DocTab>): void {
  patchTab(id, (tab) => {
    const next = change(tab);
    return {
      history: trimHistory(
        [...tab.history, { data: tab.data, annotations: tab.annotations }],
        next.data ?? tab.data,
      ),
      future: [],
      ...next,
    };
  });
}

// ---------------------------------------------------------------------------
// Anotaciones
// ---------------------------------------------------------------------------

/** Crea una anotación nueva con los valores de la herramienta y el color/grosor elegidos. */
export function createAnnotation(
  kind: AnnotationKind,
  page: number,
  geometry: Record<string, unknown>,
): Annotation {
  const defaults = ANNOTATION_DEFAULTS[kind];
  const { color, strokeWidth } = useUi.getState();
  return {
    id: newAnnotationId(),
    kind,
    page,
    color: color ?? defaults.color,
    opacity: defaults.opacity,
    text: '',
    createdAt: Date.now(),
    ...(defaults.strokeWidth > 0 ? { strokeWidth } : {}),
    ...geometry,
  } as Annotation;
}

export function addAnnotations(tabId: string, annotations: Annotation[]): void {
  const first = annotations[0];
  if (!first || tabOf(tabId)?.busy) return;
  commitChange(tabId, (tab) => ({
    annotations: [...tab.annotations, ...annotations],
    selectedAnnotationId: first.id,
  }));
}

export function updateAnnotation(tabId: string, id: string, patch: Partial<Annotation>): void {
  if (tabOf(tabId)?.busy) return;
  commitChange(tabId, (tab) => ({
    annotations: tab.annotations.map((a) => (a.id === id ? ({ ...a, ...patch } as Annotation) : a)),
  }));
}

export function moveAnnotation(tabId: string, id: string, dx: number, dy: number): void {
  if (tabOf(tabId)?.busy) return;
  commitChange(tabId, (tab) => ({
    annotations: tab.annotations.map((a) => (a.id === id ? translateAnnotation(a, dx, dy) : a)),
  }));
}

export function deleteAnnotation(tabId: string, id: string): void {
  if (tabOf(tabId)?.busy) return;
  commitChange(tabId, (tab) => ({
    annotations: tab.annotations.filter((a) => a.id !== id),
    selectedAnnotationId: tab.selectedAnnotationId === id ? null : tab.selectedAnnotationId,
  }));
  if (useUi.getState().editingAnnotationId === id) useUi.getState().setEditingAnnotation(null);
}

export function deleteSelectedAnnotation(): void {
  const tab = getActiveTab();
  if (tab?.selectedAnnotationId) deleteAnnotation(tab.id, tab.selectedAnnotationId);
}

export function selectAnnotation(tabId: string, id: string | null): void {
  patchTab(tabId, (tab) => (tab.selectedAnnotationId === id ? {} : { selectedAnnotationId: id }));
}

/** Cambia el color o el grosor de la anotación seleccionada (y recuerda el color para las nuevas). */
export function restyleSelected(patch: {
  color?: string;
  strokeWidth?: number;
  fontSize?: number;
  font?: FontFamily;
  bold?: boolean;
  italic?: boolean;
  align?: 'left' | 'center' | 'right';
}): void {
  const tab = getActiveTab();
  const selected = tab?.annotations.find((a) => a.id === tab.selectedAnnotationId);
  if (!tab || !selected) return;
  const next: Partial<Annotation> = {};
  if (patch.color) next.color = patch.color;
  if (patch.strokeWidth !== undefined && 'strokeWidth' in selected) {
    (next as { strokeWidth?: number }).strokeWidth = patch.strokeWidth;
  }
  if (patch.fontSize !== undefined && (selected.kind === 'freetext' || selected.kind === 'text')) {
    (next as { fontSize?: number }).fontSize = patch.fontSize;
  }
  if (selected.kind === 'text') {
    const text = next as Partial<AnnotationOf<'text'>>;
    if (patch.font) text.font = patch.font;
    if (patch.bold !== undefined) text.bold = patch.bold;
    if (patch.italic !== undefined) text.italic = patch.italic;
    if (patch.align) text.align = patch.align;
  }
  if (Object.keys(next).length > 0) updateAnnotation(tab.id, selected.id, next);
}

/**
 * Termina la edición de texto de una anotación. `text === null` cancela.
 * Un cuadro de texto o una nota que se queda vacío se elimina (no tiene sentido guardarlo).
 */
export function finishTextEdit(tabId: string, id: string, text: string | null): void {
  useUi.getState().setEditingAnnotation(null);
  const annotation = tabOf(tabId)?.annotations.find((a) => a.id === id);
  if (!annotation) return;
  const isContainer =
    annotation.kind === 'freetext' || annotation.kind === 'note' || annotation.kind === 'text';
  if (text === null) {
    if (isContainer && annotation.text.trim() === '') deleteAnnotation(tabId, id);
    return;
  }
  if (isContainer && text.trim() === '') {
    deleteAnnotation(tabId, id);
    return;
  }
  if (text !== annotation.text) updateAnnotation(tabId, id, { text });
}

/** Convierte la selección de texto actual en resaltado, subrayado o tachado. */
export function createMarkupFromSelection(kind: 'highlight' | 'underline' | 'strikeout'): boolean {
  const tab = getActiveTab();
  const selection = window.getSelection();
  if (!tab || tab.busy || !selection || selection.rangeCount === 0 || selection.isCollapsed) {
    return false;
  }
  const clientRects = Array.from(selection.getRangeAt(0).getClientRects());
  const created: Annotation[] = [];

  document.querySelectorAll<HTMLElement>('.pdf-page[data-page-number]').forEach((element) => {
    const pageNumber = Number(element.dataset.pageNumber);
    const size = tab.sizes[pageNumber - 1];
    if (!size) return;
    const box = element.getBoundingClientRect();
    const pixelsPerUnit = box.width / size.width;

    const rects = clientRects
      .filter((r) => {
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        return cx >= box.left && cx <= box.right && cy >= box.top && cy <= box.bottom;
      })
      .map((r) => ({
        x: (r.left - box.left) / pixelsPerUnit,
        y: (r.top - box.top) / pixelsPerUnit,
        width: r.width / pixelsPerUnit,
        height: r.height / pixelsPerUnit,
      }));

    const lines = mergeLineRects(rects, { maxHeight: 120 });
    if (lines.length > 0) created.push(createAnnotation(kind, pageNumber, { rects: lines }));
  });

  if (created.length === 0) return false;
  addAnnotations(tab.id, created);
  selection.removeAllRanges();
  return true;
}

// ---------------------------------------------------------------------------
// Deshacer / rehacer
// ---------------------------------------------------------------------------

export interface LoadedDoc {
  doc: IPdfDocument;
  numPages: number;
  sizes: PageSize[];
}

export async function loadDocument(data: Uint8Array): Promise<LoadedDoc> {
  const doc = await pdfEngine.load(data);
  try {
    return { doc, numPages: doc.numPages, sizes: await doc.getPageSizes() };
  } catch (error) {
    void doc.destroy().catch(() => undefined);
    throw error;
  }
}

export const docFields = (loaded: LoadedDoc) => ({
  doc: loaded.doc,
  numPages: loaded.numPages,
  sizes: loaded.sizes,
  outline: null,
});

/** Tras cambiar el documento: carga los marcadores del nuevo y libera el antiguo. */
export function afterDocumentSwap(tabId: string, oldDoc: IPdfDocument, loaded: LoadedDoc): void {
  void refreshForm(tabId);
  void oldDoc.destroy().catch(() => undefined);
  loaded.doc
    .getOutline()
    .then((outline) => patchTab(tabId, (t) => (t.doc === loaded.doc ? { outline } : {})))
    .catch(() => patchTab(tabId, (t) => (t.doc === loaded.doc ? { outline: [] } : {})));
}

async function restore(tabId: string, direction: 'undo' | 'redo'): Promise<void> {
  const tab = tabOf(tabId);
  if (!tab || tab.busy) return;
  const stack = direction === 'undo' ? tab.history : tab.future;
  const target = stack[stack.length - 1];
  if (!target) return;
  const current: Snapshot = { data: tab.data, annotations: tab.annotations };

  let loaded: LoadedDoc | null = null;
  if (target.data !== tab.data) {
    // Cambió el contenido de las páginas: hay que volver a cargar el documento.
    patchTab(tabId, () => ({ busy: i18n.t('busy.working') }));
    try {
      loaded = await loadDocument(target.data);
    } catch (error) {
      patchTab(tabId, () => ({ busy: null }));
      notifyError(i18n.t('errors.pageOpFailed'), error);
      return;
    }
  }

  const newCount = loaded?.numPages;
  patchTab(tabId, (t) => ({
    ...(loaded ? docFields(loaded) : {}),
    data: target.data,
    annotations: target.annotations,
    history: direction === 'undo' ? t.history.slice(0, -1) : [...t.history, current],
    future: direction === 'undo' ? [...t.future, current] : t.future.slice(0, -1),
    selectedAnnotationId: null,
    pageSelection: [],
    page: clamp(t.page, 1, newCount ?? t.numPages),
    busy: null,
  }));
  useUi.getState().setEditingAnnotation(null);
  if (loaded) afterDocumentSwap(tabId, tab.doc, loaded);
}

export const undo = (): Promise<void> => {
  const tab = getActiveTab();
  return tab ? restore(tab.id, 'undo') : Promise.resolve();
};
export const redo = (): Promise<void> => {
  const tab = getActiveTab();
  return tab ? restore(tab.id, 'redo') : Promise.resolve();
};

// ---------------------------------------------------------------------------
// Operaciones de página
// ---------------------------------------------------------------------------

/** Páginas sobre las que actúan las operaciones: la selección de miniaturas o, si no hay, la actual. */
export function targetPages(tab: DocTab): number[] {
  return tab.pageSelection.length > 0 ? [...tab.pageSelection].sort((a, b) => a - b) : [tab.page];
}

export function setPageSelection(tabId: string, pages: number[]): void {
  patchTab(tabId, () => ({ pageSelection: pages }));
}

export async function runPageOp(
  op: PageOp,
  options: { selectAfter?: number[]; goTo?: number } = {},
  forTabId?: string,
): Promise<boolean> {
  const tab = forTabId ? tabOf(forTabId) : getActiveTab();
  if (!tab || tab.busy) return false;
  const tabId = tab.id;

  // Lo escrito en el formulario pasa antes al PDF: cualquier otra operación debe verlo.
  if (op.type !== 'fillForm' && Object.keys(tab.formValues).length > 0) {
    if (!(await flushForm(tabId))) return false;
    return runPageOp(op, options, tabId);
  }
  patchTab(tabId, () => ({ busy: i18n.t('busy.pages') }));
  try {
    const result = await window.foliux.pdf.transform({
      data: tab.data,
      annotations: tab.annotations,
      op,
    });
    if (op.type === 'fillForm') {
      // Rellenar el formulario no cambia lo que se ve: no hace falta volver a cargar el visor.
      commitChange(tabId, () => ({
        data: result.data,
        annotations: result.annotations,
        formValues: {},
        busy: null,
      }));
      void refreshForm(tabId);
      return true;
    }
    const loaded = await loadDocument(result.data);

    if (!tabOf(tabId)) {
      // Se cerró la pestaña mientras se procesaba.
      void loaded.doc.destroy().catch(() => undefined);
      return false;
    }
    const goTo = clamp(options.goTo ?? tab.page, 1, loaded.numPages);
    commitChange(tabId, () => ({
      ...docFields(loaded),
      data: result.data,
      annotations: result.annotations,
      selectedAnnotationId: null,
      pageSelection: options.selectAfter ?? [],
      page: goTo,
      busy: null,
    }));
    afterDocumentSwap(tabId, tab.doc, loaded);
    useDocs.getState().goToPage(tabId, goTo);
    return true;
  } catch (error) {
    patchTab(tabId, () => ({ busy: null }));
    notifyError(i18n.t('errors.pageOpFailed'), error);
    return false;
  }
}

export function rotatePages(degrees: 90 | -90 | 180): Promise<boolean> {
  const tab = getActiveTab();
  if (!tab) return Promise.resolve(false);
  return runPageOp(
    { type: 'rotate', pages: targetPages(tab), degrees },
    { selectAfter: tab.pageSelection },
  );
}

export function deletePages(): Promise<boolean> {
  const tab = getActiveTab();
  if (!tab) return Promise.resolve(false);
  const pages = targetPages(tab);
  if (pages.length >= tab.numPages) {
    toast.error(i18n.t('errors.deleteAll'));
    return Promise.resolve(false);
  }
  return runPageOp({ type: 'delete', pages }, { goTo: Math.min(...pages) });
}

export function duplicatePages(): Promise<boolean> {
  const tab = getActiveTab();
  if (!tab) return Promise.resolve(false);
  return runPageOp({ type: 'duplicate', pages: targetPages(tab) });
}

export function insertBlankPage(): Promise<boolean> {
  const tab = getActiveTab();
  if (!tab) return Promise.resolve(false);
  const after = Math.max(...targetPages(tab));
  return runPageOp(
    { type: 'insertBlank', after, count: 1 },
    { selectAfter: [after + 1], goTo: after + 1 },
  );
}

export async function insertPagesFromFile(): Promise<boolean> {
  const tab = getActiveTab();
  if (!tab) return false;
  try {
    const [path] = await window.foliux.openPdfDialog();
    if (!path) return false;
    const after = Math.max(...targetPages(tab));
    return runPageOp({ type: 'insertFile', after, path }, { goTo: after + 1 });
  } catch (error) {
    notifyError(i18n.t('errors.pageOpFailed'), error);
    return false;
  }
}

/** Mueve páginas para que queden en la posición `target` (1 = al principio, total + 1 = al final). */
export function movePages(pages: number[], target: number): Promise<boolean> {
  const tab = getActiveTab();
  if (!tab) return Promise.resolve(false);
  const order = computeMoveOrder(tab.numPages, pages, target);
  if (order.every((page, i) => page === i + 1)) return Promise.resolve(false);
  const moved = new Set(pages);
  const selectAfter = order.flatMap((oldPage, i) => (moved.has(oldPage) ? [i + 1] : []));
  return runPageOp({ type: 'reorder', order }, { selectAfter, goTo: selectAfter[0] });
}

function offerToOpen(saved: { path: string; name: string }): void {
  toast.success(i18n.t('save.created', { name: saved.name }), {
    action: { label: i18n.t('save.open'), onClick: () => void openPdfPath(saved.path) },
  });
}

/** Guarda las páginas seleccionadas (o la actual) como un PDF nuevo. */
export async function extractSelectedPages(): Promise<void> {
  const tab = getActiveTab();
  if (!tab || tab.busy) return;
  try {
    const saved = await window.foliux.pdf.extract({
      data: tab.data,
      annotations: tab.annotations,
      pages: targetPages(tab),
      suggestedName: `${tab.name.replace(/\.pdf$/i, '')} (extracto).pdf`,
      protection: tab.protection,
    });
    if (saved) {
      offerToOpen(saved);
      await refreshRecent();
    }
  } catch (error) {
    notifyError(i18n.t('errors.pageOpFailed'), error);
  }
}

/** Elige varios PDFs y los une en uno nuevo. */
export async function mergeFiles(): Promise<void> {
  try {
    const saved = await window.foliux.pdf.merge();
    if (saved) {
      offerToOpen(saved);
      await refreshRecent();
    }
  } catch (error) {
    notifyError(i18n.t('errors.pageOpFailed'), error);
  }
}

// ---------------------------------------------------------------------------
// Guardado y cierre
// ---------------------------------------------------------------------------

/** Lee los campos de formulario del documento (si los tiene). */
export async function refreshForm(tabId: string): Promise<void> {
  const tab = tabOf(tabId);
  if (!tab) return;
  const data = tab.data;
  try {
    const form = await window.foliux.pdf.formFields({ data });
    // Si mientras tanto cambió el documento, esta lectura ya no vale.
    if (tabOf(tabId)?.data === data) patchTab(tabId, () => ({ form }));
  } catch {
    patchTab(tabId, () => ({ form: [] }));
  }
}

/** Escribe en el PDF lo que el usuario tecleó en el formulario. */
export function flushForm(tabId: string): Promise<boolean> {
  const tab = tabOf(tabId);
  if (!tab || Object.keys(tab.formValues).length === 0) return Promise.resolve(true);
  return runPageOp({ type: 'fillForm', values: tab.formValues }, {}, tabId);
}

export async function saveTab(
  tabId: string,
  saveAs = false,
  ignoreSignatures = false,
): Promise<boolean> {
  let tab = tabOf(tabId);
  if (!tab || tab.busy) return false;
  if (!saveAs && !isDirty(tab)) return true;

  // Un documento firmado deja de estarlo al guardar con cambios: se avisa antes.
  if (tab.signatures.length > 0 && !ignoreSignatures) {
    useUi.getState().setSignatureWarning(tabId);
    return false;
  }

  if (!(await flushForm(tabId))) return false;
  tab = tabOf(tabId);
  if (!tab) return false;

  // El texto y las imágenes nuevos se incorporan a las páginas antes de guardar, para que el documento
  // en pantalla coincida con el archivo (y no se dupliquen al guardar otra vez).
  if (hasPendingContent(tab)) {
    if (!(await runPageOp({ type: 'applyEdits' }, {}, tabId))) return false;
    tab = tabOf(tabId);
    if (!tab) return false;
  }

  // Se guarda lo que había al pedirlo; si el usuario sigue editando, esos cambios quedan pendientes.
  const snapshot: Snapshot = { data: tab.data, annotations: tab.annotations };
  const protection = tab.protection;
  patchTab(tabId, () => ({ busy: i18n.t('busy.saving') }));
  try {
    const saved = await window.foliux.pdf.save({
      path: tab.path,
      suggestedName: tab.name,
      saveAs,
      protection,
      ...snapshot,
    });
    if (!saved) {
      patchTab(tabId, () => ({ busy: null }));
      return false;
    }
    patchTab(tabId, () => ({
      path: saved.path,
      name: saved.name,
      saved: { ...snapshot, protection },
      // El archivo guardado ya no conserva las firmas anteriores (reescribirlo las invalida).
      signatures: [],
      busy: null,
    }));
    toast.success(i18n.t('save.done', { name: saved.name }));
    await refreshRecent();
    return true;
  } catch (error) {
    patchTab(tabId, () => ({ busy: null }));
    notifyError(i18n.t('errors.saveFailed', { name: tab.name }), error);
    return false;
  }
}

export function saveActive(saveAs = false): Promise<boolean> {
  const tab = getActiveTab();
  return tab ? saveTab(tab.id, saveAs) : Promise.resolve(false);
}

/** Cierra una pestaña; si tiene cambios sin guardar, pregunta antes. */
export function requestCloseTab(tabId: string): void {
  const tab = tabOf(tabId);
  if (!tab) return;
  if (isDirty(tab)) useUi.getState().setClosePrompt(tabId);
  else useDocs.getState().closeTab(tabId);
}

// ---------------------------------------------------------------------------
// Edición de contenido: texto, imágenes, marcas de agua, encabezados, dividir, optimizar
// ---------------------------------------------------------------------------

/** ¿Hay texto o imágenes nuevos que aún no forman parte de las páginas? */
export function hasPendingContent(tab: DocTab): boolean {
  return tab.annotations.some(isPermanent);
}

export function pendingContentCount(tab: DocTab): number {
  return tab.annotations.filter(isPermanent).length;
}

/** Incorpora a las páginas el texto y las imágenes pendientes. Se puede deshacer. */
export function applyPendingContent(): Promise<boolean> {
  return runPageOp({ type: 'applyEdits' });
}

const TEXT_DEFAULTS = {
  fontSize: 14,
  font: 'sans',
  bold: false,
  italic: false,
  align: 'left',
  angle: 0,
  background: null,
  nowrap: false,
} as const;

/** Cuadro de texto nuevo (contenido permanente). */
export function createTextItem(
  page: number,
  rect: Rect,
  extra: Partial<AnnotationOf<'text'>> = {},
): AnnotationOf<'text'> {
  return createAnnotation('text', page, {
    rect,
    ...TEXT_DEFAULTS,
    ...extra,
  }) as AnnotationOf<'text'>;
}

function toDataUrl(data: Uint8Array, format: 'png' | 'jpeg'): string {
  // Se codifica por trozos: un solo String.fromCharCode con millones de argumentos desbordaría la pila.
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < data.length; i += chunk) {
    binary += String.fromCharCode(...data.subarray(i, i + chunk));
  }
  return `data:image/${format};base64,${btoa(binary)}`;
}

/** Dimensiones reales de una imagen (para conservar su proporción al colocarla). */
function imageSize(src: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
    image.onerror = () => reject(new Error(i18n.t('errors.imageUnreadable')));
    image.src = src;
  });
}

/**
 * Pide una imagen y la coloca en la página. Si se indica `replace`, ocupa ese rectángulo (reemplazando la
 * imagen que hubiera debajo, ajustada sin deformarse); si no, se coloca en `at` con un tamaño razonable.
 */
export async function placeImage(
  tabId: string,
  page: number,
  target: { replace: Rect } | { at: { x: number; y: number }; pageWidth: number },
): Promise<void> {
  try {
    const picked = await window.foliux.openImageDialog();
    if (!picked) return;
    const src = toDataUrl(picked.data, picked.format);
    const natural = await imageSize(src);
    const ratio = natural.width / natural.height;

    let rect: Rect;
    if ('replace' in target) {
      // Se ajusta al hueco de la imagen original sin deformarla y se centra.
      const box = target.replace;
      const width = Math.min(box.width, box.height * ratio);
      const height = width / ratio;
      rect = {
        x: box.x + (box.width - width) / 2,
        y: box.y + (box.height - height) / 2,
        width,
        height,
      };
    } else {
      const width = Math.min(natural.width, target.pageWidth * 0.4);
      rect = { x: target.at.x, y: target.at.y, width, height: width / ratio };
    }
    const item = createAnnotation('image', page, { rect, src, format: picked.format });
    if ('replace' in target) {
      // La imagen original sigue en el archivo: se tapa por completo con un rectángulo blanco (debajo de la
      // nueva) para que no asome por los lados si la proporción es distinta.
      const cover = createTextItem(page, target.replace, {
        text: '',
        background: '#ffffff',
        color: '#000000',
        nowrap: true,
      });
      addAnnotations(tabId, [cover, item]);
      selectAnnotation(tabId, item.id);
    } else {
      addAnnotations(tabId, [item]);
    }
    useUi.getState().setTool('select');
  } catch (error) {
    notifyError(i18n.t('errors.imageFailed'), error);
  }
}

export interface WatermarkSettings {
  text: string;
  image: { src: string; format: 'png' | 'jpeg' } | null;
  fontSize: number;
  color: string;
  opacity: number;
  angle: number;
  imageWidth: number;
  pages: string;
}

export function applyWatermark(settings: WatermarkSettings): Promise<boolean> {
  return runPageOp({
    type: 'watermark',
    text: settings.text.trim() === '' ? undefined : settings.text,
    image: settings.image ?? undefined,
    fontSize: settings.fontSize,
    color: settings.color,
    opacity: settings.opacity,
    angle: settings.angle,
    imageWidth: settings.imageWidth,
    pages: settings.pages,
  });
}

export interface HeaderFooterSettings {
  header: { left: string; center: string; right: string };
  footer: { left: string; center: string; right: string };
  font: FontFamily;
  fontSize: number;
  color: string;
  margin: number;
  pages: string;
  startNumber: number;
}

export function applyHeaderFooter(settings: HeaderFooterSettings): Promise<boolean> {
  const tab = getActiveTab();
  return runPageOp({
    type: 'headerFooter',
    ...settings,
    fileName: tab?.name ?? '',
  });
}

export type SplitSettings =
  { mode: 'each' } | { mode: 'every'; every: number } | { mode: 'ranges'; ranges: string };

/** Divide el documento en varios archivos dentro de una carpeta que elige el usuario. */
export async function splitDocument(settings: SplitSettings): Promise<boolean> {
  const tab = getActiveTab();
  if (!tab || tab.busy) return false;
  patchTab(tab.id, () => ({ busy: i18n.t('busy.splitting') }));
  try {
    const result = await window.foliux.pdf.split({
      data: tab.data,
      annotations: tab.annotations,
      baseName: tab.name.replace(/\.pdf$/i, ''),
      protection: tab.protection,
      mode: settings.mode,
      every: settings.mode === 'every' ? settings.every : undefined,
      ranges: settings.mode === 'ranges' ? settings.ranges : undefined,
    });
    patchTab(tab.id, () => ({ busy: null }));
    if (!result) return false;
    toast.success(i18n.t('split.done', { count: result.count }), {
      description: result.folder,
    });
    return true;
  } catch (error) {
    patchTab(tab.id, () => ({ busy: null }));
    notifyError(i18n.t('errors.pageOpFailed'), error);
    return false;
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Guarda una copia optimizada sin pérdida y cuenta cuánto se ha reducido. */
export async function optimizeDocument(): Promise<void> {
  const tab = getActiveTab();
  if (!tab || tab.busy) return;
  patchTab(tab.id, () => ({ busy: i18n.t('busy.optimizing') }));
  try {
    const result = await window.foliux.pdf.optimize({
      data: tab.data,
      annotations: tab.annotations,
      suggestedName: `${tab.name.replace(/\.pdf$/i, '')} (optimizado).pdf`,
      protection: tab.protection,
    });
    patchTab(tab.id, () => ({ busy: null }));
    if (!result) return;
    const saved = result.before - result.after;
    const percent = Math.round((saved / result.before) * 100);
    toast.success(i18n.t('optimize.done', { name: result.name }), {
      description:
        saved > 0
          ? i18n.t('optimize.smaller', {
              before: formatBytes(result.before),
              after: formatBytes(result.after),
              percent,
            })
          : i18n.t('optimize.same', { size: formatBytes(result.after) }),
      action: { label: i18n.t('save.open'), onClick: () => void openPdfPath(result.path) },
    });
    await refreshRecent();
  } catch (error) {
    patchTab(tab.id, () => ({ busy: null }));
    notifyError(i18n.t('errors.pageOpFailed'), error);
  }
}
