import { BadgeCheck, FileText, Lock, Plus, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { isDirty, useDocs } from '@/store/docs';
import { requestCloseTab } from '@/lib/edit';
import { openPdfDialog } from '@/lib/actions';
import { cn } from '@/lib/utils';
import { IconButton } from '@/components/IconButton';

/**
 * Barra de título propia: logotipo + pestañas de documentos. Toda la barra se puede arrastrar
 * para mover la ventana (app-drag); las pestañas y botones no (app-no-drag).
 * Los botones de la ventana (minimizar, maximizar, cerrar) los dibuja el sistema encima (titleBarOverlay).
 */
export function TitleBar() {
  const { t } = useTranslation();
  const tabs = useDocs((s) => s.tabs);
  const activeId = useDocs((s) => s.activeId);
  const setActive = useDocs((s) => s.setActive);
  const closeTab = requestCloseTab;
  const isMac = window.foliux.platform === 'darwin';

  return (
    <header className="app-drag h-10 w-full shrink-0 bg-titlebar select-none">
      <div
        className="flex h-full items-end"
        style={{
          // Deja libre la zona de los botones de ventana del sistema
          paddingLeft: isMac ? 78 : 'env(titlebar-area-x, 0px)',
          width: isMac ? '100%' : 'env(titlebar-area-width, 100%)',
        }}
      >
        <div className="flex h-full items-center gap-2 px-3">
          <div className="flex size-6 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <FileText className="size-3.5" aria-hidden />
          </div>
          <span className="text-[13px] font-semibold tracking-tight">{t('app.name')}</span>
        </div>

        <div
          role="tablist"
          aria-label={t('titlebar.tabs')}
          className="flex min-w-0 items-end gap-0.5 self-end overflow-x-auto pt-1.5 pl-1"
        >
          {tabs.map((tab) => {
            const active = tab.id === activeId;
            return (
              <div
                key={tab.id}
                role="tab"
                tabIndex={0}
                aria-selected={active}
                title={tab.path}
                onClick={() => setActive(tab.id)}
                onAuxClick={(e) => {
                  if (e.button === 1) closeTab(tab.id); // clic central cierra la pestaña
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    setActive(tab.id);
                  } else if (e.key === 'Delete') {
                    closeTab(tab.id);
                  }
                }}
                className={cn(
                  'app-no-drag group flex h-[30px] max-w-[220px] min-w-[110px] shrink-0 cursor-default items-center gap-1.5 rounded-t-lg px-3 text-[13px] transition-colors',
                  active
                    ? 'bg-background text-foreground'
                    : 'text-muted-foreground hover:bg-background/60 hover:text-foreground',
                )}
              >
                {tab.signatures.length > 0 && (
                  <BadgeCheck
                    className="size-3 shrink-0 text-muted-foreground"
                    aria-label={t('signatures.signedBadge')}
                  />
                )}
                {tab.protection && (
                  <Lock
                    className="size-3 shrink-0 text-muted-foreground"
                    aria-label={t('security.protected')}
                  />
                )}
                {isDirty(tab) && (
                  <span
                    role="img"
                    aria-label={t('titlebar.unsaved')}
                    title={t('titlebar.unsaved')}
                    className="size-2 shrink-0 rounded-full bg-primary"
                  />
                )}
                <span className="min-w-0 flex-1 truncate">{tab.name}</span>
                <button
                  type="button"
                  aria-label={t('titlebar.closeTab', { name: tab.name })}
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTab(tab.id);
                  }}
                  className="flex size-5 shrink-0 items-center justify-center rounded opacity-0 hover:bg-accent focus-visible:opacity-100 group-hover:opacity-100 aria-[selected=true]:opacity-100"
                >
                  <X className="size-3.5" aria-hidden />
                </button>
              </div>
            );
          })}
        </div>

        <div className="app-no-drag flex h-full items-center pl-1">
          <IconButton
            label={t('titlebar.open')}
            shortcut="mod+o"
            icon={<Plus />}
            onClick={() => void openPdfDialog()}
            className="size-7"
          />
        </div>
      </div>
    </header>
  );
}
