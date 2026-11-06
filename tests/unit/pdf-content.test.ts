import { describe, expect, it } from 'vitest';
import * as pdfjsLegacy from 'pdfjs-dist/legacy/build/pdf.mjs';
import type * as PdfJs from 'pdfjs-dist';
import { PDFDocument } from 'pdf-lib';
import {
  newAnnotationId,
  parsePageRange,
  planSplit,
  type Annotation,
  type AnnotationOf,
} from '@foliux-pdf/core';
import {
  bakeAnnotations,
  fillTokens,
  optimizePdf,
  splitPdf,
  transformPdf,
} from '@foliux-pdf/services/node';
import { createPdfJsEngine } from '@foliux-pdf/services/pdf';
import { buildPdf } from './helpers';

const engine = createPdfJsEngine({ pdfjs: pdfjsLegacy as unknown as typeof PdfJs });
const noExternal = () => Promise.reject(new Error('no se esperaba leer otro archivo'));

/** PNG de 1×1 píxel (rojo). */
const PNG_1X1 =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function textItem(partial: Partial<AnnotationOf<'text'>> = {}): AnnotationOf<'text'> {
  return {
    id: newAnnotationId(),
    kind: 'text',
    page: 1,
    color: '#cc0000',
    opacity: 1,
    text: 'Texto nuevo',
    createdAt: Date.now(),
    rect: { x: 20, y: 40, width: 160, height: 30 },
    fontSize: 14,
    font: 'sans',
    bold: false,
    italic: false,
    align: 'left',
    angle: 0,
    background: null,
    nowrap: false,
    ...partial,
  };
}

function imageItem(partial: Partial<AnnotationOf<'image'>> = {}): AnnotationOf<'image'> {
  return {
    id: newAnnotationId(),
    kind: 'image',
    page: 1,
    color: '#000000',
    opacity: 1,
    text: '',
    createdAt: Date.now(),
    rect: { x: 30, y: 100, width: 80, height: 60 },
    src: PNG_1X1,
    format: 'png',
    ...partial,
  };
}

/** Texto de cada página según PDF.js (lo que vería y copiaría un lector cualquiera). */
async function pageTexts(data: Uint8Array): Promise<string[]> {
  const task = pdfjsLegacy.getDocument({ data: data.slice(), useSystemFonts: true });
  const document = await task.promise;
  const result: string[] = [];
  for (let i = 1; i <= document.numPages; i++) {
    const content = await (await document.getPage(i)).getTextContent();
    result.push(content.items.map((item) => ('str' in item ? item.str : '')).join(' '));
  }
  await task.destroy();
  return result;
}

describe('parsePageRange', () => {
  it('admite palabras clave, listas y rangos abiertos', () => {
    expect(parsePageRange('all', 4)).toEqual([1, 2, 3, 4]);
    expect(parsePageRange('', 3)).toEqual([1, 2, 3]);
    expect(parsePageRange('odd', 5)).toEqual([1, 3, 5]);
    expect(parsePageRange('even', 5)).toEqual([2, 4]);
    expect(parsePageRange('1-3, 5', 6)).toEqual([1, 2, 3, 5]);
    expect(parsePageRange('4-', 6)).toEqual([4, 5, 6]);
    expect(parsePageRange('-2', 6)).toEqual([1, 2]);
    expect(parsePageRange('3;1', 6)).toEqual([1, 3]);
  });

  it('rechaza lo que no es válido o está fuera del documento', () => {
    expect(() => parsePageRange('abc', 5)).toThrow(/no es válido/);
    expect(() => parsePageRange('2-9', 5)).toThrow(/fuera del documento/);
    expect(() => parsePageRange('0', 5)).toThrow(/fuera del documento/);
    expect(() => parsePageRange('4-2', 5)).toThrow(/fuera del documento/);
  });
});

describe('planSplit', () => {
  it('divide por páginas, cada N o por rangos', () => {
    expect(planSplit(3, { mode: 'each' })).toEqual([[1], [2], [3]]);
    expect(planSplit(5, { mode: 'every', every: 2 })).toEqual([[1, 2], [3, 4], [5]]);
    expect(planSplit(6, { mode: 'ranges', ranges: '1-2; 4-6' })).toEqual([
      [1, 2],
      [4, 5, 6],
    ]);
    expect(() => planSplit(3, { mode: 'ranges', ranges: ' ; ' })).toThrow(/al menos un rango/);
  });
});

describe('fillTokens', () => {
  it('sustituye los marcadores', () => {
    expect(
      fillTokens('Página {page} de {pages} — {file} ({date})', {
        page: 2,
        pages: 9,
        date: '01/02/2026',
        file: 'a.pdf',
      }),
    ).toBe('Página 2 de 9 — a.pdf (01/02/2026)');
  });
});

describe('texto e imágenes permanentes', () => {
  it('el texto se incorpora a la página, no queda como anotación y es legible por cualquier lector', async () => {
    const result = await transformPdf(
      buildPdf(['Hola']),
      [textItem({ text: 'Añadido ñandú' })],
      { type: 'applyEdits' },
      noExternal,
    );
    expect(result.annotations).toEqual([]); // ya es contenido de la página
    const doc = await PDFDocument.load(result.data);
    expect(doc.getPage(0).node.Annots()?.size() ?? 0).toBe(0);

    const [text] = await pageTexts(result.data);
    expect(text).toContain('Hola'); // el contenido original se conserva
    expect(text).toContain('Añadido ñandú');
  });

  it('con fondo, el rectángulo tapa el original y el texto nuevo va encima', async () => {
    const baked = await bakeAnnotations(buildPdf(['Original']), [
      textItem({ text: 'Reemplazo', background: '#ffffff', nowrap: true }),
    ]);
    const raw = Buffer.from(baked).toString('latin1');
    expect(raw).toContain('re f'); // relleno del fondo
    expect((await pageTexts(baked))[0]).toContain('Reemplazo');
  });

  it('respeta fuentes (serif/mono, negrita, cursiva) y alineación', async () => {
    const baked = await bakeAnnotations(buildPdf(['x']), [
      textItem({ text: 'Serif', font: 'serif', bold: true, italic: true, align: 'center' }),
      textItem({ text: 'Mono', font: 'mono', rect: { x: 20, y: 90, width: 160, height: 30 } }),
    ]);
    const raw = Buffer.from(baked).toString('latin1');
    expect(raw).toContain('/Times-BoldItalic');
    expect(raw).toContain('/Courier');
  });

  it('las imágenes se incrustan y el motor las localiza en su sitio', async () => {
    const result = await transformPdf(
      buildPdf(['A']),
      [imageItem({ rect: { x: 30, y: 100, width: 80, height: 60 } })],
      { type: 'applyEdits' },
      noExternal,
    );
    const document = await engine.load(result.data);
    const rects = await document.getImageRects(1);
    expect(rects).toHaveLength(1);
    const [rect] = rects;
    expect(rect!.x).toBeCloseTo(30, 0);
    expect(rect!.y).toBeCloseTo(100, 0);
    expect(rect!.width).toBeCloseTo(80, 0);
    expect(rect!.height).toBeCloseTo(60, 0);
    await document.destroy();
  });

  it('en una página girada la imagen sigue en la posición vista (coordenadas de la vista)', async () => {
    const rotated = await transformPdf(
      buildPdf(['A']),
      [],
      { type: 'rotate', pages: [1], degrees: 90 },
      noExternal,
    );
    // En la vista girada la página mide 300×200. Se coloca una imagen en la esquina superior izquierda.
    const placed = await transformPdf(
      rotated.data,
      [imageItem({ rect: { x: 10, y: 20, width: 50, height: 40 } })],
      { type: 'applyEdits' },
      noExternal,
    );
    const document = await engine.load(placed.data);
    const [rect] = await document.getImageRects(1);
    expect(rect!.x).toBeCloseTo(10, 0);
    expect(rect!.y).toBeCloseTo(20, 0);
    expect(rect!.width).toBeCloseTo(50, 0);
    expect(rect!.height).toBeCloseTo(40, 0);
    await document.destroy();
  });

  it('las anotaciones se conservan al aplicar contenido permanente en el mismo documento', async () => {
    const highlight: Annotation = {
      id: newAnnotationId(),
      kind: 'highlight',
      page: 1,
      color: '#ffd400',
      opacity: 0.4,
      text: '',
      createdAt: Date.now(),
      rects: [{ x: 10, y: 10, width: 50, height: 12 }],
    };
    const result = await transformPdf(
      buildPdf(['A']),
      [highlight, textItem()],
      { type: 'applyEdits' },
      noExternal,
    );
    expect(result.annotations.map((a) => a.kind)).toEqual(['highlight']);
  });
});

describe('marca de agua', () => {
  it('se aplica a todas las páginas o solo a las del rango', async () => {
    const all = await transformPdf(
      buildPdf(['A', 'B', 'C']),
      [],
      {
        type: 'watermark',
        text: 'CONFIDENCIAL',
        fontSize: 40,
        color: '#888888',
        opacity: 0.3,
        angle: -45,
        pages: 'all',
        imageWidth: 0.5,
      },
      noExternal,
    );
    for (const text of await pageTexts(all.data)) expect(text).toContain('CONFIDENCIAL');

    const odd = await transformPdf(
      buildPdf(['A', 'B', 'C']),
      [],
      {
        type: 'watermark',
        text: 'BORRADOR',
        fontSize: 40,
        color: '#888888',
        opacity: 0.3,
        angle: 0,
        pages: 'odd',
        imageWidth: 0.5,
      },
      noExternal,
    );
    const texts = await pageTexts(odd.data);
    expect(texts[0]).toContain('BORRADOR');
    expect(texts[1]).not.toContain('BORRADOR');
    expect(texts[2]).toContain('BORRADOR');
  });

  it('admite marca de imagen y exige texto o imagen', async () => {
    const withImage = await transformPdf(
      buildPdf(['A', 'B']),
      [],
      {
        type: 'watermark',
        image: { src: PNG_1X1, format: 'png' },
        fontSize: 40,
        color: '#888888',
        opacity: 0.5,
        angle: 0,
        pages: 'all',
        imageWidth: 0.5,
      },
      noExternal,
    );
    const document = await engine.load(withImage.data);
    expect(await document.getImageRects(1)).toHaveLength(1);
    expect(await document.getImageRects(2)).toHaveLength(1);
    // La imagen se incrusta una sola vez aunque salga en varias páginas: el número de objetos de imagen
    // (el PNG con transparencia genera la imagen y su máscara) es el mismo con 1 página que con 2.
    const oneImage = await transformPdf(
      buildPdf(['A']),
      [],
      {
        type: 'watermark',
        image: { src: PNG_1X1, format: 'png' },
        fontSize: 40,
        color: '#888888',
        opacity: 0.5,
        angle: 0,
        pages: 'all',
        imageWidth: 0.5,
      },
      noExternal,
    );
    const countImages = (data: Uint8Array) =>
      Buffer.from(data)
        .toString('latin1')
        .match(/\/Subtype \/Image/g)?.length ?? 0;
    expect(countImages(withImage.data)).toBe(countImages(oneImage.data));
    await document.destroy();

    await expect(
      transformPdf(
        buildPdf(['A']),
        [],
        {
          type: 'watermark',
          fontSize: 40,
          color: '#888888',
          opacity: 0.3,
          angle: 0,
          pages: 'all',
          imageWidth: 0.5,
        },
        noExternal,
      ),
    ).rejects.toThrow(/texto o/);
  });
});

describe('encabezado y pie', () => {
  it('numera las páginas con los marcadores y respeta el rango', async () => {
    const result = await transformPdf(
      buildPdf(['A', 'B', 'C']),
      [],
      {
        type: 'headerFooter',
        header: { left: '{file}', center: '', right: '' },
        footer: { left: '', center: 'Página {page} de {pages}', right: '' },
        font: 'sans',
        fontSize: 10,
        color: '#333333',
        margin: 24,
        pages: '2-3',
        startNumber: 1,
        fileName: 'informe.pdf',
      },
      noExternal,
    );
    const texts = await pageTexts(result.data);
    expect(texts[0]).not.toContain('Página');
    expect(texts[1]).toContain('Página 2 de 3');
    expect(texts[1]).toContain('informe.pdf');
    expect(texts[2]).toContain('Página 3 de 3');
  });

  it('la numeración puede empezar en otro número', async () => {
    const result = await transformPdf(
      buildPdf(['A', 'B']),
      [],
      {
        type: 'headerFooter',
        header: { left: '', center: '', right: '' },
        footer: { left: '', center: '', right: '{page}' },
        font: 'serif',
        fontSize: 10,
        color: '#000000',
        margin: 20,
        pages: 'all',
        startNumber: 5,
        fileName: '',
      },
      noExternal,
    );
    const texts = await pageTexts(result.data);
    expect(texts[0]).toContain('5');
    expect(texts[1]).toContain('6');
  });
});

describe('dividir y optimizar', () => {
  it('divide en un archivo por grupo, con las páginas correctas', async () => {
    const files = await splitPdf(buildPdf(['A', 'B', 'C', 'D', 'E']), [], {
      mode: 'every',
      every: 2,
    });
    expect(files.map((f) => f.pages)).toEqual([[1, 2], [3, 4], [5]]);
    const texts = await Promise.all(files.map((f) => pageTexts(f.data)));
    expect(texts.map((t) => t.map((s) => s.trim()))).toEqual([['A', 'B'], ['C', 'D'], ['E']]);
  });

  it('optimizar devuelve un PDF válido con las mismas páginas', async () => {
    const original = buildPdf(['A', 'B', 'C']);
    const optimized = await optimizePdf(original, [textItem({ text: 'Visible' })]);
    expect((await PDFDocument.load(optimized)).getPageCount()).toBe(3);
    expect((await pageTexts(optimized))[0]).toContain('Visible');
  });
});

describe('marca de agua que no cabe', () => {
  it('se reduce para verse entera aunque el tamaño pedido sea mayor que la página', async () => {
    // Página de 200 pt de ancho y letra de 72 pt: «CONFIDENCIAL» mediría más de 500 pt.
    for (const angle of [0, -45]) {
      const result = await transformPdf(
        buildPdf(['A']),
        [],
        {
          type: 'watermark',
          text: 'CONFIDENCIAL',
          fontSize: 72,
          color: '#888888',
          opacity: 0.3,
          angle,
          pages: 'all',
          imageWidth: 0.5,
        },
        noExternal,
      );
      // PDF.js descarta el texto que cae fuera de la página: si aparece completo, cabía.
      expect((await pageTexts(result.data))[0]).toContain('CONFIDENCIAL');
    }
  });
});
