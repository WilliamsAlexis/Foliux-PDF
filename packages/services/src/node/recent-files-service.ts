import { access } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { z } from 'zod';
import type { ILogger, IRecentFilesService, RecentFile } from '@foliux-pdf/core';
import { JsonFileStore } from './json-file-store';

const RecentListSchema = z.array(
  z.object({ path: z.string(), name: z.string(), openedAt: z.number() }),
);

/** Archivos abiertos recientemente, guardados en un JSON. */
export class RecentFilesService implements IRecentFilesService {
  private readonly store: JsonFileStore<RecentFile[]>;
  /** Cola para que dos operaciones seguidas no se pisen al escribir el archivo. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    storePath: string,
    private readonly limit = 15,
    logger?: ILogger,
  ) {
    this.store = new JsonFileStore(storePath, RecentListSchema, () => [], logger);
  }

  /** Devuelve los recientes que siguen existiendo en disco. */
  async list(): Promise<RecentFile[]> {
    const items = await this.store.read();
    const existing: RecentFile[] = [];
    for (const item of items) {
      try {
        await access(item.path);
        existing.push(item);
      } catch {
        // El archivo ya no existe: se omite.
      }
    }
    return existing.slice(0, this.limit);
  }

  add(path: string): Promise<void> {
    return this.enqueue(async () => {
      const full = resolve(path);
      const key = normalizeKey(full);
      const items = (await this.store.read()).filter((item) => normalizeKey(item.path) !== key);
      items.unshift({ path: full, name: basename(full), openedAt: Date.now() });
      await this.store.write(items.slice(0, this.limit));
    });
  }

  remove(path: string): Promise<void> {
    return this.enqueue(async () => {
      const key = normalizeKey(resolve(path));
      const items = await this.store.read();
      await this.store.write(items.filter((item) => normalizeKey(item.path) !== key));
    });
  }

  clear(): Promise<void> {
    return this.enqueue(() => this.store.write([]));
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const next = this.queue.then(task, task);
    this.queue = next.catch(() => undefined);
    return next;
  }
}

/** Windows y macOS no distinguen mayúsculas en las rutas. */
function normalizeKey(path: string): string {
  return process.platform === 'linux' ? path : path.toLowerCase();
}
