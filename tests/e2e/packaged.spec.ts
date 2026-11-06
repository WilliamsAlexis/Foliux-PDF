import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';
import { buildPdf } from '../unit/helpers';

/**
 * Prueba de humo de la aplicación EMPAQUETADA (la que instala el instalador). Se activa con
 * FOLIUX_PACKAGED=1 tras `npm run dist`; sin esa variable se omite.
 */
const exe = resolve('apps/desktop/dist/win-unpacked/Foliux PDF.exe');
test.skip(
  process.env['FOLIUX_PACKAGED'] !== '1',
  'Solo con FOLIUX_PACKAGED=1 y la app empaquetada',
);

test('la app empaquetada abre un PDF, trae qpdf y cifra la clave de la IA', async () => {
  expect(existsSync(exe)).toBe(true);
  const dir = await mkdtemp(join(tmpdir(), 'foliux-pkg-'));
  const pdf = join(dir, 'paquete.pdf');
  await writeFile(pdf, buildPdf(['Hola paquete']));
  const env = { ...process.env, FOLIUX_USER_DATA: dir } as Record<string, string>;
  delete env['ELECTRON_RUN_AS_NODE'];

  const app = await electron.launch({ executablePath: exe, args: [pdf], env });
  try {
    const page = await app.firstWindow();
    await page.waitForSelector('#root > *');
    await expect(page.locator('.pdf-page[data-page-number="1"] .textLayer')).toContainText(
      'Hola paquete',
      { timeout: 20_000 },
    );

    // qpdf va dentro del paquete (contraseñas AES-256).
    const hasQpdf = await app.evaluate(({ app: a }) => {
      const nodeRequire = process.mainModule?.require;
      if (!nodeRequire) return false;
      const fs = nodeRequire('node:fs') as { existsSync(path: string): boolean };
      const path = nodeRequire('node:path') as { join(...parts: string[]): string };
      return fs.existsSync(path.join(process.resourcesPath, 'qpdf', 'qpdf.exe')) && a.isPackaged;
    });
    expect(hasQpdf).toBe(true);

    // El almacén cifrado de la clave funciona en la app empaquetada.
    await page.getByRole('tab', { name: 'Asistente de IA', exact: true }).click();
    await page.getByRole('button', { name: 'Configurar la clave de la API' }).click();
    const dialog = page.getByRole('dialog', { name: 'Clave de la API de Claude' });
    await dialog.getByLabel('Clave de la API').fill(`sk-ant-api03-${'b'.repeat(40)}`);
    await dialog.getByRole('button', { name: 'Guardar clave' }).click();
    await expect(page.getByText('Clave guardada (cifrada).')).toBeVisible();

    // El actualizador está activo en la app instalada: buscar termina con un resultado claro (nunca se queda colgado).
    await page.keyboard.press('Control+k');
    await page.getByPlaceholder(/Escribe un comando/).fill('actualizaciones');
    await page.keyboard.press('Enter');
    const updates = page.getByRole('dialog', { name: 'Actualizaciones' });
    await expect(updates).toContainText('Versión instalada: 0.2.0');
    await updates.getByRole('button', { name: 'Buscar actualizaciones' }).click();
    await expect(updates.getByRole('status')).toContainText(
      /al día|versión nueva|No se pudo conectar|Todavía no hay una versión publicada|No se pudo completar/,
      { timeout: 30_000 },
    );
  } finally {
    await app.evaluate(({ app: a }) => a.exit(0)).catch(() => undefined);
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }).catch(
      () => undefined,
    );
  }
});
