import type { AppSettings, PdfFile, RecentFile } from './models';

export type Unsubscribe = () => void;

/** API que el preload expone en `window.foliux`. Es lo único que el renderer puede pedirle al sistema. */
export interface FoliuxApi {
  readonly platform: string;
  /** Ruta real de un archivo soltado en la ventana (File ya no expone `path` en Electron moderno). */
  getPathForFile(file: File): string;
  openPdfDialog(): Promise<string[]>;
  readPdf(path: string): Promise<PdfFile>;
  recent: {
    list(): Promise<RecentFile[]>;
    remove(path: string): Promise<void>;
    clear(): Promise<void>;
  };
  settings: {
    get(): Promise<AppSettings>;
    update(patch: Partial<AppSettings>): Promise<AppSettings>;
  };
  window: {
    toggleFullscreen(): Promise<boolean>;
    setFullscreen(value: boolean): Promise<boolean>;
  };
  /** Archivos recibidos antes de que la interfaz estuviera lista (asociación de archivos, línea de comandos). */
  getPendingFiles(): Promise<string[]>;
  onOpenFiles(callback: (paths: string[]) => void): Unsubscribe;
  onFullscreenChange(callback: (isFullscreen: boolean) => void): Unsubscribe;
  log(level: 'info' | 'warn' | 'error', message: string): void;
}
