import { describe, expect, it } from 'vitest';
import * as pdfjsLegacy from 'pdfjs-dist/legacy/build/pdf.mjs';
import type * as PdfJs from 'pdfjs-dist';
import { createPdfJsEngine } from '@foliux-pdf/services/pdf';
import { buildPdf, TEST_PAGE_HEIGHT, TEST_PAGE_WIDTH } from './helpers';

// En Node se usa la versión "legacy" de PDF.js (no necesita canvas para extraer texto).
const engine = createPdfJsEngine({ pdfjs: pdfjsLegacy as unknown as typeof PdfJs });

describe('createPdfJsEngine', () => {
  it('abre un PDF y lee número de páginas y tamaños', async () => {
    const doc = await engine.load(buildPdf(['uno', 'dos', 'tres']));
    expect(doc.numPages).toBe(3);

    const sizes = await doc.getPageSizes();
    expect(sizes).toHaveLength(3);
    expect(sizes[0]).toEqual({ width: TEST_PAGE_WIDTH, height: TEST_PAGE_HEIGHT });
    await doc.destroy();
  });

  it('no modifica el buffer original', async () => {
    const data = buildPdf(['uno']);
    const doc = await engine.load(data);
    expect(data.byteLength).toBeGreaterThan(0); // PDF.js trabaja con una copia
    await doc.destroy();
  });

  it('busca texto ignorando mayúsculas y devuelve página, contexto y rectángulos', async () => {
    const doc = await engine.load(buildPdf(['Hola Foliux', 'Otra pagina', 'Foliux otra vez']));

    const hits = await doc.search('foliux');

    expect(hits.map((h) => h.pageNumber)).toEqual([1, 3]);
    expect(hits[0]?.match).toBe('Foliux');
    const rect = hits[0]?.rects[0];
    expect(rect).toBeDefined();
    // El texto está a 150 pt de la base: en coordenadas de pantalla (y hacia abajo) queda ~150 desde arriba.
    expect(rect!.x).toBeGreaterThan(20);
    expect(rect!.x + rect!.width).toBeLessThan(TEST_PAGE_WIDTH);
    expect(rect!.y).toBeGreaterThan(100);
    expect(rect!.y + rect!.height).toBeLessThan(TEST_PAGE_HEIGHT);
    await doc.destroy();
  });

  it('informa del progreso y se puede cancelar', async () => {
    const doc = await engine.load(buildPdf(['a', 'b', 'c']));
    const progress: number[] = [];
    await doc.search('zzz', { onProgress: (f) => progress.push(f) });
    expect(progress.at(-1)).toBe(1);

    const controller = new AbortController();
    controller.abort();
    await expect(doc.search('a', { signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
    await doc.destroy();
  });

  it('lee los marcadores y resuelve la página de destino', async () => {
    const doc = await engine.load(buildPdf(['uno', 'dos']));
    const outline = await doc.getOutline();

    expect(outline.map((o) => o.title)).toEqual(['Capitulo 1', 'Capitulo 2']);
    expect(outline.map((o) => o.pageNumber)).toEqual([1, 2]);
    await doc.destroy();
  });

  it('lanza un error claro con un archivo que no es PDF', async () => {
    const garbage = new Uint8Array(Buffer.from('esto no es un pdf'));
    await expect(engine.load(garbage)).rejects.toMatchObject({ code: 'PDF_CORRUPT' });
  });
});
