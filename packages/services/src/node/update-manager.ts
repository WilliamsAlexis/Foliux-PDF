import type { ILogger, UpdateState } from '@foliux-pdf/core';

/** Lo mínimo que se usa de `autoUpdater` de electron-updater: así se puede probar sin red. */
export interface UpdaterLike {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, listener: (...args: any[]) => void): unknown;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

interface VersionInfo {
  version?: string;
  releaseNotes?: unknown;
}

/** Notas de la versión como texto plano corto (llegan como HTML o como lista de notas). */
function plainNotes(raw: unknown): string {
  let text = '';
  if (typeof raw === 'string') text = raw;
  else if (Array.isArray(raw)) {
    text = raw
      .map((item) =>
        item && typeof item === 'object' ? String((item as { note?: unknown }).note ?? '') : '',
      )
      .join('\n');
  }
  return text
    .replace(/<[^>]*>/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .trim()
    .slice(0, 1500);
}

/** Mensaje claro para el usuario; el detalle técnico va solo al registro. */
export function describeUpdateError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  if (/ENOTFOUND|ETIMEDOUT|ECONNREFUSED|ECONNRESET|ERR_INTERNET|net::|EAI_AGAIN/i.test(raw)) {
    return 'No se pudo conectar para buscar actualizaciones. Revisa tu conexión a internet.';
  }
  if (/404|latest\.yml|Cannot find|No published versions/i.test(raw)) {
    return 'Todavía no hay una versión publicada para actualizar.';
  }
  if (/sha512|checksum|signature/i.test(raw)) {
    return 'La descarga no superó la comprobación de integridad y se descartó. Vuelve a intentarlo más tarde.';
  }
  return 'No se pudo completar la actualización.';
}

/**
 * Gestiona la búsqueda, descarga e instalación de actualizaciones. Nada se descarga ni se instala sin que el
 * usuario lo pida: la comprobación solo avisa de que hay una versión nueva.
 */
export class UpdateManager {
  private current: UpdateState;
  private busy = false;

  constructor(
    private readonly updater: UpdaterLike | null,
    private readonly emit: (state: UpdateState) => void,
    private readonly logger?: ILogger,
    unavailableReason = 'Las actualizaciones automáticas solo funcionan en la aplicación instalada.',
  ) {
    this.current = updater
      ? { state: 'idle' }
      : { state: 'unavailable', reason: unavailableReason };
    if (!updater) return;

    updater.autoDownload = false; // descargar solo cuando el usuario lo pide
    updater.autoInstallOnAppQuit = false; // instalar solo cuando el usuario lo pide
    updater.on('checking-for-update', () => this.set({ state: 'checking' }));
    updater.on('update-available', ((info: VersionInfo) =>
      this.set({
        state: 'available',
        version: info.version ?? '',
        notes: plainNotes(info.releaseNotes),
      })) as never);
    updater.on('update-not-available', () => this.set({ state: 'none' }));
    updater.on('download-progress', ((progress: { percent?: number }) => {
      const version = this.versionOf();
      this.set({
        state: 'downloading',
        version,
        percent: Math.min(100, Math.max(0, Math.round(progress.percent ?? 0))),
      });
    }) as never);
    updater.on('update-downloaded', ((info: VersionInfo) =>
      this.set({ state: 'downloaded', version: info.version ?? this.versionOf() })) as never);
    updater.on('error', ((error: unknown) => {
      this.logger?.error('Error del actualizador', error);
      this.set({ state: 'error', message: describeUpdateError(error) });
    }) as never);
  }

  get state(): UpdateState {
    return this.current;
  }

  private versionOf(): string {
    const s = this.current;
    return 'version' in s ? s.version : '';
  }

  private set(state: UpdateState): void {
    this.current = state;
    this.emit(state);
  }

  /** Busca una versión nueva. No hace nada si ya hay una búsqueda o descarga en curso. */
  async check(): Promise<void> {
    if (!this.updater || this.busy) return;
    if (this.current.state === 'downloading' || this.current.state === 'downloaded') return;
    this.busy = true;
    try {
      await this.updater.checkForUpdates();
    } catch (error) {
      this.logger?.error('No se pudo buscar actualizaciones', error);
      this.set({ state: 'error', message: describeUpdateError(error) });
    } finally {
      this.busy = false;
    }
  }

  /** Descarga la versión que se acaba de encontrar. */
  async download(): Promise<void> {
    if (!this.updater || this.current.state !== 'available') return;
    const version = this.current.version;
    this.set({ state: 'downloading', version, percent: 0 });
    try {
      await this.updater.downloadUpdate();
    } catch (error) {
      this.logger?.error('No se pudo descargar la actualización', error);
      this.set({ state: 'error', message: describeUpdateError(error) });
    }
  }

  /** Cierra la aplicación, instala la versión descargada y la vuelve a abrir. */
  install(): void {
    if (!this.updater || this.current.state !== 'downloaded') return;
    this.updater.quitAndInstall(false, true);
  }
}
