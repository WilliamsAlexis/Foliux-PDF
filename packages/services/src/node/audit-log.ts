import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { AuditEntrySchema, type AuditEntry, type AuditInput } from '@foliux-pdf/core';

/**
 * Registro de auditoría de firmas: un archivo de texto (una entrada JSON por línea) al que solo se añade.
 * Cada entrada incluye el hash de la anterior, de modo que borrar, cambiar o reordenar una entrada
 * rompe la cadena y se detecta al verificarla. Es una evidencia de manipulación, no una garantía
 * absoluta: quien controle el equipo podría rehacer toda la cadena.
 */

const GENESIS = '0'.repeat(64);

/** Hash de una entrada: depende de todos sus campos salvo del propio hash. */
export function hashEntry(entry: Omit<AuditEntry, 'hash'>): string {
  const canonical = JSON.stringify([
    entry.id,
    entry.time,
    entry.action,
    entry.file,
    entry.fileHash,
    entry.signer,
    entry.detail,
    entry.prevHash,
  ]);
  return createHash('sha256').update(canonical).digest('hex');
}

/** Comprueba que la cadena está íntegra. Devuelve el número de la primera entrada dañada, si la hay. */
export function verifyChain(entries: readonly AuditEntry[]): { ok: boolean; brokenAt?: number } {
  let previous = GENESIS;
  let expectedId = 1;
  for (const entry of entries) {
    const { hash, ...rest } = entry;
    if (entry.id !== expectedId || entry.prevHash !== previous || hashEntry(rest) !== hash) {
      return { ok: false, brokenAt: entry.id };
    }
    previous = hash;
    expectedId += 1;
  }
  return { ok: true };
}

/** El CSV empieza con BOM para que Excel lo abra con acentos. */
export function auditToCsv(entries: readonly AuditEntry[]): string {
  const cell = (value: string | number) => `"${String(value).replaceAll('"', '""')}"`;
  const header = [
    'N.º',
    'Fecha',
    'Acción',
    'Archivo',
    'SHA-256 del archivo',
    'Firmante',
    'Detalle',
    'Hash de la entrada',
  ];
  const rows = entries.map((e) =>
    [e.id, e.time, e.action, e.file, e.fileHash, e.signer, e.detail, e.hash].map(cell).join(','),
  );
  // El BOM (U+FEFF) hace que Excel abra el archivo como UTF-8, con acentos.
  const bom = String.fromCharCode(0xfeff);
  const eol = String.fromCharCode(13, 10);
  return `${bom}${[header.map(cell).join(','), ...rows].join(eol)}${eol}`;
}

export class AuditLogService {
  /** Cola de escrituras: dos eventos simultáneos no pueden usar el mismo número ni el mismo hash anterior. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly path: string) {}

  async list(): Promise<AuditEntry[]> {
    let raw: string;
    try {
      raw = await readFile(this.path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const entries: AuditEntry[] = [];
    for (const line of raw.split('\n')) {
      if (line.trim() === '') continue;
      try {
        const parsed = AuditEntrySchema.safeParse(JSON.parse(line));
        if (parsed.success) entries.push(parsed.data);
      } catch {
        // Una línea ilegible no se muestra; la verificación de la cadena detectará el hueco.
      }
    }
    return entries;
  }

  async verify(): Promise<{ ok: boolean; brokenAt?: number }> {
    return verifyChain(await this.list());
  }

  /** Añade un evento al registro y devuelve la entrada completa. */
  append(input: AuditInput): Promise<AuditEntry> {
    const run = async (): Promise<AuditEntry> => {
      const entries = await this.list();
      const last = entries[entries.length - 1];
      const base = {
        id: (last?.id ?? 0) + 1,
        time: new Date().toISOString(),
        ...input,
        prevHash: last?.hash ?? GENESIS,
      };
      const entry: AuditEntry = { ...base, hash: hashEntry(base) };
      await mkdir(dirname(this.path), { recursive: true });
      await appendFile(this.path, `${JSON.stringify(entry)}\n`, 'utf8');
      return entry;
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }
}

/** SHA-256 de un archivo (para anotar qué se firmó). */
export function sha256(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}
