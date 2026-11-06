import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FoliuxError,
  validateProtection,
  type Permissions,
  type Protection,
} from '@foliux-pdf/core';

/**
 * Cifrado y descifrado de PDFs con qpdf (Apache 2.0, programa externo).
 *
 * Las contraseñas se pasan a qpdf por su entrada estándar («@-»), nunca como argumentos de la línea
 * de comandos (que cualquier usuario del equipo puede ver en la lista de procesos) ni en un archivo.
 * Los PDF viajan por una carpeta temporal propia que se borra siempre al terminar.
 */

const TIMEOUT_MS = 5 * 60 * 1000;

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Esquema de la salida de «qpdf --show-encryption». */
export function parsePermissions(report: string): Permissions {
  const allowed = (label: string) => new RegExp(`${label}: allowed`, 'i').test(report);
  const print = allowed('print high resolution')
    ? 'full'
    : allowed('print low resolution')
      ? 'low'
      : 'none';
  const modify =
    allowed('modify anything') ||
    (allowed('modify document assembly') &&
      allowed('modify forms') &&
      allowed('modify annotations') &&
      allowed('modify other'));
  return { print, copy: allowed('extract for any purpose'), modify };
}

export class QpdfService {
  /** @param executable Ruta de qpdf (la incluida con la aplicación o la del sistema). */
  constructor(private readonly executable: string) {}

  private run(args: string[], signal?: AbortSignal): Promise<RunResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.executable, ['@-'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        signal,
        timeout: TIMEOUT_MS,
      });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
      child.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') {
          reject(
            new FoliuxError(
              'QPDF_MISSING',
              'No se encuentra qpdf, el programa que cifra y descifra PDFs. Reinstala Foliux PDF.',
              { cause: error },
            ),
          );
        } else {
          reject(error);
        }
      });
      child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
      // Un argumento por línea: ninguno puede contener saltos de línea (ver validateProtection).
      child.stdin.end(args.join('\n'));
    });
  }

  /** Ejecuta qpdf con una carpeta temporal que se borra siempre. */
  private async withTempDir<T>(work: (dir: string) => Promise<T>): Promise<T> {
    const dir = await mkdtemp(join(tmpdir(), 'foliux-qpdf-'));
    try {
      return await work(dir);
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /** ¿Está cifrado el documento? Comprobación rápida por contenido, sin lanzar qpdf. */
  static looksEncrypted(data: Uint8Array): boolean {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).includes('/Encrypt');
  }

  /**
   * Quita el cifrado. Con una contraseña incorrecta (o ninguna cuando hace falta) lanza
   * PASSWORD_REQUIRED / PASSWORD_INVALID. Devuelve el documento descifrado y la protección que tenía.
   */
  decrypt(
    data: Uint8Array,
    password = '',
    signal?: AbortSignal,
  ): Promise<{ data: Uint8Array; protection: Protection | null }> {
    return this.withTempDir(async (dir) => {
      const input = join(dir, 'in.pdf');
      const output = join(dir, 'out.pdf');
      await writeFile(input, data);

      const info = await this.run(['--show-encryption', `--password=${password}`, input], signal);
      const report = info.stdout;
      // La marca «/Encrypt» también puede aparecer en un PDF que no está cifrado.
      if (/File is not encrypted/i.test(report)) return { data, protection: null };
      const supplied = /Supplied password is (user|owner) password/i.exec(report)?.[1] as
        'user' | 'owner' | undefined;
      if (!supplied) {
        throw password === ''
          ? new FoliuxError('PASSWORD_REQUIRED', 'Este PDF está protegido: escribe su contraseña.')
          : new FoliuxError('PASSWORD_INVALID', 'La contraseña no es correcta.');
      }

      const result = await this.run(['--decrypt', `--password=${password}`, input, output], signal);
      // 0 = bien, 3 = bien con advertencias; con otro código no hay resultado fiable.
      if (result.code !== 0 && result.code !== 3) {
        throw new FoliuxError('PDF_CORRUPT', 'No se pudo quitar la protección de este PDF.', {
          cause: new Error(result.stderr),
        });
      }

      // Contraseñas: la que se escribió es de apertura o de propietario según lo que dijo qpdf. De la otra
      // solo se conoce el valor en cifrados antiguos (qpdf lo muestra); si no, se genera una nueva al volver a cifrar.
      const revealedUser = /^User password = (.*?)\r?$/im.exec(report)?.[1] ?? '';
      const userPassword = supplied === 'user' ? password : revealedUser;
      const ownerPassword = supplied === 'owner' ? password : randomBytes(16).toString('hex');
      return {
        data: new Uint8Array(await readFile(output)),
        protection: { userPassword, ownerPassword, permissions: parsePermissions(report) },
      };
    });
  }

  /** Cifra con AES-256 aplicando los permisos indicados. */
  encrypt(data: Uint8Array, protection: Protection, signal?: AbortSignal): Promise<Uint8Array> {
    const problem = validateProtection(protection);
    if (problem) throw new FoliuxError('INVALID_REQUEST', problem);

    return this.withTempDir(async (dir) => {
      const input = join(dir, 'in.pdf');
      const output = join(dir, 'out.pdf');
      await writeFile(input, data);

      const { print, copy, modify } = protection.permissions;
      const result = await this.run(
        [
          '--encrypt',
          protection.userPassword,
          protection.ownerPassword,
          '256',
          `--print=${print}`,
          `--extract=${copy ? 'y' : 'n'}`,
          `--modify=${modify ? 'all' : 'none'}`,
          '--',
          input,
          output,
        ],
        signal,
      );
      if (result.code !== 0 && result.code !== 3) {
        throw new FoliuxError('IO_ERROR', 'No se pudo proteger el PDF con contraseña.', {
          cause: new Error(result.stderr),
        });
      }
      return new Uint8Array(await readFile(output));
    });
  }
}
