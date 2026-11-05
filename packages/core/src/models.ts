/** Preferencia de tema: claro, oscuro o automático según el sistema. */
export const THEME_PREFERENCES = ['light', 'dark', 'system'] as const;
export type ThemePreference = (typeof THEME_PREFERENCES)[number];

/** Modos de lectura (la pantalla completa es un estado aparte, combinable con cualquiera). */
export const VIEW_MODES = ['single', 'continuous', 'double'] as const;
export type ViewMode = (typeof VIEW_MODES)[number];

export interface AppSettings {
  theme: ThemePreference;
  language: string;
}

export const DEFAULT_SETTINGS: AppSettings = { theme: 'system', language: 'es' };

/** Entrada de la lista de archivos recientes. */
export interface RecentFile {
  path: string;
  name: string;
  /** Marca de tiempo (ms desde epoch) de la última apertura. */
  openedAt: number;
}

/** Contenido de un PDF leído desde disco. */
export interface PdfFile {
  path: string;
  name: string;
  data: Uint8Array;
}

/** Tamaño de página en puntos PDF (1 punto = 1/72 de pulgada), ya con la rotación de la página. */
export interface PageSize {
  width: number;
  height: number;
}

/** Rectángulo en coordenadas de la página a escala 1 (origen arriba-izquierda, unidades CSS). */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Una coincidencia de búsqueda. `pageNumber` es base 1. */
export interface SearchHit {
  pageNumber: number;
  before: string;
  match: string;
  after: string;
  rects: Rect[];
}

/** Elemento de los marcadores (índice) del documento. */
export interface OutlineItem {
  title: string;
  /** Página destino (base 1) o null si no se pudo resolver. */
  pageNumber: number | null;
  children: OutlineItem[];
}

export interface PdfMetadata {
  title?: string;
  author?: string;
  subject?: string;
  producer?: string;
}
