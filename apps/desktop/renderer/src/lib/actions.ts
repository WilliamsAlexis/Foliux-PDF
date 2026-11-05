import { FoliuxError } from '@foliux-pdf/core';
import type { ThemePreference } from '@foliux-pdf/core';
import i18n from '@/i18n';
import { pdfEngine } from './engine';
import { notifyError } from './notify';
import { CSS_UNITS, nextZoomStep, stepPage } from './layout';
import { isAbortError } from './utils';
import { getActiveTab, useDocs } from '@/store/docs';
import { useUi } from '@/store/ui';

/** Lógica de aplicación compartida por la interfaz, los atajos y la paleta de comandos. */

// ---------- Abrir archivos ----------

/** Evita abrir dos veces el mismo archivo si llegan peticiones simultáneas. */
const opening = new Set<string>();

export async function refreshRecent(): Promise<void> {
  try {
    useUi.getState().setRecent(await window.foliux.recent.list());
  } catch {
    // La lista de recientes es secundaria: si falla, simplemente no se actualiza.
  }
}

export async function openPdfPath(path: string): Promise<void> {
  const key = path.toLowerCase();
  const existing = useDocs.getState().tabs.find((t) => t.path.toLowerCase() === key);
  if (existing) {
    useDocs.getState().setActive(existing.id);
    return;
  }
  if (opening.has(key)) return;
  opening.add(key);

  const name = path.split(/[\\/]/).pop() ?? path;
  try {
    const file = await window.foliux.readPdf(path);
    const doc = await pdfEngine.load(file.data);
    const sizes = await doc.getPageSizes();

    const id = useDocs
      .getState()
      .addTab({ path: file.path, name: file.name, doc, numPages: doc.numPages, sizes });

    // Los marcadores se cargan aparte: no retrasan la apertura del documento.
    doc
      .getOutline()
      .then((outline) => useDocs.getState().update(id, { outline }))
      .catch(() => useDocs.getState().update(id, { outline: [] }));
  } catch (error) {
    notifyError(i18n.t('errors.openFailed', { name }), error);
    // Si el archivo ya no existe, se quita de la lista de recientes.
    if (error instanceof FoliuxError && error.code === 'FILE_NOT_FOUND') {
      await window.foliux.recent.remove(path).catch(() => undefined);
    }
  } finally {
    opening.delete(key);
    await refreshRecent();
  }
}

export async function openPdfPaths(paths: string[]): Promise<void> {
  for (const path of paths) await openPdfPath(path);
}

export async function openPdfDialog(): Promise<void> {
  try {
    await openPdfPaths(await window.foliux.openPdfDialog());
  } catch (error) {
    notifyError(i18n.t('errors.unexpected'), error);
  }
}

// ---------- Zoom ----------

export function setZoom(zoom: number): void {
  const tab = getActiveTab();
  if (!tab) return;
  useDocs.getState().update(tab.id, { zoomMode: 'custom', customZoom: zoom });
}

export function zoomStep(direction: 1 | -1): void {
  const tab = getActiveTab();
  if (tab) setZoom(nextZoomStep(tab.zoom, direction));
}

export function zoomByFactor(factor: number): void {
  const tab = getActiveTab();
  if (tab) setZoom(tab.zoom * factor);
}

export function setZoomMode(mode: 'fit-width' | 'fit-page'): void {
  const tab = getActiveTab();
  if (tab) useDocs.getState().update(tab.id, { zoomMode: mode });
}

/** Píxeles CSS por unidad PDF para un zoom dado. */
export function pixelsPerUnit(zoom: number): number {
  return zoom * CSS_UNITS;
}

// ---------- Navegación ----------

export function goToPage(page: number): void {
  const tab = getActiveTab();
  if (tab) useDocs.getState().goToPage(tab.id, page);
}

export function stepPages(direction: 1 | -1): void {
  const tab = getActiveTab();
  if (!tab) return;
  const target = stepPage(tab.page, tab.numPages, useUi.getState().viewMode, direction);
  useDocs.getState().goToPage(tab.id, target);
}

export function cycleTab(direction: 1 | -1): void {
  const { tabs, activeId, setActive } = useDocs.getState();
  if (tabs.length < 2) return;
  const index = tabs.findIndex((t) => t.id === activeId);
  const next = tabs[(index + direction + tabs.length) % tabs.length];
  if (next) setActive(next.id);
}

// ---------- Búsqueda ----------

/** Ejecuta una búsqueda en la pestaña indicada, cancelando la anterior si seguía en curso. */
export async function runSearch(tabId: string, query: string): Promise<void> {
  const docs = useDocs.getState();
  const tab = docs.tabs.find((t) => t.id === tabId);
  if (!tab) return;

  tab.search.abort?.abort();
  const trimmed = query.trim();
  if (trimmed.length === 0) {
    docs.updateSearch(tabId, {
      query,
      status: 'idle',
      progress: 0,
      hits: [],
      current: -1,
      abort: null,
    });
    return;
  }

  const controller = new AbortController();
  docs.updateSearch(tabId, {
    query,
    status: 'running',
    progress: 0,
    hits: [],
    current: -1,
    abort: controller,
  });

  let lastReported = 0;
  try {
    const hits = await tab.doc.search(trimmed, {
      signal: controller.signal,
      onProgress: (fraction) => {
        // Se limita la frecuencia de actualizaciones para no saturar la interfaz.
        if (fraction - lastReported >= 0.02 || fraction === 1) {
          lastReported = fraction;
          useDocs.getState().updateSearch(tabId, { progress: fraction });
        }
      },
    });

    // La coincidencia inicial es la primera desde la página actual (o la primera del documento).
    const current = tab.page;
    const first = hits.findIndex((h) => h.pageNumber >= current);
    useDocs.getState().updateSearch(tabId, {
      status: 'done',
      progress: 1,
      hits,
      current: hits.length === 0 ? -1 : first >= 0 ? first : 0,
      abort: null,
    });
    if (hits.length > 0) selectHit(tabId, first >= 0 ? first : 0);
  } catch (error) {
    if (isAbortError(error)) {
      // Cancelada por el usuario o sustituida por otra búsqueda: no es un error.
      if (useDocs.getState().tabs.find((t) => t.id === tabId)?.search.abort === controller) {
        useDocs.getState().updateSearch(tabId, { status: 'idle', abort: null });
      }
      return;
    }
    useDocs.getState().updateSearch(tabId, { status: 'error', abort: null });
    notifyError(i18n.t('errors.unexpected'), error);
  }
}

export function cancelSearch(tabId: string): void {
  const tab = useDocs.getState().tabs.find((t) => t.id === tabId);
  tab?.search.abort?.abort();
}

/** Selecciona una coincidencia y desplaza el visor hasta ella. */
export function selectHit(tabId: string, index: number): void {
  const docs = useDocs.getState();
  const tab = docs.tabs.find((t) => t.id === tabId);
  const hit = tab?.search.hits[index];
  if (!tab || !hit) return;
  docs.updateSearch(tabId, { current: index });
  docs.goToPage(tabId, hit.pageNumber, hit.rects[0]?.y);
}

export function stepHit(direction: 1 | -1): void {
  const tab = getActiveTab();
  if (!tab || tab.search.hits.length === 0) return;
  const total = tab.search.hits.length;
  selectHit(tab.id, (tab.search.current + direction + total) % total);
}

// ---------- Tema y pantalla completa ----------

const THEME_ORDER: ThemePreference[] = ['system', 'light', 'dark'];

export async function setTheme(theme: ThemePreference): Promise<void> {
  useUi.getState().setTheme(theme);
  try {
    await window.foliux.settings.update({ theme });
  } catch (error) {
    notifyError(i18n.t('errors.unexpected'), error);
  }
}

export function cycleTheme(): void {
  const current = useUi.getState().theme;
  const next = THEME_ORDER[(THEME_ORDER.indexOf(current) + 1) % THEME_ORDER.length] ?? 'system';
  void setTheme(next);
}

export async function toggleFullscreen(): Promise<void> {
  try {
    await window.foliux.window.toggleFullscreen();
  } catch (error) {
    notifyError(i18n.t('errors.unexpected'), error);
  }
}
