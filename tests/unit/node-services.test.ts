import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FoliuxError } from '@foliux-pdf/core';
import { RecentFilesService, SettingsService, readPdfFile } from '@foliux-pdf/services/node';
import { makeTempDir, writeTestPdf } from './helpers';

let dir: string;
let cleanup: () => Promise<void>;

beforeEach(async () => {
  ({ dir, cleanup } = await makeTempDir());
});
afterEach(() => cleanup());

async function touch(name: string): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, 'x');
  return path;
}

describe('RecentFilesService', () => {
  it('pone primero el archivo más reciente y no duplica', async () => {
    const service = new RecentFilesService(join(dir, 'recent.json'));
    const a = await touch('a.pdf');
    const b = await touch('b.pdf');

    await service.add(a);
    await service.add(b);
    await service.add(a);

    expect((await service.list()).map((r) => r.name)).toEqual(['a.pdf', 'b.pdf']);
  });

  it('respeta el máximo de elementos', async () => {
    const service = new RecentFilesService(join(dir, 'recent.json'), 3);
    for (let i = 0; i < 5; i++) await service.add(await touch(`f${i}.pdf`));

    const names = (await service.list()).map((r) => r.name);
    expect(names).toEqual(['f4.pdf', 'f3.pdf', 'f2.pdf']);
  });

  it('persiste entre instancias y descarta archivos que ya no existen', async () => {
    const store = join(dir, 'recent.json');
    const a = await touch('a.pdf');
    const b = await touch('b.pdf');
    const first = new RecentFilesService(store);
    await first.add(a);
    await first.add(b);

    await writeFile(a, 'x'); // sigue existiendo
    const { rm } = await import('node:fs/promises');
    await rm(a);

    const second = new RecentFilesService(store);
    expect((await second.list()).map((r) => r.name)).toEqual(['b.pdf']);
  });

  it('remove y clear funcionan', async () => {
    const service = new RecentFilesService(join(dir, 'recent.json'));
    const a = await touch('a.pdf');
    const b = await touch('b.pdf');
    await service.add(a);
    await service.add(b);

    await service.remove(a);
    expect((await service.list()).map((r) => r.name)).toEqual(['b.pdf']);
    await service.clear();
    expect(await service.list()).toEqual([]);
  });

  it('operaciones simultáneas no se pisan', async () => {
    const service = new RecentFilesService(join(dir, 'recent.json'));
    const files = await Promise.all([1, 2, 3, 4].map((i) => touch(`p${i}.pdf`)));
    await Promise.all(files.map((f) => service.add(f)));
    expect(await service.list()).toHaveLength(4);
  });

  it('un JSON corrupto no rompe: empieza vacío', async () => {
    const store = join(dir, 'recent.json');
    await writeFile(store, '{ esto no es json');
    expect(await new RecentFilesService(store).list()).toEqual([]);
  });
});

describe('SettingsService', () => {
  it('devuelve valores por defecto si no hay archivo', async () => {
    const service = new SettingsService(join(dir, 'settings.json'));
    expect(await service.get()).toEqual({
      theme: 'system',
      language: 'es',
      aiModel: 'claude-opus-5-5',
      autoCheckUpdates: true,
    });
  });

  it('guarda cambios parciales y los recuerda', async () => {
    const path = join(dir, 'nested', 'settings.json');
    await new SettingsService(path).update({ theme: 'dark' });

    expect(await new SettingsService(path).get()).toEqual({
      theme: 'dark',
      language: 'es',
      aiModel: 'claude-opus-5-5',
      autoCheckUpdates: true,
    });
  });

  it('corrige un tema inválido en disco', async () => {
    const path = join(dir, 'settings.json');
    await mkdir(dir, { recursive: true });
    await writeFile(path, JSON.stringify({ theme: 'rosa', language: 'es' }));
    expect((await new SettingsService(path).get()).theme).toBe('system');
  });

  it('no deja archivos temporales tras guardar', async () => {
    const path = join(dir, 'settings.json');
    await new SettingsService(path).update({ theme: 'light' });
    expect(JSON.parse(await readFile(path, 'utf8')).theme).toBe('light');
  });
});

describe('readPdfFile', () => {
  it('lee un PDF válido', async () => {
    const path = await writeTestPdf(dir, 'ok.pdf', ['Hola']);
    const file = await readPdfFile(path);
    expect(file.name).toBe('ok.pdf');
    expect(file.data.length).toBeGreaterThan(100);
  });

  it('rechaza archivos con otra extensión', async () => {
    const path = await touch('nota.txt');
    await expect(readPdfFile(path)).rejects.toMatchObject({ code: 'NOT_A_PDF' });
  });

  it('rechaza un .pdf que no es un PDF', async () => {
    const path = join(dir, 'falso.pdf');
    await writeFile(path, 'esto no es un PDF');
    await expect(readPdfFile(path)).rejects.toMatchObject({ code: 'NOT_A_PDF' });
  });

  it('da un error claro si el archivo no existe', async () => {
    const error = await readPdfFile(join(dir, 'no-existe.pdf')).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FoliuxError);
    expect((error as FoliuxError).code).toBe('FILE_NOT_FOUND');
    expect((error as FoliuxError).message).toContain('no-existe.pdf');
  });
});
