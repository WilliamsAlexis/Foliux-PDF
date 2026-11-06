import { rename, rm, writeFile } from 'node:fs/promises';
import { basename, extname, resolve } from 'node:path';
import { FoliuxError } from '@foliux-pdf/core';

/**
 * Guarda un PDF de forma segura: escribe primero un archivo temporal y lo renombra al final,
 * así un fallo a mitad (disco lleno, corte) nunca deja el documento original a medias.
 */
export async function writePdfFile(path: string, data: Uint8Array): Promise<string> {
  const full = resolve(path);
  const name = basename(full);
  if (extname(full).toLowerCase() !== '.pdf') {
    throw new FoliuxError('NOT_A_PDF', `«${name}» debe tener la extensión .pdf.`);
  }

  const temp = `${full}.foliux-tmp`;
  try {
    await writeFile(temp, data);
    await rename(temp, full);
    return full;
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') {
      throw new FoliuxError(
        'IO_ERROR',
        `No se pudo guardar «${name}»: el archivo está en uso o no tienes permiso. Prueba con «Guardar como».`,
        { cause: error },
      );
    }
    throw new FoliuxError('IO_ERROR', `No se pudo guardar «${name}».`, { cause: error });
  }
}
