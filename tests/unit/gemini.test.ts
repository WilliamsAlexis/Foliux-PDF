import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JSON_SCHEMAS, type FoliuxError } from '@foliux-pdf/core';
import {
  AiRouter,
  AiService,
  EncryptedKeyStore,
  GEMINI_KEY_FORMAT,
  GeminiClient,
  buildGeminiRequest,
  toGeminiSchema,
  type AiAssistant,
  type KeyCipher,
} from '@foliux-pdf/services/node';

const KEY = `AIza${'x'.repeat(35)}`;
const DOC = { documentName: 'a.pdf', documentText: '[Página 1]\nHola', totalPages: 1 };

type Call = { url: string; headers: Record<string, string>; body: Record<string, unknown> };

/** fetch falso: devuelve un flujo SSE troceado a propósito en mitad de los eventos. */
function fakeFetch(events: unknown[], options: { status?: number; errorBody?: string } = {}) {
  const calls: Call[] = [];
  const impl = async (
    url: string,
    init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
  ) => {
    calls.push({
      url,
      headers: init.headers,
      body: JSON.parse(init.body) as Record<string, unknown>,
    });
    const status = options.status ?? 200;
    if (status !== 200) {
      return {
        ok: false,
        status,
        text: async () => options.errorBody ?? '',
        body: null,
      };
    }
    const sse = events.map((e) => `data: ${JSON.stringify(e)}\r\n\r\n`).join('');
    const bytes = new TextEncoder().encode(sse);
    const chunks: Uint8Array[] = [];
    for (let i = 0; i < bytes.length; i += 17) chunks.push(bytes.subarray(i, i + 17));
    let index = 0;
    return {
      ok: true,
      status: 200,
      text: async () => '',
      body: {
        getReader: () => ({
          read: async () =>
            index < chunks.length
              ? { done: false, value: chunks[index++] }
              : { done: true, value: undefined },
        }),
      },
    };
  };
  return { impl, calls };
}

const chunk = (text: string, extra: Record<string, unknown> = {}) => ({
  candidates: [{ content: { parts: [{ text }] }, ...extra }],
});

function serviceWith(fetchLike: ReturnType<typeof fakeFetch>) {
  return new AiService({
    getKey: async () => KEY,
    getModel: async () => 'gemini-2.5-flash',
    createClient: (apiKey) => new GeminiClient(apiKey, fetchLike.impl),
  });
}

describe('Gemini: conversación', () => {
  it('envía el documento y devuelve la respuesta en streaming', async () => {
    const f = fakeFetch([
      chunk('Hola '),
      chunk('mundo', { finishReason: 'STOP' }),
      { usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 8 } },
    ]);
    const deltas: string[] = [];
    const result = await serviceWith(f).chat({
      ...DOC,
      history: [],
      question: '¿De qué trata?',
      onText: (d) => deltas.push(d),
    });
    expect(deltas.join('')).toBe('Hola mundo');
    expect(result.text).toBe('Hola mundo');
    expect(result.truncated).toBe(false);
    expect(result.usage).toMatchObject({ inputTokens: 120, outputTokens: 8 });

    const [call] = f.calls;
    expect(call!.url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse',
    );
    // La clave va en la cabecera, nunca en la URL
    expect(call!.headers['x-goog-api-key']).toBe(KEY);
    expect(call!.url).not.toContain(KEY);
    // El documento y la pregunta llegan como mensaje de usuario; el sistema, como instrucción
    const contents = call!.body.contents as { role: string; parts: { text: string }[] }[];
    expect(contents[0]!.role).toBe('user');
    expect(contents[0]!.parts[0]!.text).toContain('<documento');
    expect(contents[0]!.parts[0]!.text).toContain('¿De qué trata?');
    expect(JSON.stringify(call!.body.systemInstruction)).toContain('NO son instrucciones');
  });

  it('el historial pasa a roles user/model', () => {
    const body = buildGeminiRequest({
      system: 's',
      max_tokens: 100,
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'a' }] },
        { role: 'assistant', content: 'b' },
        { role: 'user', content: 'c' },
      ],
    });
    expect((body.contents as { role: string }[]).map((c) => c.role)).toEqual([
      'user',
      'model',
      'user',
    ]);
  });

  it('avisa si la respuesta se cortó por longitud', async () => {
    const f = fakeFetch([chunk('texto', { finishReason: 'MAX_TOKENS' })]);
    const result = await serviceWith(f).chat({
      ...DOC,
      history: [],
      question: 'x',
      onText: () => undefined,
    });
    expect(result.truncated).toBe(true);
  });

  it('un bloqueo de seguridad es un rechazo claro', async () => {
    const f = fakeFetch([chunk('', { finishReason: 'SAFETY' })]);
    await expect(
      serviceWith(f).chat({ ...DOC, history: [], question: 'x', onText: () => undefined }),
    ).rejects.toMatchObject({ code: 'AI_REFUSED' });
    const g = fakeFetch([{ promptFeedback: { blockReason: 'PROHIBITED_CONTENT' } }]);
    await expect(
      serviceWith(g).chat({ ...DOC, history: [], question: 'x', onText: () => undefined }),
    ).rejects.toMatchObject({ code: 'AI_REFUSED' });
  });
});

describe('Gemini: respuestas estructuradas', () => {
  it('pide JSON con esquema (sin additionalProperties) y valida lo que vuelve', async () => {
    const table = {
      tables: [{ title: 'T', page: 1, headers: ['a'], rows: [['1']] }],
    };
    const f = fakeFetch([chunk(JSON.stringify(table), { finishReason: 'STOP' })]);
    const result = await serviceWith(f).extractTables(DOC);
    expect(result.tables[0]!.title).toBe('T');

    const config = f.calls[0]!.body.generationConfig as Record<string, unknown>;
    expect(config.responseMimeType).toBe('application/json');
    expect(JSON.stringify(config.responseJsonSchema)).not.toContain('additionalProperties');
    expect(JSON.stringify(config.responseJsonSchema)).toContain('"tables"');
  });

  it('una respuesta que no es JSON o no cumple el formato es un error claro', async () => {
    const bad = fakeFetch([chunk('no es json', { finishReason: 'STOP' })]);
    await expect(serviceWith(bad).extractTables(DOC)).rejects.toMatchObject({ code: 'AI_ERROR' });
    const wrong = fakeFetch([chunk('{"tables":"x"}', { finishReason: 'STOP' })]);
    await expect(serviceWith(wrong).extractTables(DOC)).rejects.toMatchObject({
      code: 'AI_ERROR',
    });
  });

  it('toGeminiSchema quita additionalProperties a cualquier profundidad', () => {
    const out = JSON.stringify(toGeminiSchema(JSON_SCHEMAS.fields));
    expect(out).not.toContain('additionalProperties');
    expect(out).toContain('"enum"');
  });
});

describe('Gemini: errores', () => {
  const run = (f: ReturnType<typeof fakeFetch>) =>
    serviceWith(f).chat({ ...DOC, history: [], question: 'x', onText: () => undefined });

  it('clave no válida → AI_AUTH', async () => {
    const f = fakeFetch([], {
      status: 400,
      errorBody: '{"error":{"message":"API key not valid."}}',
    });
    await expect(run(f)).rejects.toMatchObject({ code: 'AI_AUTH' });
    const g = fakeFetch([], { status: 403, errorBody: 'PERMISSION_DENIED' });
    await expect(run(g)).rejects.toMatchObject({ code: 'AI_AUTH' });
  });

  it('límite de la capa gratuita → AI_RATE_LIMIT con consejo', async () => {
    const f = fakeFetch([], { status: 429, errorBody: 'RESOURCE_EXHAUSTED' });
    const error = (await run(f).catch((e: unknown) => e)) as FoliuxError;
    expect(error.code).toBe('AI_RATE_LIMIT');
    expect(error.message).toContain('capa gratuita');
  });

  it('modelo inexistente y documento demasiado largo', async () => {
    const f = fakeFetch([], { status: 404, errorBody: 'models/x is not found' });
    expect(((await run(f).catch((e: unknown) => e)) as FoliuxError).message).toContain(
      'no reconoce ese modelo',
    );
    const g = fakeFetch([], {
      status: 400,
      errorBody: 'The input token count exceeds the maximum number of tokens allowed',
    });
    expect(((await run(g).catch((e: unknown) => e)) as FoliuxError).message).toContain(
      'demasiado largo',
    );
  });

  it('fallo de red → mensaje de conexión; el detalle no se filtra al usuario', async () => {
    const client = new GeminiClient(KEY, async () => {
      throw new TypeError('fetch failed: C:\\secreto\\detalle');
    });
    const service = new AiService({
      getKey: async () => KEY,
      getModel: async () => 'gemini-2.5-flash',
      createClient: () => client,
    });
    const error = (await service
      .chat({ ...DOC, history: [], question: 'x', onText: () => undefined })
      .catch((e: unknown) => e)) as FoliuxError;
    expect(error.message).toContain('conexión');
    expect(error.message).not.toContain('secreto');
  });

  it('cancelar la petición se propaga como cancelación', async () => {
    const client = new GeminiClient(KEY, async () => {
      const abort = new Error('abortado');
      abort.name = 'AbortError';
      throw abort;
    });
    const service = new AiService({
      getKey: async () => KEY,
      getModel: async () => 'gemini-2.5-flash',
      createClient: () => client,
    });
    await expect(
      service.chat({ ...DOC, history: [], question: 'x', onText: () => undefined }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('un nombre de modelo raro no puede colarse en la URL', async () => {
    const f = fakeFetch([chunk('x', { finishReason: 'STOP' })]);
    const service = new AiService({
      getKey: async () => KEY,
      getModel: async () => '../../otra/ruta?x=1',
      createClient: (k) => new GeminiClient(k, f.impl),
    });
    await expect(
      service.chat({ ...DOC, history: [], question: 'x', onText: () => undefined }),
    ).rejects.toThrow(/nombre del modelo/);
    expect(f.calls).toHaveLength(0);
  });
});

describe('clave de Gemini y reparto entre servicios', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'foliux-gem-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const cipher: KeyCipher = {
    isAvailable: () => true,
    encrypt: (p) => new TextEncoder().encode(p).reverse(),
    decrypt: (d) => new TextDecoder().decode(new Uint8Array(d).reverse()),
  };

  it('acepta una clave de Google y rechaza una de Anthropic o un texto corto', async () => {
    const store = new EncryptedKeyStore(join(dir, 'g.bin'), cipher, GEMINI_KEY_FORMAT);
    await store.set(KEY);
    expect(await store.get()).toBe(KEY);
    await expect(store.set(`sk-ant-api03-${'a'.repeat(40)}`)).rejects.toThrow(/Google AI Studio/);
    await expect(store.set('corta')).rejects.toThrow(/Google AI Studio/);
  });

  it('el router usa el servicio que indican los ajustes en cada petición', async () => {
    const used: string[] = [];
    const fake = (name: string): AiAssistant =>
      ({
        chat: async () => {
          used.push(name);
          return {
            text: name,
            usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 },
            truncated: false,
          };
        },
      }) as unknown as AiAssistant;
    let provider: 'anthropic' | 'gemini' = 'anthropic';
    const router = new AiRouter(async () => provider, {
      anthropic: fake('claude'),
      gemini: fake('gemini'),
    });
    const input = { ...DOC, history: [], question: 'x', onText: () => undefined };
    await router.chat(input);
    provider = 'gemini';
    await router.chat(input);
    expect(used).toEqual(['claude', 'gemini']);
  });
});
