import { create } from 'zustand';
import type { IPdfDocument, OutlineItem, PageSize, SearchHit } from '@foliux-pdf/core';
import { clamp } from '@/lib/utils';
import type { ZoomMode } from '@/lib/layout';

export interface SearchState {
  query: string;
  status: 'idle' | 'running' | 'done' | 'error';
  /** Progreso de 0 a 1 mientras se busca. */
  progress: number;
  hits: SearchHit[];
  /** Índice de la coincidencia seleccionada (-1 si no hay). */
  current: number;
  abort: AbortController | null;
}

export const EMPTY_SEARCH: SearchState = {
  query: '',
  status: 'idle',
  progress: 0,
  hits: [],
  current: -1,
  abort: null,
};

/** Petición de desplazar el visor a una página (y opcionalmente a una altura dentro de ella). */
export interface ScrollRequest {
  page: number;
  /** Posición vertical dentro de la página a escala 1 (unidades PDF). */
  y?: number;
  nonce: number;
}

export interface DocTab {
  id: string;
  path: string;
  name: string;
  doc: IPdfDocument;
  numPages: number;
  sizes: PageSize[];
  page: number;
  zoomMode: ZoomMode;
  /** Zoom manual (1 = 100 %). Se usa cuando zoomMode es "custom". */
  customZoom: number;
  /** Zoom realmente aplicado (lo calcula el visor; sirve para mostrarlo en la barra). */
  zoom: number;
  outline: OutlineItem[] | null;
  search: SearchState;
  scrollRequest: ScrollRequest | null;
}

interface DocsState {
  tabs: DocTab[];
  activeId: string | null;
  addTab: (
    tab: Omit<
      DocTab,
      'id' | 'page' | 'zoomMode' | 'customZoom' | 'zoom' | 'outline' | 'search' | 'scrollRequest'
    >,
  ) => string;
  closeTab: (id: string) => void;
  setActive: (id: string) => void;
  update: (id: string, patch: Partial<DocTab>) => void;
  updateSearch: (id: string, patch: Partial<SearchState>) => void;
  /** Navega a una página (el visor se desplaza). */
  goToPage: (id: string, page: number, y?: number) => void;
  /** El usuario hizo scroll: se actualiza la página actual sin pedir otro desplazamiento. */
  setPageFromScroll: (id: string, page: number) => void;
}

let nonce = 0;
let counter = 0;

export const useDocs = create<DocsState>((set, get) => ({
  tabs: [],
  activeId: null,

  addTab: (base) => {
    const id = `doc-${++counter}`;
    const tab: DocTab = {
      ...base,
      id,
      page: 1,
      zoomMode: 'fit-width',
      customZoom: 1,
      zoom: 1,
      outline: null,
      search: EMPTY_SEARCH,
      scrollRequest: null,
    };
    set((s) => ({ tabs: [...s.tabs, tab], activeId: id }));
    return id;
  },

  closeTab: (id) => {
    const { tabs, activeId } = get();
    const index = tabs.findIndex((t) => t.id === id);
    const tab = tabs[index];
    if (!tab) return;

    // Liberar recursos: cancelar búsquedas en curso y cerrar el documento en PDF.js.
    tab.search.abort?.abort();
    void tab.doc.destroy().catch(() => undefined);

    const remaining = tabs.filter((t) => t.id !== id);
    const nextActive =
      activeId === id ? (remaining[Math.min(index, remaining.length - 1)]?.id ?? null) : activeId;
    set({ tabs: remaining, activeId: nextActive });
  },

  setActive: (id) => set({ activeId: id }),

  update: (id, patch) =>
    set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, ...patch } : t)) })),

  updateSearch: (id, patch) =>
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === id ? { ...t, search: { ...t.search, ...patch } } : t)),
    })),

  goToPage: (id, page, y) =>
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === id
          ? {
              ...t,
              page: clamp(Math.round(page), 1, t.numPages),
              scrollRequest: { page: clamp(Math.round(page), 1, t.numPages), y, nonce: ++nonce },
            }
          : t,
      ),
    })),

  setPageFromScroll: (id, page) =>
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === id && t.page !== page ? { ...t, page } : t)),
    })),
}));

export function getActiveTab(): DocTab | undefined {
  const { tabs, activeId } = useDocs.getState();
  return tabs.find((t) => t.id === activeId);
}

/** Hook: pestaña activa (o undefined). */
export function useActiveTab(): DocTab | undefined {
  return useDocs((s) => s.tabs.find((t) => t.id === s.activeId));
}
