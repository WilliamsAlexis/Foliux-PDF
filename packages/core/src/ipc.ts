import { z } from 'zod';
import { ERROR_CODES } from './errors';
import { THEME_PREFERENCES } from './models';

/**
 * Contrato IPC entre el renderer y el proceso principal.
 * Cada canal define el esquema Zod de su petición y de su respuesta; el proceso principal
 * valida SIEMPRE la petición antes de actuar (el renderer no es de confianza).
 */

const AppSettingsSchema = z.object({
  theme: z.enum(THEME_PREFERENCES),
  language: z.string().min(2).max(10),
});

const RecentFileSchema = z.object({
  path: z.string(),
  name: z.string(),
  openedAt: z.number(),
});

export const ipcContract = {
  'dialog:open-pdf': {
    request: z.void(),
    response: z.array(z.string()),
  },
  'file:read': {
    request: z.object({ path: z.string().min(1).max(4096) }),
    response: z.object({
      path: z.string(),
      name: z.string(),
      data: z.custom<Uint8Array>((value) => value instanceof Uint8Array),
    }),
  },
  'recent:list': { request: z.void(), response: z.array(RecentFileSchema) },
  'recent:remove': { request: z.object({ path: z.string().min(1) }), response: z.void() },
  'recent:clear': { request: z.void(), response: z.void() },
  'settings:get': { request: z.void(), response: AppSettingsSchema },
  'settings:update': { request: AppSettingsSchema.partial(), response: AppSettingsSchema },
  'window:toggle-fullscreen': { request: z.void(), response: z.boolean() },
  'window:set-fullscreen': { request: z.object({ value: z.boolean() }), response: z.boolean() },
  'app:pending-files': { request: z.void(), response: z.array(z.string()) },
  'log:write': {
    request: z.object({
      level: z.enum(['info', 'warn', 'error']),
      message: z.string().max(5000),
    }),
    response: z.void(),
  },
} as const;

export type IpcChannel = keyof typeof ipcContract;
export type IpcRequest<C extends IpcChannel> = z.input<(typeof ipcContract)[C]['request']>;
export type IpcResponse<C extends IpcChannel> = z.output<(typeof ipcContract)[C]['response']>;

/** Eventos que el proceso principal envía al renderer. */
export const ipcEvents = {
  openFiles: 'event:open-files',
  fullscreenChanged: 'event:fullscreen-changed',
} as const;

/** Resultado envuelto: así los errores llegan al renderer con código y mensaje claros. */
export const IpcErrorSchema = z.object({
  code: z.enum(ERROR_CODES),
  message: z.string(),
});

export type IpcResult<T> =
  { ok: true; value: T } | { ok: false; error: z.infer<typeof IpcErrorSchema> };
