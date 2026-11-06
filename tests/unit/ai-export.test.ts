import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import ExcelJS from 'exceljs';
import { FoliuxError } from '@foliux-pdf/core';
import {
  buildDeckPptx,
  buildTablesXlsx,
  EncryptedKeyStore,
  type KeyCipher,
} from '@foliux-pdf/services/node';

const KEY = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789';

/** Cifrado de pega: invierte los bytes. Basta para comprobar que en disco no queda la clave en claro. */
function fakeCipher(available = true): KeyCipher {
  return {
    isAvailable: () => available,
    encrypt: (plain) => new TextEncoder().encode(plain).reverse(),
    decrypt: (data) => new TextDecoder().decode(new Uint8Array(data).reverse()),
  };
}

describe('EncryptedKeyStore', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'foliux-key-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('guarda la clave cifrada: el archivo no contiene la clave en claro', async () => {
    const path = join(dir, 'ai-key.bin');
    const store = new EncryptedKeyStore(path, fakeCipher());
    await store.set(`  ${KEY}  `);
    const onDisk = (await readFile(path)).toString('latin1');
    expect(onDisk).not.toContain(KEY);
    expect(await store.get()).toBe(KEY);
    expect(await store.has()).toBe(true);
  });

  it('sin clave guardada devuelve null y clear() es idempotente', async () => {
    const store = new EncryptedKeyStore(join(dir, 'nada.bin'), fakeCipher());
    expect(await store.get()).toBeNull();
    expect(await store.has()).toBe(false);
    await expect(store.clear()).resolves.toBeUndefined();
  });

  it('clear() borra el archivo', async () => {
    const path = join(dir, 'ai-key.bin');
    const store = new EncryptedKeyStore(path, fakeCipher());
    await store.set(KEY);
    await store.clear();
    await expect(stat(path)).rejects.toThrow();
    expect(await store.has()).toBe(false);
  });

  it('rechaza lo que no parece una clave de Anthropic', async () => {
    const store = new EncryptedKeyStore(join(dir, 'k.bin'), fakeCipher());
    await expect(store.set('hola')).rejects.toBeInstanceOf(FoliuxError);
    await expect(store.set('sk-proj-' + 'a'.repeat(40))).rejects.toBeInstanceOf(FoliuxError);
  });

  it('sin cifrado del sistema no guarda nada (nunca en claro)', async () => {
    const path = join(dir, 'k.bin');
    const store = new EncryptedKeyStore(path, fakeCipher(false));
    await expect(store.set(KEY)).rejects.toMatchObject({ code: 'AI_ERROR' });
    await expect(stat(path)).rejects.toThrow();
    expect(store.secureStorage).toBe(false);
    expect(await store.get()).toBeNull();
  });

  it('un archivo dañado se trata como «sin clave»', async () => {
    const path = join(dir, 'k.bin');
    const failing: KeyCipher = {
      ...fakeCipher(),
      decrypt: () => {
        throw new Error('no se puede descifrar');
      },
    };
    await new EncryptedKeyStore(path, fakeCipher()).set(KEY);
    expect(await new EncryptedKeyStore(path, failing).get()).toBeNull();
  });
});

describe('exportadores de la IA', () => {
  it('buildTablesXlsx crea una hoja por tabla con cabecera y números', async () => {
    const bytes = await buildTablesXlsx([
      {
        title: 'Ventas',
        page: 2,
        headers: ['Mes', 'Importe'],
        rows: [
          ['Enero', '1200'],
          ['Febrero', '0034'],
        ],
      },
      { title: 'Ventas', page: 2, headers: [], rows: [['a', 'b']] },
    ]);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(bytes as unknown as ArrayBuffer);
    expect(workbook.worksheets).toHaveLength(2);
    const first = workbook.worksheets[0]!;
    expect(first.name).toBe('Ventas (p. 2)');
    expect(first.getRow(1).getCell(1).value).toBe('Mes');
    expect(first.getRow(2).getCell(2).value).toBe(1200);
    // Un valor que empieza por 0 se conserva como texto (códigos, teléfonos).
    expect(first.getRow(3).getCell(2).value).toBe('0034');
    // Dos tablas con el mismo título no pueden compartir nombre de hoja.
    expect(workbook.worksheets[1]!.name).not.toBe(first.name);
  });

  it('buildTablesXlsx limpia los caracteres que Excel no admite en un nombre de hoja', async () => {
    const title = 'a/b?c*d[e]f:g\\h' + 'x'.repeat(40);
    const bytes = await buildTablesXlsx([{ title, page: 1, headers: [], rows: [['1']] }]);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(bytes as unknown as ArrayBuffer);
    const name = workbook.worksheets[0]!.name;
    expect(name.length).toBeLessThanOrEqual(31);
    expect(/[\\/?*[\]:]/.test(name)).toBe(false);
  });

  it('buildTablesXlsx sin tablas es un error claro', async () => {
    await expect(buildTablesXlsx([])).rejects.toBeInstanceOf(FoliuxError);
  });

  it('buildDeckPptx crea una diapositiva por entrada con sus notas', async () => {
    const bytes = await buildDeckPptx({
      title: 'Informe',
      slides: [
        { title: 'Portada', bullets: ['Resumen anual'], notes: '' },
        {
          title: 'Resultados',
          bullets: ['Ventas +10 %', 'Costes estables'],
          notes: 'Hablar despacio',
        },
        { title: 'Cierre', bullets: [], notes: '' },
      ],
    });
    const zip = await JSZip.loadAsync(bytes);
    const slides = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n));
    expect(slides).toHaveLength(3);
    const second = await zip.file('ppt/slides/slide2.xml')!.async('string');
    expect(second).toContain('Resultados');
    expect(second).toContain('Ventas +10 %');
    const notes = Object.keys(zip.files).filter((n) =>
      /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(n),
    );
    const noteTexts = await Promise.all(notes.map((n) => zip.file(n)!.async('string')));
    expect(noteTexts.some((text) => text.includes('Hablar despacio'))).toBe(true);
  });
});
