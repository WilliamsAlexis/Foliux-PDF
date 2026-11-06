import * as Dialog from '@radix-ui/react-dialog';
import { useTranslation } from 'react-i18next';
import { useDocs } from '@/store/docs';
import { useUi } from '@/store/ui';
import { saveTab } from '@/lib/edit';
import { Button } from '@/components/ui/button';

/** Aviso al cerrar una pestaña con cambios sin guardar. */
export function ConfirmCloseDialog() {
  const { t } = useTranslation();
  const tabId = useUi((s) => s.closePrompt);
  const setClosePrompt = useUi((s) => s.setClosePrompt);
  const tab = useDocs((s) => s.tabs.find((candidate) => candidate.id === tabId));
  const open = tab !== undefined;

  const close = () => setClosePrompt(null);

  const discard = () => {
    if (!tab) return;
    close();
    useDocs.getState().closeTab(tab.id);
  };

  const saveAndClose = async () => {
    if (!tab) return;
    const id = tab.id;
    close();
    if (await saveTab(id)) useDocs.getState().closeTab(id);
  };

  return (
    <Dialog.Root open={open} onOpenChange={(value) => !value && close()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
        <Dialog.Content className="fixed top-[28%] left-1/2 z-50 w-[440px] max-w-[calc(100vw-2rem)] -translate-x-1/2 rounded-xl border border-border bg-popover p-5 text-popover-foreground shadow-2xl">
          <Dialog.Title className="text-base font-semibold">{t('closeDialog.title')}</Dialog.Title>
          <Dialog.Description className="mt-2 text-sm text-muted-foreground">
            {t('closeDialog.message', { name: tab?.name ?? '' })}
          </Dialog.Description>
          <div className="mt-5 flex flex-wrap justify-end gap-2">
            <Button variant="ghost" onClick={close}>
              {t('closeDialog.cancel')}
            </Button>
            <Button variant="outline" onClick={discard}>
              {t('closeDialog.discard')}
            </Button>
            <Button autoFocus onClick={() => void saveAndClose()}>
              {t('closeDialog.save')}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
