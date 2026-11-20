import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import { buildPdf } from '../unit/helpers';

/**
 * El visor abre con una hoja en columna (modo continuo): al desplazarse aparece la siguiente.
 * «Doble página» (dos hojas lado a lado) no se recuerda entre sesiones.
 */
let dir: string;
let pdfPath: string;

async function launch(): Promise<ElectronApplication> {
  const env = { ...process.env, FOLIUX_USER_DATA: dir } as Record<string, string>;
  delete env['ELECTRON_RUN_AS_NODE'];
  return electron.launch({ args: [resolve('apps/desktop'), pdfPath], env });
}

test.beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'foliux-view-'));
  pdfPath = join(dir, 'vista.pdf');
  await writeFile(pdfPath, buildPdf(['Uno', 'Dos', 'Tres']));
});
test.afterAll(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }).catch(
    () => undefined,
  );
});

test('un modo «doble página» guardado por una versión anterior se abre en continuo', async () => {
  // Primera sesión: se deja guardado el modo antiguo, tal como lo dejaría la versión anterior
  let app = await launch();
  let page = await app.firstWindow();
  await page.waitForSelector('#root > *');
  await page.evaluate(() =>
    window.localStorage.setItem(
      'foliux-ui',
      JSON.stringify({
        state: { viewMode: 'double', sidebarOpen: true, sidebarTab: 'thumbnails' },
        version: 0,
      }),
    ),
  );
  await app.close();

  // Segunda sesión: las hojas están en una sola columna (misma x, cada una debajo de la anterior)
  app = await launch();
  page = await app.firstWindow();
  await page.waitForSelector('.pdf-page');
  await expect(page.getByRole('button', { name: /^Continuo/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  const first = await page.locator('.pdf-page').nth(0).boundingBox();
  const second = await page.locator('.pdf-page').nth(1).boundingBox();
  expect(Math.abs(first!.x - second!.x)).toBeLessThan(2);
  expect(second!.y).toBeGreaterThan(first!.y + first!.height - 2);
  await app.close();
});

test('«doble página» sigue disponible, pero no se queda guardado', async () => {
  let app = await launch();
  let page = await app.firstWindow();
  await page.waitForSelector('.pdf-page');
  await page.getByRole('button', { name: /^Doble página/ }).click();
  await expect(page.getByRole('button', { name: /^Doble página/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await app.close();

  app = await launch();
  page = await app.firstWindow();
  await page.waitForSelector('.pdf-page');
  await expect(page.getByRole('button', { name: /^Continuo/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await app.close();
});
