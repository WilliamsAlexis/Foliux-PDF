import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { AnnotationKind, RecentFile, ThemePreference, ViewMode } from '@foliux-pdf/core';

export type SidebarTab =
  | 'thumbnails'
  | 'outline'
  | 'annotations'
  | 'tools'
  | 'compare'
  | 'forms'
  | 'signatures'
  | 'assistant'
  | 'workspaces'
  | 'results';

/** Cuadros de diálogo de herramientas de edición. */
export type ToolDialog =
  | 'watermark'
  | 'headerFooter'
  | 'split'
  | 'security'
  | 'metadata'
  | 'redact'
  | 'field'
  | 'signature'
  | 'sign'
  | 'certificate'
  | 'audit'
  | 'ocr'
  | 'convert'
  | 'pdfa'
  | 'batch'
  | 'newDocument'
  | 'link'
  | 'crop'
  | 'convertOptions'
  | 'stamp'
  | 'initials'
  | null;

/** Herramienta activa: seleccionar/leer o crear un tipo de anotación. */
export type Tool = 'select' | 'edittext' | 'field' | 'signature' | 'link' | 'crop' | AnnotationKind;

/** Formatos a los que se puede exportar el documento (cada uno abre su cuadro de opciones). */
export type ConvertFormat = 'docx' | 'xlsx' | 'pptx' | 'images' | 'txt' | 'html';

interface UiState {
  sidebarOpen: boolean;
  sidebarTab: SidebarTab;
  viewMode: ViewMode;
  fullscreen: boolean;
  searchOpen: boolean;
  paletteOpen: boolean;
  /** Se está arrastrando un archivo sobre la ventana. */
  dragging: boolean;
  theme: ThemePreference;
  recent: RecentFile[];
  tool: Tool;
  /** Color elegido por el usuario para las anotaciones nuevas (null = el de cada herramienta). */
  color: string | null;
  strokeWidth: number;
  /** Anotación cuyo texto se está editando. */
  editingAnnotationId: string | null;
  /** Pestaña que se intenta cerrar con cambios sin guardar (muestra el aviso). */
  closePrompt: string | null;
  toolDialog: ToolDialog;
  /** PDF protegido que está esperando su contraseña (muestra el cuadro para escribirla). */
  passwordPrompt: { path: string; invalid: boolean } | null;
  /** Pestaña que se intenta guardar con firmas digitales (se avisa de que se invalidarán). */
  signatureWarning: string | null;
  /** Zona dibujada para un campo de formulario nuevo (espera a que se elijan sus datos). */
  fieldDraft: {
    page: number;
    rect: { x: number; y: number; width: number; height: number };
  } | null;
  /** Zona dibujada para un enlace o un recorte (espera a que se elijan sus datos). */
  zoneDraft: {
    page: number;
    rect: { x: number; y: number; width: number; height: number };
  } | null;
  /** Formato elegido en Convertir (para el cuadro de opciones). */
  convertFormat: ConvertFormat;
  /** Firma visual elegida que se colocará al pulsar sobre la página. */
  pendingSignature: {
    src: string;
    format: 'png' | 'jpeg';
    ratio: number;
    name: string;
    /** Ancho inicial al colocarla (unidades PDF); por defecto, el de una firma. */
    width?: number;
    /** No anotar la colocación en el registro de auditoría (sellos y fechas no son firmas). */
    silent?: boolean;
  } | null;

  setPasswordPrompt: (prompt: { path: string; invalid: boolean } | null) => void;
  setSignatureWarning: (tabId: string | null) => void;
  setFieldDraft: (draft: UiFieldDraft) => void;
  setZoneDraft: (draft: UiFieldDraft) => void;
  setConvertFormat: (format: ConvertFormat) => void;
  setPendingSignature: (signature: UiPendingSignature) => void;
  setToolDialog: (dialog: ToolDialog) => void;
  setTool: (tool: Tool) => void;
  setColor: (color: string | null) => void;
  setStrokeWidth: (width: number) => void;
  setEditingAnnotation: (id: string | null) => void;
  setClosePrompt: (tabId: string | null) => void;
  setSidebarOpen: (open: boolean) => void;
  toggleSidebar: () => void;
  setSidebarTab: (tab: SidebarTab) => void;
  setViewMode: (mode: ViewMode) => void;
  setFullscreen: (value: boolean) => void;
  setSearchOpen: (open: boolean) => void;
  setPaletteOpen: (open: boolean) => void;
  setDragging: (value: boolean) => void;
  setTheme: (theme: ThemePreference) => void;
  setRecent: (items: RecentFile[]) => void;
}

type UiFieldDraft = {
  page: number;
  rect: { x: number; y: number; width: number; height: number };
} | null;
type UiPendingSignature = {
  src: string;
  format: 'png' | 'jpeg';
  ratio: number;
  name: string;
  width?: number;
  silent?: boolean;
} | null;

/** Estado de la interfaz. Solo el modo de lectura y la barra lateral se recuerdan entre sesiones. */
export const useUi = create<UiState>()(
  persist(
    (set) => ({
      sidebarOpen: true,
      sidebarTab: 'thumbnails',
      viewMode: 'continuous',
      fullscreen: false,
      searchOpen: false,
      paletteOpen: false,
      dragging: false,
      theme: 'system',
      recent: [],
      tool: 'select',
      color: null,
      strokeWidth: 2,
      editingAnnotationId: null,
      closePrompt: null,
      toolDialog: null,
      passwordPrompt: null,
      signatureWarning: null,
      fieldDraft: null,
      zoneDraft: null,
      convertFormat: 'docx',
      pendingSignature: null,

      setPasswordPrompt: (passwordPrompt) => set({ passwordPrompt }),
      setSignatureWarning: (signatureWarning) => set({ signatureWarning }),
      setFieldDraft: (fieldDraft) => set({ fieldDraft }),
      setZoneDraft: (zoneDraft) => set({ zoneDraft }),
      setConvertFormat: (convertFormat) => set({ convertFormat }),
      setPendingSignature: (pendingSignature) => set({ pendingSignature }),
      setToolDialog: (toolDialog) => set({ toolDialog }),
      setTool: (tool) => set({ tool, editingAnnotationId: null }),
      setColor: (color) => set({ color }),
      setStrokeWidth: (strokeWidth) => set({ strokeWidth }),
      setEditingAnnotation: (editingAnnotationId) => set({ editingAnnotationId }),
      setClosePrompt: (closePrompt) => set({ closePrompt }),
      setSidebarOpen: (sidebarOpen) => set({ sidebarOpen }),
      toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
      setSidebarTab: (sidebarTab) => set({ sidebarTab, sidebarOpen: true }),
      setViewMode: (viewMode) => set({ viewMode }),
      setFullscreen: (fullscreen) => set({ fullscreen }),
      setSearchOpen: (searchOpen) => set({ searchOpen }),
      setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
      setDragging: (dragging) => set({ dragging }),
      setTheme: (theme) => set({ theme }),
      setRecent: (recent) => set({ recent }),
    }),
    {
      name: 'foliux-ui',
      // v1: «Doble página» deja de recordarse entre sesiones (abría los documentos con dos hojas una al lado de
      // otra sin que se notara por qué). Quien lo tuviera guardado vuelve al modo continuo: una hoja en columna
      // y, al desplazarse, aparece la siguiente.
      version: 1,
      migrate: (persisted) => {
        const state = (persisted ?? {}) as { viewMode?: string };
        return state.viewMode === 'double' ? { ...state, viewMode: 'continuous' } : state;
      },
      partialize: (s) => ({
        sidebarOpen: s.sidebarOpen,
        sidebarTab: s.sidebarTab,
        // «Doble página» es un modo puntual: al reabrir se vuelve a una sola hoja en columna.
        viewMode: s.viewMode === 'double' ? 'continuous' : s.viewMode,
      }),
    },
  ),
);
