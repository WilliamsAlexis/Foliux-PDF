import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { PDFDocument, StandardFonts } from 'pdf-lib';

/**
 * Fase 3 de extremo a extremo: añadir y reemplazar texto e imágenes, marcas de agua, encabezados,
 * dividir y optimizar. Los diálogos nativos de archivos no se pueden manejar desde Playwright,
 * así que se sustituyen en el proceso principal por respuestas fijas.
 */
test.describe.configure({ mode: 'serial' });

const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

let app: ElectronApplication;
let page: Page;
let dir: string;
let pdfPath: string;
let imagePath: string;

/** PDF de prueba: página 1 con texto; página 2 con una imagen en (30,100) de 80×60. */
async function buildTestPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const first = doc.addPage([200, 300]);
  first.drawText('Hola Foliux', { x: 20, y: 150, size: 24, font });
  const second = doc.addPage([200, 300]);
  second.drawText('Segunda', { x: 20, y: 250, size: 18, font });
  const png = await doc.embedPng(Buffer.from(PNG_BASE64, 'base64'));
  second.drawImage(png, { x: 30, y: 140, width: 80, height: 60 }); // arriba-izq. de la vista: (30, 100)
  return doc.save({ useObjectStreams: false });
}

/** Sustituye un diálogo nativo del proceso principal por una respuesta fija. */
async function mockDialog(
  kind: 'open' | 'save',
  result: { canceled: boolean; filePaths?: string[]; filePath?: string },
) {
  await app.evaluate(
    ({ dialog }, { kind: k, result: r }) => {
      const answer = async () => r;
      if (k === 'open') dialog.showOpenDialog = answer as unknown as typeof dialog.showOpenDialog;
      else dialog.showSaveDialog = answer as unknown as typeof dialog.showSaveDialog;
    },
    { kind, result },
  );
}

const sidebarTab = (name: string) => page.getByRole('tab', { name, exact: true }).click();
const pageText = (n: number) => page.locator(`.pdf-page[data-page-number="${n}"] .textLayer`);

async function goToPage(n: number) {
  const input = page.getByRole('textbox', { name: 'Número de página' });
  await input.fill(String(n));
  await input.press('Enter');
}

test.beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'foliux-e2e3-'));
  pdfPath = join(dir, 'edicion.pdf');
  imagePath = join(dir, 'logo.png');
  await writeFile(pdfPath, await buildTestPdf());
  await writeFile(imagePath, Buffer.from(PNG_BASE64, 'base64'));

  const env = { ...process.env, FOLIUX_USER_DATA: dir } as Record<string, string>;
  delete env['ELECTRON_RUN_AS_NODE'];
  app = await electron.launch({ args: [resolve('apps/desktop'), pdfPath], env });
  page = await app.firstWindow();
  await page.waitForSelector('#root > *');
  await expect(pageText(1)).toContainText('Hola Foliux', { timeout: 15_000 });
});

test.afterAll(async () => {
  await app?.evaluate(({ app: electronApp }) => electronApp.exit(0)).catch(() => undefined);
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }).catch(
    () => undefined,
  );
});

test('añadir texto: se escribe, queda pendiente y «Aplicar cambios» lo incorpora a la página', async () => {
  await page.getByRole('button', { name: 'Añadir texto', exact: true }).click();
  const box = await page.locator('.pdf-page').first().boundingBox();
  await page.mouse.click(box!.x + box!.width * 0.25, box!.y + 220);

  const editor = page.getByRole('textbox', { name: 'Texto del cuadro' });
  await expect(editor).toBeFocused();
  await editor.fill('Texto añadido');
  await editor.press('Control+Enter');

  // Pendiente: aparece en la lista de anotaciones, pero aún no forma parte del texto de la página.
  await sidebarTab('Anotaciones');
  await expect(page.getByRole('button', { name: /^Añadir texto pág\. 1/ })).toBeVisible();

  await sidebarTab('Herramientas');
  await page.getByRole('button', { name: /Aplicar cambios/ }).click();
  await expect(pageText(1)).toContainText('Texto añadido', { timeout: 10_000 });

  await sidebarTab('Anotaciones');
  await expect(page.getByText('aún no tiene anotaciones')).toBeVisible();
});

test('deshacer devuelve el texto a pendiente y rehacer lo vuelve a aplicar', async () => {
  await page.keyboard.press('Control+z');
  await expect(pageText(1)).not.toContainText('Texto añadido', { timeout: 10_000 });
  await expect(page.getByRole('button', { name: /^Añadir texto pág\. 1/ })).toBeVisible();
  await page.keyboard.press('Control+Shift+z');
  await expect(pageText(1)).toContainText('Texto añadido', { timeout: 10_000 });
});

test('editar texto existente: se reescribe y el original queda tapado (no borrado)', async () => {
  await goToPage(1);
  await page.getByRole('button', { name: 'Editar texto existente' }).click();
  const span = pageText(1).locator('span', { hasText: 'Hola Foliux' }).first();
  await span.scrollIntoViewIfNeeded();
  await span.click();

  const editor = page.getByRole('textbox', { name: 'Texto del cuadro' });
  await expect(editor).toBeFocused();
  await expect(editor).toHaveValue('Hola Foliux');
  await editor.fill('Adios Foliux');
  await editor.press('Control+Enter');

  await sidebarTab('Herramientas');
  await page.getByRole('button', { name: /Aplicar cambios/ }).click();
  await expect(pageText(1)).toContainText('Adios Foliux', { timeout: 10_000 });

  await page.keyboard.press('Control+s');
  await expect(page.getByRole('img', { name: 'Cambios sin guardar' })).toHaveCount(0, {
    timeout: 10_000,
  });
  const raw = (await readFile(pdfPath)).toString('latin1');
  expect(raw).toContain('(Adios Foliux)'); // el texto nuevo está en la página…
  // …y el original sigue siendo extraíble por cualquier lector (solo está tapado): limitación documentada.
  await expect(pageText(1)).toContainText('Hola Foliux');
  await page.screenshot({ path: 'test-results/20-texto-editado.png' });
});

test('marca de agua de texto en todas las páginas', async () => {
  await sidebarTab('Herramientas');
  await page.getByRole('button', { name: /^Marca de agua/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Marca de agua' });
  await dialog.getByRole('textbox').first().fill('BORRADOR');
  await dialog.getByRole('button', { name: 'Aplicar marca de agua' }).click();
  await expect(dialog).toHaveCount(0, { timeout: 10_000 });
  await expect(pageText(1)).toContainText('BORRADOR', { timeout: 10_000 });
  await goToPage(2);
  await expect(pageText(2)).toContainText('BORRADOR', { timeout: 10_000 });
});

test('encabezado y pie: numeración «Página 2 de 2»', async () => {
  await sidebarTab('Herramientas');
  await page.getByRole('button', { name: /^Encabezado y pie/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Encabezado, pie y numeración' });
  // El pie centrado ya viene con «Página {page} de {pages}».
  await dialog.getByRole('button', { name: 'Aplicar', exact: true }).click();
  await expect(dialog).toHaveCount(0, { timeout: 10_000 });
  await expect(pageText(2)).toContainText('Página 2 de 2', { timeout: 10_000 });
  await page.screenshot({ path: 'test-results/21-pie-y-marca.png' });
});

test('un rango de páginas no válido se avisa en el propio diálogo', async () => {
  await sidebarTab('Herramientas');
  await page.getByRole('button', { name: /^Marca de agua/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Marca de agua' });
  await dialog.getByRole('combobox', { name: 'Páginas' }).selectOption('custom');
  await dialog.getByRole('textbox', { name: 'Rango personalizado' }).fill('9-12');
  await dialog.getByRole('button', { name: 'Aplicar marca de agua' }).click();
  await expect(dialog.getByRole('alert')).toContainText('fuera del documento');
  await dialog.getByRole('button', { name: 'Cancelar' }).click();
});

test('reemplazar una imagen existente con la herramienta de imagen', async () => {
  const imagesIn = async () =>
    (await readFile(pdfPath)).toString('latin1').match(/\/Subtype \/Image/g)?.length ?? 0;
  const before = await imagesIn();

  await goToPage(2);
  await mockDialog('open', { canceled: false, filePaths: [imagePath] });
  await page.getByRole('button', { name: 'Añadir o reemplazar imagen' }).click();

  // La imagen que ya hay en la página se marca para poder reemplazarla.
  const marked = pageText(2)
    .locator('xpath=ancestor::div[contains(@class,"pdf-page")]')
    .locator('[data-image-rect]');
  await expect(marked).toHaveCount(1, { timeout: 10_000 });
  await marked.scrollIntoViewIfNeeded();
  const rect = await marked.boundingBox();
  await page.mouse.click(rect!.x + rect!.width / 2, rect!.y + rect!.height / 2);

  await sidebarTab('Anotaciones');
  await expect(
    page.getByRole('button', { name: /^Añadir o reemplazar imagen pág. 2/ }),
  ).toBeVisible();

  await page.keyboard.press('Control+s');
  await expect(page.getByRole('img', { name: 'Cambios sin guardar' })).toHaveCount(0, {
    timeout: 10_000,
  });
  expect(await imagesIn()).toBeGreaterThan(before);
  await page.screenshot({ path: 'test-results/22-imagen-reemplazada.png' });
});

test('dividir en un archivo por página', async () => {
  const out = join(dir, 'partes');
  await mkdir(out);
  await mockDialog('open', { canceled: false, filePaths: [out] });

  await sidebarTab('Herramientas');
  await page.getByRole('button', { name: /^Dividir/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Dividir el documento' });
  await dialog.getByRole('radio', { name: 'Un archivo por página' }).check();
  await expect(dialog.getByText('Se crearán 2 archivo(s).')).toBeVisible();
  await dialog.getByRole('button', { name: 'Dividir…' }).click();
  await expect(dialog).toHaveCount(0, { timeout: 15_000 });

  const files = (await readdir(out)).sort();
  expect(files).toEqual(['edicion - parte 1.pdf', 'edicion - parte 2.pdf']);
  expect((await PDFDocument.load(await readFile(join(out, files[0]!)))).getPageCount()).toBe(1);
});

test('optimizar guarda una copia válida y avisa del resultado', async () => {
  const copy = join(dir, 'copia.pdf');
  await mockDialog('save', { canceled: false, filePath: copy });
  await sidebarTab('Herramientas');
  await page.getByRole('button', { name: /^Optimizar/ }).click();
  await expect(page.getByText(/Se guardó «copia\.pdf»/)).toBeVisible({ timeout: 15_000 });
  expect((await PDFDocument.load(await readFile(copy))).getPageCount()).toBe(2);
});
