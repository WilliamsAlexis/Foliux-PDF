import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { NewDocumentSchema, pageSizeFor } from '@foliux-pdf/core';
import { createBlankPdf, transformPdf } from '@foliux-pdf/services/node';

describe('PDF nuevo', () => {
  it('crea un PDF válido con las páginas y el tamaño pedidos', async () => {
    const data = await createBlankPdf({ width: 300, height: 400, pages: 3 });
    const doc = await PDFDocument.load(data, { updateMetadata: false });
    expect(doc.getPageCount()).toBe(3);
    expect(doc.getPage(0).getSize()).toEqual({ width: 300, height: 400 });
    expect(doc.getProducer()).toBe('Foliux PDF');
  });

  it('el documento nuevo admite las operaciones normales (añadir una página)', async () => {
    const data = await createBlankPdf({ width: 200, height: 200, pages: 1 });
    const result = await transformPdf(data, [], { type: 'insertBlank', after: 1 }, async () => {
      throw new Error('no se esperaba leer otro archivo');
    });
    expect((await PDFDocument.load(result.data)).getPageCount()).toBe(2);
  });

  it('A4 en vertical y en horizontal', () => {
    const portrait = pageSizeFor('a4', 'portrait');
    const landscape = pageSizeFor('a4', 'landscape');
    expect(portrait.width).toBeLessThan(portrait.height);
    expect(landscape).toEqual({ width: portrait.height, height: portrait.width });
  });

  it('rechaza medidas o páginas fuera de rango', () => {
    expect(NewDocumentSchema.safeParse({ width: 10, height: 300, pages: 1 }).success).toBe(false);
    expect(NewDocumentSchema.safeParse({ width: 300, height: 99999, pages: 1 }).success).toBe(
      false,
    );
    expect(NewDocumentSchema.safeParse({ width: 300, height: 300, pages: 0 }).success).toBe(false);
    expect(NewDocumentSchema.safeParse({ width: 300, height: 300, pages: 201 }).success).toBe(
      false,
    );
    expect(NewDocumentSchema.safeParse({ width: 300, height: 300, pages: 5 }).success).toBe(true);
  });
});
