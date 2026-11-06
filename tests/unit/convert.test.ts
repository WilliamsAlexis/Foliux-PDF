import { describe, expect, it } from 'vitest';
import * as pdfjsLegacy from 'pdfjs-dist/legacy/build/pdf.mjs';
import type * as PdfJs from 'pdfjs-dist';
import JSZip from 'jszip';
import ExcelJS from 'exceljs';
import { PDFDocument } from 'pdf-lib';
import type { PageWord } from '@foliux-pdf/core';
import {
  buildDocx,
  buildPptx,
  buildXlsx,
  convertOfficeToPdf,
  convertToPdfA,
  imagesToPdf,
  transformPdf,
} from '@foliux-pdf/services/node';
import { createPdfJsEngine } from '@foliux-pdf/services/pdf';
import { buildPdf, everything } from './helpers';

const engine = createPdfJsEngine({ pdfjs: pdfjsLegacy as unknown as typeof PdfJs });
const noExternal = () => Promise.reject(new Error('no se esperaba leer otro archivo'));

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const word = (text: string, x: number, y: number, height = 8): PageWord => ({
  text,
  x,
  y,
  width: text.length * height * 0.55,
  height,
});

async function pageText(data: Uint8Array, page = 1): Promise<string> {
  const task = pdfjsLegacy.getDocument({ data: data.slice(), useSystemFonts: true });
  const content = await (await (await task.promise).getPage(page)).getTextContent();
  await task.destroy();
  return content.items.map((i) => ('str' in i ? i.str : '')).join(' ');
}

describe('OCR: texto invisible sobre la página', () => {
  const words = [
    { text: 'Hola', x: 20, y: 30, width: 40, height: 12 },
    { text: 'escaneado', x: 70, y: 30, width: 70, height: 12 },
  ];

  it('el documento pasa a ser buscable sin cambiar lo que se ve', async () => {
    const original = buildPdf(['Fondo']);
    const result = await transformPdf(
      original,
      [],
      { type: 'ocrText', pages: [{ page: 1, words }] },
      noExternal,
    );
    const text = await pageText(result.data);
    expect(text).toContain('Hola');
    expect(text).toContain('escaneado');
    expect(text).toContain('Fondo'); // el contenido original sigue

    // Las palabras quedan donde las puso el OCR (en la vista), con el ancho pedido
    const document = await engine.load(result.data);
    const found = await document.getWords(1);
    const hola = found.find((w) => w.text === 'Hola')!;
    expect(hola.x).toBeCloseTo(20, 0);
    expect(hola.width).toBeCloseTo(40, 0);
    await document.destroy();
  });

  it('el texto es invisible (modo de dibujo 3)', async () => {
    const result = await transformPdf(
      buildPdf(['A']),
      [],
      { type: 'ocrText', pages: [{ page: 1, words }] },
      noExternal,
    );
    expect(await everything(result.data)).toContain('3 Tr');
  });

  it('funciona en páginas giradas', async () => {
    const rotated = await transformPdf(
      buildPdf(['A']),
      [],
      { type: 'rotate', pages: [1], degrees: 90 },
      noExternal,
    );
    const result = await transformPdf(
      rotated.data,
      [],
      { type: 'ocrText', pages: [{ page: 1, words }] },
      noExternal,
    );
    const document = await engine.load(result.data);
    // «Hola» queda pegada al «A» del texto original; «escaneado» se ve suelta.
    const word = (await document.getWords(1)).find((w) => w.text === 'escaneado')!;
    expect(word.x).toBeCloseTo(70, 0);
    expect(word.width).toBeCloseTo(70, 0);
    expect(Math.abs(word.y - 31.5)).toBeLessThan(2);
    await document.destroy();
  });

  it('rechaza una página inexistente', async () => {
    await expect(
      transformPdf(
        buildPdf(['A']),
        [],
        { type: 'ocrText', pages: [{ page: 5, words }] },
        noExternal,
      ),
    ).rejects.toThrow(/no existe/);
  });
});

describe('PDF → Word, Excel y PowerPoint', () => {
  it('Word: párrafos, títulos y un salto de página entre páginas', async () => {
    const docx = await buildDocx([
      { words: [word('Título', 10, 10, 16), word('Primer', 10, 40), word('párrafo', 50, 40)] },
      { words: [word('Segunda', 10, 10), word('página', 60, 10)] },
    ]);
    const zip = await JSZip.loadAsync(docx);
    const xml = await zip.file('word/document.xml')!.async('string');
    expect(xml).toContain('Título');
    expect(xml).toContain('Primer párrafo');
    expect(xml).toContain('Segunda página');
    expect(xml).toContain('w:br w:type="page"');
    expect(xml).toMatch(/Heading2/); // el título es un encabezado
  });

  it('Excel: una hoja por página con la tabla reconstruida y los números como números', async () => {
    const xlsx = await buildXlsx([
      {
        words: [
          word('Producto', 10, 10),
          word('Precio', 150, 10),
          word('Lápiz', 10, 25),
          word('0,50', 150, 25),
          word('Libro', 10, 40),
          word('12', 150, 40),
          word('007', 10, 55),
          word('x', 150, 55),
        ],
      },
      { words: [word('Texto', 10, 10), word('suelto', 60, 10)] },
    ]);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(xlsx as unknown as ArrayBuffer);
    expect(workbook.worksheets.map((s) => s.name)).toEqual(['Página 1', 'Página 2']);
    const sheet = workbook.getWorksheet('Página 1')!;
    expect(sheet.getRow(1).values).toEqual([undefined, 'Producto', 'Precio']);
    expect(sheet.getRow(2).values).toEqual([undefined, 'Lápiz', 0.5]); // «0,50» → número
    expect(sheet.getRow(3).getCell(2).value).toBe(12);
    expect(sheet.getRow(4).getCell(1).value).toBe('007'); // los ceros a la izquierda se respetan
  });

  it('PowerPoint: una diapositiva por página con su imagen y el texto en las notas', async () => {
    const pptx = await buildPptx([
      { image: new Uint8Array(PNG), width: 600, height: 800, notes: 'Notas de la uno' },
      { image: new Uint8Array(PNG), width: 600, height: 800, notes: '' },
    ]);
    const zip = await JSZip.loadAsync(pptx);
    const slides = Object.keys(zip.files).filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f));
    expect(slides).toHaveLength(2);
    expect(Object.keys(zip.files).some((f) => f.startsWith('ppt/media/'))).toBe(true);
    const notes = Object.keys(zip.files).find((f) => /notesSlide\d+\.xml$/.test(f))!;
    expect(await zip.file(notes)!.async('string')).toContain('Notas de la uno');
  });
});

describe('imágenes → PDF', () => {
  it('crea una página por imagen con su proporción', async () => {
    const pdf = await imagesToPdf([
      { name: 'a.png', data: new Uint8Array(PNG) },
      { name: 'b.png', data: new Uint8Array(PNG) },
    ]);
    const doc = await PDFDocument.load(pdf);
    expect(doc.getPageCount()).toBe(2);
    expect(doc.getPage(0).getSize()).toEqual({ width: 0.75, height: 0.75 });
  });

  it('un archivo que no es PNG ni JPEG da un error con su nombre', async () => {
    await expect(
      imagesToPdf([{ name: 'raro.gif', data: new Uint8Array([1, 2, 3, 4]) }]),
    ).rejects.toThrow(/raro\.gif/);
    await expect(imagesToPdf([])).rejects.toThrow(/No hay imágenes/);
  });
});

describe('PDF/A (mejor esfuerzo)', () => {
  it('añade XMP con la marca PDF/A, identificador y perfil de color, y avisa de lo que no puede arreglar', async () => {
    const icc = new Uint8Array(400).fill(7);
    const result = await convertToPdfA(buildPdf(['Archivo']), {
      iccProfile: icc,
      title: 'Mi & <doc>',
    });
    const all = await everything(result.data);
    expect(all).toContain('pdfaid:part');
    expect(all).toContain('<pdfaid:conformance>B</pdfaid:conformance>');
    expect(all).toContain('Mi &amp; &lt;doc&gt;'); // el título se escapa en el XML
    expect(all).toContain('/OutputIntent');
    expect(all).toContain('GTS_PDFA1');
    expect(all).toMatch(/\/ID \[/);
    expect(result.fixed.join(' ')).toMatch(/XMP/);

    // buildPdf usa Helvetica sin incrustar: PDF/A no lo admite y se dice claramente
    const fonts = result.issues.find((i) => i.code === 'FONTS_NOT_EMBEDDED');
    expect(fonts).toMatchObject({ blocking: true });
    expect((await PDFDocument.load(result.data)).getPageCount()).toBe(1);
  });

  it('sin perfil de color se avisa; sin JavaScript ni adjuntos tras la conversión', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([200, 200]);
    await doc.attach(Buffer.from('dato'), 'extra.txt', { mimeType: 'text/plain' });
    const result = await convertToPdfA(await doc.save({ useObjectStreams: false }));
    expect(result.issues.map((i) => i.code)).toContain('NO_OUTPUT_INTENT');
    expect(result.fixed.join(' ')).toMatch(/adjunto/);
    expect(await everything(result.data)).not.toContain('extra.txt');
  });
});

describe('Office → PDF', () => {
  it('sin LibreOffice avisa con un error claro', async () => {
    await expect(convertOfficeToPdf('C:/x/informe.docx', undefined, null)).rejects.toMatchObject({
      code: 'LIBREOFFICE_MISSING',
    });
  });

  it('rechaza archivos que no son de Office', async () => {
    await expect(
      convertOfficeToPdf('C:/x/foto.png', undefined, 'C:/falso/soffice.exe'),
    ).rejects.toThrow(/no es un documento de Office/);
  });
});
