import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, extname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FoliuxError } from '@foliux-pdf/core';

/**
 * Conversión de documentos de Office a PDF con LibreOffice (programa externo, MPL 2.0). Foliux NO lo
 * incluye (pesa cientos de megas): si el usuario lo tiene instalado se usa; si no, se le avisa.
 */

export const OFFICE_EXTENSIONS = [
  '.doc',
  '.docx',
  '.odt',
  '.rtf',
  '.xls',
  '.xlsx',
  '.ods',
  '.ppt',
  '.pptx',
  '.odp',
];

const CANDIDATES = [
  process.env['LIBREOFFICE_PATH'] ?? '',
  'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
  'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe',
  '/usr/bin/soffice',
  '/usr/local/bin/soffice',
  '/opt/libreoffice/program/soffice',
  '/Applications/LibreOffice.app/Contents/MacOS/soffice',
];

export function findLibreOffice(): string | null {
  return CANDIDATES.find((path) => path !== '' && existsSync(path)) ?? null;
}

const TIMEOUT_MS = 5 * 60 * 1000;

/** Convierte un documento de Office a PDF. Devuelve los bytes del PDF. */
export async function convertOfficeToPdf(
  inputPath: string,
  signal?: AbortSignal,
  executable: string | null = findLibreOffice(),
): Promise<Uint8Array> {
  if (!executable) {
    throw new FoliuxError(
      'LIBREOFFICE_MISSING',
      'Para convertir documentos de Office a PDF hace falta LibreOffice (es gratuito). Instálalo y vuelve a intentarlo.',
    );
  }
  const extension = extname(inputPath).toLowerCase();
  if (!OFFICE_EXTENSIONS.includes(extension)) {
    throw new FoliuxError(
      'INVALID_REQUEST',
      `«${basename(inputPath)}» no es un documento de Office admitido.`,
    );
  }

  const work = await mkdtemp(join(tmpdir(), 'foliux-office-'));
  try {
    // Un perfil de usuario propio evita choques con un LibreOffice que el usuario ya tenga abierto.
    const profile = pathToFileURL(join(work, 'profile')).href;
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        executable,
        [
          '--headless',
          '--norestore',
          '--nolockcheck',
          `-env:UserInstallation=${profile}`,
          '--convert-to',
          'pdf',
          '--outdir',
          work,
          inputPath,
        ],
        { stdio: 'ignore', windowsHide: true, signal, timeout: TIMEOUT_MS },
      );
      child.on('error', reject);
      child.on('close', (code) =>
        code === 0 ? resolve() : reject(new Error(`LibreOffice terminó con el código ${code}`)),
      );
    });
    const output = join(work, `${basename(inputPath, extension)}.pdf`);
    if (!existsSync(output)) throw new Error('LibreOffice no generó el PDF');
    return new Uint8Array(await readFile(output));
  } catch (error) {
    if ((error as Error).name === 'AbortError') throw error;
    throw new FoliuxError('IO_ERROR', 'No se pudo convertir el documento con LibreOffice.', {
      cause: error,
    });
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => undefined);
  }
}
