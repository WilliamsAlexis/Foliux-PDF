import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import {
  app,
  BrowserWindow,
  dialog,
  Menu,
  nativeTheme,
  protocol,
  safeStorage,
  session,
  shell,
  type MenuItemConstructorOptions,
} from 'electron';
import log from 'electron-log/main';
import { autoUpdater } from 'electron-updater';
import { ipcEvents, type ILogger, type ThemePreference } from '@foliux-pdf/core';
import {
  AiService,
  AuditLogService,
  EncryptedKeyStore,
  QpdfService,
  UpdateManager,
  WorkspaceService,
  type UpdaterLike,
  RecentFilesService,
  SettingsService,
} from '@foliux-pdf/services/node';
import { registerIpcHandlers } from './ipc';

// Permite aislar los datos de usuario (las pruebas E2E no tocan los del usuario real).
if (process.env['FOLIUX_USER_DATA']) app.setPath('userData', process.env['FOLIUX_USER_DATA']);

// ---------- Registro de errores (electron-log) ----------
log.initialize();
log.transports.file.level = 'info';
log.errorHandler.startCatching({ showDialog: false });
const logger: ILogger = log;

// El renderer se sirve desde un protocolo propio (foliux://app/) en vez de file://.
// Así 'self' de la CSP tiene sentido y PDF.js puede leer sus fuentes y mapas de caracteres con fetch.
const APP_SCHEME = 'foliux';
const APP_ORIGIN = `${APP_SCHEME}://app/`;
protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
]);

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.gz': 'application/gzip',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
};

/** Sirve los archivos del renderer compilado, impidiendo salir de su carpeta (path traversal). */
function registerAppProtocol(): void {
  const root = normalize(join(__dirname, '../renderer'));
  protocol.handle(APP_SCHEME, async (request) => {
    const { pathname } = new URL(request.url);
    const relative = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
    const file = normalize(join(root, relative));
    if (!file.startsWith(root + sep)) return new Response('Prohibido', { status: 403 });
    try {
      const body = await readFile(file);
      const type = MIME_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream';
      return new Response(new Uint8Array(body), { headers: { 'Content-Type': type } });
    } catch {
      return new Response('No encontrado', { status: 404 });
    }
  });
}

const DEV_URL = process.env['ELECTRON_RENDERER_URL'];
const TITLEBAR_HEIGHT = 40;

// ---------- Estado ----------
let mainWindow: BrowserWindow | null = null;
let rendererReady = false; // el renderer ya pidió los archivos pendientes
const pendingFiles: string[] = [];

const recent = new RecentFilesService(
  join(app.getPath('userData'), 'recent-files.json'),
  15,
  logger,
);
const settings = new SettingsService(join(app.getPath('userData'), 'settings.json'), logger);

// ---------- Utilidades ----------

/** Rutas de archivos .pdf que existen, tomadas de los argumentos de la línea de comandos. */
function pdfPathsFromArgs(argv: string[]): string[] {
  return argv
    .slice(1)
    .filter(
      (arg) => !arg.startsWith('-') && extname(arg).toLowerCase() === '.pdf' && existsSync(arg),
    );
}

/** Entrega archivos al renderer, o los guarda hasta que esté listo. */
function openFiles(paths: string[]): void {
  if (paths.length === 0) return;
  if (rendererReady && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(ipcEvents.openFiles, paths);
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  } else {
    pendingFiles.push(...paths);
  }
}

function isDarkTheme(): boolean {
  return nativeTheme.shouldUseDarkColors;
}

/** Colores de la barra de título propia (coinciden con los del renderer). */
function titleBarColors(): { color: string; symbolColor: string; height: number } {
  return isDarkTheme()
    ? { color: '#18181b', symbolColor: '#e4e4e7', height: TITLEBAR_HEIGHT }
    : { color: '#f4f4f5', symbolColor: '#27272a', height: TITLEBAR_HEIGHT };
}

function applyTheme(theme: ThemePreference | string): void {
  nativeTheme.themeSource = theme === 'light' || theme === 'dark' ? theme : 'system';
}

function isTrustedUrl(url: string): boolean {
  if (DEV_URL && url.startsWith(DEV_URL)) return true;
  return url.startsWith(APP_ORIGIN);
}

// ---------- Ventana ----------

const iconPath = join(__dirname, '../../build/icon.png');

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 560,
    show: false,
    title: 'Foliux PDF',
    // Icono de la ventana en desarrollo; al instalar lo aporta el propio ejecutable.
    ...(existsSync(iconPath) ? { icon: iconPath } : {}),
    backgroundColor: isDarkTheme() ? '#09090b' : '#ffffff',
    // Barra de título propia: el renderer dibuja las pestañas; el sistema pone los botones de ventana.
    titleBarStyle: 'hidden',
    ...(process.platform !== 'darwin' ? { titleBarOverlay: titleBarColors() } : {}),
    trafficLightPosition: { x: 14, y: 13 },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // --- Seguridad obligatoria ---
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false,
    },
  });

  window.once('ready-to-show', () => window.show());

  window.on('enter-full-screen', () => window.webContents.send(ipcEvents.fullscreenChanged, true));
  window.on('leave-full-screen', () => window.webContents.send(ipcEvents.fullscreenChanged, false));
  window.on('closed', () => {
    mainWindow = null;
    rendererReady = false;
  });
  // El renderer bloquea el cierre (beforeunload) cuando hay cambios sin guardar; aquí se pregunta.
  window.webContents.on('will-prevent-unload', (event) => {
    const choice = dialog.showMessageBoxSync(window, {
      type: 'warning',
      buttons: ['Cancelar', 'Salir sin guardar'],
      defaultId: 0,
      cancelId: 0,
      title: 'Cambios sin guardar',
      message: 'Hay documentos con cambios sin guardar.',
      detail: 'Si sales ahora, esos cambios se perderán.',
    });
    // preventDefault ignora el bloqueo y deja cerrar la ventana.
    if (choice === 1) event.preventDefault();
  });
  window.webContents.on('render-process-gone', (_event, details) => {
    logger.error(`El proceso de la interfaz terminó: ${details.reason}`);
  });

  if (DEV_URL) void window.loadURL(DEV_URL);
  else void window.loadURL(`${APP_ORIGIN}index.html`);

  // Solo con el servidor de desarrollo (npm run dev); nunca al ejecutar la compilación.
  if (DEV_URL) window.webContents.openDevTools({ mode: 'detach' });
  return window;
}

/** Endurece cualquier contenido web que cree Electron (ventanas, navegación, permisos). */
function hardenWebContents(): void {
  app.on('web-contents-created', (_event, contents) => {
    // Nada de abrir ventanas nuevas; los enlaces http(s) se abren en el navegador del sistema.
    contents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
      return { action: 'deny' };
    });
    // La ventana nunca navega fuera de la aplicación (p. ej. al soltar un archivo mal).
    contents.on('will-navigate', (event, url) => {
      if (!isTrustedUrl(url)) event.preventDefault();
    });
    contents.on('will-attach-webview', (event) => event.preventDefault());
  });
}

function buildMenu(): void {
  // En Windows/Linux no hay menú (los atajos y la paleta de comandos lo sustituyen).
  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(null);
    return;
  }
  // En macOS hace falta un menú mínimo para que funcionen copiar/pegar y salir.
  const template: MenuItemConstructorOptions[] = [
    { role: 'appMenu' },
    { role: 'editMenu' },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------- Arranque ----------

if (!app.requestSingleInstanceLock()) {
  // Ya hay otra instancia: ella recibirá los archivos y esta se cierra.
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
    openFiles(pdfPathsFromArgs(argv));
  });

  // macOS: doble clic en un PDF asociado
  app.on('open-file', (event, path) => {
    event.preventDefault();
    openFiles([path]);
  });

  pendingFiles.push(...pdfPathsFromArgs(process.argv));

  hardenWebContents();

  void app.whenReady().then(async () => {
    app.setAppUserModelId('com.foliux.pdf');

    applyTheme((await settings.get()).theme);
    nativeTheme.on('updated', () => {
      if (process.platform !== 'darwin') mainWindow?.setTitleBarOverlay(titleBarColors());
    });

    // qpdf: el incluido con la aplicación (junto al ejecutable al empaquetar, o en resources/ en desarrollo).
    const qpdfPath =
      process.platform === 'win32'
        ? app.isPackaged
          ? join(process.resourcesPath, 'qpdf', 'qpdf.exe')
          : join(app.getAppPath(), 'resources', 'qpdf', 'qpdf.exe')
        : 'qpdf';

    // Clave de la API de Claude: cifrada con el sistema operativo (en Windows, DPAPI). Solo la usa este proceso.
    const keyStore = new EncryptedKeyStore(join(app.getPath('userData'), 'ai-key.bin'), {
      isAvailable: () => safeStorage.isEncryptionAvailable(),
      encrypt: (plain) => safeStorage.encryptString(plain),
      decrypt: (encrypted) => safeStorage.decryptString(Buffer.from(encrypted)),
    });
    const ai = new AiService({
      getKey: () => keyStore.get(),
      getModel: async () => (await settings.get()).aiModel,
    });

    // Actualizaciones: solo en la aplicación instalada. Avisan; descargar e instalar lo decide el usuario.
    const updates = new UpdateManager(
      app.isPackaged ? (autoUpdater as unknown as UpdaterLike) : null,
      (state) => mainWindow?.webContents.send(ipcEvents.updateChanged, state),
      logger,
    );

    registerIpcHandlers({
      logger,
      recent,
      settings,
      qpdf: new QpdfService(qpdfPath),
      ai,
      keyStore,
      updates,
      workspaces: new WorkspaceService(join(app.getPath('userData'), 'workspaces.json'), logger),
      audit: new AuditLogService(join(app.getPath('userData'), 'audit-log.jsonl')),
      getWindow: (event) => BrowserWindow.fromWebContents(event.sender),
      isTrustedUrl,
      onSettingsChanged: applyTheme,
      takePendingFiles: () => {
        rendererReady = true;
        return pendingFiles.splice(0, pendingFiles.length);
      },
      onRecentAdded: (path) => app.addRecentDocument(path),
    });

    // Ningún permiso (cámara, ubicación, notificaciones...) se concede a la interfaz.
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) =>
      callback(false),
    );
    registerAppProtocol();
    buildMenu();
    mainWindow = createWindow();

    // Búsqueda silenciosa al iniciar (unos segundos después, para no retrasar el arranque).
    if (app.isPackaged && (await settings.get()).autoCheckUpdates) {
      setTimeout(() => void updates.check(), 8000);
    }
    logger.info(`Foliux PDF ${app.getVersion()} iniciado (${process.platform})`);

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
