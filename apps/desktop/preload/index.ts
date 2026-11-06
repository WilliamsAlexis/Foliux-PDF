import { contextBridge, ipcRenderer, webUtils } from 'electron';
import {
  FoliuxError,
  ipcEvents,
  type FoliuxApi,
  type IpcChannel,
  type IpcRequest,
  type IpcResponse,
  type IpcResult,
  type UpdateState,
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
  readPdf: (path, password) => call('file:read', { path, password }),
  openImageDialog: () => call('dialog:open-image'),
  chooseFolder: () => call('dialog:choose-folder'),
  updates: {
    status: () => call('update:status'),
    check: () => call('update:check'),
    download: () => call('update:download'),
    install: () => call('update:install'),
    onChange: (callback) => subscribe<UpdateState>(ipcEvents.updateChanged, callback),
  },
  workspaces: {
    list: () => call('workspace:list'),
    create: (name) => call('workspace:create', { name }),
    rename: (id, name) => call('workspace:rename', { id, name }),
    delete: (id) => call('workspace:delete', { id }),
    addDocuments: (id, paths) => call('workspace:add', { id, paths }),
    removeDocument: (id, path) => call('workspace:remove', { id, path }),
  },
  ai: {
    status: () => call('ai:status'),
    setKey: (key) => call('ai:set-key', { key }),
    clearKey: () => call('ai:clear-key'),
    cancel: (requestId) => call('ai:cancel', { requestId }),
    chat: (request) => call('ai:chat', request),
    extractTables: (request) => call('ai:extract-tables', request),
    detectFields: (request) => call('ai:detect-fields', request),
    findSensitive: (request) => call('ai:find-sensitive', request),
    makeSlides: (request) => call('ai:make-slides', request),
    audioSummary: (request) => call('ai:audio-summary', request),
    exportTables: (request) => call('ai:export-tables', request),
    exportSlides: (request) => call('ai:export-slides', request),
    onChunk: (callback) =>
      subscribe<{ requestId: string; delta: string }>(ipcEvents.aiChunk, callback),
  },
  openCertificateDialog: () => call('dialog:open-certificate'),
  audit: {
    list: () => call('audit:list'),
    exportCsv: () => call('audit:export'),
    record: (input) => call('audit:record', input),
  },
  certificate: { create: (request) => call('cert:create', request) },
  pdf: {
    save: (request) => call('pdf:save', request),
    create: (spec) => call('pdf:create', spec),
    transform: (request) => call('pdf:transform', request),
    extract: (request) => call('pdf:extract', request),
    merge: () => call('pdf:merge'),
    split: (request) => call('pdf:split', request),
    metadata: (request) => call('pdf:metadata', request),
    toOffice: (request) => call('convert:pdf-to-office', request),
    toPresentation: (request) => call('convert:pdf-to-pptx', request),
    toImages: (request) => call('convert:pdf-to-images', request),
    fromImages: () => call('convert:images-to-pdf'),
    fromOffice: () => call('convert:office-to-pdf'),
    officeStatus: () => call('convert:office-status'),
    pdfa: (request) => call('pdf:pdfa', request),
    process: (request) => call('pdf:process', request),
    writeCopy: (request) => call('pdf:write-copy', request),
    formFields: (request) => call('pdf:form-fields', request),
    verify: (request) => call('pdf:verify', request),
    sign: (request) => call('pdf:sign', request),
    redact: (request) => call('pdf:redact', request),
    optimize: (request) => call('pdf:optimize', request),
  },
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
