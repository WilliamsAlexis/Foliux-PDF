import { BookMarked, LayoutGrid, ListFilter } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { DocTab } from '@/store/docs';
import { useUi, type SidebarTab } from '@/store/ui';
import { IconButton } from '@/components/IconButton';
import { cn } from '@/lib/utils';
import { ThumbnailList } from './ThumbnailList';
import { OutlineTree } from './OutlineTree';
import { ResultsList } from './ResultsList';

const TABS: { id: SidebarTab; icon: React.ReactNode; label: string }[] = [
  { id: 'thumbnails', icon: <LayoutGrid />, label: 'sidebar.thumbnails' },
  { id: 'outline', icon: <BookMarked />, label: 'sidebar.outline' },
  { id: 'results', icon: <ListFilter />, label: 'sidebar.results' },
];

/** Barra lateral plegable con miniaturas, marcadores y resultados de búsqueda. */
export function Sidebar({ tab }: { tab: DocTab }) {
  const { t } = useTranslation();
  const open = useUi((s) => s.sidebarOpen);
  const active = useUi((s) => s.sidebarTab);
  const setTab = useUi((s) => s.setSidebarTab);

  return (
    <aside
      aria-label={t('sidebar.label')}
      aria-hidden={!open}
      // inert evita que el contenido oculto reciba foco con el teclado
      inert={!open}
      className={cn(
        'shrink-0 overflow-hidden border-border bg-background transition-[width] duration-200 ease-out',
        open ? 'w-[248px] border-r' : 'w-0',
      )}
    >
      <div className="flex h-full w-[248px] flex-col">
        <div
          role="tablist"
          aria-label={t('sidebar.label')}
          className="flex shrink-0 gap-1 border-b border-border p-1.5"
        >
          {TABS.map(({ id, icon, label }) => (
            <IconButton
              key={id}
              role="tab"
              id={`sidebar-tab-${id}`}
              aria-selected={active === id}
              aria-controls={`sidebar-panel-${id}`}
              label={t(label)}
              icon={icon}
              className={cn(active === id && 'bg-accent text-accent-foreground')}
              onClick={() => setTab(id)}
            />
          ))}
        </div>
        <div
          role="tabpanel"
          id={`sidebar-panel-${active}`}
          aria-labelledby={`sidebar-tab-${active}`}
          className="min-h-0 flex-1 overflow-y-auto"
        >
          {active === 'thumbnails' && <ThumbnailList tab={tab} />}
          {active === 'outline' && <OutlineTree tab={tab} />}
          {active === 'results' && <ResultsList tab={tab} />}
        </div>
      </div>
    </aside>
  );
}
