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
import { PDFDocument } from 'pdf-lib';
import { buildPdf } from '../unit/helpers';

/**
 * Barra de acciones (estilo Acrobat) de extremo a extremo: despliegue, selección, teclado, y las herramientas
 * nuevas (recortar, enlace, sellos con redimensionado, convertir a texto, imprimir, correo).
 */
test.describe.configure({ mode: 'serial' });

let app: ElectronApplication;
let page: Page;
let dir: string;
let pdfPath: string;

const tabButton = (name: string) => page.getByRole('button', { name, exact: true });
const toolbar = (name: string) => page.getByRole('toolbar', { name, exact: true });
const pageText = (n: number) => page.locator(`.pdf-page[data-page-number="${n}"] .textLayer`);

async function openAction(name: string) {
  if ((await tabButton(name).getAttribute('aria-expanded')) !== 'true')
    await tabButton(name).click();
  await expect(toolbar(name)).toBeVisible();
}
async function tool(action: string, name: string) {
  await openAction(action);
  await toolbar(action).getByRole('button', { name, exact: true }).click();
}

/** Arrastra sobre la primera página (cerca del principio: la página es más alta que la ventana). */
async function dragOnPage(fromX: number, fromY: number, toX: number, toY: number) {
  const box = await page.locator('.pdf-page').first().boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width * fromX, box!.y + fromY);
  await page.mouse.down();
  await page.mouse.move(box!.x + box!.width * toX, box!.y + toY, { steps: 8 });
  await page.mouse.up();
}

test.beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'foliux-ribbon-'));
  pdfPath = join(dir, 'barra.pdf');
  await writeFile(pdfPath, buildPdf(['Hola Foliux', 'Segunda pagina', 'Tercera Foliux']));
  const env = { ...process.env, FOLIUX_USER_DATA: dir } as Record<string, string>;
  delete env['ELECTRON_RUN_AS_NODE'];
  app = await electron.launch({ args: [resolve('apps/desktop'), pdfPath], env });
  page = await app.firstWindow();
  await page.waitForSelector('#root > *');
  await expect(pageText(1)).toContainText('Hola Foliux', { timeout: 15_000 });
});

test.afterAll(async () => {
  await app?.evaluate(({ app: a }) => a.exit(0)).catch(() => undefined);
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }).catch(
    () => undefined,
  );
});

test('al abrir solo se ven las acciones principales; cada una despliega su barra', async () => {
  for (const name of [
    'Editar',
    'Firmar',
    'Comentar',
    'Convertir',
    'Organizar páginas',
    'Proteger',
    'Compartir',
  ]) {
    await expect(tabButton(name)).toBeVisible();
    await expect(tabButton(name)).toHaveAttribute('aria-expanded', 'false');
  }
  // Ninguna sub-herramienta está disponible todavía (la barra secundaria está oculta para todos).
  await expect(page.getByRole('button', { name: 'Rectángulo', exact: true })).toHaveCount(0);

  await tabButton('Editar').click();
  await expect(tabButton('Editar')).toHaveAttribute('aria-expanded', 'true');
  await expect(toolbar('Editar').getByRole('button', { name: 'Rectángulo' })).toBeVisible();

  // Al elegir otra acción, la anterior se oculta y aparece la nueva
  await tabButton('Firmar').click();
  await expect(toolbar('Firmar')).toBeVisible();
  await expect(tabButton('Editar')).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByRole('button', { name: 'Rectángulo', exact: true })).toHaveCount(0);

  // Volver a pulsar la acción activa la contrae
  await tabButton('Firmar').click();
  await expect(tabButton('Firmar')).toHaveAttribute('aria-expanded', 'false');
  await expect(toolbar('Firmar')).toHaveCount(0);
});

test('teclado: flechas entre acciones, Esc contrae y devuelve el foco', async () => {
  await tabButton('Editar').focus();
  await page.keyboard.press('ArrowRight');
  await expect(tabButton('Firmar')).toBeFocused();
  await page.keyboard.press('End');
  await expect(tabButton('Compartir')).toBeFocused();
  await page.keyboard.press('Home');
  await expect(tabButton('Editar')).toBeFocused();

  await page.keyboard.press('Enter'); // abre
  await expect(toolbar('Editar')).toBeVisible();
  await toolbar('Editar').getByRole('button', { name: 'Seleccionar' }).focus();
  await page.keyboard.press('Escape');
  await expect(toolbar('Editar')).toHaveCount(0);
  await expect(tabButton('Editar')).toBeFocused();
});

test('las herramientas que dependen de una selección están deshabilitadas hasta que la hay', async () => {
  await openAction('Editar');
  const del = toolbar('Editar').getByRole('button', { name: 'Borrar elemento' });
  await expect(del).toHaveAttribute('aria-disabled', 'true');

  await tool('Editar', 'Rectángulo');
  await expect(toolbar('Editar').getByRole('button', { name: 'Rectángulo' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await dragOnPage(0.2, 200, 0.6, 320);
  // El rectángulo recién dibujado queda seleccionado: ya se puede borrar
  await expect(del).toHaveAttribute('aria-disabled', 'false');
  await del.click();
  await expect(del).toHaveAttribute('aria-disabled', 'true');
});

test('recortar: se dibuja la zona y se guarda como recorte de la página', async () => {
  await tool('Editar', 'Recortar');
  await dragOnPage(0.15, 200, 0.65, 520);
  const dialog = page.getByRole('dialog', { name: 'Recortar página' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('no se borra del archivo');
  await dialog.getByRole('button', { name: 'Recortar', exact: true }).click();
  await expect(dialog).toBeHidden();

  await page.keyboard.press('Control+s');
  await expect(page.getByText(/Guardado|guardó/i).first()).toBeVisible({ timeout: 10_000 });
  const saved = await PDFDocument.load(await readFile(pdfPath), { updateMetadata: false });
  const crop = saved.getPage(0).getCropBox();
  expect(crop.width).toBeLessThan(160); // la página medía 200
  expect(crop.height).toBeLessThan(250); // y 300
  expect(saved.getPage(1).getCropBox().width).toBeCloseTo(200, 0); // las demás no cambian
});

test('enlace: solo admite http/https/correo y queda como anotación Link en el archivo', async () => {
  await tool('Editar', 'Agregar enlace');
  await dragOnPage(0.2, 150, 0.7, 220);
  const dialog = page.getByRole('dialog', { name: 'Agregar enlace' });
  await expect(dialog).toBeVisible();

  await dialog.getByRole('textbox').fill('javascript:alert(1)');
  await dialog.getByRole('button', { name: 'Agregar enlace' }).click();
  await expect(dialog.getByRole('alert')).toContainText('no es válida');

  await dialog.getByRole('textbox').fill('ejemplo.com/ruta');
  await dialog.getByRole('button', { name: 'Agregar enlace' }).click();
  await expect(dialog).toBeHidden();

  await page.keyboard.press('Control+s');
  await expect
    .poll(async () =>
      (await readFile(pdfPath)).toString('latin1').includes('https://ejemplo.com/ruta'),
    )
    .toBe(true);
});

test('sellos: se eligen, se colocan y se pueden mover y redimensionar', async () => {
  await tool('Comentar', 'Sellos');
  const dialog = page.getByRole('dialog', { name: 'Sellos' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Aprobado' }).click();
  await expect(dialog).toBeHidden();

  const box = await page.locator('.pdf-page').first().boundingBox();
  await page.mouse.click(box!.x + box!.width * 0.5, box!.y + 420);
  const image = page.locator('svg image').first();
  await expect(image).toBeVisible();
  const before = await image.boundingBox();

  // Esquina inferior derecha: arrastrar la agranda conservando la proporción
  const handle = page.locator('[data-resize-handle="se"]');
  await expect(handle).toBeVisible();
  const h = await handle.boundingBox();
  await page.mouse.move(h!.x + h!.width / 2, h!.y + h!.height / 2);
  await page.mouse.down();
  await page.mouse.move(h!.x + h!.width / 2 + 60, h!.y + h!.height / 2 + 30, { steps: 6 });
  await page.mouse.up();
  const after = await image.boundingBox();
  expect(after!.width).toBeGreaterThan(before!.width + 20);
  expect(Math.abs(after!.width / after!.height - before!.width / before!.height)).toBeLessThan(
    0.05,
  );

  // Y se puede mover arrastrando la propia imagen
  await page.mouse.move(after!.x + after!.width / 2, after!.y + after!.height / 2);
  await page.mouse.down();
  await page.mouse.move(after!.x + after!.width / 2 - 80, after!.y + after!.height / 2, {
    steps: 6,
  });
  await page.mouse.up();
  const moved = await image.boundingBox();
  expect(moved!.x).toBeLessThan(after!.x - 40);
});

test('convertir a texto: pide opciones, respeta el rango y escribe el archivo', async () => {
  const target = join(dir, 'salida.txt');
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = (async () => ({
      canceled: false,
      filePath,
    })) as unknown as typeof dialog.showSaveDialog;
  }, target);

  await tool('Convertir', 'A texto (.txt)');
  const dialog = page.getByRole('dialog', { name: 'Convertir a texto (.txt)' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('Nombre del archivo')).toHaveValue('barra');
  // Solo la página 3
  await dialog.getByRole('combobox', { name: 'Páginas' }).selectOption('custom');
  await dialog.getByLabel('Rango personalizado').fill('3');
  await dialog.getByRole('button', { name: 'Convertir', exact: true }).click();

  await expect
    .poll(async () => readFile(target, 'utf8').catch(() => ''))
    .toContain('Tercera Foliux');
  const text = await readFile(target, 'utf8');
  expect(text).toContain('--- Página 3 ---');
  expect(text).not.toContain('Hola Foliux');
});

test('compartir: imprimir dibuja las páginas y enviar por correo abre un mensaje nuevo', async () => {
  // Se sustituye window.print para comprobar lo que se enviaría a la impresora
  await page.evaluate(() => {
    const w = window as unknown as { __printed?: number };
    window.print = () => {
      w.__printed = document.querySelectorAll('#foliux-print-root img').length;
    };
  });
  await tool('Compartir', 'Imprimir');
  await expect
    .poll(async () =>
      page.evaluate(() => (window as unknown as { __printed?: number }).__printed ?? 0),
    )
    .toBe(3);

  // El correo: solo se abre un mensaje nuevo (mailto) y se avisa de dónde está el archivo
  await app.evaluate(({ shell }) => {
    (globalThis as unknown as { __mailto?: string }).__mailto = '';
    shell.openExternal = (async (url: string) => {
      (globalThis as unknown as { __mailto?: string }).__mailto = url;
    }) as unknown as typeof shell.openExternal;
  });
  await tool('Compartir', 'Enviar por correo');
  await expect
    .poll(async () =>
      app.evaluate(() => (globalThis as unknown as { __mailto?: string }).__mailto ?? ''),
    )
    .toMatch(/^mailto:\?subject=barra\.pdf&body=/);
});
