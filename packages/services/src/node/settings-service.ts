import { z } from 'zod';
import {
  DEFAULT_SETTINGS,
  THEME_PREFERENCES,
  type AppSettings,
  type ILogger,
  type ISettingsService,
} from '@foliux-pdf/core';
import { JsonFileStore } from './json-file-store';

const SettingsSchema = z.object({
  theme: z.enum(THEME_PREFERENCES).catch(DEFAULT_SETTINGS.theme),
  language: z.string().catch(DEFAULT_SETTINGS.language),
});

/** Preferencias del usuario (tema, idioma) guardadas en un JSON. */
export class SettingsService implements ISettingsService {
  private readonly store: JsonFileStore<AppSettings>;

  constructor(storePath: string, logger?: ILogger) {
    this.store = new JsonFileStore(
      storePath,
      SettingsSchema,
      () => ({ ...DEFAULT_SETTINGS }),
      logger,
    );
  }

  get(): Promise<AppSettings> {
    return this.store.read();
  }

  async update(patch: Partial<AppSettings>): Promise<AppSettings> {
    const next = { ...(await this.store.read()), ...patch };
    await this.store.write(next);
    return next;
  }
}
