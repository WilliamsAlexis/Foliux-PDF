import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';

test('OCR real dentro de Electron', async () => {
  test.setTimeout(240_000);
  const dir = await mkdtemp(join(tmpdir(), 'foliux-ocr-'));
  const env = { ...process.env, FOLIUX_USER_DATA: dir } as Record<string, string>;
  delete env['ELECTRON_RUN_AS_NODE'];

  // 1) Un «escaneo»: texto dibujado como imagen (se genera con un canvas de la propia app)
  const seed = join(dir, 'semilla.pdf');
  const s = await PDFDocument.create();
  s.addPage([300, 200]);
  await writeFile(seed, await s.save());
  let app = await electron.launch({ args: [resolve('apps/desktop'), seed], env });
  let page = await app.firstWindow();
  await page.waitForSelector('#root > *');
  const dataUrl = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 1200;
    canvas.height = 500;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, 1200, 500);
    ctx.fillStyle = '#000';
    ctx.font = '90px Arial';
    ctx.fillText('FACTURA 2026', 80, 180);
    ctx.fillText('Total pagado', 80, 330);
    return canvas.toDataURL('image/png');
  });
  await app.evaluate(({ app: a }) => a.exit(0)).catch(() => undefined);

  const scan = await PDFDocument.create();
  const png = await scan.embedPng(Buffer.from(dataUrl.split(',')[1]!, 'base64'));
  const sp = scan.addPage([600, 250]);
  sp.drawImage(png, { x: 0, y: 0, width: 600, height: 250 });
  const scanPath = join(dir, 'escaneo.pdf');
  await writeFile(scanPath, await scan.save());

  // 2) Se abre y se le aplica el OCR desde la interfaz
  app = await electron.launch({ args: [resolve('apps/desktop'), scanPath], env });
  page = await app.firstWindow();
  await page.waitForSelector('#root > *');
  await expect(page.locator('.pdf-page canvas').first()).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('.pdf-page .textLayer').first()).not.toContainText('FACTURA');

  const logs: string[] = [];
  page.on('console', (m) => logs.push(m.text()));
  await page.keyboard.press('Control+k');
  await page.getByPlaceholder(/Escribe un comando/).fill('OCR');
  await page.keyboard.press('Enter');
  await page
    .getByRole('dialog', { name: /Reconocer texto/ })
    .getByRole('button', { name: 'Empezar' })
    .click();

  await expect(page.locator('.pdf-page .textLayer').first()).toContainText('FACTURA', {
    timeout: 200_000,
  });
  await expect(page.locator('.pdf-page .textLayer').first()).toContainText('2026');
  console.log('OCR OK; consola:', logs.slice(-5).join(' | '));
  await page.screenshot({ path: 'test-results/30-ocr.png' });
  await app.evaluate(({ app: a }) => a.exit(0)).catch(() => undefined);
});
