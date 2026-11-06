import { existsSync } from 'node:fs';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { app, dialog, ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import {
  FoliuxError,
  ipcContract,
  ipcEvents,
  type ErrorCode,
  type ILogger,
  type IpcChannel,
  type IpcRequest,
  type IpcResponse,
  type IpcResult,
  type IRecentFilesService,
  type Protection,
  type ISettingsService,
} from '@foliux-pdf/core';
import {
  bakeAnnotations,
  createBlankPdf,
  auditToCsv,
  buildDeckPptx,
  buildDocx,
  buildTablesXlsx,
  type AiService,
  type UpdateManager,
  type WorkspaceService,
  type EncryptedKeyStore,
  buildPptx,
  buildXlsx,
  convertOfficeToPdf,
  convertToPdfA,
  createSelfSignedCertificate,
  findLibreOffice,
  imagesToPdf,
  optimizePdf as optimizeBytes,
  OFFICE_EXTENSIONS,
  inspectMetadata,
  mayContainSignatures,
  readFormFields,
  redactDocument,
  sha256,
  signPdf,
  verifySignatures,
  QpdfService,
  type AuditLogService,
  extractPages,
  mergePdfs,
  openForEditing,
  optimizePdf,
  splitPdf,
  readPdfFile,
  transformPdf,
  writePdfFile,
} from '@foliux-pdf/services/node';

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
  /** Cifrado y descifrado de PDFs (qpdf). */
  qpdf: QpdfService;
  /** Asistente de IA (API de Claude) y almacén cifrado de su clave. */
  ai: AiService;
  keyStore: EncryptedKeyStore;
  /** Espacios de trabajo (grupos de documentos por proyecto). */
  workspaces: WorkspaceService;
  /** Actualizaciones de la aplicación. */
  updates: UpdateManager;
  /** Registro de auditoría de firmas. */
  audit: AuditLogService;
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

/**
 * Rutas que el renderer puede sobrescribir al guardar: solo las de documentos que la aplicación
 * abrió o guardó ella misma. Cualquier otra ruta obliga a pasar por el diálogo «Guardar como».
 */
const writablePaths = new Set<string>();
const pathKey = (path: string) => resolve(path).toLowerCase();

const PDF_FILTERS = [{ name: 'Documentos PDF', extensions: ['pdf'] }];
const IMAGE_FILTERS = [{ name: 'Imágenes PNG o JPEG', extensions: ['png', 'jpg', 'jpeg'] }];

/** Tamaño máximo de una imagen que se puede insertar (la imagen viaja codificada dentro del documento). */
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

/** Reconoce PNG y JPEG por su contenido (no por la extensión). */
function detectImageFormat(data: Uint8Array): 'png' | 'jpeg' | null {
  if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return 'png';
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'jpeg';
  return null;
}

/** Nombre de archivo válido en Windows, macOS y Linux. */
function safeFileName(name: string): string {
  const forbidden = '<>:"/\\|?*'; // incluye la barra invertida
  const clean = [...name]
    .map((char) => (char.charCodeAt(0) < 32 || forbidden.includes(char) ? '_' : char))
    .join('')
    .trim();
  return clean || 'documento';
}

/** Primer nombre libre en la carpeta: «x.pdf», «x (2).pdf», «x (3).pdf»... */
function freeName(folder: string, base: string): string {
  let candidate = join(folder, `${base}.pdf`);
  for (let n = 2; existsSync(candidate); n++) candidate = join(folder, `${base} (${n}).pdf`);
  return candidate;
}

export function registerIpcHandlers(deps: IpcDeps): void {
  /** Pide al usuario dónde guardar. Devuelve null si cancela. */
  async function askSavePath(
    event: IpcMainInvokeEvent,
    title: string,
    defaultPath: string,
  ): Promise<string | null> {
    const window = deps.getWindow(event);
    const options = { title, defaultPath, filters: PDF_FILTERS };
    const result = window
      ? await dialog.showSaveDialog(window, options)
      : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return null;
    return extname(result.filePath).toLowerCase() === '.pdf'
      ? result.filePath
      : `${result.filePath}.pdf`;
  }

  /** Pide dónde guardar un archivo que no es PDF (Word, Excel, PowerPoint...). */
  async function askSaveFile(
    event: IpcMainInvokeEvent,
    title: string,
    defaultPath: string,
    filter: { name: string; extensions: string[] },
  ): Promise<string | null> {
    const window = deps.getWindow(event);
    const options = { title, defaultPath, filters: [filter] };
    const result = window
      ? await dialog.showSaveDialog(window, options)
      : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return null;
    const wanted = `.${filter.extensions[0]}`;
    return extname(result.filePath).toLowerCase() === wanted
      ? result.filePath
      : `${result.filePath}${wanted}`;
  }

  /** Perfil sRGB del sistema (Windows lo incluye siempre); no se redistribuye, se lee del equipo. */
  async function systemSrgbProfile(): Promise<Uint8Array | undefined> {
    const candidates = [
      'C:\\Windows\\System32\\spool\\drivers\\color\\sRGB Color Space Profile.icm',
      '/usr/share/color/icc/colord/sRGB.icc',
      '/usr/share/color/icc/sRGB.icc',
      '/System/Library/ColorSync/Profiles/sRGB Profile.icc',
    ];
    for (const path of candidates) {
      if (existsSync(path)) return new Uint8Array(await readFile(path));
    }
    return undefined;
  }

  /** Aplica la protección elegida (si la hay) a los bytes que se van a escribir. */
  const protect = (bytes: Uint8Array, protection: Protection | null | undefined) =>
    protection ? deps.qpdf.encrypt(bytes, protection) : Promise.resolve(bytes);

  /** Escribe el archivo, lo autoriza para futuros guardados y lo añade a recientes. */
  async function writeAndRemember(path: string, data: Uint8Array) {
    const written = await writePdfFile(path, data);
    writablePaths.add(pathKey(written));
    await deps.recent.add(written);
    deps.onRecentAdded(written);
    return { path: written, name: basename(written) };
  }

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

  handle(deps, 'file:read', async ({ path, password }) => {
    const file = await readPdfFile(path);
    writablePaths.add(pathKey(file.path));
    // Abrir un archivo lo añade a recientes (y a la lista de documentos recientes del sistema).
    await deps.recent.add(file.path);
    deps.onRecentAdded(file.path);
    // Un PDF protegido se descifra para trabajar con él; la protección se recuerda para volver a aplicarla al guardar.
    let working = file.data;
    let protection: Protection | null = null;
    if (QpdfService.looksEncrypted(file.data)) {
      const decrypted = await deps.qpdf.decrypt(file.data, password ?? '');
      working = decrypted.data;
      protection = decrypted.protection;
    }
    // Las firmas se verifican sobre el archivo tal cual está en disco (los desplazamientos de bytes de la firma
    // se refieren a esos bytes, no al documento descifrado ni al que reescribe Foliux).
    const signatures = mayContainSignatures(file.data) ? verifySignatures(file.data) : [];
    if (signatures.length > 0) {
      const last = signatures[signatures.length - 1];
      await deps.audit
        .append({
          action: 'signature-check',
          file: file.name,
          fileHash: sha256(file.data),
          signer: signatures
            .map((s) => s.signer)
            .join(', ')
            .slice(0, 300),
          detail: signatures
            .map(
              (s) =>
                `firma ${s.index}: ${s.integrity}${s.coversWholeDocument ? '' : ' (con cambios posteriores)'}`,
            )
            .join('; ')
            .slice(0, 1900),
        })
        .catch(() => undefined);
      void last;
    }

    // Las anotaciones que Foliux guardó antes se separan para poder editarlas.
    const prepared = await openForEditing(working);
    return {
      ...file,
      data: prepared.data,
      annotations: prepared.annotations,
      protection,
      signatures,
    };
  });

  handle(
    deps,
    'pdf:save',
    async ({ path, suggestedName, saveAs, data, annotations, protection }, event) => {
      let target = path;
      if (saveAs || path === '' || !writablePaths.has(pathKey(path))) {
        const chosen = await askSavePath(event, 'Guardar PDF', path || suggestedName);
        if (!chosen) return null;
        target = chosen;
      }
      const bytes = await protect(
        await bakeAnnotations(data, annotations, basename(target)),
        protection,
      );
      return writeAndRemember(target, bytes);
    },
  );

  handle(deps, 'pdf:create', async (spec) => ({ data: await createBlankPdf(spec) }));

  handle(deps, 'pdf:transform', ({ data, annotations, op }) =>
    transformPdf(data, annotations, op, async (path) => {
      const file = await readPdfFile(path);
      return { data: file.data, name: file.name };
    }),
  );

  handle(
    deps,
    'pdf:extract',
    async ({ data, annotations, pages, suggestedName, protection }, event) => {
      const chosen = await askSavePath(event, 'Guardar páginas extraídas', suggestedName);
      if (!chosen) return null;
      let bytes: Uint8Array;
      try {
        bytes = await extractPages(data, annotations, pages);
      } catch (error) {
        if (error instanceof RangeError) {
          throw new FoliuxError('INVALID_REQUEST', 'Alguna de las páginas elegidas no existe.');
        }
        throw error;
      }
      return writeAndRemember(chosen, await protect(bytes, protection));
    },
  );

  handle(deps, 'dialog:open-image', async (_request, event) => {
    const window = deps.getWindow(event);
    const options = {
      title: 'Elegir imagen',
      properties: ['openFile'] as Array<'openFile'>,
      filters: IMAGE_FILTERS,
    };
    const picked = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options);
    const path = picked.filePaths[0];
    if (picked.canceled || !path) return null;

    const name = basename(path);
    const info = await stat(path).catch(() => null);
    if (!info?.isFile()) throw new FoliuxError('FILE_NOT_FOUND', `No se encontró «${name}».`);
    if (info.size > MAX_IMAGE_BYTES) {
      throw new FoliuxError('FILE_TOO_LARGE', `«${name}» es demasiado grande (máximo 25 MB).`);
    }
    const data = new Uint8Array(await readFile(path));
    const format = detectImageFormat(data);
    if (!format) {
      throw new FoliuxError('INVALID_REQUEST', `«${name}» no es una imagen PNG o JPEG válida.`);
    }
    return { name, format, data };
  });

  handle(
    deps,
    'pdf:split',
    async ({ data, annotations, mode, every, ranges, baseName, protection }, event) => {
      const plan =
        mode === 'each'
          ? ({ mode: 'each' } as const)
          : mode === 'every'
            ? ({ mode: 'every', every: every ?? 1 } as const)
            : ({ mode: 'ranges', ranges: ranges ?? '' } as const);

      // Primero se calcula (así un rango mal escrito falla antes de pedir la carpeta).
      let files: Awaited<ReturnType<typeof splitPdf>>;
      try {
        files = await splitPdf(data, annotations, plan);
      } catch (error) {
        if (error instanceof FoliuxError) throw error;
        throw new FoliuxError(
          'INVALID_REQUEST',
          error instanceof Error ? error.message : 'Rango no válido.',
        );
      }

      const window = deps.getWindow(event);
      const options = {
        title: 'Elige la carpeta donde guardar los archivos',
        properties: ['openDirectory', 'createDirectory'] as Array<
          'openDirectory' | 'createDirectory'
        >,
      };
      const picked = window
        ? await dialog.showOpenDialog(window, options)
        : await dialog.showOpenDialog(options);
      const folder = picked.filePaths[0];
      if (picked.canceled || !folder) return null;

      const base = safeFileName(baseName);
      const digits = String(files.length).length;
      let index = 0;
      for (const file of files) {
        index += 1;
        const part = String(index).padStart(digits, '0');
        await writePdfFile(
          freeName(folder, `${base} - parte ${part}`),
          await protect(file.data, protection),
        );
      }
      return { folder, count: files.length };
    },
  );

  handle(deps, 'pdf:optimize', async ({ data, annotations, suggestedName, protection }, event) => {
    const chosen = await askSavePath(event, 'Guardar copia optimizada', suggestedName);
    if (!chosen) return null;
    const optimized = await protect(await optimizePdf(data, annotations), protection);
    const saved = await writeAndRemember(chosen, optimized);
    return { ...saved, before: data.byteLength, after: optimized.byteLength };
  });

  handle(deps, 'pdf:metadata', ({ data }) => inspectMetadata(data));

  // ---- Fase 6: conversión ----
  handle(deps, 'convert:pdf-to-office', async ({ format, pages, suggestedName }, event) => {
    const filter =
      format === 'docx'
        ? { name: 'Documento de Word', extensions: ['docx'] }
        : { name: 'Libro de Excel', extensions: ['xlsx'] };
    const chosen = await askSaveFile(event, 'Guardar la conversión', suggestedName, filter);
    if (!chosen) return null;
    const bytes = format === 'docx' ? await buildDocx(pages) : await buildXlsx(pages);
    await writeFile(chosen, bytes);
    return { path: chosen, name: basename(chosen) };
  });

  handle(deps, 'convert:pdf-to-pptx', async ({ pages, suggestedName }, event) => {
    const chosen = await askSaveFile(event, 'Guardar la presentación', suggestedName, {
      name: 'Presentación de PowerPoint',
      extensions: ['pptx'],
    });
    if (!chosen) return null;
    await writeFile(chosen, await buildPptx(pages));
    return { path: chosen, name: basename(chosen) };
  });

  handle(deps, 'convert:pdf-to-images', async ({ pages, format, baseName }, event) => {
    const window = deps.getWindow(event);
    const options = {
      title: 'Elige la carpeta donde guardar las imágenes',
      properties: ['openDirectory', 'createDirectory'] as Array<
        'openDirectory' | 'createDirectory'
      >,
    };
    const picked = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options);
    const folder = picked.filePaths[0];
    if (picked.canceled || !folder) return null;
    const base = safeFileName(baseName);
    const extension = format === 'png' ? 'png' : 'jpg';
    const digits = String(pages.length).length;
    for (const page of pages) {
      const name = `${base} - página ${String(page.page).padStart(digits, '0')}`;
      let path = join(folder, `${name}.${extension}`);
      for (let n = 2; existsSync(path); n++) path = join(folder, `${name} (${n}).${extension}`);
      await writeFile(path, page.image);
    }
    return { folder, count: pages.length };
  });

  handle(deps, 'convert:images-to-pdf', async (_request, event) => {
    const window = deps.getWindow(event);
    const options = {
      title: 'Elige las imágenes (se unirán en este orden)',
      properties: ['openFile', 'multiSelections'] as Array<'openFile' | 'multiSelections'>,
      filters: IMAGE_FILTERS,
    };
    const picked = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options);
    if (picked.canceled || picked.filePaths.length === 0) return null;

    const images = [];
    for (const path of picked.filePaths) {
      const info = await stat(path).catch(() => null);
      if (!info?.isFile() || info.size > MAX_IMAGE_BYTES) {
        throw new FoliuxError(
          'FILE_TOO_LARGE',
          `«${basename(path)}» no existe o es demasiado grande (máximo 25 MB).`,
        );
      }
      images.push({ name: basename(path), data: new Uint8Array(await readFile(path)) });
    }
    const pdf = await imagesToPdf(images);
    const first = picked.filePaths[0] ?? '';
    const chosen = await askSavePath(event, 'Guardar el PDF', join(dirname(first), 'Imágenes.pdf'));
    if (!chosen) return null;
    return writeAndRemember(chosen, pdf);
  });

  handle(deps, 'convert:office-status', () => ({ libreOffice: findLibreOffice() !== null }));

  handle(deps, 'convert:office-to-pdf', async (_request, event) => {
    // Se comprueba antes de pedir nada: así el aviso sale enseguida si no hay LibreOffice.
    if (!findLibreOffice()) await convertOfficeToPdf('x.docx'); // lanza LIBREOFFICE_MISSING con su mensaje
    const window = deps.getWindow(event);
    const options = {
      title: 'Elige el documento de Office',
      properties: ['openFile'] as Array<'openFile'>,
      filters: [
        {
          name: 'Documentos de Office',
          extensions: OFFICE_EXTENSIONS.map((extension) => extension.slice(1)),
        },
      ],
    };
    const picked = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options);
    const input = picked.filePaths[0];
    if (picked.canceled || !input) return null;
    const pdf = await convertOfficeToPdf(input);
    const chosen = await askSavePath(
      event,
      'Guardar el PDF',
      join(dirname(input), `${basename(input, extname(input))}.pdf`),
    );
    if (!chosen) return null;
    return writeAndRemember(chosen, pdf);
  });

  handle(deps, 'pdf:pdfa', async ({ data, annotations, suggestedName }, event) => {
    const chosen = await askSavePath(event, 'Guardar la copia para archivado', suggestedName);
    if (!chosen) return null;
    const baked = await bakeAnnotations(data, annotations, basename(chosen));
    const result = await convertToPdfA(baked, { iccProfile: await systemSrgbProfile() });
    const saved = await writeAndRemember(chosen, result.data);
    return { ...saved, issues: result.issues, fixed: result.fixed };
  });

  handle(deps, 'pdf:process', async ({ data, annotations, action, protection, watermarkText }) => {
    const notations = annotations ?? [];
    const noOp = async () => {
      throw new FoliuxError('INVALID_REQUEST', 'Esta acción no necesita otro archivo.');
    };
    switch (action) {
      case 'bake':
        return { data: await bakeAnnotations(data, notations), note: 'Guardado.' };
      case 'optimize': {
        const out = await optimizeBytes(data, notations);
        return { data: out, note: 'Copia optimizada sin pérdida.' };
      }
      case 'pdfa': {
        const baked = await bakeAnnotations(data, notations);
        const result = await convertToPdfA(baked, { iccProfile: await systemSrgbProfile() });
        const blocking = result.issues.filter((issue) => issue.blocking).length;
        return {
          data: result.data,
          note:
            blocking > 0
              ? `PDF/A parcial: ${blocking} problema(s) sin resolver.`
              : 'PDF/A (mejor esfuerzo).',
        };
      }
      case 'clean-metadata': {
        const out = await transformPdf(
          data,
          notations,
          {
            type: 'cleanMetadata',
            info: true,
            xmp: true,
            thumbnails: true,
            attachments: true,
            javascript: true,
          },
          noOp,
        );
        return {
          data: await bakeAnnotations(out.data, out.annotations),
          note: 'Metadatos limpiados.',
        };
      }
      case 'watermark': {
        const out = await transformPdf(
          data,
          notations,
          {
            type: 'watermark',
            text: watermarkText || 'CONFIDENCIAL',
            fontSize: 72,
            color: '#888888',
            opacity: 0.25,
            angle: -45,
            imageWidth: 0.5,
            pages: 'all',
          },
          noOp,
        );
        return {
          data: await bakeAnnotations(out.data, out.annotations),
          note: 'Marca de agua aplicada.',
        };
      }
      case 'protect': {
        if (!protection)
          throw new FoliuxError('INVALID_REQUEST', 'Indica la contraseña y los permisos.');
        const baked = await bakeAnnotations(data, notations);
        return {
          data: await deps.qpdf.encrypt(baked, protection),
          note: 'Protegido con contraseña.',
        };
      }
    }
  });

  handle(deps, 'dialog:choose-folder', async (_request, event) => {
    const window = deps.getWindow(event);
    const options = {
      title: 'Elige una carpeta',
      properties: ['openDirectory', 'createDirectory'] as Array<
        'openDirectory' | 'createDirectory'
      >,
    };
    const picked = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options);
    return picked.canceled ? null : (picked.filePaths[0] ?? null);
  });

  handle(deps, 'pdf:write-copy', async ({ data, folder, name }) => {
    const path = freeName(folder, safeFileName(name.replace(/\.pdf$/i, '')));
    await writePdfFile(path, data);
    return { path, name: basename(path) };
  });

  handle(deps, 'pdf:form-fields', ({ data }) => readFormFields(data));

  // ---- Actualizaciones ----
  const updateInfo = () => ({ current: app.getVersion(), state: deps.updates.state });
  handle(deps, 'update:status', () => updateInfo());
  handle(deps, 'update:check', async () => {
    await deps.updates.check();
    return updateInfo();
  });
  handle(deps, 'update:download', () => deps.updates.download());
  handle(deps, 'update:install', () => deps.updates.install());

  // ---- Fase 8: espacios de trabajo ----
  handle(deps, 'workspace:list', () => deps.workspaces.list());
  handle(deps, 'workspace:create', ({ name }) => deps.workspaces.create(name));
  handle(deps, 'workspace:rename', ({ id, name }) => deps.workspaces.rename(id, name));
  handle(deps, 'workspace:delete', ({ id }) => deps.workspaces.delete(id));
  handle(deps, 'workspace:add', ({ id, paths }) => deps.workspaces.addDocuments(id, paths));
  handle(deps, 'workspace:remove', ({ id, path }) => deps.workspaces.removeDocument(id, path));

  // ---- Fase 7: asistente de IA ----
  // Peticiones en curso, para poder cancelarlas. La clave de la API nunca sale de este proceso.
  const aiRequests = new Map<string, AbortController>();
  const withAiRequest = async <T>(
    requestId: string,
    work: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> => {
    const controller = new AbortController();
    aiRequests.set(requestId, controller);
    try {
      return await work(controller.signal);
    } catch (error) {
      // Cancelar no es un fallo: se avisa a la interfaz con un error identificable.
      if ((error as Error).name === 'AbortError') throw new FoliuxError('AI_ERROR', 'Cancelado.');
      throw error;
    } finally {
      aiRequests.delete(requestId);
    }
  };

  handle(deps, 'ai:status', async () => ({
    configured: await deps.keyStore.has(),
    secureStorage: deps.keyStore.secureStorage,
    model: (await deps.settings.get()).aiModel,
  }));
  handle(deps, 'ai:set-key', ({ key }) => deps.keyStore.set(key));
  handle(deps, 'ai:clear-key', () => deps.keyStore.clear());
  handle(deps, 'ai:cancel', ({ requestId }) => {
    aiRequests.get(requestId)?.abort();
  });

  handle(deps, 'ai:chat', (request, event) =>
    withAiRequest(request.requestId, (signal) =>
      deps.ai.chat({
        documentName: request.documentName,
        documentText: request.documentText,
        totalPages: request.totalPages,
        history: request.history,
        question: request.question,
        workspace: request.workspace,
        signal,
        onText: (delta) => {
          if (!event.sender.isDestroyed()) {
            event.sender.send(ipcEvents.aiChunk, { requestId: request.requestId, delta });
          }
        },
      }),
    ),
  );
  handle(deps, 'ai:extract-tables', (request) =>
    withAiRequest(request.requestId, (signal) => deps.ai.extractTables({ ...request, signal })),
  );
  handle(deps, 'ai:detect-fields', (request) =>
    withAiRequest(request.requestId, (signal) => deps.ai.detectFields({ ...request, signal })),
  );
  handle(deps, 'ai:find-sensitive', (request) =>
    withAiRequest(request.requestId, (signal) => deps.ai.findSensitive({ ...request, signal })),
  );
  handle(deps, 'ai:make-slides', (request) =>
    withAiRequest(request.requestId, (signal) => deps.ai.makeSlides({ ...request, signal })),
  );
  handle(deps, 'ai:audio-summary', (request) =>
    withAiRequest(request.requestId, async (signal) => {
      const result = await deps.ai.audioSummary({ ...request, signal });
      return { text: result.text };
    }),
  );

  handle(deps, 'ai:export-tables', async ({ tables, suggestedName }, event) => {
    const chosen = await askSaveFile(event, 'Guardar las tablas', suggestedName, {
      name: 'Libro de Excel',
      extensions: ['xlsx'],
    });
    if (!chosen) return null;
    await writeFile(chosen, await buildTablesXlsx(tables));
    return { path: chosen, name: basename(chosen) };
  });

  handle(deps, 'ai:export-slides', async ({ deck, suggestedName }, event) => {
    const chosen = await askSaveFile(event, 'Guardar la presentación', suggestedName, {
      name: 'Presentación de PowerPoint',
      extensions: ['pptx'],
    });
    if (!chosen) return null;
    await writeFile(chosen, await buildDeckPptx(deck));
    return { path: chosen, name: basename(chosen) };
  });

  handle(deps, 'pdf:verify', ({ data }) => verifySignatures(data));

  handle(
    deps,
    'pdf:sign',
    async (
      { data, annotations, certificate, passphrase, reason, location, contact, suggestedName },
      event,
    ) => {
      const chosen = await askSavePath(event, 'Guardar documento firmado', suggestedName);
      if (!chosen) return null;
      // Primero se incorpora todo lo pendiente; la firma va siempre al final (cualquier cambio posterior la invalida).
      const baked = await bakeAnnotations(data, annotations, basename(chosen));
      const signed = await signPdf(baked, { certificate, passphrase, reason, location, contact });
      const saved = await writeAndRemember(chosen, signed);
      const signatures = verifySignatures(signed);
      const last = signatures[signatures.length - 1];
      await deps.audit
        .append({
          action: 'digital-signature',
          file: saved.name,
          fileHash: sha256(signed),
          signer: last?.signer ?? '',
          detail:
            `Motivo: ${reason || '—'}; lugar: ${location || '—'}; huella del certificado: ${last?.fingerprint ?? '—'}`.slice(
              0,
              1900,
            ),
        })
        .catch(() => undefined);
      return { ...saved, signatures };
    },
  );

  handle(deps, 'dialog:open-certificate', async (_request, event) => {
    const window = deps.getWindow(event);
    const options = {
      title: 'Elegir certificado',
      properties: ['openFile'] as Array<'openFile'>,
      filters: [{ name: 'Certificados PKCS#12', extensions: ['p12', 'pfx'] }],
    };
    const picked = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options);
    const path = picked.filePaths[0];
    if (picked.canceled || !path) return null;
    const info = await stat(path).catch(() => null);
    if (!info?.isFile() || info.size > 2 * 1024 * 1024) {
      throw new FoliuxError(
        'INVALID_REQUEST',
        'El archivo del certificado no es válido o es demasiado grande.',
      );
    }
    return { name: basename(path), data: new Uint8Array(await readFile(path)) };
  });

  handle(deps, 'cert:create', async (request, event) => {
    const window = deps.getWindow(event);
    const options = {
      title: 'Guardar el certificado',
      defaultPath: `${request.commonName}.p12`,
      filters: [{ name: 'Certificado PKCS#12', extensions: ['p12'] }],
    };
    const result = window
      ? await dialog.showSaveDialog(window, options)
      : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return null;
    const path =
      extname(result.filePath).toLowerCase() === '.p12'
        ? result.filePath
        : `${result.filePath}.p12`;

    const { p12, fingerprint } = createSelfSignedCertificate(request);
    // Solo lo puede leer el usuario (en Windows el modo se ignora; la carpeta del usuario ya es privada).
    await writeFile(path, p12, { mode: 0o600 });
    await deps.audit
      .append({
        action: 'certificate-created',
        file: basename(path),
        fileHash: sha256(p12),
        signer: request.commonName,
        detail: `Certificado autofirmado, válido ${request.days} días. Huella: ${fingerprint}`,
      })
      .catch(() => undefined);
    return { path, name: basename(path), fingerprint };
  });

  handle(deps, 'audit:list', async () => {
    const entries = await deps.audit.list();
    return { entries, chainOk: (await deps.audit.verify()).ok };
  });

  handle(deps, 'audit:export', async (_request, event) => {
    const window = deps.getWindow(event);
    const options = {
      title: 'Exportar el registro de auditoría',
      defaultPath: 'registro-de-auditoria.csv',
      filters: [{ name: 'CSV', extensions: ['csv'] }],
    };
    const result = window
      ? await dialog.showSaveDialog(window, options)
      : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return null;
    await writeFile(result.filePath, auditToCsv(await deps.audit.list()), 'utf8');
    return { path: result.filePath, name: basename(result.filePath) };
  });

  handle(deps, 'audit:record', async (input) => {
    await deps.audit.append(input);
  });

  handle(deps, 'pdf:redact', ({ data, annotations, pages }) =>
    redactDocument(data, annotations, pages),
  );

  handle(deps, 'pdf:merge', async (_request, event) => {
    const window = deps.getWindow(event);
    const options = {
      title: 'Elige los PDFs que quieres combinar (se unirán en este orden)',
      properties: ['openFile', 'multiSelections'] as Array<'openFile' | 'multiSelections'>,
      filters: PDF_FILTERS,
    };
    const picked = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options);
    if (picked.canceled || picked.filePaths.length === 0) return null;
    if (picked.filePaths.length < 2) {
      throw new FoliuxError('INVALID_REQUEST', 'Elige al menos dos PDFs para combinarlos.');
    }

    const files = [];
    for (const path of picked.filePaths) {
      const file = await readPdfFile(path);
      files.push({ data: file.data, name: file.name });
    }
    const first = picked.filePaths[0] ?? '';
    const chosen = await askSavePath(
      event,
      'Guardar PDF combinado',
      join(dirname(first), 'Combinado.pdf'),
    );
    if (!chosen) return null;
    return writeAndRemember(chosen, await mergePdfs(files));
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
