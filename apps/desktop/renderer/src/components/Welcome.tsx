import { FilePlus2, FileText, FolderOpen, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/IconButton';
import { openPdfDialog, openPdfPath, refreshRecent } from '@/lib/actions';
import { formatShortcut } from '@/lib/shortcuts';
import { useUi } from '@/store/ui';
import { useUpdate } from '@/store/update';
import { openNewDocumentDialog } from '@/lib/newdoc';

/** Pantalla inicial cuando no hay ningún documento abierto. */
export function Welcome() {
  const { t } = useTranslation();
  const recent = useUi((s) => s.recent);

  const clear = async () => {
    await window.foliux.recent.clear();
    await refreshRecent();
  };
  const remove = async (path: string) => {
    await window.foliux.recent.remove(path);
    await refreshRecent();
  };

  return (
    <div className="flex h-full items-center justify-center overflow-auto p-8">
      <div className="w-full max-w-[560px]">
        <div className="mb-8 flex flex-col items-center text-center">
          <img src="./logo.svg" alt="" aria-hidden className="mb-4 size-16 drop-shadow-lg" />
          <h1 className="text-3xl font-semibold tracking-tight">{t('welcome.title')}</h1>
          <p className="mt-2 text-muted-foreground">{t('welcome.subtitle')}</p>
          <div className="mt-6 flex flex-wrap justify-center gap-2">
            <Button onClick={() => void openPdfDialog()}>
              <FolderOpen aria-hidden /> {t('welcome.open')}
              <kbd className="ml-1 rounded bg-primary-foreground/20 px-1.5 py-0.5 font-sans text-xs">
                {formatShortcut('mod+o')}
              </kbd>
            </Button>
            <Button variant="outline" onClick={openNewDocumentDialog}>
              <FilePlus2 aria-hidden /> {t('welcome.new')}
              <kbd className="ml-1 rounded bg-muted px-1.5 py-0.5 font-sans text-xs">
                {formatShortcut('mod+n')}
              </kbd>
            </Button>
          </div>
          <p className="mt-3 text-sm text-muted-foreground">{t('welcome.dropHint')}</p>
        </div>

        <section aria-labelledby="recent-heading">
          <div className="mb-2 flex items-center justify-between">
            <h2 id="recent-heading" className="text-sm font-semibold">
              {t('welcome.recent')}
            </h2>
            {recent.length > 0 && (
              <Button variant="ghost" size="sm" onClick={() => void clear()}>
                {t('welcome.clearRecent')}
              </Button>
            )}
          </div>
          {recent.length === 0 ? (
            <p className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
              {t('welcome.noRecent')}
            </p>
          ) : (
            <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border">
              {recent.map((file) => (
                <li key={file.path} className="group flex items-center hover:bg-accent/50">
                  <button
                    type="button"
                    onClick={() => void openPdfPath(file.path)}
                    className="flex min-w-0 flex-1 items-center gap-3 px-3 py-2.5 text-left"
                  >
                    <FileText className="size-5 shrink-0 text-primary" aria-hidden />
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium">{file.name}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {file.path}
                      </span>
                    </span>
                  </button>
                  <IconButton
                    label={t('welcome.removeRecent', { name: file.name })}
                    icon={<X />}
                    className="mr-1.5 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100"
                    onClick={() => void remove(file.path)}
                  />
                </li>
              ))}
            </ul>
          )}
        </section>

        <p className="mt-6 text-center text-xs text-muted-foreground">
          {t('welcome.shortcuts', { keys: formatShortcut('mod+k') })}
        </p>
        <p className="mt-2 text-center text-xs">
          <button
            type="button"
            className="text-muted-foreground underline"
            onClick={() => useUpdate.getState().setDialogOpen(true)}
          >
            {t('updates.toolsAction')}
          </button>
        </p>
      </div>
    </div>
  );
}
