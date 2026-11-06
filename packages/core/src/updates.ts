import { z } from 'zod';

/** Estado de las actualizaciones de la aplicación (las gestiona el proceso principal con electron-updater). */
export const UpdateStateSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('idle') }),
  /** Esta ejecución no puede actualizarse sola (p. ej. en desarrollo). */
  z.object({ state: z.literal('unavailable'), reason: z.string() }),
  z.object({ state: z.literal('checking') }),
  z.object({ state: z.literal('none') }),
  z.object({ state: z.literal('available'), version: z.string(), notes: z.string() }),
  z.object({ state: z.literal('downloading'), version: z.string(), percent: z.number() }),
  z.object({ state: z.literal('downloaded'), version: z.string() }),
  z.object({ state: z.literal('error'), message: z.string() }),
]);
export type UpdateState = z.infer<typeof UpdateStateSchema>;

export const UpdateInfoSchema = z.object({
  /** Versión instalada. */
  current: z.string(),
  state: UpdateStateSchema,
});
export type UpdateInfo = z.infer<typeof UpdateInfoSchema>;
