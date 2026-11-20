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
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { PDFDocument, StandardFonts } from 'pdf-lib';

/**
 * Convertir a Word y a Excel con imágenes de por medio:
 *  - Word conserva las imágenes (salvo un escaneo que ocupa toda la página).
 *  - Excel ya no falla con páginas que no tienen texto.
 */
test.describe.configure({ mode: 'serial' });

const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

let app: ElectronApplication;
let page: Page;
let dir: string;

/** Página 1: texto y una imagen; página 2: solo una imagen; página 3: una imagen que ocupa toda la página. */
async function buildPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const png = await doc.embedPng(Buffer.from(PNG_BASE64, 'base64'));
  const first = doc.addPage([400, 300]);
  first.drawText('Informe de ventas', { x: 30, y: 260, size: 18, font });
  first.drawImage(png, { x: 30, y: 120, width: 120, height: 80 });
  first.drawText('Fin de la pagina', { x: 30, y: 40, size: 12, font });
  const second = doc.addPage([400, 300]);
  second.drawImage(png, { x: 100, y: 100, width: 150, height: 100 });
  const third = doc.addPage([400, 300]);
  third.drawImage(png, { x: 0, y: 0, width: 400, height: 300 });
  return doc.save({ useObjectStreams: false });
}

async function convertTo(tool: string, dialogTitle: string, target: string) {
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = (async () => ({
      canceled: false,
      filePath,
    })) as unknown as typeof dialog.showSaveDialog;
  }, target);
  const tab = page.getByRole('button', { name: 'Convertir', exact: true });
  if ((await tab.getAttribute('aria-expanded')) !== 'true') await tab.click();
  await page
    .getByRole('toolbar', { name: 'Convertir', exact: true })
    .getByRole('button', { name: tool, exact: true })
    .click();
  const dialog = page.getByRole('dialog', { name: dialogTitle });
  await expect(dialog).toBeVisible();
  return dialog;
}

test.beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'foliux-office-'));
  const pdf = join(dir, 'imagenes.pdf');
  await writeFile(pdf, await buildPdf());
  const env = { ...process.env, FOLIUX_USER_DATA: dir } as Record<string, string>;
  delete env['ELECTRON_RUN_AS_NODE'];
  app = await electron.launch({ args: [resolve('apps/desktop'), pdf], env });
  page = await app.firstWindow();
  await page.waitForSelector('#root > *');
  await expect(page.locator('.pdf-page .textLayer').first()).toContainText('Informe de ventas', {
    timeout: 15_000,
  });
});

test.afterAll(async () => {
  await app?.evaluate(({ app: a }) => a.exit(0)).catch(() => undefined);
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }).catch(
    () => undefined,
  );
});

test('Excel: un PDF con páginas sin texto ya no da error', async () => {
  const target = join(dir, 'salida.xlsx');
  const dialog = await convertTo('A Excel', 'Convertir a Excel (.xlsx)', target);
  await dialog.getByRole('button', { name: 'Convertir', exact: true }).click();
  await expect(page.getByText(/Se creó «salida\.xlsx»/)).toBeVisible({ timeout: 20_000 });

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load((await readFile(target)) as unknown as ArrayBuffer);
  expect(workbook.worksheets.map((s) => s.name)).toEqual(['Página 1', 'Página 2', 'Página 3']);
  expect(String(workbook.worksheets[0]!.getRow(1).getCell(1).value)).toContain('Informe');
  expect(String(workbook.worksheets[1]!.getRow(1).getCell(1).value)).toContain('OCR');
});

test('Word: conserva las imágenes, en su sitio, salvo la que ocupa toda la página', async () => {
  const target = join(dir, 'salida.docx');
  const dialog = await convertTo('A Word', 'Convertir a Word (.docx)', target);
  await expect(dialog.getByLabel(/Incluir las imágenes del documento/)).toBeChecked();
  await dialog.getByRole('button', { name: 'Convertir', exact: true }).click();
  await expect(page.getByText(/Se creó «salida\.docx»/)).toBeVisible({ timeout: 30_000 });

  const zip = await JSZip.loadAsync(await readFile(target));
  const media = Object.keys(zip.files).filter((n) => /^word\/media\/.+\.png$/.test(n));
  // Dos imágenes (páginas 1 y 2); el escaneo a toda página (3) no se incluye
  expect(media).toHaveLength(2);
  const xml = await zip.file('word/document.xml')!.async('string');
  const title = xml.indexOf('Informe de ventas');
  const image = xml.indexOf('<w:drawing');
  const end = xml.indexOf('Fin de la pagina');
  expect(title).toBeGreaterThan(-1);
  expect(image).toBeGreaterThan(title);
  expect(end).toBeGreaterThan(image);
  expect((xml.match(/<w:sectPr/g) ?? []).length).toBe(3);
});

test('Word: sin la casilla de imágenes solo lleva el texto', async () => {
  const target = join(dir, 'solo-texto.docx');
  const dialog = await convertTo('A Word', 'Convertir a Word (.docx)', target);
  await dialog.getByLabel(/Incluir las imágenes del documento/).uncheck();
  await dialog.getByRole('button', { name: 'Convertir', exact: true }).click();
  await expect(page.getByText(/Se creó «solo-texto\.docx»/)).toBeVisible({ timeout: 30_000 });
  const zip = await JSZip.loadAsync(await readFile(target));
  expect(Object.keys(zip.files).some((n) => n.startsWith('word/media/'))).toBe(false);
});
