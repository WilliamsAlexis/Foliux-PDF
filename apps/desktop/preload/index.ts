import { contextBridge, ipcRenderer, webUtils } from 'electron';
import {
  FoliuxError,
  ipcEvents,
  type FoliuxApi,
  type IpcChannel,
  type IpcRequest,
  type IpcResponse,
  type IpcResult,
} from '@foliux-pdf/core';

/**
 * Puente seguro: aquí se define lo ÚNICO que el renderer puede pedirle al sistema.
 * No se expone ipcRenderer ni ninguna API de Node; cada función llama a un canal concreto.
 * El proceso principal valida cada petición con Zod.
 */
async function call<C extends IpcChannel>(
  channel: C,
  request?: IpcRequest<C>,
): Promise<IpcResponse<C>> {
  const result = (await ipcRenderer.invoke(channel, request)) as IpcResult<IpcResponse<C>>;
  if (!result.ok) throw new FoliuxError(result.error.code, result.error.message);
  return result.value;
}

function subscribe<T>(channel: string, callback: (payload: T) => void): () => void {
  const listener = (_event: Electron.IpcRendererEvent, payload: T) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const api: FoliuxApi = {
  platform: process.platform,
  getPathForFile: (file) => webUtils.getPathForFile(file),
  openPdfDialog: () => call('dialog:open-pdf'),
  readPdf: (path) => call('file:read', { path }),
  recent: {
    list: () => call('recent:list'),
    remove: (path) => call('recent:remove', { path }),
    clear: () => call('recent:clear'),
  },
  settings: {
    get: () => call('settings:get'),
    update: (patch) => call('settings:update', patch),
  },
  window: {
    toggleFullscreen: () => call('window:toggle-fullscreen'),
    setFullscreen: (value) => call('window:set-fullscreen', { value }),
  },
  getPendingFiles: () => call('app:pending-files'),
  onOpenFiles: (callback) => subscribe<string[]>(ipcEvents.openFiles, callback),
  onFullscreenChange: (callback) => subscribe<boolean>(ipcEvents.fullscreenChanged, callback),
  log: (level, message) => {
    void call('log:write', { level, message }).catch(() => undefined);
  },
};

contextBridge.exposeInMainWorld('foliux', api);
