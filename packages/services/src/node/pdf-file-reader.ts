import { open, stat } from 'node:fs/promises';
import { basename, extname, resolve } from 'node:path';
import { FoliuxError, type PdfFile } from '@foliux-pdf/core';

/** Tamaño máximo que se acepta abrir (1 GiB). */
export const MAX_PDF_BYTES = 1024 * 1024 * 1024;

/**
 * Lee un PDF de disco comprobando antes que realmente lo es.
 * Es la única vía por la que el renderer puede pedir contenido de archivos, y solo de PDFs.
 */
export async function readPdfFile(path: string): Promise<PdfFile> {
  const full = resolve(path);
  const name = basename(full);

  if (extname(full).toLowerCase() !== '.pdf') {
    throw new FoliuxError('NOT_A_PDF', `«${name}» no es un archivo PDF.`);
  }

  let size: number;
  try {
    const info = await stat(full);
    if (!info.isFile()) throw new FoliuxError('FILE_NOT_FOUND', `«${name}» no es un archivo.`);
    size = info.size;
  } catch (error) {
    if (error instanceof FoliuxError) throw error;
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new FoliuxError(
        'FILE_NOT_FOUND',
        `No se encontró el archivo «${name}». ¿Se movió o se borró?`,
      );
    }
    throw new FoliuxError('IO_ERROR', `No se pudo acceder a «${name}».`, { cause: error });
  }

  if (size > MAX_PDF_BYTES) {
    throw new FoliuxError('FILE_TOO_LARGE', `«${name}» es demasiado grande (máximo 1 GB).`);
  }

  try {
    const handle = await open(full, 'r');
    try {
      const buffer = Buffer.alloc(size);
      await handle.read(buffer, 0, size, 0);

      // Los PDFs empiezan con "%PDF-" (algunos tienen basura antes, hasta 1 KiB).
      const head = buffer.subarray(0, Math.min(1024, size)).toString('latin1');
      if (!head.includes('%PDF-')) {
        throw new FoliuxError('NOT_A_PDF', `«${name}» no parece un PDF válido.`);
      }
      return { path: full, name, data: new Uint8Array(buffer) };
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error instanceof FoliuxError) throw error;
    throw new FoliuxError('IO_ERROR', `No se pudo leer «${name}».`, { cause: error });
  }
}
