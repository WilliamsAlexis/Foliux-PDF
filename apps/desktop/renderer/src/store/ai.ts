import { create } from 'zustand';
import type { ChatMessage, SensitiveCategory } from '@foliux-pdf/core';

/** Estado del asistente de IA: conversaciones por documento, tareas en curso y cuadros pendientes. */

export interface AiStatus {
  configured: boolean;
  secureStorage: boolean;
  model: string;
}

/** Campo de formulario propuesto por la IA, a revisar antes de crearlo. */
export interface FieldCandidate {
  id: string;
  label: string;
  type: 'text' | 'checkbox' | 'dropdown' | 'radio';
  page: number;
  options: string[];
  multiline: boolean;
  /** ¿Se encontró la etiqueta en la página? Si no, no se puede colocar el campo. */
  located: boolean;
  checked: boolean;
}

/** Dato sensible propuesto por la IA, a revisar antes de marcarlo para redactar. */
export interface SensitiveCandidate {
  id: string;
  text: string;
  category: SensitiveCategory;
  reason: string;
  /** Veces que aparece en el documento (0 = la IA lo citó mal y no se puede marcar). */
  occurrences: number;
  checked: boolean;
}

export type AiReview =
  | { kind: 'fields'; tabId: string; items: FieldCandidate[] }
  | { kind: 'sensitive'; tabId: string; items: SensitiveCandidate[] };

/** Aviso previo a enviar un documento a la API (la IA es un servicio externo). */
export interface ConsentPrompt {
  tabId: string;
  documentName: string;
  tokens: number;
  includedPages: number;
  totalPages: number;
  truncated: boolean;
  /** Más de uno cuando se consulta un espacio de trabajo entero. */
  documentCount?: number;
  resolve: (accepted: boolean) => void;
}

interface AiState {
  status: AiStatus | null;
  chats: Record<string, ChatMessage[]>;
  /** Respuesta de la conversación que va llegando. */
  stream: { tabId: string; requestId: string; text: string } | null;
  /** Tarea que no es una conversación (tablas, campos, presentación...). */
  task: { tabId: string; requestId: string; label: string } | null;
  /** Documentos cuyo envío a la IA ya aceptó el usuario en esta sesión. */
  consented: string[];
  consentPrompt: ConsentPrompt | null;
  keyDialog: boolean;
  slidesDialog: boolean;
  review: AiReview | null;
  /** Texto del resumen en audio y estado de la locución. */
  audio: { tabId: string; text: string; state: 'playing' | 'paused' | 'stopped' } | null;

  setStatus: (status: AiStatus | null) => void;
  setChat: (tabId: string, messages: ChatMessage[]) => void;
  setStream: (stream: AiState['stream']) => void;
  setTask: (task: AiState['task']) => void;
  addConsent: (tabId: string) => void;
  setConsentPrompt: (prompt: ConsentPrompt | null) => void;
  setKeyDialog: (open: boolean) => void;
  setSlidesDialog: (open: boolean) => void;
  setReview: (review: AiReview | null) => void;
  setAudio: (audio: AiState['audio']) => void;
}

export const useAi = create<AiState>()((set) => ({
  status: null,
  chats: {},
  stream: null,
  task: null,
  consented: [],
  consentPrompt: null,
  keyDialog: false,
  slidesDialog: false,
  review: null,
  audio: null,

  setStatus: (status) => set({ status }),
  setChat: (tabId, messages) => set((s) => ({ chats: { ...s.chats, [tabId]: messages } })),
  setStream: (stream) => set({ stream }),
  setTask: (task) => set({ task }),
  addConsent: (tabId) =>
    set((s) => (s.consented.includes(tabId) ? s : { consented: [...s.consented, tabId] })),
  setConsentPrompt: (consentPrompt) => set({ consentPrompt }),
  setKeyDialog: (keyDialog) => set({ keyDialog }),
  setSlidesDialog: (slidesDialog) => set({ slidesDialog }),
  setReview: (review) => set({ review }),
  setAudio: (audio) => set({ audio }),
}));
