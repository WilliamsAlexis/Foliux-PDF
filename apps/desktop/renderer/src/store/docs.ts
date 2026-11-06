import { create } from 'zustand';
import type {
  Annotation,
  FormFieldInfo,
  FormValues,
  SignatureReport,
  IPdfDocument,
  OutlineItem,
  PageSize,
  Protection,
  SearchHit,
} from '@foliux-pdf/core';
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

/** Estado editable de un documento: sirve para el historial (deshacer/rehacer) y para saber si hay cambios. */
export interface Snapshot {
  /** Bytes del PDF SIN las anotaciones de Foliux (se escriben al guardar). */
  data: Uint8Array;
  annotations: Annotation[];
}

export interface DocTab {
  id: string;
  path: string;
  name: string;
  doc: IPdfDocument;
  /** Bytes actuales del documento (con los cambios de páginas ya aplicados). */
  data: Uint8Array;
  annotations: Annotation[];
  selectedAnnotationId: string | null;
  /** Páginas seleccionadas en las miniaturas (base 1). */
  pageSelection: number[];
  history: Snapshot[];
  future: Snapshot[];
  /** Último estado guardado en disco; si coincide con el actual no hay cambios pendientes. */
  saved: Snapshot & { protection: Protection | null };
  /** Contraseñas y permisos con los que se guardará el archivo (null = sin proteger). */
  protection: Protection | null;
  /** Firmas digitales que tenía el archivo al abrirlo (guardar con cambios las invalida). */
  signatures: SignatureReport[];
  /** Campos de formulario del documento (null = aún sin leer). */
  form: FormFieldInfo[] | null;
  /** Valores escritos por el usuario que todavía no están en el PDF. */
  formValues: FormValues;
  /** Texto de la operación larga en curso (bloquea la edición mientras tanto). */
  busy: string | null;
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
      | 'id'
      | 'page'
      | 'zoomMode'
      | 'customZoom'
      | 'zoom'
      | 'outline'
      | 'search'
      | 'scrollRequest'
      | 'selectedAnnotationId'
      | 'pageSelection'
      | 'history'
      | 'future'
      | 'saved'
      | 'busy'
      | 'form'
      | 'formValues'
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
      selectedAnnotationId: null,
      pageSelection: [],
      history: [],
      future: [],
      saved: { data: base.data, annotations: base.annotations, protection: base.protection },
      busy: null,
      form: null,
      formValues: {},
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

/** ¿Tiene cambios sin guardar? (compara por referencia: deshacer hasta el estado guardado lo deja limpio). */
export function isDirty(tab: DocTab): boolean {
  return (
    tab.data !== tab.saved.data ||
    tab.annotations !== tab.saved.annotations ||
    tab.protection !== tab.saved.protection ||
    Object.keys(tab.formValues).length > 0
  );
}

export function getActiveTab(): DocTab | undefined {
  const { tabs, activeId } = useDocs.getState();
  return tabs.find((t) => t.id === activeId);
}

/** Hook: pestaña activa (o undefined). */
export function useActiveTab(): DocTab | undefined {
  return useDocs((s) => s.tabs.find((t) => t.id === s.activeId));
}
