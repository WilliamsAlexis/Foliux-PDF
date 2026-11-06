import { useTranslation } from 'react-i18next';
import * as Dialog from '@radix-ui/react-dialog';
import { Button } from '@/components/ui/button';
import { useUpdate } from '@/store/update';
import { checkForUpdates, downloadUpdate, installUpdate, setAutoCheck } from '@/lib/updates';

/** Estado de las actualizaciones: versión instalada, buscar, descargar e instalar. */
export function UpdateDialog() {
  const { t } = useTranslation();
  const open = useUpdate((s) => s.dialogOpen);
  const setOpen = useUpdate((s) => s.setDialogOpen);
  const current = useUpdate((s) => s.current);
  const state = useUpdate((s) => s.state);
  const autoCheck = useUpdate((s) => s.autoCheck);

  const searching = state.state === 'checking';
  const canSearch =
    state.state !== 'unavailable' &&
    state.state !== 'downloading' &&
    state.state !== 'downloaded' &&
    !searching;

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
        <Dialog.Content className="fixed top-[12%] left-1/2 z-50 w-[480px] max-w-[calc(100vw-2rem)] -translate-x-1/2 rounded-xl border border-border bg-popover p-5 text-popover-foreground shadow-2xl">
          <Dialog.Title className="text-base font-semibold">{t('updates.title')}</Dialog.Title>
          <Dialog.Description className="mt-1 mb-4 text-sm text-muted-foreground">
            {t('updates.installed', { version: current || '—' })}
          </Dialog.Description>

          <div role="status" aria-live="polite" className="mb-4 space-y-2 text-sm">
            {state.state === 'idle' && <p>{t('updates.idle')}</p>}
            {state.state === 'unavailable' && <p>{state.reason}</p>}
            {state.state === 'checking' && <p>{t('updates.checking')}</p>}
            {state.state === 'none' && <p>{t('updates.none')}</p>}
            {state.state === 'available' && (
              <>
                <p className="font-medium">{t('updates.available', { version: state.version })}</p>
                {state.notes && (
                  <p className="max-h-32 overflow-y-auto text-xs whitespace-pre-wrap text-muted-foreground">
                    {state.notes}
                  </p>
                )}
              </>
            )}
            {state.state === 'downloading' && (
              <>
                <p>
                  {t('updates.downloading', { version: state.version, percent: state.percent })}
                </p>
                <div
                  role="progressbar"
                  aria-valuenow={state.percent}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  className="h-2 overflow-hidden rounded-full bg-muted"
                >
                  <div
                    className="h-full bg-primary transition-[width]"
                    style={{ width: `${state.percent}%` }}
                  />
                </div>
              </>
            )}
            {state.state === 'downloaded' && (
              <>
                <p className="font-medium">{t('updates.downloaded', { version: state.version })}</p>
                <p className="text-xs text-muted-foreground">{t('updates.installNote')}</p>
              </>
            )}
            {state.state === 'error' && (
              <p role="alert" className="text-destructive">
                {state.message}
              </p>
            )}
          </div>

          <label className="mb-4 flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={autoCheck}
              onChange={(event) => void setAutoCheck(event.target.checked)}
            />
            {t('updates.autoCheck')}
          </label>

          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setOpen(false)}>
              {t('dialogs.close')}
            </Button>
            {canSearch && state.state !== 'available' && (
              <Button variant="outline" onClick={() => void checkForUpdates()}>
                {t('updates.check')}
              </Button>
            )}
            {state.state === 'available' && (
              <Button onClick={() => void downloadUpdate()}>{t('updates.download')}</Button>
            )}
            {state.state === 'downloaded' && (
              <Button onClick={() => void installUpdate()}>{t('updates.install')}</Button>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
