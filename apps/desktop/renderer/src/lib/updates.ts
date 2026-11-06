import { toast } from 'sonner';
import type { UpdateState } from '@foliux-pdf/core';
import i18n from '@/i18n';
import { isDirty, useDocs } from '@/store/docs';
import { useUpdate } from '@/store/update';
import { notifyError } from './notify';

/** Actualizaciones de la aplicación: avisar, descargar e instalar siempre por decisión del usuario. */

const TOAST_ID = 'app-update';

/** Aviso al aparecer una versión nueva (la búsqueda silenciosa del inicio solo llega aquí). */
function announce(state: UpdateState): void {
  if (state.state === 'available') {
    toast(i18n.t('updates.availableToast', { version: state.version }), {
      id: TOAST_ID,
      duration: 20_000,
      action: {
        label: i18n.t('updates.details'),
        onClick: () => useUpdate.getState().setDialogOpen(true),
      },
    });
  } else if (state.state === 'downloaded') {
    toast.success(i18n.t('updates.downloadedToast', { version: state.version }), {
      id: TOAST_ID,
      duration: 20_000,
      action: {
        label: i18n.t('updates.details'),
        onClick: () => useUpdate.getState().setDialogOpen(true),
      },
    });
  }
}

export async function initUpdates(): Promise<() => void> {
  const off = window.foliux.updates.onChange((state) => {
    useUpdate.getState().set({ state });
    announce(state);
  });
  try {
    const [info, settings] = await Promise.all([
      window.foliux.updates.status(),
      window.foliux.settings.get(),
    ]);
    useUpdate.getState().set({
      current: info.current,
      // El estado que llegue por evento antes de esta lectura es más reciente: no se pisa.
      state: useUpdate.getState().state.state === 'idle' ? info.state : useUpdate.getState().state,
      autoCheck: settings.autoCheckUpdates,
    });
  } catch (error) {
    window.foliux.log('warn', `No se pudo leer el estado de las actualizaciones: ${String(error)}`);
  }
  return off;
}

export async function checkForUpdates(): Promise<void> {
  try {
    const info = await window.foliux.updates.check();
    useUpdate.getState().set({ current: info.current, state: info.state });
  } catch (error) {
    notifyError(i18n.t('updates.failed'), error);
  }
}

export async function downloadUpdate(): Promise<void> {
  try {
    await window.foliux.updates.download();
  } catch (error) {
    notifyError(i18n.t('updates.failed'), error);
  }
}

/** Instala y reinicia; con cambios sin guardar se pide guardarlos antes (reiniciar los perdería). */
export async function installUpdate(): Promise<void> {
  if (useDocs.getState().tabs.some(isDirty)) {
    toast.error(i18n.t('updates.unsaved'));
    return;
  }
  try {
    await window.foliux.updates.install();
  } catch (error) {
    notifyError(i18n.t('updates.failed'), error);
  }
}

export async function setAutoCheck(value: boolean): Promise<void> {
  useUpdate.getState().set({ autoCheck: value });
  try {
    await window.foliux.settings.update({ autoCheckUpdates: value });
  } catch (error) {
    useUpdate.getState().set({ autoCheck: !value });
    notifyError(i18n.t('updates.failed'), error);
  }
}
