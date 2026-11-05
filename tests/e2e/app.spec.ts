import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { buildPdf } from '../unit/helpers';

/**
 * Pruebas de extremo a extremo: arrancan la aplicación Electron real (hay que compilarla antes
 * con `npm run build`; el script `npm run test:e2e` ya lo hace).
 */

let app: ElectronApplication;
let page: Page;
let dir: string;
let pdfPath: string;

test.beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'foliux-e2e-'));
  pdfPath = join(dir, 'prueba.pdf');
  await writeFile(pdfPath, buildPdf(['Hola Foliux', 'Segunda pagina', 'Tercera Foliux']));

  // Si se lanza desde un entorno basado en Electron (p. ej. VS Code), ELECTRON_RUN_AS_NODE haría que
  // Electron arrancara como un Node normal; se elimina para que abra la aplicación.
  const env = { ...process.env, FOLIUX_USER_DATA: dir } as Record<string, string>;
  delete env['ELECTRON_RUN_AS_NODE'];

  app = await electron.launch({
    args: [resolve('apps/desktop'), pdfPath], // el PDF llega como argumento, como al hacer doble clic
    env,
  });
  page = await app.firstWindow();
  // firstWindow() puede devolver la ventana antes de que cargue la interfaz: se espera a que pinte la raíz.
  await page.waitForSelector('#root > *');
});

test.afterAll(async () => {
  await app?.close();
  await rm(dir, { recursive: true, force: true });
});

test('la ventana es segura (sandbox, aislamiento, sin Node en el renderer)', async () => {
  // Se leen los ajustes REALES de la ventana desde el proceso principal.
  const prefs = await app.evaluate(({ BrowserWindow }) => {
    const contents = BrowserWindow.getAllWindows()[0]!.webContents as unknown as {
      getLastWebPreferences(): {
        sandbox?: boolean;
        contextIsolation?: boolean;
        nodeIntegration?: boolean;
      };
    };
    const p = contents.getLastWebPreferences();
    return {
      sandbox: p.sandbox,
      contextIsolation: p.contextIsolation,
      nodeIntegration: p.nodeIntegration,
    };
  });
  expect(prefs).toEqual({ sandbox: true, contextIsolation: true, nodeIntegration: false });

  const flags = await page.evaluate(() => ({
    hasRequire: typeof (window as unknown as { require?: unknown }).require,
    hasProcess: typeof (window as unknown as { process?: unknown }).process,
  }));
  expect(flags).toEqual({ hasRequire: 'undefined', hasProcess: 'undefined' });

  const csp = await page
    .locator('meta[http-equiv="Content-Security-Policy"]')
    .getAttribute('content');
  expect(csp).toContain("default-src 'none'");
  expect(csp).not.toContain("'unsafe-eval'"); // 'wasm-unsafe-eval' (PDF.js) sí está permitido
});

test('abre el PDF recibido por línea de comandos y muestra pestaña, páginas y miniaturas', async () => {
  await expect(page.getByRole('tab', { name: /prueba\.pdf/ })).toBeVisible();
  await expect(page.getByText('de 3')).toBeVisible();
  await expect(page.locator('.pdf-page canvas').first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('button', { name: 'Página 2' })).toBeVisible();
  await page.screenshot({ path: 'test-results/01-visor.png' });
});

test('el texto del PDF queda seleccionable (capa de texto)', async () => {
  const text = page.locator('.pdf-page .textLayer').first();
  await expect(text).toContainText('Hola Foliux', { timeout: 15_000 });
});

test('buscar resalta coincidencias y navega entre ellas', async () => {
  await page.keyboard.press('Control+f');
  const input = page.getByRole('textbox', { name: 'Buscar texto' });
  await expect(input).toBeFocused();
  await input.fill('foliux');
  await input.press('Enter');
  await expect(page.getByText('1 de 2')).toBeVisible({ timeout: 10_000 });
  await input.press('Enter');
  await expect(page.getByText('2 de 2')).toBeVisible();
  await page.screenshot({ path: 'test-results/02-busqueda.png' });
  await input.press('Escape');
  await expect(input).toBeHidden();
});

test('modos de lectura: página única y doble página', async () => {
  // Se vuelve a la página 1 (en doble página, la 3 de 3 se muestra sola)
  await page.locator('#page-input').fill('1');
  await page.locator('#page-input').press('Enter');
  await page.getByRole('button', { name: /^Página única/ }).click();
  await expect(page.locator('.pdf-page')).toHaveCount(1);

  await page.getByRole('button', { name: /^Doble página/ }).click();
  await expect(page.locator('.pdf-page')).toHaveCount(2);
  await page.screenshot({ path: 'test-results/03-doble.png' });

  await page.getByRole('button', { name: /^Continuo/ }).click();
  await expect(page.locator('.pdf-page')).toHaveCount(3);
});

test('la paleta de comandos (Ctrl+K) ejecuta acciones', async () => {
  await page.keyboard.press('Control+k');
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await page.keyboard.type('claro');
  await expect(dialog.getByText('Cambiar tema')).toBeVisible();
  await page.screenshot({ path: 'test-results/04-paleta.png' });
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});

test('tema oscuro y cierre de pestaña', async () => {
  await page.getByRole('button', { name: /^Tema/ }).click(); // automático -> claro
  await page.getByRole('button', { name: /^Tema/ }).click(); // claro -> oscuro
  await expect(page.locator('html')).toHaveClass(/dark/);
  await page.waitForTimeout(500); // deja terminar las transiciones de color antes de la captura
  await page.screenshot({ path: 'test-results/05-oscuro.png' });

  await page.keyboard.press('Control+w');
  await expect(page.getByRole('heading', { name: 'Foliux PDF' })).toBeVisible();
  await page.waitForTimeout(500);
  await page.screenshot({ path: 'test-results/06-bienvenida.png' });
});
