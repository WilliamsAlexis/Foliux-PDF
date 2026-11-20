import { FoliuxError } from '@foliux-pdf/core';
import type { AiClientLike } from './ai';

/**
 * Cliente de la API de Gemini (Google AI Studio) con la misma forma que usa AiService para Claude: así se reutilizan
 * todos los textos, la validación y el manejo de errores. Traduce una petición «al estilo Anthropic» (system, mensajes
 * con bloques de texto, esquema JSON de salida) a la API REST de Gemini y devuelve el resultado con la forma esperada.
 *
 * - La clave viaja en la cabecera `x-goog-api-key` (no en la URL, para que no acabe en registros).
 * - No hay caché del documento ni reintento automático en otro modelo: son funciones de Claude.
 */

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';
/** Máximo de tokens de salida que admiten los modelos de Gemini 2.x. */
const MAX_OUTPUT = 65536;

type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
  body: { getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }> } } | null;
}>;

interface GeminiChunk {
  candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    cachedContentTokenCount?: number;
  };
  promptFeedback?: { blockReason?: string };
}

type ContentBlock = string | { type: string; text?: string }[];
interface AnthropicStyleParams {
  system?: string;
  max_tokens?: number;
  messages?: { role: string; content: ContentBlock }[];
  output_config?: { format?: { schema?: unknown } };
}

/** Gemini no admite `additionalProperties` en el esquema: se quita (el resultado se valida igualmente con Zod). */
export function toGeminiSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(toGeminiSchema);
  if (schema && typeof schema === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(schema)) {
      if (key === 'additionalProperties') continue;
      out[key] = toGeminiSchema(value);
    }
    return out;
  }
  return schema;
}

function textOf(content: ContentBlock): string {
  if (typeof content === 'string') return content;
  return content
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('\n\n');
}

/** Cuerpo de la petición a Gemini. Exportado para poder probarlo. */
export function buildGeminiRequest(params: AnthropicStyleParams): Record<string, unknown> {
  const generationConfig: Record<string, unknown> = {
    maxOutputTokens: Math.min(params.max_tokens ?? 8192, MAX_OUTPUT),
  };
  const schema = params.output_config?.format?.schema;
  if (schema) {
    generationConfig.responseMimeType = 'application/json';
    generationConfig.responseJsonSchema = toGeminiSchema(schema);
  }
  return {
    ...(params.system ? { systemInstruction: { parts: [{ text: params.system }] } } : {}),
    contents: (params.messages ?? []).map((message) => ({
      role: message.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: textOf(message.content) }],
    })),
    generationConfig,
  };
}

/** Errores de HTTP de Gemini traducidos a mensajes claros (sin datos sensibles). */
export function mapGeminiHttpError(status: number, body: string): FoliuxError {
  const lower = body.toLowerCase();
  if (
    status === 401 ||
    status === 403 ||
    /api key not valid|api_key_invalid|permission_denied/.test(lower)
  ) {
    return new FoliuxError(
      'AI_AUTH',
      'La clave de Gemini no es válida o no tiene permiso. Revísala en Ajustes del asistente.',
    );
  }
  if (status === 400 && /api key|api_key/.test(lower)) {
    return new FoliuxError(
      'AI_AUTH',
      'La clave de Gemini no es válida. Revísala en Ajustes del asistente.',
    );
  }
  if (status === 429 || /resource_exhausted|quota/.test(lower)) {
    return new FoliuxError(
      'AI_RATE_LIMIT',
      'Gemini alcanzó el límite de uso (la capa gratuita tiene un tope por minuto y por día). Espera un poco o prueba con un documento más corto.',
    );
  }
  if (status === 400 && /token count|too long|exceeds the maximum|input.*too large/.test(lower)) {
    return new FoliuxError(
      'AI_ERROR',
      'El documento es demasiado largo para este modelo. Prueba con un documento más corto o con una parte.',
    );
  }
  if (status === 404) {
    return new FoliuxError(
      'AI_ERROR',
      'Gemini no reconoce ese modelo. Elige otro en Ajustes del asistente (por ejemplo gemini-2.5-flash).',
    );
  }
  return new FoliuxError('AI_ERROR', `La API de Gemini devolvió un error (${status}).`);
}

const REFUSALS = new Set(['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII', 'IMAGE_SAFETY']);

export class GeminiClient implements AiClientLike {
  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike,
  ) {}

  private stream(params: Record<string, unknown>, options?: { signal?: AbortSignal }) {
    const listeners: ((delta: string) => void)[] = [];
    const typed = params as unknown as AnthropicStyleParams & { model?: string };
    let started: ReturnType<GeminiClient['execute']> | null = null;
    return {
      on: (_event: 'text', listener: (delta: string) => void) => {
        listeners.push(listener);
        return undefined;
      },
      // La petición empieza al pedir el resultado final, cuando ya están registrados los oyentes.
      finalMessage: () => {
        started ??= this.execute(typed, options?.signal, (delta) =>
          listeners.forEach((l) => l(delta)),
        );
        return started;
      },
    };
  }

  private async execute(
    params: AnthropicStyleParams & { model?: string },
    signal: AbortSignal | undefined,
    onText: (delta: string) => void,
  ) {
    const model = params.model ?? '';
    if (!/^[A-Za-z0-9._-]{1,80}$/.test(model)) {
      throw new FoliuxError('AI_ERROR', 'El nombre del modelo de Gemini no es válido.');
    }
    let response;
    try {
      response = await this.fetchImpl(`${ENDPOINT}/${model}:streamGenerateContent?alt=sse`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': this.apiKey },
        body: JSON.stringify(buildGeminiRequest(params)),
        signal,
      });
    } catch (error) {
      if ((error as Error).name === 'AbortError') throw error;
      throw new FoliuxError(
        'AI_ERROR',
        'No se pudo conectar con la API de Gemini. Revisa tu conexión a internet.',
        { cause: error },
      );
    }
    if (!response.ok)
      throw mapGeminiHttpError(response.status, await response.text().catch(() => ''));
    if (!response.body) throw new FoliuxError('AI_ERROR', 'Gemini no devolvió ninguna respuesta.');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let text = '';
    let finish: string | undefined;
    let blocked = false;
    const usage = { input: 0, output: 0, cached: 0 };

    const handle = (payload: string) => {
      let chunk: GeminiChunk;
      try {
        chunk = JSON.parse(payload) as GeminiChunk;
      } catch {
        return; // una línea que no es JSON (comentario del flujo): se ignora
      }
      if (chunk.promptFeedback?.blockReason) blocked = true;
      const candidate = chunk.candidates?.[0];
      for (const part of candidate?.content?.parts ?? []) {
        if (part.text) {
          text += part.text;
          onText(part.text);
        }
      }
      if (candidate?.finishReason) finish = candidate.finishReason;
      if (chunk.usageMetadata) {
        usage.input = chunk.usageMetadata.promptTokenCount ?? usage.input;
        usage.output = chunk.usageMetadata.candidatesTokenCount ?? usage.output;
        usage.cached = chunk.usageMetadata.cachedContentTokenCount ?? usage.cached;
      }
    };

    for (;;) {
      const { done, value } = await reader.read();
      if (value) buffer += decoder.decode(value, { stream: !done });
      // Eventos SSE: bloques separados por una línea en blanco; cada «data:» lleva un JSON.
      let separator = buffer.search(/\r?\n\r?\n/);
      while (separator >= 0) {
        const event = buffer.slice(0, separator);
        buffer = buffer.slice(separator).replace(/^\r?\n\r?\n/, '');
        for (const line of event.split(/\r?\n/)) {
          if (line.startsWith('data:')) handle(line.slice(5).trim());
        }
        separator = buffer.search(/\r?\n\r?\n/);
      }
      if (done) break;
    }
    for (const line of buffer.split(/\r?\n/))
      if (line.startsWith('data:')) handle(line.slice(5).trim());

    const refused = blocked || (finish !== undefined && REFUSALS.has(finish));
    return {
      stop_reason: refused ? 'refusal' : finish === 'MAX_TOKENS' ? 'max_tokens' : 'end_turn',
      content: [{ type: 'text', text }],
      usage: {
        input_tokens: usage.input,
        output_tokens: usage.output,
        cache_read_input_tokens: usage.cached,
      },
    };
  }

  get messages() {
    return {
      stream: (params: Record<string, unknown>, options?: { signal?: AbortSignal }) =>
        this.stream(params, options),
    };
  }

  get beta() {
    return { messages: this.messages };
  }
}
