import { toast } from 'sonner';
import {
  FoliuxError,
  boundsOf,
  buildDocumentText,
  estimateTokens,
  fieldRectFor,
  locatePhrase,
  normalizeForMatch,
  type AiModelId,
  type ChatMessage,
  type NewFormField,
  type PageWord,
  type Rect,
} from '@foliux-pdf/core';
import i18n from '@/i18n';
import { getActiveTab, type DocTab } from '@/store/docs';
import {
  useAi,
  type ConsentPrompt,
  type FieldCandidate,
  type SensitiveCandidate,
} from '@/store/ai';
import { notifyError } from './notify';
import { addAnnotations, createAnnotation, runPageOp } from './edit';
import { tick } from './raster';

/** Asistente de IA: todo lo que sale hacia la API pasa por el proceso principal (aquí no hay claves). */

const baseName = (tab: DocTab) => tab.name.replace(/\.pdf$/i, '');
export const newRequestId = () => crypto.randomUUID().replace(/-/g, '');

// ---------------------------------------------------------------------------
// Estado de la API y clave
// ---------------------------------------------------------------------------

export async function refreshAiStatus(): Promise<void> {
  try {
    useAi.getState().setStatus(await window.foliux.ai.status());
  } catch (error) {
    notifyError(i18n.t('ai.failed'), error);
  }
}

export async function saveApiKey(key: string): Promise<void> {
  await window.foliux.ai.setKey(key);
  await refreshAiStatus();
  toast.success(i18n.t('ai.keySaved'));
}

export async function removeApiKey(): Promise<void> {
  await window.foliux.ai.clearKey();
  await refreshAiStatus();
  toast.success(i18n.t('ai.keyRemoved'));
}

export async function changeModel(model: AiModelId): Promise<void> {
  try {
    await window.foliux.settings.update({ aiModel: model as AiModelId });
    await refreshAiStatus();
  } catch (error) {
    notifyError(i18n.t('ai.failed'), error);
  }
}

/** Suscribe la recepción del texto que va llegando de la conversación. Devuelve la baja. */
export function initAi(): () => void {
  void refreshAiStatus();
  return window.foliux.ai.onChunk(({ requestId, delta }) => {
    const { stream, setStream } = useAi.getState();
    if (stream && stream.requestId === requestId) {
      setStream({ ...stream, text: stream.text + delta });
    }
  });
}

// ---------------------------------------------------------------------------
// Texto del documento
// ---------------------------------------------------------------------------

interface ExtractedDocument {
  pages: PageWord[][];
  text: string;
  totalPages: number;
  includedPages: number;
  truncated: boolean;
}

// El texto se extrae una vez por documento cargado (al editarlo se carga otro y se vuelve a extraer).
const extracted = new WeakMap<object, ExtractedDocument>();

async function extractDocument(tab: DocTab): Promise<ExtractedDocument> {
  const cached = extracted.get(tab.doc);
  if (cached) return cached;
  const pages: PageWord[][] = [];
  for (let page = 1; page <= tab.numPages; page++) {
    pages.push(await tab.doc.getWords(page));
    if (page % 5 === 0) await tick();
  }
  const built = buildDocumentText(pages.map((words) => ({ words })));
  const result = { pages, ...built };
  extracted.set(tab.doc, result);
  return result;
}

// ---------------------------------------------------------------------------
// Preparación de cada petición: clave, texto y consentimiento
// ---------------------------------------------------------------------------

interface Payload {
  tab: DocTab;
  document: ExtractedDocument;
  body: { documentName: string; documentText: string; totalPages: number };
}

/** Pregunta al usuario si acepta enviar el texto a la API. */
export function requestConsent(info: Omit<ConsentPrompt, 'resolve'>): Promise<boolean> {
  return new Promise((resolve) => {
    useAi.getState().setConsentPrompt({ ...info, resolve });
  });
}

function askConsent(tab: DocTab, document: ExtractedDocument): Promise<boolean> {
  return requestConsent({
    tabId: tab.id,
    documentName: tab.name,
    tokens: estimateTokens(document.text),
    includedPages: document.includedPages,
    totalPages: document.totalPages,
    truncated: document.truncated,
  });
}

/** ¿Hay clave configurada? Si no, abre el cuadro para ponerla. */
export async function ensureApiKey(): Promise<boolean> {
  await refreshAiStatus();
  if (useAi.getState().status?.configured) return true;
  useAi.getState().setKeyDialog(true);
  return false;
}

/** Comprueba que hay clave, extrae el texto y pide permiso (una vez por documento) para enviarlo. */
async function prepare(): Promise<Payload | null> {
  const tab = getActiveTab();
  const ai = useAi.getState();
  if (!tab || tab.busy || ai.stream || ai.task) return null;

  if (!(await ensureApiKey())) return null;

  ai.setTask({ tabId: tab.id, requestId: '', label: i18n.t('ai.reading') });
  let document: ExtractedDocument;
  try {
    document = await extractDocument(tab);
  } catch (error) {
    ai.setTask(null);
    notifyError(i18n.t('ai.failed'), error);
    return null;
  }
  ai.setTask(null);

  if (document.text.replace(/\[Página \d+\]/g, '').trim() === '') {
    toast.error(i18n.t('ai.noText'));
    return null;
  }
  if (!useAi.getState().consented.includes(tab.id)) {
    if (!(await askConsent(tab, document))) return null;
    useAi.getState().addConsent(tab.id);
  }
  return {
    tab,
    document,
    body: {
      documentName: tab.name,
      documentText: document.text,
      totalPages: document.totalPages,
    },
  };
}

/** Errores de la API con su mensaje claro; la falta de clave abre el cuadro para ponerla. */
export function reportAiError(error: unknown): void {
  if (error instanceof FoliuxError) {
    if (error.code === 'AI_ERROR' && error.message === 'Cancelado.') {
      toast.info(i18n.t('ai.cancelled'));
      return;
    }
    if (error.code === 'AI_KEY_MISSING' || error.code === 'AI_AUTH') {
      useAi.getState().setKeyDialog(true);
    }
  }
  notifyError(i18n.t('ai.failed'), error);
}

/** Ejecuta una tarea de IA que no es una conversación, con su indicador y su botón de cancelar. */
async function runTask<T>(
  tab: DocTab,
  label: string,
  work: (requestId: string) => Promise<T>,
): Promise<T | null> {
  const requestId = newRequestId();
  useAi.getState().setTask({ tabId: tab.id, requestId, label });
  try {
    return await work(requestId);
  } catch (error) {
    reportAiError(error);
    return null;
  } finally {
    useAi.getState().setTask(null);
  }
}

export function cancelAi(): void {
  const { stream, task } = useAi.getState();
  const requestId = stream?.requestId || task?.requestId;
  if (requestId) void window.foliux.ai.cancel(requestId).catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Conversación
// ---------------------------------------------------------------------------

export async function askQuestion(question: string): Promise<void> {
  const text = question.trim();
  if (text === '') return;
  const payload = await prepare();
  if (!payload) return;
  const { tab, body, document } = payload;
  await runChat(tab.id, body, text, {
    onTruncated: () =>
      toast.info(
        i18n.t('ai.truncated', { included: document.includedPages, total: document.totalPages }),
        { id: 'ai-truncated' },
      ),
    truncatedAlready: document.truncated,
  });
}

/**
 * Envía una pregunta con el texto ya preparado y gestiona la respuesta que va llegando.
 * Sirve para un documento (clave = id de la pestaña) y para un espacio de trabajo (clave = «ws:id»).
 */
export async function runChat(
  chatKey: string,
  body: { documentName: string; documentText: string; totalPages: number },
  question: string,
  options: { workspace?: boolean; onTruncated: () => void; truncatedAlready: boolean },
): Promise<void> {
  const ai = useAi.getState();
  const history: ChatMessage[] = ai.chats[chatKey] ?? [];
  ai.setChat(chatKey, [...history, { role: 'user', content: question }]);
  const requestId = newRequestId();
  ai.setStream({ tabId: chatKey, requestId, text: '' });

  try {
    const result = await window.foliux.ai.chat({
      ...body,
      requestId,
      history,
      question,
      workspace: options.workspace,
    });
    useAi
      .getState()
      .setChat(chatKey, [
        ...(useAi.getState().chats[chatKey] ?? []),
        { role: 'assistant', content: result.text },
      ]);
    if (result.truncated || options.truncatedAlready) options.onTruncated();
  } catch (error) {
    // Lo que llegó antes de fallar o de cancelar se conserva como respuesta parcial.
    const partial = useAi.getState().stream?.text.trim();
    if (partial) {
      useAi
        .getState()
        .setChat(chatKey, [
          ...(useAi.getState().chats[chatKey] ?? []),
          { role: 'assistant', content: `${partial}\n\n${i18n.t('ai.partial')}` },
        ]);
    }
    reportAiError(error);
  } finally {
    useAi.getState().setStream(null);
  }
}

export function clearChat(tabId: string): void {
  useAi.getState().setChat(tabId, []);
}

/** Pregunta lista para el texto seleccionado en el visor (si no hay selección, avisa). */
export function questionAboutSelection(template: string): string | null {
  const selected = window.getSelection()?.toString().trim() ?? '';
  if (selected === '') {
    toast.info(i18n.t('ai.selectFirst'));
    return null;
  }
  return `${template}\n\n«${selected.slice(0, 6000)}»`;
}

// ---------------------------------------------------------------------------
// Tablas → Excel y presentación → PowerPoint
// ---------------------------------------------------------------------------

export async function extractTablesToExcel(): Promise<void> {
  const payload = await prepare();
  if (!payload) return;
  const result = await runTask(payload.tab, i18n.t('ai.extractingTables'), (requestId) =>
    window.foliux.ai.extractTables({ ...payload.body, requestId }),
  );
  if (!result) return;
  if (result.tables.length === 0) {
    toast.info(i18n.t('ai.noTables'));
    return;
  }
  try {
    const saved = await window.foliux.ai.exportTables({
      tables: result.tables,
      suggestedName: `${baseName(payload.tab)} - tablas.xlsx`,
    });
    if (saved) {
      toast.success(i18n.t('ai.tablesSaved', { count: result.tables.length }), {
        description: saved.path,
      });
    }
  } catch (error) {
    notifyError(i18n.t('ai.failed'), error);
  }
}

export async function makePresentation(slideCount: number): Promise<void> {
  const payload = await prepare();
  if (!payload) return;
  const deck = await runTask(payload.tab, i18n.t('ai.makingSlides'), (requestId) =>
    window.foliux.ai.makeSlides({ ...payload.body, requestId, slideCount }),
  );
  if (!deck) return;
  try {
    const saved = await window.foliux.ai.exportSlides({
      deck,
      suggestedName: `${baseName(payload.tab)} - presentación.pptx`,
    });
    if (saved) {
      toast.success(i18n.t('ai.slidesSaved', { count: deck.slides.length }), {
        description: saved.path,
      });
    }
  } catch (error) {
    notifyError(i18n.t('ai.failed'), error);
  }
}

// ---------------------------------------------------------------------------
// Resumen en audio (voz del sistema: no sale nada más del equipo)
// ---------------------------------------------------------------------------

/** Trozos de unas pocas frases: las voces del sistema se cortan con textos muy largos. */
export function splitForSpeech(text: string, max = 220): string[] {
  const sentences = text.replace(/\s+/g, ' ').match(/[^.!?…]+[.!?…]*\s*/g) ?? [text];
  const chunks: string[] = [];
  let current = '';
  for (const sentence of sentences) {
    if (current !== '' && current.length + sentence.length > max) {
      chunks.push(current.trim());
      current = '';
    }
    current += sentence;
    // Una frase sin puntos, larga: se parte por comas o por longitud.
    while (current.length > max * 1.5) {
      const cut = current.lastIndexOf(',', max) > 40 ? current.lastIndexOf(',', max) + 1 : max;
      chunks.push(current.slice(0, cut).trim());
      current = current.slice(cut);
    }
  }
  if (current.trim() !== '') chunks.push(current.trim());
  return chunks.filter((chunk) => chunk !== '');
}

export function speak(tabId: string, text: string): void {
  const synth = window.speechSynthesis;
  synth.cancel();
  const voice = synth.getVoices().find((v) => v.lang.toLowerCase().startsWith('es'));
  const chunks = splitForSpeech(text);
  chunks.forEach((chunk, index) => {
    const utterance = new SpeechSynthesisUtterance(chunk);
    utterance.lang = voice?.lang ?? 'es-ES';
    if (voice) utterance.voice = voice;
    if (index === chunks.length - 1) {
      utterance.onend = () => useAi.getState().setAudio({ tabId, text, state: 'stopped' });
    }
    utterance.onerror = (event) => {
      // cancel() provoca un error «interrupted»/«canceled» que no es un fallo.
      if (event.error !== 'interrupted' && event.error !== 'canceled') {
        toast.error(i18n.t('ai.speechFailed'));
      }
    };
    synth.speak(utterance);
  });
  useAi.getState().setAudio({ tabId, text, state: 'playing' });
}

export function pauseSpeech(): void {
  const audio = useAi.getState().audio;
  if (!audio) return;
  window.speechSynthesis.pause();
  useAi.getState().setAudio({ ...audio, state: 'paused' });
}

export function resumeSpeech(): void {
  const audio = useAi.getState().audio;
  if (!audio) return;
  window.speechSynthesis.resume();
  useAi.getState().setAudio({ ...audio, state: 'playing' });
}

export function stopSpeech(): void {
  const audio = useAi.getState().audio;
  window.speechSynthesis.cancel();
  if (audio) useAi.getState().setAudio({ ...audio, state: 'stopped' });
}

export async function audioSummary(): Promise<void> {
  const payload = await prepare();
  if (!payload) return;
  const result = await runTask(payload.tab, i18n.t('ai.summarizing'), (requestId) =>
    window.foliux.ai.audioSummary({ ...payload.body, requestId, language: 'español' }),
  );
  if (!result) return;
  speak(payload.tab.id, result.text);
}

// ---------------------------------------------------------------------------
// Detección de campos de formulario
// ---------------------------------------------------------------------------

/** Nombre de campo a partir de la etiqueta («Fecha de nacimiento» → fecha_de_nacimiento), sin repetir. */
function fieldNameFor(label: string, taken: Set<string>): string {
  const base = normalizeForMatch(label).replace(/ /g, '_').slice(0, 40) || 'campo';
  let name = base;
  for (let n = 2; taken.has(name); n++) name = `${base}_${n}`;
  taken.add(name);
  return name;
}

export async function detectFormFields(): Promise<void> {
  const payload = await prepare();
  if (!payload) return;
  const result = await runTask(payload.tab, i18n.t('ai.detectingFields'), (requestId) =>
    window.foliux.ai.detectFields({ ...payload.body, requestId }),
  );
  if (!result) return;
  if (result.fields.length === 0) {
    toast.info(i18n.t('ai.noFields'));
    return;
  }
  const items: FieldCandidate[] = result.fields.map((field, index) => {
    const words = payload.document.pages[field.page - 1] ?? [];
    const located = locatePhrase(words, field.label).length > 0;
    return {
      id: `f${index}`,
      label: field.label,
      type: field.type,
      page: field.page,
      options: field.options,
      multiline: field.multiline,
      located,
      checked: located,
    };
  });
  useAi.getState().setReview({ kind: 'fields', tabId: payload.tab.id, items });
}

/** Crea de una vez los campos que el usuario aceptó, junto a su etiqueta. */
export async function createDetectedFields(items: FieldCandidate[]): Promise<boolean> {
  const first = items[0];
  if (!first) return false;
  const tab = getActiveTab();
  if (!tab) return false;
  const document = await extractDocument(tab);
  const taken = new Set((tab.form ?? []).map((f) => f.name));
  const seen = new Map<string, number>();
  const fields: NewFormField[] = [];

  for (const item of items) {
    const size = tab.sizes[item.page - 1];
    const matches = locatePhrase(document.pages[item.page - 1] ?? [], item.label);
    // Si la etiqueta se repite en la página, cada campo usa la siguiente aparición.
    const key = `${item.page}|${normalizeForMatch(item.label)}`;
    const nth = seen.get(key) ?? 0;
    seen.set(key, nth + 1);
    const match = matches[nth] ?? matches[0];
    if (!size || !match) continue;
    // Sin opciones, un desplegable o un grupo de opciones no tiene sentido: se crea como texto.
    const type =
      (item.type === 'dropdown' || item.type === 'radio') && item.options.length === 0
        ? 'text'
        : item.type;
    fields.push({
      type,
      name: fieldNameFor(item.label, taken),
      page: item.page,
      rect: fieldRectFor(boundsOf(match), type, item.multiline, size, item.options.length),
      options: type === 'dropdown' || type === 'radio' ? item.options : [],
      multiline: item.multiline,
      required: false,
    });
  }
  if (fields.length === 0) {
    toast.error(i18n.t('ai.nothingToCreate'));
    return false;
  }
  const ok = await runPageOp({ type: 'addFormFields', fields }, {}, tab.id);
  if (ok) toast.success(i18n.t('ai.fieldsCreated', { count: fields.length }));
  return ok;
}

// ---------------------------------------------------------------------------
// Redacción inteligente
// ---------------------------------------------------------------------------

/** Parte una coincidencia en una caja por línea (si ocupa varias líneas, una sola caja taparía texto ajeno). */
function lineBoxes(words: PageWord[]): Rect[] {
  const lines: PageWord[][] = [];
  for (const word of words) {
    const line = lines[lines.length - 1];
    const last = line?.[line.length - 1];
    if (line && last && Math.abs(word.y - last.y) < Math.max(word.height, last.height) * 0.6) {
      line.push(word);
    } else lines.push([word]);
  }
  return lines.map((line) => boundsOf(line));
}

export async function findSensitiveData(): Promise<void> {
  const payload = await prepare();
  if (!payload) return;
  const result = await runTask(payload.tab, i18n.t('ai.findingSensitive'), (requestId) =>
    window.foliux.ai.findSensitive({ ...payload.body, requestId }),
  );
  if (!result) return;
  if (result.items.length === 0) {
    toast.info(i18n.t('ai.noSensitive'));
    return;
  }
  // Se cuentan las apariciones reales: la IA puede citar mal un texto, y eso no se puede marcar.
  const seen = new Set<string>();
  const items: SensitiveCandidate[] = [];
  for (const item of result.items) {
    const key = normalizeForMatch(item.text);
    if (key === '' || seen.has(key)) continue;
    seen.add(key);
    const occurrences = payload.document.pages.reduce(
      (sum, words) => sum + locatePhrase(words, item.text).length,
      0,
    );
    items.push({
      id: `s${items.length}`,
      text: item.text,
      category: item.category,
      reason: item.reason,
      occurrences,
      checked: occurrences > 0,
    });
  }
  useAi.getState().setReview({ kind: 'sensitive', tabId: payload.tab.id, items });
}

/** Marca como «a redactar» todas las apariciones de lo aceptado. No borra nada hasta aplicar la redacción. */
export async function markSensitiveForRedaction(items: SensitiveCandidate[]): Promise<number> {
  const tab = getActiveTab();
  if (!tab || tab.busy) return 0;
  const document = await extractDocument(tab);
  const marks = [];
  for (const [index, words] of document.pages.entries()) {
    for (const item of items) {
      for (const match of locatePhrase(words, item.text)) {
        for (const box of lineBoxes(match)) {
          marks.push(
            createAnnotation('redact', index + 1, {
              rect: { x: box.x - 1, y: box.y - 1, width: box.width + 2, height: box.height + 2 },
            }),
          );
        }
      }
    }
  }
  if (marks.length > 0) addAnnotations(tab.id, marks);
  return marks.length;
}

export function closeReview(): void {
  useAi.getState().setReview(null);
}
