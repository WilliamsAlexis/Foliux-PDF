import { z } from 'zod';
import { buildDocumentText } from './ai';
import type { PageWord } from './models';

/**
 * Espacios de trabajo: grupos de documentos por proyecto. Un espacio solo guarda las rutas de los PDF
 * (no copia ni modifica los archivos); sirve para abrirlos juntos y para preguntarle a la IA por todos a la vez.
 */

export const MAX_WORKSPACE_DOCUMENTS = 200;

export const WorkspaceDocumentSchema = z.object({
  path: z.string().min(1).max(1000),
  name: z.string().min(1).max(300),
});
export type WorkspaceDocument = z.infer<typeof WorkspaceDocumentSchema>;

export const WorkspaceSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(80),
  createdAt: z.number(),
  documents: z.array(WorkspaceDocumentSchema).max(MAX_WORKSPACE_DOCUMENTS),
});
export type Workspace = z.infer<typeof WorkspaceSchema>;

/** Lo que se guarda en disco. */
export const WorkspaceFileSchema = z.object({ workspaces: z.array(WorkspaceSchema).max(100) });
export type WorkspaceFile = z.infer<typeof WorkspaceFileSchema>;

/** Lo que ve la interfaz: cada documento indica si su archivo sigue existiendo. */
export const WorkspaceViewSchema = WorkspaceSchema.extend({
  documents: z.array(WorkspaceDocumentSchema.extend({ exists: z.boolean() })),
});
export type WorkspaceView = z.infer<typeof WorkspaceViewSchema>;

export function validateWorkspaceName(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed === '') return 'Escribe un nombre para el espacio.';
  if (trimmed.length > 80) return 'El nombre del espacio es demasiado largo.';
  return null;
}

// ---------------------------------------------------------------------------
// Texto de varios documentos para la IA
// ---------------------------------------------------------------------------

export interface WorkspaceTextEntry {
  name: string;
  totalPages: number;
  includedPages: number;
  truncated: boolean;
}

export interface WorkspaceText {
  text: string;
  documents: WorkspaceTextEntry[];
  totalPages: number;
  includedPages: number;
  /** Algún documento no cupo entero: se recortó (hay que decírselo al usuario). */
  truncated: boolean;
}

/** Una sola línea y sin comillas angulares: el nombre del archivo va dentro del texto que lee la IA. */
const safeName = (name: string) => name.replace(/[\r\n<>]+/g, ' ').trim();

/**
 * Une el texto de varios documentos. Cada uno lleva su cabecera «=== Documento N: nombre ===» y sus marcas
 * «[Página N]», para que la IA pueda citar documento y página. Si no cabe todo, el presupuesto se reparte:
 * los documentos cortos entran enteros y el resto se recorta por páginas completas a partes iguales.
 */
export function buildWorkspaceText(
  documents: readonly { name: string; pages: readonly { words: readonly PageWord[] }[] }[],
  maxChars: number,
): WorkspaceText {
  const full = documents.map((doc) => buildDocumentText(doc.pages, Number.MAX_SAFE_INTEGER));
  const headerOf = (index: number) =>
    `=== Documento ${index + 1}: ${safeName(documents[index]?.name ?? '')} (${full[index]?.totalPages ?? 0} páginas) ===\n`;
  const headersLength = documents.reduce((sum, _doc, index) => sum + headerOf(index).length + 2, 0);

  // Reparto «por llenado»: de menor a mayor, cada documento recibe a lo sumo su parte equitativa del resto.
  const caps = new Array<number>(documents.length).fill(0);
  let remaining = Math.max(0, maxChars - headersLength);
  const order = full
    .map((_f, index) => index)
    .sort((a, b) => full[a]!.text.length - full[b]!.text.length);
  order.forEach((index, position) => {
    const left = order.length - position;
    const cap = Math.floor(remaining / left);
    const length = full[index]!.text.length;
    caps[index] = Math.min(length, cap);
    remaining -= caps[index]!;
  });

  const parts: string[] = [];
  const entries: WorkspaceTextEntry[] = [];
  documents.forEach((doc, index) => {
    const built =
      caps[index]! >= full[index]!.text.length
        ? full[index]!
        : buildDocumentText(doc.pages, Math.max(1, caps[index]!));
    parts.push(`${headerOf(index)}${built.text}`);
    entries.push({
      name: safeName(doc.name),
      totalPages: built.totalPages,
      includedPages: built.includedPages,
      truncated: built.truncated,
    });
  });
  return {
    text: parts.join('\n\n'),
    documents: entries,
    totalPages: entries.reduce((sum, e) => sum + e.totalPages, 0),
    includedPages: entries.reduce((sum, e) => sum + e.includedPages, 0),
    truncated: entries.some((e) => e.truncated),
  };
}
