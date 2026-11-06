import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as pdfjsLegacy from 'pdfjs-dist/legacy/build/pdf.mjs';
import { PDFDocument, PDFName, PDFString, type PDFDict } from 'pdf-lib';
import {
  FoliuxError,
  FULL_PERMISSIONS,
  validateProtection,
  type Protection,
} from '@foliux-pdf/core';
import {
  QpdfService,
  inspectMetadata,
  parsePermissions,
  transformPdf,
} from '@foliux-pdf/services/node';
import { buildPdf, everything } from './helpers';

const QPDF = resolve('apps/desktop/resources/qpdf/qpdf.exe');
const hasQpdf = existsSync(QPDF);
const noExternal = () => Promise.reject(new Error('no se esperaba leer otro archivo'));

const protection = (partial: Partial<Protection> = {}): Protection => ({
  userPassword: 'abrir',
  ownerPassword: 'propietario',
  permissions: { print: 'low', copy: false, modify: false },
  ...partial,
});

describe('validateProtection', () => {
  it('acepta protecciones útiles y rechaza las vacías o peligrosas', () => {
    expect(validateProtection(protection())).toBeNull();
    // Solo contraseña de apertura, sin restringir nada
    expect(
      validateProtection(protection({ ownerPassword: 'p', permissions: FULL_PERMISSIONS })),
    ).toBeNull();
    // Sin contraseña y sin restricciones: no protege nada
    expect(
      validateProtection(protection({ userPassword: '', permissions: FULL_PERMISSIONS })),
    ).toMatch(/ninguna protección/);
    // Restringir permisos exige contraseña de propietario
    expect(validateProtection(protection({ ownerPassword: '' }))).toMatch(/propietario/);
    // Para qpdf, un valor que empieza por «-» sería una opción
    expect(validateProtection(protection({ userPassword: '--print=full' }))).toMatch(/empezar por/);
    expect(validateProtection(protection({ ownerPassword: 'a\nb' }))).toMatch(/saltos de línea/);
  });
});

describe('parsePermissions', () => {
  it('interpreta la salida de qpdf', () => {
    const report = [
      'extract for accessibility: allowed',
      'extract for any purpose: not allowed',
      'print low resolution: allowed',
      'print high resolution: not allowed',
      'modify document assembly: not allowed',
      'modify forms: not allowed',
      'modify annotations: not allowed',
      'modify other: not allowed',
      'modify anything: not allowed',
    ].join('\r\n');
    expect(parsePermissions(report)).toEqual({ print: 'low', copy: false, modify: false });
    expect(parsePermissions(report.replaceAll('not allowed', 'allowed'))).toEqual(FULL_PERMISSIONS);
  });
});

describe.skipIf(!hasQpdf)('QpdfService (qpdf real)', () => {
  const qpdf = new QpdfService(QPDF);
  const plain = buildPdf(['Texto reservado']);

  it('cifra con AES-256, pdf.js exige la contraseña y con ella lee el texto', async () => {
    const encrypted = await qpdf.encrypt(plain, protection());
    expect(QpdfService.looksEncrypted(encrypted)).toBe(true);
    expect(Buffer.from(encrypted).toString('latin1')).not.toContain('Texto reservado');

    const load = (password?: string) =>
      pdfjsLegacy.getDocument({ data: encrypted.slice(), password, useSystemFonts: true });
    const open = (password?: string) => load(password).promise;
    await expect(open()).rejects.toMatchObject({ name: 'PasswordException' });
    await expect(open('mala')).rejects.toMatchObject({ name: 'PasswordException' });
    const task = load('abrir');
    const document = await task.promise;
    const content = await (await document.getPage(1)).getTextContent();
    expect(content.items.map((i) => ('str' in i ? i.str : '')).join('')).toContain(
      'Texto reservado',
    );
    await task.destroy();
  });

  it('descifra con la contraseña correcta y devuelve la protección que tenía', async () => {
    const encrypted = await qpdf.encrypt(plain, protection());
    const opened = await qpdf.decrypt(encrypted, 'abrir');
    expect(QpdfService.looksEncrypted(opened.data)).toBe(false);
    expect(opened.protection!.userPassword).toBe('abrir');
    expect(opened.protection!.permissions).toEqual({ print: 'low', copy: false, modify: false });
    // Una propietaria desconocida se sustituye por otra (nunca queda vacía si hay restricciones)
    expect(opened.protection!.ownerPassword).not.toBe('');
    // El documento descifrado se puede editar con pdf-lib
    expect((await PDFDocument.load(opened.data)).getPageCount()).toBe(1);

    const asOwner = await qpdf.decrypt(encrypted, 'propietario');
    expect(asOwner.protection!.ownerPassword).toBe('propietario');
  });

  it('distingue «hace falta contraseña» de «contraseña incorrecta»', async () => {
    const encrypted = await qpdf.encrypt(plain, protection());
    await expect(qpdf.decrypt(encrypted)).rejects.toMatchObject({ code: 'PASSWORD_REQUIRED' });
    await expect(qpdf.decrypt(encrypted, 'mala')).rejects.toMatchObject({
      code: 'PASSWORD_INVALID',
    });
  });

  it('un PDF con permisos pero sin contraseña de apertura se abre solo y conserva las restricciones', async () => {
    const restricted = await qpdf.encrypt(
      plain,
      protection({ userPassword: '', permissions: { print: 'none', copy: true, modify: false } }),
    );
    const opened = await qpdf.decrypt(restricted); // contraseña vacía
    expect(opened.protection!.userPassword).toBe('');
    expect(opened.protection!.permissions).toEqual({ print: 'none', copy: true, modify: false });
  });

  it('admite contraseñas con espacios, comillas y Unicode', async () => {
    for (const password of [' a b"c\'d ', 'contraseña-ñandú-日本', '@arroba', 'a\\b']) {
      const encrypted = await qpdf.encrypt(plain, protection({ userPassword: password }));
      const opened = await qpdf.decrypt(encrypted, password);
      expect(opened.protection!.userPassword).toBe(password);
    }
  });

  it('rechaza las contraseñas no válidas antes de lanzar qpdf', () => {
    expect(() => qpdf.encrypt(plain, protection({ userPassword: '-x' }))).toThrow(FoliuxError);
  });

  it('si no encuentra qpdf avisa con un error claro', async () => {
    const missing = new QpdfService(resolve('no-existe/qpdf.exe'));
    await expect(missing.decrypt(plain, 'x')).rejects.toMatchObject({ code: 'QPDF_MISSING' });
  });
});

describe('poda de objetos sin uso', () => {
  /** PDF de varias páginas con un texto distinto en cada una (el contenido queda comprimido). */
  async function pagesPdf(texts: string[], withBookmarks = false): Promise<Uint8Array> {
    const doc = await PDFDocument.create();
    const pages = texts.map((text) => {
      const page = doc.addPage([200, 200]);
      page.drawText(text, { x: 10, y: 100, size: 10 });
      return page;
    });
    if (withBookmarks) {
      // Un marcador que apunta a cada página (sin el texto de la página en su título).
      const items = pages.map((page, index) =>
        doc.context.register(
          doc.context.obj({
            Title: PDFString.of(`Marcador ${index + 1}`),
            Dest: [page.ref, 'Fit'],
          }),
        ),
      );
      const root = doc.context.register(doc.context.obj({ Type: 'Outlines', Count: items.length }));
      items.forEach((ref, i) => {
        const item = doc.context.lookup(ref) as PDFDict;
        item.set(PDFName.of('Parent'), root);
        if (i > 0) item.set(PDFName.of('Prev'), items[i - 1]!);
        if (i < items.length - 1) item.set(PDFName.of('Next'), items[i + 1]!);
      });
      const rootDict = doc.context.lookup(root) as PDFDict;
      rootDict.set(PDFName.of('First'), items[0]!);
      rootDict.set(PDFName.of('Last'), items[items.length - 1]!);
      doc.catalog.set(PDFName.of('Outlines'), root);
    }
    return doc.save({ useObjectStreams: false });
  }

  it('una página eliminada ya no queda dentro del archivo', async () => {
    const result = await transformPdf(
      await pagesPdf(['Pagina visible', 'DATO-CONFIDENCIAL-12345', 'Otra']),
      [],
      { type: 'delete', pages: [2] },
      noExternal,
    );
    expect((await PDFDocument.load(result.data)).getPageCount()).toBe(2);
    const all = await everything(result.data);
    expect(all).not.toContain('DATO-CONFIDENCIAL-12345');
  });

  it('tampoco queda si un marcador del índice apuntaba a la página eliminada', async () => {
    const result = await transformPdf(
      await pagesPdf(['Pagina visible', 'DATO-CONFIDENCIAL-12345', 'Otra'], true),
      [],
      { type: 'delete', pages: [2] },
      noExternal,
    );
    expect(await everything(result.data)).not.toContain('DATO-CONFIDENCIAL-12345');
    // El documento resultante sigue siendo válido
    expect((await PDFDocument.load(result.data)).getPageCount()).toBe(2);
  });

  it('sin el arreglo, el contenido seguiría ahí: la prueba de control comprueba que el texto está antes', async () => {
    expect(await everything(await pagesPdf(['x', 'DATO-CONFIDENCIAL-12345']))).toContain(
      'DATO-CONFIDENCIAL-12345',
    );
  });
});

describe('metadatos', () => {
  /** PDF con autor, XMP, adjunto y JavaScript. */
  async function dirtyPdf(): Promise<Uint8Array> {
    const doc = await PDFDocument.create();
    doc.addPage([200, 200]);
    doc.setTitle('Informe interno');
    doc.setAuthor('Autor Secreto');
    doc.setKeywords(['clave-oculta']);
    const xmp = doc.context.stream('<x:xmpmeta>XMP-SECRETO</x:xmpmeta>', {
      Type: 'Metadata',
      Subtype: 'XML',
    });
    doc.catalog.set(PDFName.of('Metadata'), doc.context.register(xmp));
    await doc.attach(Buffer.from('contenido adjunto'), 'adjunto-secreto.txt', {
      mimeType: 'text/plain',
    });
    doc.catalog.set(
      PDFName.of('OpenAction'),
      doc.context.obj({ S: 'JavaScript', JS: PDFString.of('app.alert(1)') }),
    );
    return doc.save({ useObjectStreams: false });
  }

  it('informa de lo que contiene el documento', async () => {
    const report = await inspectMetadata(await dirtyPdf());
    expect(report).toMatchObject({
      title: 'Informe interno',
      author: 'Autor Secreto',
      keywords: 'clave-oculta',
      hasXmp: true,
      hasJavaScript: true,
      attachments: ['adjunto-secreto.txt'],
    });
  });

  it('la limpieza borra todo, también del archivo (no solo lo oculta)', async () => {
    const before = await dirtyPdf();
    const cleaned = await transformPdf(
      before,
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
    const report = await inspectMetadata(cleaned.data);
    expect(report).toMatchObject({
      title: '',
      author: '',
      keywords: '',
      hasXmp: false,
      hasJavaScript: false,
      attachments: [],
    });
    const all = await everything(cleaned.data);
    for (const secret of [
      'Autor Secreto',
      'XMP-SECRETO',
      'adjunto-secreto',
      'contenido adjunto',
      'app.alert',
    ]) {
      expect(all).not.toContain(secret);
    }
  });

  it('se puede limpiar solo una parte', async () => {
    const cleaned = await transformPdf(
      await dirtyPdf(),
      [],
      {
        type: 'cleanMetadata',
        info: true,
        xmp: false,
        thumbnails: false,
        attachments: false,
        javascript: false,
      },
      noExternal,
    );
    const report = await inspectMetadata(cleaned.data);
    expect(report.author).toBe('');
    expect(report.hasXmp).toBe(true);
    expect(report.attachments).toEqual(['adjunto-secreto.txt']);
  });
});
