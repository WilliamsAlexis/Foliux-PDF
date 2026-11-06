import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FoliuxError, buildWorkspaceText, type PageWord } from '@foliux-pdf/core';
import { WorkspaceService } from '@foliux-pdf/services/node';

const word = (text: string, x = 10, y = 10): PageWord => ({
  text,
  x,
  y,
  width: text.length * 6,
  height: 10,
});

/** Documento de `pages` páginas con `wordsPerPage` palabras cada una. */
function fakeDoc(name: string, pages: number, wordsPerPage: number) {
  return {
    name,
    pages: Array.from({ length: pages }, (_p, p) => ({
      words: Array.from({ length: wordsPerPage }, (_w, i) =>
        word(`${name}${p}x${i}`, 10 + i * 40, 10),
      ),
    })),
  };
}

describe('WorkspaceService', () => {
  let dir: string;
  let service: WorkspaceService;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'foliux-ws-'));
    service = new WorkspaceService(join(dir, 'workspaces.json'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('crea, lista y renombra espacios, y persiste en disco', async () => {
    const created = await service.create('  Proyecto Alfa ');
    expect(created.name).toBe('Proyecto Alfa');
    await service.rename(created.id, 'Alfa 2');
    const again = new WorkspaceService(join(dir, 'workspaces.json'));
    expect((await again.list()).map((w) => w.name)).toEqual(['Alfa 2']);
  });

  it('rechaza nombres vacíos o demasiado largos', async () => {
    await expect(service.create('   ')).rejects.toBeInstanceOf(FoliuxError);
    await expect(service.create('x'.repeat(81))).rejects.toBeInstanceOf(FoliuxError);
  });

  it('añade documentos sin repetirlos (sin distinguir mayúsculas) e indica si existen', async () => {
    const real = join(dir, 'real.pdf');
    await writeFile(real, 'x');
    const ws = await service.create('P');
    const view = await service.addDocuments(ws.id, [
      real,
      real.toUpperCase(),
      join(dir, 'falta.pdf'),
    ]);
    expect(view.documents.map((d) => d.name)).toEqual(['real.pdf', 'falta.pdf']);
    expect(view.documents.map((d) => d.exists)).toEqual([true, false]);
  });

  it('quita un documento y borra el espacio', async () => {
    const ws = await service.create('P');
    await service.addDocuments(ws.id, [join(dir, 'a.pdf'), join(dir, 'b.pdf')]);
    const view = await service.removeDocument(ws.id, join(dir, 'A.PDF'));
    expect(view.documents.map((d) => d.name)).toEqual(['b.pdf']);
    await service.delete(ws.id);
    expect(await service.list()).toEqual([]);
  });

  it('un espacio inexistente es un error claro', async () => {
    await expect(service.addDocuments('no-existe', [join(dir, 'a.pdf')])).rejects.toBeInstanceOf(
      FoliuxError,
    );
  });

  it('cambios simultáneos no se pisan', async () => {
    const ws = await service.create('P');
    await Promise.all(
      ['a', 'b', 'c', 'd', 'e'].map((n) => service.addDocuments(ws.id, [join(dir, `${n}.pdf`)])),
    );
    const [view] = await service.list();
    expect(view!.documents).toHaveLength(5);
  });
});

describe('buildWorkspaceText', () => {
  it('une los documentos con cabecera y marcas de página', () => {
    const result = buildWorkspaceText([fakeDoc('uno', 2, 3), fakeDoc('dos', 1, 3)], 1_000_000);
    expect(result.text).toContain('=== Documento 1: uno (2 páginas) ===');
    expect(result.text).toContain('=== Documento 2: dos (1 páginas) ===');
    expect(result.text).toContain('[Página 2]');
    expect(result.totalPages).toBe(3);
    expect(result.includedPages).toBe(3);
    expect(result.truncated).toBe(false);
  });

  it('si no cabe, los documentos cortos entran enteros y el grande se recorta por páginas', () => {
    const small = fakeDoc('corto', 1, 5);
    const big = fakeDoc('largo', 40, 60);
    const result = buildWorkspaceText([big, small], 6000);
    const [bigEntry, smallEntry] = result.documents;
    expect(smallEntry!.truncated).toBe(false);
    expect(smallEntry!.includedPages).toBe(1);
    expect(bigEntry!.truncated).toBe(true);
    expect(bigEntry!.includedPages).toBeGreaterThan(0);
    expect(bigEntry!.includedPages).toBeLessThan(40);
    expect(result.truncated).toBe(true);
    // El presupuesto se respeta (con un pequeño margen por la primera página obligatoria).
    expect(result.text.length).toBeLessThan(7500);
  });

  it('el nombre del archivo no puede romper la cabecera ni introducir etiquetas', () => {
    const result = buildWorkspaceText([fakeDoc('a<b>\nc', 1, 2)], 100_000);
    const header = result.text.split('\n')[0]!;
    expect(header).toBe('=== Documento 1: a b c (1 páginas) ===');
    expect(result.documents[0]!.name).toBe('a b c');
  });

  it('con documentos sin texto no falla', () => {
    const result = buildWorkspaceText([{ name: 'vacío', pages: [{ words: [] }] }], 1000);
    expect(result.totalPages).toBe(1);
    expect(result.text).toContain('[Página 1]');
  });
});
