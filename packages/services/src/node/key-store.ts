import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { FoliuxError } from '@foliux-pdf/core';

/**
 * Cifrado del sistema operativo (en Windows, DPAPI; en macOS, el llavero; en Linux, el gestor de secretos).
 * El proceso principal pasa aquí `safeStorage` de Electron; en las pruebas, uno falso.
 */
export interface KeyCipher {
  isAvailable(): boolean;
  encrypt(plain: string): Uint8Array;
  decrypt(encrypted: Uint8Array): string;
}

/**
 * Guarda la clave de la API cifrada en un archivo. Si el sistema no ofrece cifrado NO se guarda en claro:
 * es preferible no recordar la clave que dejarla legible en el disco.
 */
export interface KeyFormat {
  /** Forma que debe tener la clave. */
  pattern: RegExp;
  /** Mensaje cuando no la tiene. */
  invalidMessage: string;
}

/** Clave de la API de Anthropic: empieza por «sk-ant-». */
export const ANTHROPIC_KEY_FORMAT: KeyFormat = {
  pattern: /^sk-ant-[A-Za-z0-9_-]{16,}$/,
  invalidMessage:
    'La clave no tiene el formato de una clave de la API de Anthropic (empieza por «sk-ant-»).',
};

/** Clave de Google AI Studio (empieza por «AIza» hasta ahora; se admite cualquier clave razonable que no sea de Anthropic). */
export const GEMINI_KEY_FORMAT: KeyFormat = {
  pattern: /^(?!sk-)[A-Za-z0-9_.-]{20,200}$/,
  invalidMessage:
    'La clave no tiene el formato de una clave de Google AI Studio (suele empezar por «AIza»).',
};

export class EncryptedKeyStore {
  constructor(
    private readonly path: string,
    private readonly cipher: KeyCipher,
    private readonly format: KeyFormat = ANTHROPIC_KEY_FORMAT,
  ) {}

  get secureStorage(): boolean {
    return this.cipher.isAvailable();
  }

  async get(): Promise<string | null> {
    if (!this.cipher.isAvailable()) return null;
    try {
      return this.cipher.decrypt(new Uint8Array(await readFile(this.path)));
    } catch {
      // Sin archivo, dañado o cifrado por otra cuenta o equipo: se trata como «sin clave».
      return null;
    }
  }

  async has(): Promise<boolean> {
    return (await this.get()) !== null;
  }

  async set(key: string): Promise<void> {
    const trimmed = key.trim();
    if (!this.format.pattern.test(trimmed)) {
      throw new FoliuxError('INVALID_REQUEST', this.format.invalidMessage);
    }
    if (!this.cipher.isAvailable()) {
      throw new FoliuxError(
        'AI_ERROR',
        'Este equipo no ofrece almacenamiento cifrado, así que Foliux no guardará la clave (no se deja nunca en claro).',
      );
    }
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, this.cipher.encrypt(trimmed), { mode: 0o600 });
    await chmod(this.path, 0o600).catch(() => undefined);
  }

  async clear(): Promise<void> {
    await rm(this.path, { force: true });
  }
}
