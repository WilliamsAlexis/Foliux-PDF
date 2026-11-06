import { describe, expect, it } from 'vitest';
import { PDFArray, PDFDocument } from 'pdf-lib';
import {
  annotationAt,
  computeMoveOrder,
  hitTestAnnotation,
  mergeLineRects,
  newAnnotationId,
  translateAnnotation,
  type Annotation,
} from '@foliux-pdf/core';
import {
  applyMatrix,
  bakeAnnotations,
  extractPages,
  invertMatrix,
  mergePdfs,
  openForEditing,
  toWinAnsi,
  transformPdf,
  viewToUserMatrix,
  wrapText,
} from '@foliux-pdf/services/node';
import { buildPdf, TEST_PAGE_HEIGHT, TEST_PAGE_WIDTH } from './helpers';

const noExternal = () => Promise.reject(new Error('no se esperaba leer otro archivo'));

function make(partial: Partial<Annotation> & Pick<Annotation, 'kind'>): Annotation {
  const base = {
    id: newAnnotationId(),
    page: 1,
    color: '#ffd400',
    opacity: 0.5,
    text: '',
    createdAt: Date.now(),
  };
  const shapes: Record<string, object> = {
    highlight: { rects: [{ x: 10, y: 20, width: 80, height: 12 }] },
    underline: { rects: [{ x: 10, y: 40, width: 80, height: 12 }] },
    strikeout: { rects: [{ x: 10, y: 60, width: 80, height: 12 }] },
    ink: {
      strokes: [
        [
          { x: 10, y: 100 },
          { x: 50, y: 120 },
          { x: 90, y: 100 },
        ],
      ],
      strokeWidth: 2,
    },
    rect: { rect: { x: 20, y: 140, width: 60, height: 30 }, strokeWidth: 2 },
    ellipse: { rect: { x: 100, y: 140, width: 60, height: 30 }, strokeWidth: 2 },
    line: { from: { x: 10, y: 200 }, to: { x: 90, y: 220 }, strokeWidth: 2 },
    arrow: { from: { x: 100, y: 200 }, to: { x: 180, y: 220 }, strokeWidth: 2 },
    note: { at: { x: 150, y: 20 } },
    freetext: { rect: { x: 20, y: 240, width: 120, height: 40 }, fontSize: 12 },
  };
  return { ...base, ...shapes[partial.kind], ...partial } as Annotation;
}

async function pageCount(data: Uint8Array): Promise<number> {
  return (await PDFDocument.load(data)).getPageCount();
}

async function texts(data: Uint8Array): Promise<string[]> {
  // El texto de cada página va en su flujo de contenido: sirve para reconocer qué página es cuál.
  const doc = await PDFDocument.load(data);
  return doc.getPages().map((page) => {
    // El contenido puede ser un flujo o una lista de flujos (pdf-lib la crea al anotar la página).
    const contents = page.node.Contents();
    const streams = contents instanceof PDFArray ? contents.asArray() : contents ? [contents] : [];
    const raw = streams
      .map((entry) => doc.context.lookup(entry) as { getContents?: () => Uint8Array } | undefined)
      .map((stream) => Buffer.from(stream?.getContents?.() ?? new Uint8Array()).toString('latin1'))
      .join('\n');
    return /\((.*?)\)/.exec(raw)?.[1] ?? '';
  });
}

describe('geometría de páginas', () => {
  const box = { x: 0, y: 0, width: 200, height: 300 };

  it('la esquina superior izquierda de la vista cae donde toca para cada rotación', () => {
    // (vista) arriba-izquierda → (usuario)
    expect(applyMatrix(viewToUserMatrix(0, box), { x: 0, y: 0 })).toEqual({ x: 0, y: 300 });
    expect(applyMatrix(viewToUserMatrix(90, box), { x: 0, y: 0 })).toEqual({ x: 0, y: 0 });
    expect(applyMatrix(viewToUserMatrix(180, box), { x: 0, y: 0 })).toEqual({ x: 200, y: 0 });
    expect(applyMatrix(viewToUserMatrix(270, box), { x: 0, y: 0 })).toEqual({ x: 200, y: 300 });
  });

  it('la inversa deshace la transformación', () => {
    for (const rotation of [0, 90, 180, 270]) {
      const m = viewToUserMatrix(rotation, { x: 5, y: 7, width: 200, height: 300 });
      const p = { x: 33, y: 71 };
      const back = applyMatrix(invertMatrix(m), applyMatrix(m, p));
      expect(back.x).toBeCloseTo(p.x);
      expect(back.y).toBeCloseTo(p.y);
    }
  });
});

describe('utilidades de texto', () => {
  it('toWinAnsi conserva acentos y sustituye lo que no se puede escribir', () => {
    expect(toWinAnsi('Canción — “ok” €')).toBe('Canción — “ok” €');
    expect(toWinAnsi('漢字')).toBe('??');
  });

  it('wrapText respeta saltos de línea y el ancho máximo', () => {
    const measure = (s: string) => s.length * 10;
    expect(wrapText('uno dos tres', measure, 80)).toEqual(['uno dos', 'tres']);
    expect(wrapText('a\nb', measure, 80)).toEqual(['a', 'b']);
  });
});

describe('mergeLineRects', () => {
  it('fusiona fragmentos de la misma línea y descarta contenedores enormes', () => {
    const merged = mergeLineRects([
      { x: 10, y: 10, width: 30, height: 12 },
      { x: 41, y: 10.5, width: 30, height: 12 },
      { x: 10, y: 30, width: 50, height: 12 },
      { x: 0, y: 0, width: 200, height: 900 },
    ]);
    expect(merged).toHaveLength(2);
    expect(merged[0]).toMatchObject({ x: 10, width: 61 });
  });
});

describe('computeMoveOrder', () => {
  it('mueve páginas a una posición', () => {
    expect(computeMoveOrder(5, [2], 5)).toEqual([1, 3, 4, 2, 5]);
    expect(computeMoveOrder(5, [4, 5], 1)).toEqual([4, 5, 1, 2, 3]);
    expect(computeMoveOrder(5, [1], 6)).toEqual([2, 3, 4, 5, 1]);
    expect(computeMoveOrder(5, [2], 2)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('anotaciones en el PDF', () => {
  it('guarda todos los tipos y los recupera idénticos al reabrir', async () => {
    const kinds = [
      'highlight',
      'underline',
      'strikeout',
      'ink',
      'rect',
      'ellipse',
      'line',
      'arrow',
      'note',
      'freetext',
    ] as const;
    const annotations = kinds.map((kind) =>
      make({ kind, text: kind === 'freetext' ? 'Hola, canción ñ' : `texto ${kind}` }),
    );

    const baked = await bakeAnnotations(buildPdf(['A']), annotations);
    const reopened = await openForEditing(baked);

    expect(reopened.recovered).toBe(true);
    expect(reopened.annotations).toHaveLength(kinds.length);
    for (const original of annotations) {
      const found = reopened.annotations.find((a) => a.id === original.id);
      expect(found).toEqual(original);
    }
    // Y el documento devuelto ya no lleva esas anotaciones (se editan aparte).
    const doc = await PDFDocument.load(reopened.data);
    expect(doc.getPage(0).node.Annots()?.size() ?? 0).toBe(0);
  });

  it('crea anotaciones estándar con apariencia (las ve cualquier lector)', async () => {
    const baked = await bakeAnnotations(buildPdf(['A']), [make({ kind: 'highlight' })]);
    const doc = await PDFDocument.load(baked);
    const text = Buffer.from(baked).toString('latin1');
    expect(text).toContain('/Subtype /Highlight');
    expect(text).toContain('/QuadPoints');
    expect(text).toContain('/AP');
    expect(text).toContain('/BM /Multiply');
    expect(doc.getPage(0).node.Annots()?.size()).toBe(1);
  });

  it('volver a guardar reemplaza las anotaciones en vez de duplicarlas', async () => {
    const first = await bakeAnnotations(buildPdf(['A']), [make({ kind: 'rect' })]);
    const reopened = await openForEditing(first);
    const second = await bakeAnnotations(reopened.data, reopened.annotations);
    const again = await openForEditing(second);
    expect(again.annotations).toHaveLength(1);
  });

  it('un PDF sin anotaciones de Foliux se devuelve intacto', async () => {
    const data = buildPdf(['A']);
    const result = await openForEditing(data);
    expect(result.data).toBe(data);
    expect(result.annotations).toEqual([]);
  });
});

describe('operaciones de página', () => {
  it('gira páginas y adapta las anotaciones a la nueva vista', async () => {
    const note = make({ kind: 'rect' });
    const result = await transformPdf(
      buildPdf(['A', 'B']),
      [note],
      { type: 'rotate', pages: [1], degrees: 90 },
      noExternal,
    );
    const doc = await PDFDocument.load(result.data);
    expect(doc.getPage(0).getRotation().angle).toBe(90);
    expect(doc.getPage(1).getRotation().angle).toBe(0);

    const rotated = result.annotations[0];
    expect(rotated?.kind).toBe('rect');
    if (rotated?.kind === 'rect' && note.kind === 'rect') {
      // Girar 90° en sentido horario: un punto (x, y) pasa a (alto − y, x). Las dimensiones se intercambian.
      expect(rotated.rect.width).toBeCloseTo(note.rect.height);
      expect(rotated.rect.height).toBeCloseTo(note.rect.width);
      expect(rotated.rect.x).toBeCloseTo(TEST_PAGE_HEIGHT - (note.rect.y + note.rect.height));
      expect(rotated.rect.y).toBeCloseTo(note.rect.x);
    }
    expect(TEST_PAGE_WIDTH).toBe(200);
  });

  it('borra páginas y se lleva sus anotaciones; no deja borrar todas', async () => {
    const onSecond = make({ kind: 'rect', page: 2 });
    const onFirst = make({ kind: 'ellipse', page: 1 });
    const result = await transformPdf(
      buildPdf(['A', 'B', 'C']),
      [onFirst, onSecond],
      { type: 'delete', pages: [2] },
      noExternal,
    );
    expect(await pageCount(result.data)).toBe(2);
    expect(await texts(result.data)).toEqual(['A', 'C']);
    expect(result.annotations.map((a) => a.id)).toEqual([onFirst.id]);

    await expect(
      transformPdf(buildPdf(['A']), [], { type: 'delete', pages: [1] }, noExternal),
    ).rejects.toThrow(/todas las páginas/);
  });

  it('reordena y las anotaciones siguen a su página', async () => {
    const onA = make({ kind: 'rect', page: 1 });
    const result = await transformPdf(
      buildPdf(['A', 'B', 'C']),
      [onA],
      { type: 'reorder', order: [3, 1, 2] },
      noExternal,
    );
    expect(await texts(result.data)).toEqual(['C', 'A', 'B']);
    expect(result.annotations[0]?.page).toBe(2);
    expect(result.annotations[0]?.id).toBe(onA.id);

    await expect(
      transformPdf(buildPdf(['A', 'B']), [], { type: 'reorder', order: [1, 1] }, noExternal),
    ).rejects.toThrow(/no es válido/);
  });

  it('duplica páginas junto a la original', async () => {
    const result = await transformPdf(
      buildPdf(['A', 'B']),
      [make({ kind: 'rect', page: 1 })],
      { type: 'duplicate', pages: [1] },
      noExternal,
    );
    expect(await texts(result.data)).toEqual(['A', 'A', 'B']);
    // La anotación también se copia, con un identificador distinto.
    expect(result.annotations.map((a) => a.page)).toEqual([1, 2]);
    expect(new Set(result.annotations.map((a) => a.id)).size).toBe(2);
  });

  it('inserta una página en blanco con el tamaño de su vecina', async () => {
    const result = await transformPdf(
      buildPdf(['A', 'B']),
      [],
      { type: 'insertBlank', after: 1 },
      noExternal,
    );
    const doc = await PDFDocument.load(result.data);
    expect(doc.getPageCount()).toBe(3);
    expect(doc.getPage(1).getSize()).toEqual({ width: TEST_PAGE_WIDTH, height: TEST_PAGE_HEIGHT });
    expect((await texts(result.data))[1]).toBe('');
  });

  it('inserta las páginas de otro archivo en la posición pedida', async () => {
    const other = buildPdf(['X', 'Y']);
    const result = await transformPdf(
      buildPdf(['A', 'B']),
      [],
      { type: 'insertFile', after: 1, path: 'otro.pdf' },
      async () => ({ data: other, name: 'otro.pdf' }),
    );
    expect(await texts(result.data)).toEqual(['A', 'X', 'Y', 'B']);
  });

  it('rechaza páginas fuera de rango', async () => {
    await expect(
      transformPdf(buildPdf(['A']), [], { type: 'rotate', pages: [5], degrees: 90 }, noExternal),
    ).rejects.toThrow(/no existe/);
  });

  it('extrae páginas a un PDF nuevo y une varios PDFs', async () => {
    const extracted = await extractPages(buildPdf(['A', 'B', 'C']), [], [3, 1]);
    expect(await texts(extracted)).toEqual(['A', 'C']);

    const merged = await mergePdfs([
      { data: buildPdf(['A']), name: 'a.pdf' },
      { data: buildPdf(['B', 'C']), name: 'b.pdf' },
    ]);
    expect(await texts(merged)).toEqual(['A', 'B', 'C']);
  });

  it('un archivo que no es PDF da un error claro', async () => {
    await expect(
      transformPdf(new Uint8Array([1, 2, 3]), [], { type: 'delete', pages: [1] }, noExternal),
    ).rejects.toThrow(/dañado/);
  });

  it('mover una anotación no altera su tipo', () => {
    const moved = translateAnnotation(make({ kind: 'note' }), 5, 5);
    expect(moved.kind).toBe('note');
  });
});

describe('detección de clics', () => {
  it('las figuras huecas solo responden en el borde; las marcas y notas, en su área', () => {
    const rect = make({ kind: 'rect' }); // x 20..80, y 140..170
    expect(hitTestAnnotation(rect, { x: 20, y: 150 })).toBe(true); // borde izquierdo
    expect(hitTestAnnotation(rect, { x: 50, y: 155 })).toBe(false); // interior
    expect(hitTestAnnotation(rect, { x: 200, y: 10 })).toBe(false);

    expect(hitTestAnnotation(make({ kind: 'highlight' }), { x: 30, y: 25 })).toBe(true);
    expect(hitTestAnnotation(make({ kind: 'line' }), { x: 50, y: 210 })).toBe(true);
    expect(hitTestAnnotation(make({ kind: 'note' }), { x: 160, y: 30 })).toBe(true);
  });

  it('annotationAt devuelve la de más arriba y respeta la página', () => {
    const below = make({ kind: 'highlight' });
    const above = make({ kind: 'underline', rects: [{ x: 10, y: 20, width: 80, height: 12 }] });
    expect(annotationAt([below, above], 1, { x: 30, y: 25 })?.id).toBe(above.id);
    expect(annotationAt([below, above], 2, { x: 30, y: 25 })).toBeUndefined();
  });
});

describe('compatibilidad con otros lectores (PDF.js como lector ajeno)', () => {
  it('lee los 10 tipos de anotación y procesa sus apariencias sin errores', async () => {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const kinds = [
      'highlight',
      'underline',
      'strikeout',
      'ink',
      'rect',
      'ellipse',
      'line',
      'arrow',
      'note',
      'freetext',
    ] as const;
    const annotations = kinds.map((kind) => make({ kind, text: 'texto' }));
    const baked = await bakeAnnotations(buildPdf(['A']), annotations);

    const task = pdfjs.getDocument({ data: baked.slice(), useSystemFonts: true });
    const document = await task.promise;
    const page = await document.getPage(1);

    const found = await page.getAnnotations();
    const subtypes = found.map((a: { subtype: string }) => a.subtype).sort();
    expect(subtypes).toEqual(
      [
        'Circle',
        'FreeText',
        'Highlight',
        'Ink',
        'Line',
        'Line',
        'Square',
        'StrikeOut',
        'Text',
        'Underline',
      ].sort(),
    );

    // Las apariencias (AP) se interpretan: añaden operaciones gráficas respecto a la página sin anotaciones.
    const plain = await (await pdfjs.getDocument({ data: buildPdf(['A']) }).promise).getPage(1);
    const withAnnotations = await page.getOperatorList({
      annotationMode: pdfjs.AnnotationMode.ENABLE,
    });
    const without = await plain.getOperatorList({ annotationMode: pdfjs.AnnotationMode.ENABLE });
    expect(withAnnotations.fnArray.length).toBeGreaterThan(without.fnArray.length + 20);
    await task.destroy();
  });
});
