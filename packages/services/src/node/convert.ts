import ExcelJS from 'exceljs';
import PptxGenJS from 'pptxgenjs';
import { Document, HeadingLevel, Packer, PageBreak, Paragraph, TextRun } from 'docx';
import { PDFDocument } from 'pdf-lib';
import {
  FoliuxError,
  type ExtractedTables,
  type SlideDeck,
  buildParagraphs,
  buildTable,
  groupLines,
  type PageWord,
} from '@foliux-pdf/core';
import { savePdf } from '../pdf-edit/page-ops';

/** Generadores de documentos de Office a partir del texto de un PDF (aproximados: ver layout.ts). */

/** Documento de Word: un párrafo por bloque de texto, los títulos como encabezados y un salto por página. */
export async function buildDocx(
  pages: readonly { words: readonly PageWord[] }[],
): Promise<Uint8Array> {
  const children: Paragraph[] = [];
  pages.forEach((page, index) => {
    if (index > 0) children.push(new Paragraph({ children: [new PageBreak()] }));
    for (const paragraph of buildParagraphs(groupLines(page.words))) {
      children.push(
        paragraph.heading
          ? new Paragraph({ text: paragraph.text, heading: HeadingLevel.HEADING_2 })
          : new Paragraph({ children: [new TextRun(paragraph.text)], spacing: { after: 120 } }),
      );
    }
  });
  if (children.length === 0) children.push(new Paragraph(''));
  const document = new Document({
    creator: 'Foliux PDF',
    sections: [{ children }],
  });
  return new Uint8Array(await Packer.toBuffer(document));
}

/** Un número escrito como texto pasa a ser número, salvo que empiece por 0 (códigos, teléfonos). */
function asCell(text: string): string | number {
  const clean = text.trim();
  if (/^-?(0|[1-9]\d*)([.,]\d+)?$/.test(clean)) return Number(clean.replace(',', '.'));
  return text;
}

/** Libro de Excel: una hoja por página con la tabla reconstruida (o el texto línea a línea si no hay columnas). */
export async function buildXlsx(
  pages: readonly { words: readonly PageWord[] }[],
): Promise<Uint8Array> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Foliux PDF';
  pages.forEach((page, index) => {
    const sheet = workbook.addWorksheet(`Página ${index + 1}`);
    for (const row of buildTable(groupLines(page.words))) sheet.addRow(row.map(asCell));
    sheet.columns.forEach((column) => {
      let longest = 8;
      column.eachCell?.({ includeEmpty: false }, (cell) => {
        longest = Math.max(longest, String(cell.value ?? '').length);
      });
      column.width = Math.min(60, longest + 2);
    });
  });
  const buffer = await workbook.xlsx.writeBuffer();
  return new Uint8Array(buffer as ArrayBuffer);
}

/** Presentación de PowerPoint: una diapositiva por página con su imagen, y el texto en las notas. */
export async function buildPptx(
  pages: readonly { image: Uint8Array; width: number; height: number; notes: string }[],
): Promise<Uint8Array> {
  const pptx = new PptxGenJS();
  pptx.author = 'Foliux PDF';
  // Pulgadas: la primera página fija el tamaño de las diapositivas.
  const first = pages[0];
  if (!first) throw new FoliuxError('INVALID_REQUEST', 'No hay páginas que convertir.');
  const width = first.width / 72;
  const height = first.height / 72;
  pptx.defineLayout({ name: 'PAGINA', width, height });
  pptx.layout = 'PAGINA';

  for (const page of pages) {
    const slide = pptx.addSlide();
    const data = `image/png;base64,${Buffer.from(page.image).toString('base64')}`;
    slide.addImage({ data, x: 0, y: 0, w: width, h: height });
    if (page.notes.trim() !== '') slide.addNotes(page.notes);
  }
  const output = await pptx.write({ outputType: 'nodebuffer' });
  return new Uint8Array(output as Buffer);
}

const isPng = (d: Uint8Array) => d[0] === 0x89 && d[1] === 0x50 && d[2] === 0x4e && d[3] === 0x47;
const isJpeg = (d: Uint8Array) => d[0] === 0xff && d[1] === 0xd8 && d[2] === 0xff;

/** Une imágenes PNG o JPEG en un PDF, una por página y con su proporción. */
export async function imagesToPdf(
  images: readonly { name: string; data: Uint8Array }[],
): Promise<Uint8Array> {
  if (images.length === 0)
    throw new FoliuxError('INVALID_REQUEST', 'No hay imágenes que convertir.');
  const doc = await PDFDocument.create({ updateMetadata: false });
  doc.setProducer('Foliux PDF');
  for (const image of images) {
    let embedded;
    try {
      if (isPng(image.data)) embedded = await doc.embedPng(image.data);
      else if (isJpeg(image.data)) embedded = await doc.embedJpg(image.data);
      else throw new Error('formato no admitido');
    } catch (error) {
      throw new FoliuxError(
        'INVALID_REQUEST',
        `«${image.name}» no es una imagen PNG o JPEG válida.`,
        { cause: error },
      );
    }
    // 96 ppp → puntos, y como mucho 1000 pt por el lado largo
    let scale = 0.75;
    const longest = Math.max(embedded.width, embedded.height) * scale;
    if (longest > 1000) scale *= 1000 / longest;
    const page = doc.addPage([embedded.width * scale, embedded.height * scale]);
    page.drawImage(embedded, { x: 0, y: 0, width: page.getWidth(), height: page.getHeight() });
  }
  return savePdf(doc);
}

/** Nombre de hoja válido en Excel: máximo 31 caracteres, sin \ / ? * [ ] : y único en el libro. */
function sheetName(title: string, taken: Set<string>): string {
  // Caracteres que Excel no admite en un nombre de hoja (el 92 es la barra invertida).
  const forbidden = new Set([String.fromCharCode(92), '/', '?', '*', '[', ']', ':']);
  const clean =
    [...title]
      .map((char) => (forbidden.has(char) ? ' ' : char))
      .join('')
      .trim()
      .slice(0, 31) || 'Tabla';
  let name = clean;
  for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${clean.slice(0, 28)} ${n}`;
  taken.add(name.toLowerCase());
  return name;
}

/** Libro de Excel con una hoja por tabla extraída por la IA. */
export async function buildTablesXlsx(tables: ExtractedTables['tables']): Promise<Uint8Array> {
  if (tables.length === 0) throw new FoliuxError('INVALID_REQUEST', 'No hay tablas que exportar.');
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Foliux PDF';
  const taken = new Set<string>();
  for (const table of tables) {
    const sheet = workbook.addWorksheet(sheetName(`${table.title} (p. ${table.page})`, taken));
    if (table.headers.length > 0) sheet.addRow(table.headers).font = { bold: true };
    for (const row of table.rows) sheet.addRow(row.map(asCell));
    sheet.columns.forEach((column) => {
      let longest = 8;
      column.eachCell?.({ includeEmpty: false }, (cell) => {
        longest = Math.max(longest, String(cell.value ?? '').length);
      });
      column.width = Math.min(60, longest + 2);
    });
  }
  return new Uint8Array((await workbook.xlsx.writeBuffer()) as ArrayBuffer);
}

/** Presentación de PowerPoint generada por la IA: portada y una diapositiva por idea, con notas del orador. */
export async function buildDeckPptx(deck: SlideDeck): Promise<Uint8Array> {
  const pptx = new PptxGenJS();
  pptx.author = 'Foliux PDF';
  pptx.title = deck.title;
  pptx.layout = 'LAYOUT_WIDE';
  deck.slides.forEach((data, index) => {
    const slide = pptx.addSlide();
    if (index === 0) {
      slide.background = { color: '1F2A44' };
      slide.addText(data.title, {
        x: 0.8,
        y: 2.2,
        w: 11.7,
        h: 1.6,
        fontSize: 40,
        bold: true,
        color: 'FFFFFF',
      });
      if (data.bullets.length > 0) {
        slide.addText(data.bullets.join(' · '), {
          x: 0.8,
          y: 4.0,
          w: 11.7,
          h: 1.2,
          fontSize: 20,
          color: 'C9D3EA',
        });
      }
    } else {
      slide.addText(data.title, {
        x: 0.6,
        y: 0.4,
        w: 12.1,
        h: 0.9,
        fontSize: 30,
        bold: true,
        color: '1F2A44',
      });
      slide.addText(
        data.bullets.map((text) => ({ text, options: { bullet: true, breakLine: true } })),
        {
          x: 0.8,
          y: 1.6,
          w: 11.7,
          h: 5,
          fontSize: 22,
          color: '333333',
          valign: 'top',
          paraSpaceAfter: 10,
        },
      );
    }
    if (data.notes.trim() !== '') slide.addNotes(data.notes);
  });
  const output = await pptx.write({ outputType: 'nodebuffer' });
  return new Uint8Array(output as Buffer);
}
