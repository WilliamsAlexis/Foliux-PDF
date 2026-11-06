import type {
  OutlineItem,
  PageSize,
  PageWord,
  PdfMetadata,
  Rect,
  RecentFile,
  AppSettings,
  SearchHit,
} from './models';

/**
 * Interfaces de los servicios. El resto de la aplicación depende solo de estas interfaces,
 * así se puede cambiar de librería (por ejemplo PDF.js) sin tocar el resto del código.
 */

export interface RenderPageOptions {
  /** Escala de visualización (1 = 100 % = 96 DPI CSS). */
  scale: number;
  /** Escala del dispositivo (devicePixelRatio). Por defecto, la de la ventana. */
  outputScale?: number;
  signal?: AbortSignal;
}

export interface SearchOptions {
  signal?: AbortSignal;
  /** Progreso de 0 a 1. */
  onProgress?: (fraction: number) => void;
  /** Máximo de coincidencias a devolver. */
  maxHits?: number;
}

export interface IPdfDocument {
  readonly numPages: number;
  /** Tamaños de todas las páginas (en puntos PDF; a escala 1 equivalen a píxeles CSS × 0.75). */
  getPageSizes(): Promise<PageSize[]>;
  /** Dibuja una página en un canvas nuevo. Se cancela con `signal` (lanza AbortError). */
  renderPage(pageNumber: number, options: RenderPageOptions): Promise<HTMLCanvasElement>;
  /** Crea la capa de texto (seleccionable) de una página. */
  renderTextLayer(pageNumber: number, options: RenderPageOptions): Promise<HTMLElement>;
  search(query: string, options?: SearchOptions): Promise<SearchHit[]>;
  /** Rectángulos (en unidades de la vista, origen arriba-izquierda) de las imágenes dibujadas en la página. */
  getImageRects(pageNumber: number): Promise<Rect[]>;
  /** Palabras de la página con su posición aproximada (para conservar el texto al redactar o comparar). */
  getWords(pageNumber: number): Promise<PageWord[]>;
  getOutline(): Promise<OutlineItem[]>;
  getMetadata(): Promise<PdfMetadata>;
  destroy(): Promise<void>;
}

export interface LoadPdfOptions {
  password?: string;
}

export interface IPdfEngine {
  load(data: Uint8Array, options?: LoadPdfOptions): Promise<IPdfDocument>;
}

export interface IRecentFilesService {
  list(): Promise<RecentFile[]>;
  add(path: string): Promise<void>;
  remove(path: string): Promise<void>;
  clear(): Promise<void>;
}

export interface ISettingsService {
  get(): Promise<AppSettings>;
  update(patch: Partial<AppSettings>): Promise<AppSettings>;
}

/** Registro de eventos y errores. */
export interface ILogger {
  info(message: string, ...details: unknown[]): void;
  warn(message: string, ...details: unknown[]): void;
  error(message: string, ...details: unknown[]): void;
}
