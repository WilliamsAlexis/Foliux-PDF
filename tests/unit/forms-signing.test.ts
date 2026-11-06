import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as pdfjsLegacy from 'pdfjs-dist/legacy/build/pdf.mjs';
import { PDFDocument } from 'pdf-lib';
import type { FormFieldInfo } from '@foliux-pdf/core';
import {
  AuditLogService,
  auditToCsv,
  createSelfSignedCertificate,
  readFormFields,
  signPdf,
  transformPdf,
  verifyChain,
  verifySignatures,
} from '@foliux-pdf/services/node';
import { buildPdf } from './helpers';

const noExternal = () => Promise.reject(new Error('no se esperaba leer otro archivo'));

/** Documento de 200×300 con un campo de cada tipo en la página 1. */
async function formPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([200, 300]);
  const form = doc.getForm();

  const text = form.createTextField('nombre');
  text.setText('Ana');
  text.addToPage(page, { x: 20, y: 250, width: 100, height: 20 });

  const check = form.createCheckBox('acepto');
  check.addToPage(page, { x: 20, y: 220, width: 14, height: 14 });

  const dropdown = form.createDropdown('pais');
  dropdown.addOptions(['España', 'Chile', 'México']);
  dropdown.select('Chile');
  dropdown.addToPage(page, { x: 20, y: 180, width: 100, height: 20 });

  const radio = form.createRadioGroup('turno');
  radio.addOptionToPage('mañana', page, { x: 20, y: 150, width: 12, height: 12 });
  radio.addOptionToPage('tarde', page, { x: 60, y: 150, width: 12, height: 12 });

  const list = form.createOptionList('aficiones');
  list.addOptions(['leer', 'correr', 'cocinar']);
  list.addToPage(page, { x: 20, y: 90, width: 100, height: 40 });

  return doc.save({ useObjectStreams: false });
}

const byName = (fields: FormFieldInfo[], name: string) => fields.find((f) => f.name === name)!;

describe('formularios', () => {
  it('lee los campos con su tipo, valor, opciones y posición en la vista', async () => {
    const fields = await readFormFields(await formPdf());
    expect(fields.map((f) => f.name).sort()).toEqual([
      'acepto',
      'aficiones',
      'nombre',
      'pais',
      'turno',
    ]);

    const name = byName(fields, 'nombre');
    expect(name).toMatchObject({ type: 'text', value: 'Ana', multiline: false });
    // La vista tiene el origen arriba: un campo en y=250..270 (PDF) queda en y=30 con la página de 300 de alto
    expect(name.widgets[0]).toMatchObject({ page: 1 });
    expect(Math.abs(name.widgets[0]!.rect.y - 30)).toBeLessThan(1);
    expect(Math.abs(name.widgets[0]!.rect.x - 20)).toBeLessThan(1);
    expect(Math.abs(name.widgets[0]!.rect.width - 100)).toBeLessThan(2);

    expect(byName(fields, 'acepto')).toMatchObject({ type: 'checkbox', value: false });
    expect(byName(fields, 'pais')).toMatchObject({
      type: 'dropdown',
      value: ['Chile'],
      options: ['España', 'Chile', 'México'],
    });
    const radio = byName(fields, 'turno');
    expect(radio).toMatchObject({ type: 'radio', value: '' });
    expect(radio.widgets.map((w) => w.option)).toEqual(['mañana', 'tarde']);
    expect(byName(fields, 'aficiones')).toMatchObject({
      type: 'list',
      options: ['leer', 'correr', 'cocinar'],
    });
  });

  it('un PDF sin formulario devuelve una lista vacía', async () => {
    expect(await readFormFields(buildPdf(['A']))).toEqual([]);
  });

  it('rellena todos los tipos de campo y el formulario sigue siendo editable', async () => {
    const result = await transformPdf(
      await formPdf(),
      [],
      {
        type: 'fillForm',
        values: {
          nombre: 'Beatriz Núñez',
          acepto: true,
          pais: ['México'],
          turno: 'tarde',
          aficiones: ['leer', 'cocinar'],
          inexistente: 'se ignora',
        },
      },
      noExternal,
    );
    const fields = await readFormFields(result.data);
    expect(byName(fields, 'nombre').value).toBe('Beatriz Núñez');
    expect(byName(fields, 'acepto').value).toBe(true);
    expect(byName(fields, 'pais').value).toEqual(['México']);
    expect(byName(fields, 'turno').value).toBe('tarde');
    expect(byName(fields, 'aficiones').value).toEqual(['leer', 'cocinar']);
    expect(fields).toHaveLength(5);
  });

  it('se pueden vaciar los valores', async () => {
    const filled = await transformPdf(
      await formPdf(),
      [],
      { type: 'fillForm', values: { nombre: 'x', turno: 'mañana' } },
      noExternal,
    );
    const cleared = await transformPdf(
      filled.data,
      [],
      { type: 'fillForm', values: { nombre: '', turno: '' } },
      noExternal,
    );
    const fields = await readFormFields(cleared.data);
    expect(byName(fields, 'nombre').value).toBe('');
    expect(byName(fields, 'turno').value).toBe('');
  });

  it('crea campos nuevos de cada tipo y rechaza nombres repetidos o no válidos', async () => {
    const base = buildPdf(['A']);
    const rect = { x: 20, y: 50, width: 100, height: 24 };
    let data = base;
    for (const field of [
      { type: 'text' as const, name: 'dni', page: 1, rect, multiline: true },
      { type: 'checkbox' as const, name: 'ok', page: 1, rect: { ...rect, y: 90 } },
      {
        type: 'dropdown' as const,
        name: 'ciudad',
        page: 1,
        rect: { ...rect, y: 120 },
        options: ['A', 'B'],
      },
      {
        type: 'radio' as const,
        name: 'sexo',
        page: 1,
        rect: { x: 20, y: 160, width: 30, height: 40 },
        options: ['M', 'F'],
      },
      {
        type: 'list' as const,
        name: 'cosas',
        page: 1,
        rect: { ...rect, y: 210, height: 50 },
        options: ['x', 'y', 'z'],
      },
    ]) {
      data = (await transformPdf(data, [], { type: 'addFormField', field }, noExternal)).data;
    }
    const fields = await readFormFields(data);
    expect(fields.map((f) => f.type).sort()).toEqual([
      'checkbox',
      'dropdown',
      'list',
      'radio',
      'text',
    ]);
    expect(byName(fields, 'dni').multiline).toBe(true);
    expect(byName(fields, 'sexo').widgets).toHaveLength(2);
    // El campo cae donde se dibujó (en la vista)
    expect(Math.abs(byName(fields, 'dni').widgets[0]!.rect.y - 50)).toBeLessThan(1);

    await expect(
      transformPdf(
        data,
        [],
        { type: 'addFormField', field: { type: 'text', name: 'dni', page: 1, rect } },
        noExternal,
      ),
    ).rejects.toThrow(/Ya hay un campo/);
    await expect(
      transformPdf(
        base,
        [],
        { type: 'addFormField', field: { type: 'text', name: 'a.b', page: 1, rect } },
        noExternal,
      ),
    ).rejects.toThrow(/puntos/);
    await expect(
      transformPdf(
        base,
        [],
        { type: 'addFormField', field: { type: 'dropdown', name: 'd', page: 1, rect } },
        noExternal,
      ),
    ).rejects.toThrow(/al menos una opción/);
  });

  it('addFormFields crea varios campos de una vez y rechaza el lote si uno se repite', async () => {
    const base = buildPdf(['A']);
    const rect = { x: 10, y: 10, width: 80, height: 18 };
    const result = await transformPdf(
      base,
      [],
      {
        type: 'addFormFields',
        fields: [
          { type: 'text', name: 'nombre', page: 1, rect },
          { type: 'checkbox', name: 'acepto', page: 1, rect: { ...rect, y: 40 } },
        ],
      },
      noExternal,
    );
    const names = (await readFormFields(result.data)).map((f) => f.name).sort();
    expect(names).toEqual(['acepto', 'nombre']);

    await expect(
      transformPdf(
        base,
        [],
        {
          type: 'addFormFields',
          fields: [
            { type: 'text', name: 'igual', page: 1, rect },
            { type: 'text', name: 'igual', page: 1, rect: { ...rect, y: 40 } },
          ],
        },
        noExternal,
      ),
    ).rejects.toThrow(/Ya hay un campo/);
  });

  it('no crea campos en páginas giradas (aviso claro)', async () => {
    const rotated = await transformPdf(
      buildPdf(['A']),
      [],
      { type: 'rotate', pages: [1], degrees: 90 },
      noExternal,
    );
    await expect(
      transformPdf(
        rotated.data,
        [],
        {
          type: 'addFormField',
          field: {
            type: 'text',
            name: 'x',
            page: 1,
            rect: { x: 10, y: 10, width: 50, height: 20 },
          },
        },
        noExternal,
      ),
    ).rejects.toThrow(/páginas giradas/);
  });

  it('borra un campo y aplana el formulario (el valor pasa a ser texto de la página)', async () => {
    const withoutCheck = await transformPdf(
      await formPdf(),
      [],
      { type: 'deleteFormField', name: 'acepto' },
      noExternal,
    );
    expect((await readFormFields(withoutCheck.data)).map((f) => f.name)).not.toContain('acepto');

    const flat = await transformPdf(await formPdf(), [], { type: 'flattenForm' }, noExternal);
    expect(await readFormFields(flat.data)).toEqual([]);
    const task = pdfjsLegacy.getDocument({ data: flat.data.slice(), useSystemFonts: true });
    const content = await (await (await task.promise).getPage(1)).getTextContent();
    expect(content.items.map((i) => ('str' in i ? i.str : '')).join(' ')).toContain('Ana');
    await task.destroy();
  });
});

describe('firma digital', () => {
  const passphrase = 'clave-de-prueba';
  let p12: Uint8Array;
  let fingerprint: string;

  beforeAll(() => {
    ({ p12, fingerprint } = createSelfSignedCertificate({
      commonName: 'Ana Prueba',
      organization: 'Foliux',
      email: 'ana@example.com',
      days: 30,
      passphrase,
    }));
  });

  const sign = (data: Uint8Array, extra: Partial<Parameters<typeof signPdf>[1]> = {}) =>
    signPdf(data, {
      certificate: p12,
      passphrase,
      reason: 'Conforme',
      location: 'Madrid',
      contact: 'ana@example.com',
      ...extra,
    });

  it('firma y la verificación confirma el firmante, el motivo y que nada cambió', async () => {
    const signed = await sign(buildPdf(['Contrato']));
    const [report] = verifySignatures(signed);
    expect(report).toMatchObject({
      index: 1,
      signer: 'Ana Prueba',
      integrity: 'valid',
      coversWholeDocument: true,
      selfSigned: true,
      expiredWhenSigned: false,
      reason: 'Conforme',
      location: 'Madrid',
      fingerprint,
    });
    expect(new Date(report!.signedAt).getTime()).toBeGreaterThan(Date.now() - 60_000);
    // Avisos honestos
    expect(report!.notes.join(' ')).toMatch(/autofirmado/);
    expect(report!.notes.join(' ')).toMatch(/sello de tiempo/);
  });

  it('el PDF firmado sigue siendo un PDF válido (pdf.js y pdf-lib lo abren)', async () => {
    const signed = await sign(buildPdf(['Contrato']));
    const task = pdfjsLegacy.getDocument({ data: signed.slice(), useSystemFonts: true });
    expect((await task.promise).numPages).toBe(1);
    await task.destroy();
    expect((await PDFDocument.load(signed)).getPageCount()).toBe(1);
  });

  it('detecta que el documento se alteró después de firmar', async () => {
    const signed = Buffer.from(await sign(buildPdf(['Contrato de venta por 1000 euros'])));
    // Se cambia el importe dentro del contenido firmado
    const at = signed.indexOf('1000');
    expect(at).toBeGreaterThan(0);
    signed.write('9000', at, 'latin1');
    expect(verifySignatures(new Uint8Array(signed))[0]).toMatchObject({ integrity: 'modified' });
  });

  it('avisa si se añadió contenido tras la firma (la firma en sí sigue siendo correcta)', async () => {
    const signed = await sign(buildPdf(['Contrato']));
    const extended = new Uint8Array([...signed, ...Buffer.from('\n% añadido después\n')]);
    const [report] = verifySignatures(extended);
    expect(report).toMatchObject({ integrity: 'valid', coversWholeDocument: false });
    expect(report!.notes.join(' ')).toMatch(/después de esta firma/);
  });

  it('detecta una firma que no corresponde al certificado', async () => {
    const signed = Buffer.from(await sign(buildPdf(['Contrato'])));
    const text = signed.toString('latin1');
    const gap = /\/Contents\s*<([0-9a-fA-F]+)>/.exec(text)!;
    // Se estropea el valor de la firma (no el resumen): el contenido firmado sigue igual
    const hex = gap[1]!;
    // El valor de la firma RSA son los últimos bytes del bloque (antes del relleno de ceros): se estropea uno de ahí.
    const trimmedLength = hex.replace(/0+$/, '').length;
    const sigStart = gap.index + gap[0].indexOf('<') + 1 + trimmedLength - 20;
    const original = signed[sigStart]!;
    signed[sigStart] = original === 0x41 ? 0x42 : 0x41;
    const [report] = verifySignatures(new Uint8Array(signed));
    expect(['invalid', 'unreadable']).toContain(report!.integrity);
    expect(report!.integrity).not.toBe('valid');
  });

  it('una contraseña de certificado incorrecta da un error claro', async () => {
    await expect(sign(buildPdf(['A']), { passphrase: 'mala' })).rejects.toMatchObject({
      code: 'PASSWORD_INVALID',
    });
  });

  it('un documento sin firmas devuelve una lista vacía', () => {
    expect(verifySignatures(buildPdf(['A']))).toEqual([]);
  });
});

describe('registro de auditoría', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'foliux-audit-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const input = (n: number) => ({
    action: 'digital-signature' as const,
    file: `doc${n}.pdf`,
    fileHash: `hash${n}`,
    signer: 'Ana',
    detail: `Motivo "${n}", con comas`,
  });

  it('encadena las entradas y la cadena se verifica', async () => {
    const log = new AuditLogService(join(dir, 'a.jsonl'));
    expect(await log.list()).toEqual([]);
    for (let i = 1; i <= 3; i++) await log.append(input(i));
    const entries = await log.list();
    expect(entries.map((e) => e.id)).toEqual([1, 2, 3]);
    expect(entries[1]!.prevHash).toBe(entries[0]!.hash);
    expect(await log.verify()).toEqual({ ok: true });
  });

  it('detecta una entrada cambiada, borrada o reordenada', async () => {
    const path = join(dir, 'b.jsonl');
    const log = new AuditLogService(path);
    for (let i = 1; i <= 4; i++) await log.append(input(i));
    const lines = (await readFile(path, 'utf8')).trim().split('\n');

    // Cambiar el contenido de la entrada 2
    await writeFile(
      path,
      [lines[0], lines[1]!.replace('doc2', 'docX'), lines[2], lines[3]].join('\n') + '\n',
    );
    expect(await log.verify()).toEqual({ ok: false, brokenAt: 2 });

    // Borrar la entrada 2
    await writeFile(path, [lines[0], lines[2], lines[3]].join('\n') + '\n');
    expect((await log.verify()).ok).toBe(false);

    // Reordenar
    await writeFile(path, [lines[0], lines[2], lines[1], lines[3]].join('\n') + '\n');
    expect((await log.verify()).ok).toBe(false);

    // Borrar la última no se puede detectar por la cadena (documentado), pero el resto sigue siendo coherente
    await writeFile(path, lines.slice(0, 3).join('\n') + '\n');
    expect(await log.verify()).toEqual({ ok: true });
  });

  it('las escrituras simultáneas no repiten números ni rompen la cadena', async () => {
    const log = new AuditLogService(join(dir, 'c.jsonl'));
    await Promise.all(Array.from({ length: 25 }, (_, i) => log.append(input(i))));
    const entries = await log.list();
    expect(entries.map((e) => e.id)).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
    expect(verifyChain(entries)).toEqual({ ok: true });
  });

  it('exporta a CSV con comillas escapadas y marca BOM para Excel', async () => {
    const log = new AuditLogService(join(dir, 'd.jsonl'));
    await log.append(input(1));
    const csv = auditToCsv(await log.list());
    expect(csv.startsWith('﻿')).toBe(true);
    expect(csv).toContain('"Motivo ""1"", con comas"');
    expect(csv.trim().split('\r\n')).toHaveLength(2);
  });
});
