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
 * Fase 2 de extremo a extremo: anotaciones, páginas, guardado y reapertura sobre la app real.
 * Las pruebas comparten la aplicación y van en orden (cada una parte de lo que dejó la anterior).
 */
test.describe.configure({ mode: 'serial' });

let app: ElectronApplication;
let page: Page;
let dir: string;
let pdfPath: string;

const ANNOTATIONS_TAB = 'Anotaciones';

async function openSidebarTab(name: string) {
  await page.getByRole('tab', { name, exact: true }).click();
}

test.beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'foliux-e2e2-'));
  pdfPath = join(dir, 'editable.pdf');
  await writeFile(pdfPath, buildPdf(['Hola Foliux', 'Segunda pagina', 'Tercera pagina']));

  const env = { ...process.env, FOLIUX_USER_DATA: dir } as Record<string, string>;
  delete env['ELECTRON_RUN_AS_NODE'];
  app = await electron.launch({ args: [resolve('apps/desktop'), pdfPath], env });
  page = await app.firstWindow();
  await page.waitForSelector('#root > *');
  await expect(page.locator('.pdf-page .textLayer').first()).toContainText('Hola Foliux', {
    timeout: 15_000,
  });
});

test.afterAll(async () => {
  // Con cambios sin guardar, cerrar la ventana abre el aviso modal (comportamiento deseado): se sale a la fuerza.
  await app?.evaluate(({ app: electronApp }) => electronApp.exit(0)).catch(() => undefined);
  // (exit termina el proceso de golpe, por eso se ignora el error de conexión cerrada)
  // Windows tarda un instante en soltar los archivos de Chromium tras terminar el proceso.
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }).catch(
    () => undefined,
  );
});

test('seleccionar texto muestra la barra y resalta; aparece en la lista y marca cambios', async () => {
  const span = page.locator('.pdf-page .textLayer span').first();
  // Se espera a que el zoom «ajustar al ancho» se asiente y la capa de texto se redibuje a su tamaño final
  // (a 364 % la frase mide cientos de píxeles; recién abierto, el texto aún es pequeño).
  await expect.poll(async () => (await span.boundingBox())?.width ?? 0).toBeGreaterThan(300);
  // A este zoom el texto queda fuera de la ventana: se lleva a la vista antes de arrastrar el ratón.
  await span.scrollIntoViewIfNeeded();
  const box = await span.boundingBox();
  expect(box).not.toBeNull();
  const y = box!.y + box!.height / 2;
  await page.mouse.move(box!.x + 1, y);
  await page.mouse.down();
  await page.mouse.move(box!.x + box!.width - 1, y, { steps: 6 });
  await page.mouse.up();

  const bar = page.getByRole('toolbar', { name: 'Marcar el texto seleccionado' });
  await expect(bar).toBeVisible();
  await bar.getByRole('button', { name: 'Resaltar' }).click();

  // El resaltado debe cubrir el texto seleccionado (misma posición y anchura, con holgura de redondeo).
  const highlight = await page.locator('svg.mix-blend-multiply rect').first().boundingBox();
  const spanAfter = await span.boundingBox();
  expect(highlight).not.toBeNull();
  expect(Math.abs(highlight!.x - spanAfter!.x)).toBeLessThan(6);
  expect(Math.abs(highlight!.width - spanAfter!.width)).toBeLessThan(spanAfter!.width * 0.1);

  await openSidebarTab(ANNOTATIONS_TAB);
  await expect(page.getByRole('button', { name: /^Resaltar pág\. 1/ })).toBeVisible();
  await expect(page.getByRole('img', { name: 'Cambios sin guardar' })).toBeVisible();
  await page.screenshot({ path: 'test-results/10-resaltado.png' });
});

test('dibujar un rectángulo con la herramienta y moverlo', async () => {
  await page.getByRole('button', { name: 'Rectángulo' }).click();
  const pageBox = await page.locator('.pdf-page').first().boundingBox();
  expect(pageBox).not.toBeNull();
  // Posiciones cerca del inicio de la página: la página entera es más alta que la ventana.
  const x = pageBox!.x + pageBox!.width * 0.2;
  const y = pageBox!.y + 220;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 120, y + 70, { steps: 8 });
  await page.mouse.up();

  await expect(page.getByRole('button', { name: /^Rectángulo pág\. 1/ })).toBeVisible();

  // Esc vuelve a la herramienta de selección; Ctrl+Z / Ctrl+Shift+Z deshacen y rehacen.
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+z');
  await expect(page.getByRole('button', { name: /^Rectángulo pág\. 1/ })).toHaveCount(0);
  await page.keyboard.press('Control+Shift+z');
  await expect(page.getByRole('button', { name: /^Rectángulo pág\. 1/ })).toBeVisible();
});

test('un cuadro de texto se escribe y se guarda su contenido', async () => {
  await page.getByRole('button', { name: 'Cuadro de texto' }).click();
  const pageBox = await page.locator('.pdf-page').first().boundingBox();
  await page.mouse.click(pageBox!.x + pageBox!.width * 0.3, pageBox!.y + 360);
  const editor = page.getByRole('textbox', { name: 'Texto del cuadro' });
  await expect(editor).toBeFocused();
  await editor.fill('Revisar canción ñ');
  await editor.press('Control+Enter');
  await expect(page.getByText('Revisar canción ñ').first()).toBeVisible();
});

test('guardar escribe anotaciones PDF estándar y limpia el aviso de cambios', async () => {
  await page.keyboard.press('Control+s');
  await expect(page.getByRole('img', { name: 'Cambios sin guardar' })).toHaveCount(0, {
    timeout: 10_000,
  });

  const bytes = await readFile(pdfPath);
  const text = bytes.toString('latin1');
  expect(text).toContain('/Subtype /Highlight');
  expect(text).toContain('/Subtype /Square');
  expect(text).toContain('/Subtype /FreeText');
  const doc = await PDFDocument.load(bytes);
  expect(doc.getPageCount()).toBe(3);
  expect(doc.getPage(0).node.Annots()?.size()).toBe(3);
});

test('girar una página se guarda en el archivo y las anotaciones la siguen', async () => {
  await openSidebarTab('Miniaturas');
  await page.getByRole('button', { name: 'Página 1' }).click();
  await page.getByRole('button', { name: 'Girar a la derecha' }).click();
  await expect(page.getByRole('img', { name: 'Cambios sin guardar' })).toBeVisible({
    timeout: 10_000,
  });

  await page.keyboard.press('Control+s');
  await expect(page.getByRole('img', { name: 'Cambios sin guardar' })).toHaveCount(0, {
    timeout: 10_000,
  });

  const doc = await PDFDocument.load(await readFile(pdfPath));
  expect(doc.getPage(0).getRotation().angle).toBe(90);
  expect(doc.getPage(0).node.Annots()?.size()).toBe(3);
  await page.screenshot({ path: 'test-results/11-girada.png' });
});

test('eliminar una página y deshacerlo', async () => {
  await page.getByRole('button', { name: 'Página 3' }).click();
  await page.getByRole('button', { name: 'Eliminar página' }).click();
  await expect(page.getByText('de 2')).toBeVisible({ timeout: 10_000 });

  await page.keyboard.press('Control+z');
  await expect(page.getByText('de 3')).toBeVisible({ timeout: 10_000 });
});

test('insertar una página en blanco y reordenar arrastrando', async () => {
  await page.getByRole('button', { name: 'Página 1' }).click();
  await page.getByRole('button', { name: 'Insertar página en blanco' }).click();
  await expect(page.getByText('de 4')).toBeVisible({ timeout: 10_000 });

  // Arrastrar la miniatura 2 (la nueva, en blanco) al final. Chromium no inicia arrastres HTML5 con
  // el ratón simulado, así que se envían los eventos de arrastre directamente a las miniaturas.
  await page.evaluate(() => {
    const thumbs = Array.from(document.querySelectorAll<HTMLElement>('button[draggable="true"]'));
    const source = thumbs[1]!;
    const target = thumbs[thumbs.length - 1]!;
    const transfer = new DataTransfer();
    const fire = (element: HTMLElement, type: string, clientY = 0) =>
      element.dispatchEvent(
        new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer, clientY }),
      );
    const box = target.getBoundingClientRect();
    fire(source, 'dragstart');
    fire(target, 'dragover', box.bottom - 4); // mitad inferior = detrás de la última
    fire(target, 'drop', box.bottom - 4);
    fire(source, 'dragend');
  });
  await expect(page.getByText('de 4')).toBeVisible();
  // Con la página en blanco al final, la 2 vuelve a ser «Segunda pagina».
  await expect(page.locator('.pdf-page[data-page-number="2"] .textLayer')).toContainText(
    'Segunda',
    { timeout: 10_000 },
  );
});

test('cerrar con cambios pregunta; «No guardar» descarta y reabrir recupera las anotaciones editables', async () => {
  await page.getByRole('tab', { name: /editable\.pdf/ }).click();
  await page.getByRole('button', { name: 'Cerrar editable.pdf' }).click();
  const dialog = page.getByRole('dialog', { name: 'Cambios sin guardar' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'No guardar' }).click();
  await expect(page.getByRole('tab', { name: /editable\.pdf/ })).toHaveCount(0);

  // Reabre el archivo (tal como se guardó: 3 páginas, la 1 girada, 3 anotaciones editables).
  await app.evaluate(({ BrowserWindow }, path) => {
    BrowserWindow.getAllWindows()[0]!.webContents.send('event:open-files', [path]);
  }, pdfPath);
  await expect(page.getByRole('tab', { name: /editable\.pdf/ })).toBeVisible();
  await expect(page.getByText('de 3')).toBeVisible({ timeout: 10_000 });

  await openSidebarTab(ANNOTATIONS_TAB);
  await expect(page.getByRole('button', { name: /^Resaltar pág\. 1/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Rectángulo pág\. 1/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Cuadro de texto pág\. 1/ })).toBeVisible();
  // Recién abierto no hay cambios pendientes.
  await expect(page.getByRole('img', { name: 'Cambios sin guardar' })).toHaveCount(0);
  await page.screenshot({ path: 'test-results/12-reabierto.png' });
});
