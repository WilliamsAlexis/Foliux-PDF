import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ZodType } from 'zod';
import type { ILogger } from '@foliux-pdf/core';

/**
 * Almacén JSON en disco con validación (Zod) y escritura atómica
 * (se escribe a un archivo temporal y luego se renombra, así nunca queda un JSON a medias).
 */
export class JsonFileStore<T> {
  constructor(
    private readonly filePath: string,
    private readonly schema: ZodType<T>,
    private readonly fallback: () => T,
    private readonly logger?: ILogger,
  ) {}

  async read(): Promise<T> {
    try {
      const raw = await readFile(this.filePath, 'utf8');
      const parsed = this.schema.safeParse(JSON.parse(raw));
      if (parsed.success) return parsed.data;
      this.logger?.warn(`Datos inválidos en ${this.filePath}; se usan los valores por defecto.`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.logger?.warn(
          `No se pudo leer ${this.filePath}; se usan los valores por defecto.`,
          error,
        );
      }
    }
    return this.fallback();
  }

  async write(value: T): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temp = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify(value, null, 2), 'utf8');
    await rename(temp, this.filePath);
  }
}
