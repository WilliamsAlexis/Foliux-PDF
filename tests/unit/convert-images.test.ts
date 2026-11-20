import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import ExcelJS from 'exceljs';
import { buildParagraphs, groupLines, type PageWord } from '@foliux-pdf/core';
import { buildDocx, buildTablesXlsx, buildXlsx } from '@foliux-pdf/services/node';

const PNG = new Uint8Array(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  ),
);

const word = (text: string, x: number, y: number): PageWord => ({
  text,
  x,
  y,
  width: text.length * 6,
  height: 10,
});

describe('Excel: páginas sin texto (imágenes o escaneos)', () => {
  it('una página sin texto ya no hace fallar la conversión y deja una nota', async () => {
    const bytes = await buildXlsx([
      { words: [word('Mes', 10, 10), word('Importe', 100, 10)], page: 1 },
      { words: [], page: 2 },
    ]);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(bytes as unknown as ArrayBuffer);
    expect(workbook.worksheets.map((s) => s.name)).toEqual(['Página 1', 'Página 2']);
    expect(String(workbook.worksheets[1]!.getRow(1).getCell(1).value)).toContain(
      'prueba antes con el OCR',
    );
  });

  it('un documento entero sin texto también se convierte', async () => {
    const bytes = await buildXlsx([{ words: [] }, { words: [] }, { words: [] }]);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(bytes as unknown as ArrayBuffer);
    expect(workbook.worksheets).toHaveLength(3);
  });

  it('las tablas de la IA sin filas ni cabeceras tampoco fallan', async () => {
    const bytes = await buildTablesXlsx([{ title: 'Vacía', page: 1, headers: [], rows: [] }]);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(bytes as unknown as ArrayBuffer);
    expect(workbook.worksheets).toHaveLength(1);
  });
});

describe('Word: imágenes y tamaño de página', () => {
  it('los párrafos conocen su posición vertical', () => {
    const paragraphs = buildParagraphs(groupLines([word('Uno', 10, 20), word('Dos', 10, 200)]));
    expect(paragraphs.map((p) => Math.round(p.y))).toEqual([20, 200]);
  });

  it('inserta las imágenes en su sitio (entre los párrafos) y conserva el tamaño de página', async () => {
    const bytes = await buildDocx([
      {
        width: 400,
        height: 300,
        words: [word('Arriba', 10, 10), word('Abajo', 10, 250)],
        images: [{ x: 100, y: 100, width: 120, height: 80, data: PNG }],
      },
      { width: 400, height: 300, words: [word('Segunda', 10, 10)] },
    ]);
    const zip = await JSZip.loadAsync(bytes);
    const media = Object.keys(zip.files).filter((n) => /^word\/media\/.+\.png$/.test(n));
    expect(media).toHaveLength(1);

    const xml = await zip.file('word/document.xml')!.async('string');
    // Orden: texto de arriba, imagen, texto de abajo
    const top = xml.indexOf('Arriba');
    const image = xml.indexOf('<w:drawing');
    const bottom = xml.indexOf('Abajo');
    expect(top).toBeGreaterThan(-1);
    expect(image).toBeGreaterThan(top);
    expect(bottom).toBeGreaterThan(image);
    // Una sección por página, con el tamaño del PDF (400×300 pt = 8000×6000 twips)
    expect((xml.match(/<w:sectPr/g) ?? []).length).toBe(2);
    expect(xml).toContain('w:w="8000"');
    expect(xml).toContain('w:h="6000"');
  });

  it('una imagen más ancha que la página se reduce para caber', async () => {
    const bytes = await buildDocx([
      {
        width: 300,
        height: 400,
        words: [],
        images: [{ x: 0, y: 0, width: 1000, height: 500, data: PNG }],
      },
    ]);
    const xml = await (await JSZip.loadAsync(bytes)).file('word/document.xml')!.async('string');
    const cx = Number(/<wp:extent cx="(\d+)"/.exec(xml)?.[1]);
    // Cabe en el ancho útil (300 − 72 pt de márgenes = 228 pt ≈ 2 895 600 EMU)
    expect(cx).toBeGreaterThan(0);
    expect(cx).toBeLessThanOrEqual(228 * 12700 + 5000);
  });

  it('sin imágenes funciona como antes y un documento vacío no falla', async () => {
    const bytes = await buildDocx([{ words: [word('Hola', 10, 10)] }, { words: [] }]);
    const zip = await JSZip.loadAsync(bytes);
    expect(Object.keys(zip.files).some((n) => n.startsWith('word/media/'))).toBe(false);
    const empty = await buildDocx([]);
    expect(empty.length).toBeGreaterThan(100);
  });
});
