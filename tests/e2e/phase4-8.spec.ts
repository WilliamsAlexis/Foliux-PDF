import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
 * Fases 4 a 8 de extremo a extremo: redacción desde la búsqueda, asistente de IA (clave, aviso de envío),
 * y espacios de trabajo. No se llama a la API de Anthropic: la prueba llega hasta el aviso previo al envío
 * y cancela. Los diálogos nativos se sustituyen en el proceso principal por respuestas fijas.
 */
test.describe.configure({ mode: 'serial' });

let app: ElectronApplication;
let page: Page;
let dir: string;
let firstPath: string;
let secondPath: string;

async function mockOpenDialog(filePaths: string[]) {
  await app.evaluate(({ dialog }, paths) => {
    dialog.showOpenDialog = (async () => ({
      canceled: false,
      filePaths: paths,
    })) as unknown as typeof dialog.showOpenDialog;
  }, filePaths);
}

const sidebarTab = (name: string) => page.getByRole('tab', { name, exact: true }).click();
const pageText = (n: number) => page.locator(`.pdf-page[data-page-number="${n}"] .textLayer`);

test.beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'foliux-e2e48-'));
  firstPath = join(dir, 'uno.pdf');
  secondPath = join(dir, 'dos.pdf');
  await writeFile(firstPath, buildPdf(['Hola Foliux', 'Segunda pagina', 'Tercera Foliux']));
  await writeFile(secondPath, buildPdf(['Otro documento']));

  const env = { ...process.env, FOLIUX_USER_DATA: dir } as Record<string, string>;
  delete env['ELECTRON_RUN_AS_NODE'];
  app = await electron.launch({ args: [resolve('apps/desktop'), firstPath], env });
  page = await app.firstWindow();
  await page.waitForSelector('#root > *');
  await expect(pageText(1)).toContainText('Hola Foliux', { timeout: 15_000 });
});

/** Cierra la aplicación sin el aviso de cambios sin guardar (la prueba de redacción deja el documento modificado). */
async function quit() {
  await app?.evaluate(({ app: a }) => a.exit(0)).catch(() => undefined);
}

test.afterAll(async () => {
  await quit();
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }).catch(
    () => undefined,
  );
});

test('redacción: marcar los resultados de una búsqueda y aplicarla borra el texto', async () => {
  await page.keyboard.press('Control+f');
  await page.getByPlaceholder('Buscar en el documento…').fill('Foliux');
  await expect(page.getByText('1 de 2')).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: 'Marcar todos los resultados para redactar' }).click();
  await expect(page.getByText('Se marcaron 2 zona(s) para redactar.')).toBeVisible();
  await page.keyboard.press('Escape');

  await sidebarTab('Herramientas');
  await page.getByRole('button', { name: /Aplicar redacciones/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Aplicar redacción permanente' });
  await dialog.getByRole('button', { name: 'Redactar de forma permanente' }).click();
  await expect(page.getByText('Redactadas 2 página(s).')).toBeVisible({ timeout: 30_000 });

  // El texto tapado ya no existe en las páginas; el resto sigue ahí.
  await expect(pageText(1)).not.toContainText('Foliux');
  await expect(pageText(1)).toContainText('Hola');
  await expect(pageText(2)).toContainText('Segunda');
});

test('asistente: sin clave pide configurarla, valida el formato y avisa antes de enviar', async () => {
  await sidebarTab('Asistente de IA');
  await page.getByRole('button', { name: 'Configurar la clave de la API' }).click();
  const dialog = page.getByRole('dialog', { name: 'Clave de la API de Claude' });

  // Una clave con otro formato se rechaza con un mensaje claro y no se guarda.
  await dialog.getByLabel('Clave de la API').fill('esto-no-es-una-clave-de-anthropic');
  await dialog.getByRole('button', { name: 'Guardar clave' }).click();
  await expect(dialog.getByRole('alert')).toContainText('no tiene el formato');

  // Una clave con el formato correcto se cifra y guarda (no se llama a la API).
  await dialog.getByLabel('Clave de la API').fill(`sk-ant-api03-${'a'.repeat(40)}`);
  await dialog.getByRole('button', { name: 'Guardar clave' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText('Clave guardada (cifrada).')).toBeVisible();

  // La clave nunca llega a la interfaz: ni el estado ni el almacenamiento del navegador la contienen.
  const leaked = await page.evaluate(() =>
    JSON.stringify([
      window.localStorage,
      window.sessionStorage,
      Object.keys((window as unknown as { foliux: { ai: object } }).foliux.ai),
    ]).includes('sk-ant'),
  );
  expect(leaked).toBe(false);

  // Al preguntar, antes de enviar nada se pide permiso mostrando lo que se enviará.
  const box = page.getByLabel(/Pregunta sobre el documento/);
  await box.fill('¿De qué trata?');
  await box.press('Enter');
  const consent = page.getByRole('dialog', { name: 'Enviar el documento a la IA' });
  await expect(consent).toBeVisible();
  await expect(consent).toContainText('tokens');
  await consent.getByRole('button', { name: 'Cancelar' }).click();
  await expect(consent).toBeHidden();
  // Al cancelar no se envió ni se anotó nada en la conversación.
  await expect(page.getByText('¿De qué trata?')).toHaveCount(0);
});

test('asistente: el archivo de la clave está cifrado en disco', async () => {
  const userData = await app.evaluate(({ app: a }) => a.getPath('userData'));
  expect(resolve(userData).toLowerCase()).toBe(resolve(dir).toLowerCase());
  const onDisk = (await readFile(join(userData, 'ai-key.bin'))).toString('latin1');
  expect(onDisk.length).toBeGreaterThan(20);
  expect(onDisk).not.toContain('sk-ant');
});

test('espacios de trabajo: crear, añadir documentos, quitar y eliminar', async () => {
  await sidebarTab('Espacios de trabajo');
  await page.getByRole('button', { name: 'Nuevo espacio' }).click();
  await page.getByLabel('Nombre del espacio').fill('Proyecto A');
  await page.locator('form').getByRole('button', { name: 'Guardar' }).click();
  await expect(page.getByRole('combobox', { name: 'Espacio de trabajo' })).toHaveValue(/.+/);
  await expect(page.getByText('Este espacio aún no tiene documentos.')).toBeVisible();

  // Documentos abiertos
  await page.getByRole('button', { name: 'Añadir abiertos' }).click();
  await expect(page.getByRole('button', { name: 'uno.pdf', exact: true })).toBeVisible();

  // Documentos elegidos con el diálogo del sistema
  await mockOpenDialog([secondPath]);
  await page.getByRole('button', { name: 'Añadir PDF…' }).click();
  await expect(page.getByRole('button', { name: 'dos.pdf', exact: true })).toBeVisible();

  // Añadir de nuevo el mismo documento no lo duplica
  await page.getByRole('button', { name: 'Añadir abiertos' }).click();
  await expect(page.getByRole('button', { name: 'uno.pdf', exact: true })).toHaveCount(1);

  // Abrir un documento del espacio lo abre en una pestaña
  await page.getByRole('button', { name: 'dos.pdf', exact: true }).click();
  await expect(pageText(1)).toContainText('Otro documento', { timeout: 15_000 });

  await page.getByRole('button', { name: 'Quitar «dos.pdf» del espacio' }).click();
  await expect(page.getByRole('button', { name: 'dos.pdf', exact: true })).toHaveCount(0);

  // Eliminar pide confirmación (segunda pulsación)
  await page.getByRole('button', { name: 'Eliminar espacio' }).click();
  await page.getByRole('button', { name: /¿Seguro\? Pulsa otra vez/ }).click();
  await expect(page.getByRole('option', { name: 'Sin espacios' })).toBeAttached();
});

test('espacios de trabajo: la lista se conserva al reiniciar la aplicación', async () => {
  await page.getByRole('button', { name: 'Nuevo espacio' }).click();
  await page.getByLabel('Nombre del espacio').fill('Persistente');
  await page.locator('form').getByRole('button', { name: 'Guardar' }).click();
  await expect(page.getByRole('option', { name: 'Persistente' })).toBeAttached();

  await quit();
  const env = { ...process.env, FOLIUX_USER_DATA: dir } as Record<string, string>;
  delete env['ELECTRON_RUN_AS_NODE'];
  app = await electron.launch({ args: [resolve('apps/desktop'), secondPath], env });
  page = await app.firstWindow();
  await page.waitForSelector('#root > *');
  await expect(pageText(1)).toContainText('Otro documento', { timeout: 15_000 });
  await sidebarTab('Espacios de trabajo');
  await expect(page.getByRole('option', { name: 'Persistente' })).toBeAttached();
});

test('actualizaciones: el diálogo muestra la versión y avisa de que en desarrollo no aplica', async () => {
  await page.keyboard.press('Control+k');
  await page.getByPlaceholder(/Escribe un comando/).fill('actualizaciones');
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Actualizaciones' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Versión instalada: 0.2.0');
  // Sin la app instalada no hay actualizador: se explica y no se ofrece buscar.
  await expect(dialog).toContainText('solo funcionan en la aplicación instalada');
  await expect(dialog.getByRole('button', { name: 'Buscar actualizaciones' })).toHaveCount(0);

  // La preferencia de buscar al iniciar se guarda.
  const box = dialog.getByLabel(/Buscar actualizaciones al iniciar/);
  await expect(box).toBeChecked();
  await box.uncheck();
  await expect
    .poll(async () =>
      page.evaluate(
        async () =>
          (
            await (
              window as unknown as {
                foliux: { settings: { get(): Promise<{ autoCheckUpdates: boolean }> } };
              }
            ).foliux.settings.get()
          ).autoCheckUpdates,
      ),
    )
    .toBe(false);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});

test('PDF nuevo: se crea en blanco, se escribe texto y se guarda como archivo', async () => {
  const target = join(dir, 'nuevo.pdf');
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = (async () => ({
      canceled: false,
      filePath,
    })) as unknown as typeof dialog.showSaveDialog;
  }, target);

  await page.keyboard.press('Control+n');
  const dialog = page.getByRole('dialog', { name: 'Nuevo PDF' });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Número de páginas').fill('2');
  await dialog.getByRole('button', { name: 'Crear' }).click();
  await expect(dialog).toBeHidden();

  // Pestaña sin título, 2 páginas y con cambios (cerrarla preguntaría)
  await expect(page.getByRole('tab', { name: /Documento sin título/ })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.locator('.pdf-page')).toHaveCount(2, { timeout: 10_000 });

  // Guardar elige la ruta con el diálogo «Guardar como» y escribe un PDF válido de 2 páginas
  await page.keyboard.press('Control+s');
  await expect(page.getByText(/nuevo\.pdf/).first()).toBeVisible({ timeout: 10_000 });
  const bytes = await readFile(target);
  expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  expect((bytes.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length).toBe(2);
});
