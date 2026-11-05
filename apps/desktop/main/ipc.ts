import { dialog, ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import {
  FoliuxError,
  ipcContract,
  type ErrorCode,
  type ILogger,
  type IpcChannel,
  type IpcRequest,
  type IpcResponse,
  type IpcResult,
  type IRecentFilesService,
  type ISettingsService,
} from '@foliux-pdf/core';
import { readPdfFile } from '@foliux-pdf/services/node';

export interface IpcDeps {
  logger: ILogger;
  recent: IRecentFilesService;
  settings: ISettingsService;
  /** Ventana que envió la petición (para diálogos y pantalla completa). */
  getWindow: (event: IpcMainInvokeEvent) => BrowserWindow | null;
  /** Solo se atiende al renderer propio: servidor de desarrollo o protocolo foliux://app/. */
  isTrustedUrl: (url: string) => boolean;
  /** Aplica el tema al sistema (nativeTheme) y a la barra de título. */
  onSettingsChanged: (theme: string) => void;
  /** Devuelve y vacía los archivos recibidos antes de que el renderer estuviera listo. */
  takePendingFiles: () => string[];
  onRecentAdded: (path: string) => void;
}

/**
 * Registra un manejador IPC con validación Zod de la petición y de la respuesta.
 * Los errores se devuelven como { ok: false, error } con un mensaje apto para el usuario.
 */
function handle<C extends IpcChannel>(
  deps: IpcDeps,
  channel: C,
  fn: (
    request: IpcRequest<C>,
    event: IpcMainInvokeEvent,
  ) => Promise<IpcResponse<C>> | IpcResponse<C>,
): void {
  ipcMain.handle(channel, async (event, raw: unknown): Promise<IpcResult<IpcResponse<C>>> => {
    try {
      // 1) Solo se atiende a nuestra propia interfaz (no a páginas externas).
      const url = event.senderFrame?.url ?? '';
      if (!deps.isTrustedUrl(url)) {
        throw new FoliuxError('UNTRUSTED_SENDER', 'Petición rechazada por seguridad.');
      }

      // 2) Validar la petición con su esquema.
      const parsed = ipcContract[channel].request.safeParse(raw);
      if (!parsed.success) {
        deps.logger.warn(`IPC ${channel}: petición inválida`, parsed.error.issues);
        throw new FoliuxError('INVALID_REQUEST', 'La petición no es válida.');
      }

      // 3) Ejecutar y validar la respuesta.
      const result = await fn(parsed.data as IpcRequest<C>, event);
      const checked = ipcContract[channel].response.safeParse(result);
      if (!checked.success) {
        deps.logger.error(`IPC ${channel}: respuesta inválida`, checked.error.issues);
        throw new FoliuxError('UNKNOWN', 'Error interno: respuesta inesperada.');
      }
      return { ok: true, value: checked.data as IpcResponse<C> };
    } catch (error) {
      return { ok: false, error: toIpcError(error, channel, deps.logger) };
    }
  });
}

function toIpcError(
  error: unknown,
  channel: string,
  logger: ILogger,
): { code: ErrorCode; message: string } {
  if (error instanceof FoliuxError) {
    // Errores esperados (archivo no encontrado, no es PDF...) solo se anotan como aviso.
    logger.warn(`IPC ${channel}: ${error.code} - ${error.message}`);
    return { code: error.code, message: error.message };
  }
  logger.error(`IPC ${channel}: error inesperado`, error);
  return {
    code: 'UNKNOWN',
    message: 'Ocurrió un error inesperado. Consulta el registro de errores.',
  };
}

export function registerIpcHandlers(deps: IpcDeps): void {
  handle(deps, 'dialog:open-pdf', async (_request, event) => {
    const window = deps.getWindow(event);
    const options = {
      title: 'Abrir PDF',
      properties: ['openFile', 'multiSelections'] as Array<'openFile' | 'multiSelections'>,
      filters: [{ name: 'Documentos PDF', extensions: ['pdf'] }],
    };
    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options);
    return result.canceled ? [] : result.filePaths;
  });

  handle(deps, 'file:read', async ({ path }) => {
    const file = await readPdfFile(path);
    // Abrir un archivo lo añade a recientes (y a la lista de documentos recientes del sistema).
    await deps.recent.add(file.path);
    deps.onRecentAdded(file.path);
    return file;
  });

  handle(deps, 'recent:list', () => deps.recent.list());
  handle(deps, 'recent:remove', async ({ path }) => deps.recent.remove(path));
  handle(deps, 'recent:clear', async () => deps.recent.clear());

  handle(deps, 'settings:get', () => deps.settings.get());
  handle(deps, 'settings:update', async (patch) => {
    const next = await deps.settings.update(patch);
    deps.onSettingsChanged(next.theme);
    return next;
  });

  handle(deps, 'window:toggle-fullscreen', (_request, event) => {
    const window = deps.getWindow(event);
    if (!window) return false;
    window.setFullScreen(!window.isFullScreen());
    return window.isFullScreen();
  });
  handle(deps, 'window:set-fullscreen', ({ value }, event) => {
    const window = deps.getWindow(event);
    if (!window) return false;
    window.setFullScreen(value);
    return window.isFullScreen();
  });

  handle(deps, 'app:pending-files', () => deps.takePendingFiles());

  handle(deps, 'log:write', ({ level, message }) => {
    deps.logger[level](`[renderer] ${message}`);
  });
}
