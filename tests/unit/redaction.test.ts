import { describe, expect, it } from 'vitest';
import * as pdfjsLegacy from 'pdfjs-dist/legacy/build/pdf.mjs';
import type * as PdfJs from 'pdfjs-dist';
import { PDFDocument } from 'pdf-lib';
import { newAnnotationId, type Annotation } from '@foliux-pdf/core';
import { redactDocument, transformPdf } from '@foliux-pdf/services/node';
import { createPdfJsEngine } from '@foliux-pdf/services/pdf';
import { everything } from './helpers';

const engine = createPdfJsEngine({ pdfjs: pdfjsLegacy as unknown as typeof PdfJs });
const noExternal = () => Promise.reject(new Error('no se esperaba leer otro archivo'));

/** PNG de 1×1 píxel (representa «la página ya dibujada y tapada»). */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const SECRET = 'NUMERO-DE-CUENTA-9999';

/** Tres páginas de 200×300; la 2 contiene el secreto y una frase normal. */
async function samplePdf(titleWithSecret = false): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  if (titleWithSecret) doc.setTitle(`Informe ${SECRET}`);
  for (const lines of [['Pagina uno'], [SECRET, 'Frase normal'], ['Pagina tres']]) {
    const page = doc.addPage([200, 300]);
    lines.forEach((line, i) => page.drawText(line, { x: 10, y: 250 - i * 30, size: 12 }));
  }
  return doc.save({ useObjectStreams: false });
}

function annotation(partial: Partial<Annotation> & Pick<Annotation, 'kind' | 'page'>): Annotation {
  return {
    id: newAnnotationId(),
    color: '#e03131',
    opacity: 0.3,
    text: '',
    createdAt: Date.now(),
    ...partial,
  } as Annotation;
}

async function pageTexts(data: Uint8Array): Promise<string[]> {
  const task = pdfjsLegacy.getDocument({ data: data.slice(), useSystemFonts: true });
  const document = await task.promise;
  const out: string[] = [];
  for (let i = 1; i <= document.numPages; i++) {
    const content = await (await document.getPage(i)).getTextContent();
    out.push(content.items.map((item) => ('str' in item ? item.str : '')).join(' '));
  }
  await task.destroy();
  return out;
}

const redactedPage = (
  page: number,
  words: { text: string; x: number; y: number; width: number; height: number }[],
) => ({
  page,
  image: new Uint8Array(PNG_1X1),
  format: 'png' as const,
  words,
});

describe('redacción permanente', () => {
  it('control: antes de redactar, el secreto está en el archivo', async () => {
    expect(await everything(await samplePdf())).toContain(SECRET);
  });

  it('el contenido redactado desaparece del archivo, no solo de la vista', async () => {
    const mark = annotation({
      kind: 'redact',
      page: 2,
      rect: { x: 5, y: 30, width: 150, height: 20 },
    });
    const result = await redactDocument(
      await samplePdf(),
      [mark],
      [redactedPage(2, [{ text: 'Frase', x: 10, y: 60, width: 40, height: 12 }])],
    );

    const all = await everything(result.data);
    expect(all).not.toContain(SECRET);
    // Las demás páginas siguen intactas
    expect(all).toContain('Pagina uno');
    expect(all).toContain('Pagina tres');
    expect((await PDFDocument.load(result.data)).getPageCount()).toBe(3);
  });

  it('las palabras que no se redactan siguen siendo texto buscable; las redactadas no', async () => {
    const mark = annotation({
      kind: 'redact',
      page: 2,
      rect: { x: 5, y: 30, width: 150, height: 20 },
    });
    const result = await redactDocument(
      await samplePdf(),
      [mark],
      [
        redactedPage(2, [
          { text: 'Frase', x: 10, y: 60, width: 40, height: 12 },
          { text: 'normal', x: 55, y: 60, width: 45, height: 12 },
        ]),
      ],
    );
    const texts = await pageTexts(result.data);
    expect(texts[0]).toContain('Pagina uno');
    expect(texts[1]).toContain('Frase');
    expect(texts[1]).toContain('normal');
    expect(texts[1]).not.toContain(SECRET);
    expect(texts[2]).toContain('Pagina tres');
  });

  it('la página redactada es una imagen del tamaño de la página', async () => {
    const mark = annotation({
      kind: 'redact',
      page: 2,
      rect: { x: 0, y: 0, width: 10, height: 10 },
    });
    const result = await redactDocument(await samplePdf(), [mark], [redactedPage(2, [])]);
    const document = await engine.load(result.data);
    const [rect] = await document.getImageRects(2);
    expect(rect).toMatchObject({ x: 0, y: 0 });
    expect(rect!.width).toBeCloseTo(200, 0);
    expect(rect!.height).toBeCloseTo(300, 0);
    // Las páginas no redactadas no tienen imágenes
    expect(await document.getImageRects(1)).toHaveLength(0);
    await document.destroy();
  });

  it('en una página girada la imagen también cubre toda la vista', async () => {
    const rotated = await transformPdf(
      await samplePdf(),
      [],
      { type: 'rotate', pages: [2], degrees: 90 },
      noExternal,
    );
    const mark = annotation({
      kind: 'redact',
      page: 2,
      rect: { x: 0, y: 0, width: 10, height: 10 },
    });
    const result = await redactDocument(rotated.data, [mark], [redactedPage(2, [])]);
    const document = await engine.load(result.data);
    const [rect] = await document.getImageRects(2);
    // En la vista girada la página mide 300×200
    expect(rect!.width).toBeCloseTo(300, 0);
    expect(rect!.height).toBeCloseTo(200, 0);
    await document.destroy();
  });

  it('se eliminan las marcas y las anotaciones que tocan la zona; el resto se conserva', async () => {
    const mark = annotation({
      kind: 'redact',
      page: 2,
      rect: { x: 5, y: 30, width: 150, height: 20 },
    });
    const touching = annotation({ kind: 'note', page: 2, at: { x: 10, y: 35 }, text: SECRET });
    const apart = annotation({
      kind: 'highlight',
      page: 2,
      rects: [{ x: 10, y: 200, width: 50, height: 12 }],
    });
    const otherPage = annotation({
      kind: 'highlight',
      page: 1,
      rects: [{ x: 10, y: 20, width: 50, height: 12 }],
    });
    const result = await redactDocument(
      await samplePdf(),
      [mark, touching, apart, otherPage],
      [redactedPage(2, [])],
    );
    const kept = result.annotations.map((a) => a.id).sort();
    expect(kept).toEqual([apart.id, otherPage.id].sort());
    // Ni la marca ni el texto de la nota quedan en el archivo
    expect(await everything(result.data)).not.toContain(SECRET);
  });

  it('también desaparecen los metadatos si se limpian a continuación', async () => {
    const mark = annotation({
      kind: 'redact',
      page: 2,
      rect: { x: 0, y: 0, width: 10, height: 10 },
    });
    const redacted = await redactDocument(await samplePdf(true), [mark], [redactedPage(2, [])]);
    // El título del documento menciona el secreto: sigue ahí hasta que se limpian los metadatos.
    expect(await everything(redacted.data)).toContain(SECRET);
    const cleaned = await transformPdf(
      redacted.data,
      [],
      {
        type: 'cleanMetadata',
        info: true,
        xmp: true,
        thumbnails: true,
        attachments: true,
        javascript: true,
      },
      noExternal,
    );
    expect(await everything(cleaned.data)).not.toContain(SECRET);
  });
});

describe('palabras de una página (motor)', () => {
  it('devuelve cada palabra con su posición', async () => {
    const document = await engine.load(await samplePdf());
    const words = await document.getWords(2);
    const texts = words.map((w) => w.text);
    expect(texts).toContain(SECRET);
    expect(texts).toContain('Frase');
    const secret = words.find((w) => w.text === SECRET)!;
    // La primera línea está arriba en la vista y la segunda, más abajo
    expect(words.find((w) => w.text === 'Frase')!.y).toBeGreaterThan(secret.y);
    expect(secret.width).toBeGreaterThan(50);
    await document.destroy();
  });
});
