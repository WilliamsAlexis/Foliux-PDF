import { describe, expect, it } from 'vitest';
import { PDFArray, PDFDocument, PDFName, type PDFDict, type PDFString } from 'pdf-lib';
import {
  PageOpSchema,
  buildHtmlDocument,
  buildPlainText,
  type PageOp,
  type PageWord,
} from '@foliux-pdf/core';
import { isSafeLinkUrl, transformPdf } from '@foliux-pdf/services/node';
import { buildPdf } from './helpers';

const noExternal = () => Promise.reject(new Error('no se esperaba leer otro archivo'));
const run = (data: Uint8Array, op: PageOp) => transformPdf(data, [], op, noExternal);
const load = (data: Uint8Array) => PDFDocument.load(data, { updateMetadata: false });
const word = (text: string, x: number, y: number, height = 10): PageWord => ({
  text,
  x,
  y,
  width: text.length * 6,
  height,
});

describe('recortar páginas', () => {
  it('recorta una página al rectángulo dibujado (coordenadas de la vista)', async () => {
    const base = buildPdf(['A', 'B']);
    const before = (await load(base)).getPage(0).getCropBox();
    const out = await run(
      base,
      PageOpSchema.parse({
        type: 'crop',
        page: 1,
        rect: { x: 20, y: 30, width: 100, height: 80 },
      }),
    );
    const doc = await load(out.data);
    const box = doc.getPage(0).getCropBox();
    expect(box.width).toBeCloseTo(100, 3);
    expect(box.height).toBeCloseTo(80, 3);
    // El borde izquierdo avanza 20 y el superior baja 30 (en la vista el eje y va hacia abajo)
    expect(box.x).toBeCloseTo(before.x + 20, 3);
    expect(box.y + box.height).toBeCloseTo(before.y + before.height - 30, 3);
    // La otra página no cambia
    expect(doc.getPage(1).getCropBox().width).toBeCloseTo(before.width, 3);
  });

  it('con «todas las páginas» aplica los mismos márgenes a cada una', async () => {
    const base = buildPdf(['A', 'B', 'C']);
    const out = await run(
      base,
      PageOpSchema.parse({
        type: 'crop',
        page: 1,
        rect: { x: 10, y: 10, width: 150, height: 100 },
        allPages: true,
      }),
    );
    const doc = await load(out.data);
    const sizes = doc.getPages().map((p) => p.getCropBox().width);
    expect(sizes.every((w) => Math.abs(w - 150) < 0.01)).toBe(true);
  });

  it('respeta el giro de la página', async () => {
    const rotated = await run(
      buildPdf(['A']),
      PageOpSchema.parse({ type: 'rotate', pages: [1], degrees: 90 }),
    );
    // En la vista la página está girada: el recorte de 60×40 debe quedar como 40×60 en el espacio del PDF
    const out = await run(
      rotated.data,
      PageOpSchema.parse({
        type: 'crop',
        page: 1,
        rect: { x: 5, y: 5, width: 60, height: 40 },
      }),
    );
    const box = (await load(out.data)).getPage(0).getCropBox();
    expect(box.width).toBeCloseTo(40, 3);
    expect(box.height).toBeCloseTo(60, 3);
  });

  it('rechaza un recorte demasiado pequeño', async () => {
    await expect(
      run(
        buildPdf(['A']),
        PageOpSchema.parse({ type: 'crop', page: 1, rect: { x: 5, y: 5, width: 10, height: 10 } }),
      ),
    ).rejects.toThrow(/demasiado pequeña/);
  });
});

describe('enlaces', () => {
  const rect = { x: 10, y: 10, width: 60, height: 20 };

  it('añade un enlace web como anotación Link con acción URI', async () => {
    const out = await run(
      buildPdf(['A']),
      PageOpSchema.parse({ type: 'addLink', page: 1, rect, url: 'https://example.com/ruta?a=1' }),
    );
    const page = (await load(out.data)).getPage(0);
    const annots = page.node.Annots() as PDFArray;
    const link = page.doc.context.lookup(annots.get(annots.size() - 1)) as PDFDict;
    expect((link.get(PDFName.of('Subtype')) as PDFName).decodeText()).toBe('Link');
    const action = page.doc.context.lookup(link.get(PDFName.of('A'))) as PDFDict;
    expect((action.get(PDFName.of('URI')) as PDFString).decodeText()).toBe(
      'https://example.com/ruta?a=1',
    );
  });

  it('un enlace interno apunta a otra página', async () => {
    const out = await run(
      buildPdf(['A', 'B']),
      PageOpSchema.parse({ type: 'addLink', page: 1, rect, targetPage: 2 }),
    );
    const page = (await load(out.data)).getPage(0);
    const annots = page.node.Annots() as PDFArray;
    const link = page.doc.context.lookup(annots.get(annots.size() - 1)) as PDFDict;
    expect(link.get(PDFName.of('Dest'))).toBeInstanceOf(PDFArray);
  });

  it('solo admite http, https y mailto (nunca javascript: ni file:)', () => {
    for (const bad of [
      'javascript:alert(1)',
      'file:///C:/secreto.txt',
      'data:text/html,x',
      'ftp://x.com',
      'https://a b',
    ]) {
      expect(isSafeLinkUrl(bad)).toBe(false);
      expect(PageOpSchema.safeParse({ type: 'addLink', page: 1, rect, url: bad }).success).toBe(
        false,
      );
    }
    for (const good of [
      'https://example.com',
      'http://localhost:3000/x',
      'mailto:ana@example.com',
    ]) {
      expect(isSafeLinkUrl(good)).toBe(true);
    }
  });

  it('sin dirección ni página es un error claro', async () => {
    await expect(
      run(buildPdf(['A']), PageOpSchema.parse({ type: 'addLink', page: 1, rect })),
    ).rejects.toThrow(/necesita una dirección o una página/);
  });
});

describe('exportar texto', () => {
  const pages = [
    { page: 1, words: [word('Título', 10, 10, 20), word('Hola', 10, 50), word('mundo', 50, 50)] },
    { page: 3, words: [word('<script>alert(1)</script>', 10, 10)] },
  ];

  it('texto plano con separadores por página (conserva el número real)', () => {
    const text = buildPlainText(pages);
    expect(text).toContain('--- Página 1 ---');
    expect(text).toContain('--- Página 3 ---');
    expect(text).toContain('Hola mundo');
  });

  it('HTML autónomo: escapa el contenido y no incluye scripts', () => {
    const html = buildHtmlDocument('Informe "A" <b>', pages);
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('<title>Informe &quot;A&quot; &lt;b&gt;</title>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).toContain('id="pagina-3"');
  });
});
