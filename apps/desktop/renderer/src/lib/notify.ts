import { toast } from 'sonner';
import i18n from '@/i18n';

/** Muestra un error al usuario (toast) y lo envía al registro del proceso principal. */
export function notifyError(title: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  toast.error(title, { description: message });
  window.foliux.log('error', `${title}: ${message}`);
}

export function notifyUnexpected(error: unknown): void {
  notifyError(i18n.t('errors.unexpected'), error);
}
