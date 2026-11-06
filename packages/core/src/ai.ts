import { z } from 'zod';
import { buildParagraphs, groupLines } from './layout';
import type { PageWord, Rect } from './models';

/**
 * Asistente de IA (API de Claude). Aquí viven los tipos y las funciones puras: modelos disponibles,
 * forma de las respuestas estructuradas y utilidades para preparar el texto del documento y localizar
 * en la página lo que la IA señala. Las llamadas a la API se hacen siempre desde el proceso principal.
 */

export const AI_MODELS = [
  {
    id: 'claude-opus-5-5',
    label: 'Claude Opus 5.5',
    hint: 'La más capaz. Entrada 4 $ / salida 20 $ por millón de tokens.',
  },
  {
    id: 'claude-sonnet-5-5',
    label: 'Claude Sonnet 5.5',
    hint: 'Equilibrada y más barata. 2 $ / 10 $ por millón.',
  },
  {
    id: 'claude-haiku-5-5',
    label: 'Claude Haiku 5.5',
    hint: 'La más rápida y barata. 0,10 $ / 0,50 $ por millón.',
  },
] as const;
export type AiModelId = (typeof AI_MODELS)[number]['id'];
export const AI_MODEL_IDS = AI_MODELS.map((m) => m.id) as [AiModelId, ...AiModelId[]];
export const DEFAULT_AI_MODEL: AiModelId = 'claude-opus-5-5';

/** Mensaje de una conversación con el documento. */
export const ChatMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().max(200000),
});
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

// ---------------------------------------------------------------------------
// Respuestas estructuradas
// ---------------------------------------------------------------------------

export const ExtractedTablesSchema = z.object({
  tables: z
    .array(
      z.object({
        title: z.string().max(300),
        page: z.number().int().min(1),
        headers: z.array(z.string().max(500)).max(100),
        rows: z.array(z.array(z.string().max(2000)).max(100)).max(5000),
      }),
    )
    .max(200),
});
export type ExtractedTables = z.infer<typeof ExtractedTablesSchema>;

export const DetectedFieldsSchema = z.object({
  fields: z
    .array(
      z.object({
        /** Etiqueta del campo tal como aparece en el documento («Nombre:», «Fecha de nacimiento»...). */
        label: z.string().min(1).max(200),
        type: z.enum(['text', 'checkbox', 'dropdown', 'radio']),
        page: z.number().int().min(1),
        /** Opciones (desplegable o botones de opción). */
        options: z.array(z.string().max(200)).max(50),
        multiline: z.boolean(),
      }),
    )
    .max(300),
});
export type DetectedFields = z.infer<typeof DetectedFieldsSchema>;

export const SENSITIVE_CATEGORIES = [
  'nombre',
  'documento_identidad',
  'cuenta_bancaria',
  'tarjeta',
  'correo',
  'telefono',
  'direccion',
  'fecha_nacimiento',
  'salud',
  'otro',
] as const;
export type SensitiveCategory = (typeof SENSITIVE_CATEGORIES)[number];

export const SensitiveItemsSchema = z.object({
  items: z
    .array(
      z.object({
        /** Texto EXACTO tal como aparece en el documento. */
        text: z.string().min(1).max(300),
        category: z.enum(SENSITIVE_CATEGORIES),
        reason: z.string().max(300),
      }),
    )
    .max(1000),
});
export type SensitiveItems = z.infer<typeof SensitiveItemsSchema>;

export const SlideDeckSchema = z.object({
  title: z.string().min(1).max(200),
  slides: z
    .array(
      z.object({
        title: z.string().min(1).max(200),
        bullets: z.array(z.string().min(1).max(400)).max(8),
        notes: z.string().max(3000),
      }),
    )
    .min(1)
    .max(60),
});
export type SlideDeck = z.infer<typeof SlideDeckSchema>;

/** Esquemas JSON de lo anterior, tal como se los pide a la API (salida estructurada). */
export const JSON_SCHEMAS = {
  tables: {
    type: 'object',
    additionalProperties: false,
    required: ['tables'],
    properties: {
      tables: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['title', 'page', 'headers', 'rows'],
          properties: {
            title: { type: 'string' },
            page: { type: 'integer' },
            headers: { type: 'array', items: { type: 'string' } },
            rows: { type: 'array', items: { type: 'array', items: { type: 'string' } } },
          },
        },
      },
    },
  },
  fields: {
    type: 'object',
    additionalProperties: false,
    required: ['fields'],
    properties: {
      fields: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['label', 'type', 'page', 'options', 'multiline'],
          properties: {
            label: { type: 'string' },
            type: { type: 'string', enum: ['text', 'checkbox', 'dropdown', 'radio'] },
            page: { type: 'integer' },
            options: { type: 'array', items: { type: 'string' } },
            multiline: { type: 'boolean' },
          },
        },
      },
    },
  },
  sensitive: {
    type: 'object',
    additionalProperties: false,
    required: ['items'],
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['text', 'category', 'reason'],
          properties: {
            text: { type: 'string' },
            category: { type: 'string', enum: [...SENSITIVE_CATEGORIES] },
            reason: { type: 'string' },
          },
        },
      },
    },
  },
  slides: {
    type: 'object',
    additionalProperties: false,
    required: ['title', 'slides'],
    properties: {
      title: { type: 'string' },
      slides: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['title', 'bullets', 'notes'],
          properties: {
            title: { type: 'string' },
            bullets: { type: 'array', items: { type: 'string' } },
            notes: { type: 'string' },
          },
        },
      },
    },
  },
} as const;

// ---------------------------------------------------------------------------
// Texto del documento
// ---------------------------------------------------------------------------

/** Aproximación del número de tokens (en español, algo más de un token cada 3,5 caracteres). */
export const estimateTokens = (text: string): number => Math.ceil(text.length / 3.5);

/** Máximo de caracteres que se envían (~430.000 tokens): holgado para el contexto de 1 M y para el coste. */
export const MAX_DOCUMENT_CHARS = 1_500_000;

export interface DocumentText {
  text: string;
  totalPages: number;
  includedPages: number;
  /** El documento no cabía entero: se enviaron solo las primeras páginas (hay que decírselo al usuario). */
  truncated: boolean;
}

/** Texto legible del documento con marcas «[Página N]» para que la IA pueda citar páginas. */
export function buildDocumentText(
  pages: readonly { words: readonly PageWord[] }[],
  maxChars = MAX_DOCUMENT_CHARS,
): DocumentText {
  const parts: string[] = [];
  let length = 0;
  let included = 0;
  for (const [index, page] of pages.entries()) {
    const body = buildParagraphs(groupLines(page.words))
      .map((paragraph) => paragraph.text)
      .join('\n');
    const block = `[Página ${index + 1}]\n${body}\n`;
    if (length + block.length > maxChars && included > 0) break;
    parts.push(block);
    length += block.length;
    included += 1;
  }
  return {
    text: parts.join('\n'),
    totalPages: pages.length,
    includedPages: included,
    truncated: included < pages.length,
  };
}

// ---------------------------------------------------------------------------
// Localizar texto en la página
// ---------------------------------------------------------------------------

/** Minúsculas, sin acentos y sin signos: para comparar texto de la IA con el del documento. */
export function normalizeForMatch(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Busca una frase en las palabras de una página. Devuelve cada coincidencia como la lista de palabras que la forman. */
export function locatePhrase(words: readonly PageWord[], phrase: string): PageWord[][] {
  const target = normalizeForMatch(phrase).split(' ').filter(Boolean);
  if (target.length === 0) return [];
  const normalized = words.map((word) => normalizeForMatch(word.text));
  const matches: PageWord[][] = [];

  for (let start = 0; start < words.length; start++) {
    // Una palabra del documento puede ser varias de la frase («Nombre:» → «nombre»); se acumulan hasta cubrirla.
    let matched = 0;
    let end = start;
    while (end < words.length && matched < target.length) {
      const parts = (normalized[end] ?? '').split(' ').filter(Boolean);
      if (parts.length === 0) {
        end += 1;
        continue;
      }
      if (!parts.every((part, i) => part === target[matched + i])) break;
      matched += parts.length;
      end += 1;
    }
    if (matched === target.length && end > start) {
      matches.push(words.slice(start, end) as PageWord[]);
      start = end - 1;
    }
  }
  return matches;
}

/** Rectángulo que cubre varias palabras. */
export function boundsOf(words: readonly PageWord[]): Rect {
  const x1 = Math.min(...words.map((w) => w.x));
  const y1 = Math.min(...words.map((w) => w.y));
  const x2 = Math.max(...words.map((w) => w.x + w.width));
  const y2 = Math.max(...words.map((w) => w.y + w.height));
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

/**
 * Dónde colocar un campo de formulario respecto a su etiqueta: a la derecha si cabe; si no, debajo.
 * `pageWidth` y `pageHeight` están en las unidades de la vista.
 */
export function fieldRectFor(
  label: Rect,
  type: 'text' | 'checkbox' | 'dropdown' | 'radio',
  multiline: boolean,
  page: { width: number; height: number },
  optionCount = 0,
): Rect {
  const margin = 24;
  const gap = 6;
  const height = Math.max(16, label.height + 4);
  if (type === 'checkbox') {
    const side = Math.max(11, Math.min(14, label.height));
    return {
      x: Math.max(0, label.x - side - gap),
      y: label.y + (label.height - side) / 2,
      width: side,
      height: side,
    };
  }
  const roomRight = page.width - margin - (label.x + label.width + gap);
  const rows = type === 'radio' ? Math.max(2, optionCount) * 18 : multiline ? height * 3 : height;
  if (roomRight >= 80) {
    return {
      x: label.x + label.width + gap,
      y: label.y - 2,
      width: Math.min(220, roomRight),
      height: rows,
    };
  }
  return {
    x: label.x,
    y: label.y + label.height + gap,
    width: Math.min(220, page.width - margin - label.x),
    height: rows,
  };
}
