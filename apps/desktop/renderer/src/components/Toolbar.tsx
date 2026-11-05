import { useEffect, useState } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  Columns2,
  FileText,
  Maximize,
  Monitor,
  Moon,
  PanelLeft,
  Scroll,
  Search,
  Sun,
  Terminal,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ViewMode } from '@foliux-pdf/core';
import type { DocTab } from '@/store/docs';
import { useUi } from '@/store/ui';
import { IconButton } from '@/components/IconButton';
import {
  cycleTheme,
  goToPage,
  setZoom,
  setZoomMode,
  stepPages,
  toggleFullscreen,
  zoomStep,
} from '@/lib/actions';
import { cn } from '@/lib/utils';

const ZOOM_OPTIONS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];

const VIEW_MODE_ICONS: Record<ViewMode, React.ReactNode> = {
  single: <FileText />,
  continuous: <Scroll />,
  double: <Columns2 />,
};

/** Barra de herramientas. Hoy muestra las herramientas de lectura; en próximas fases cambiará según la herramienta activa. */
export function Toolbar({ tab }: { tab: DocTab }) {
  const { t } = useTranslation();
  const { viewMode, setViewMode, sidebarOpen, toggleSidebar, searchOpen, setSearchOpen, theme } =
    useUi();
  const setPaletteOpen = useUi((s) => s.setPaletteOpen);

  // Cuadro de página: se edita libremente y se aplica con Enter o al salir del campo.
  const [pageText, setPageText] = useState(String(tab.page));
  useEffect(() => setPageText(String(tab.page)), [tab.page, tab.id]);

  const commitPage = () => {
    const value = Number.parseInt(pageText, 10);
    if (Number.isFinite(value)) goToPage(value);
    else setPageText(String(tab.page));
  };

  // Ctrl+G enfoca el cuadro de página
  useEffect(() => {
    const focus = () => {
      const input = document.getElementById('page-input') as HTMLInputElement | null;
      input?.focus();
      input?.select();
    };
    window.addEventListener('foliux:focus-page', focus);
    return () => window.removeEventListener('foliux:focus-page', focus);
  }, []);

  const zoomValue =
    tab.zoomMode === 'custom' ? String(Math.round(tab.zoom * 100) / 100) : tab.zoomMode;
  const zoomIsPreset =
    tab.zoomMode !== 'custom' || ZOOM_OPTIONS.some((z) => Math.abs(z - tab.zoom) < 0.005);

  const ThemeIcon = theme === 'dark' ? Moon : theme === 'light' ? Sun : Monitor;

  return (
    <div
      role="toolbar"
      aria-label={t('toolbar.label')}
      className="flex h-11 shrink-0 items-center gap-1 border-b border-border bg-background px-2"
    >
      <IconButton
        label={t('toolbar.sidebar')}
        shortcut="mod+b"
        icon={<PanelLeft />}
        aria-pressed={sidebarOpen}
        onClick={toggleSidebar}
      />

      <Divider />

      <IconButton
        label={t('toolbar.previousPage')}
        icon={<ChevronLeft />}
        disabled={tab.page <= 1}
        onClick={() => stepPages(-1)}
      />
      <input
        id="page-input"
        aria-label={t('toolbar.page')}
        value={pageText}
        inputMode="numeric"
        onChange={(e) => setPageText(e.target.value.replace(/\D/g, ''))}
        onBlur={commitPage}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            commitPage();
            (e.target as HTMLInputElement).blur();
          } else if (e.key === 'Escape') {
            setPageText(String(tab.page));
            (e.target as HTMLInputElement).blur();
          }
        }}
        className="h-8 w-12 rounded-md border border-input bg-transparent px-1 text-center text-sm tabular-nums"
      />
      <span className="text-sm whitespace-nowrap text-muted-foreground tabular-nums">
        {t('toolbar.pageOf', { total: tab.numPages })}
      </span>
      <IconButton
        label={t('toolbar.nextPage')}
        icon={<ChevronRight />}
        disabled={tab.page >= tab.numPages}
        onClick={() => stepPages(1)}
      />

      <Divider />

      <IconButton
        label={t('toolbar.zoomOut')}
        shortcut="mod+-"
        icon={<ZoomOut />}
        onClick={() => zoomStep(-1)}
      />
      <select
        aria-label={t('toolbar.zoom')}
        value={zoomValue}
        onChange={(e) => {
          const v = e.target.value;
          if (v === 'fit-width' || v === 'fit-page') setZoomMode(v);
          else setZoom(Number(v));
        }}
        className="h-8 rounded-md border border-input bg-background px-1.5 text-sm tabular-nums"
      >
        <option value="fit-width">{t('toolbar.fitWidth')}</option>
        <option value="fit-page">{t('toolbar.fitPage')}</option>
        {!zoomIsPreset && <option value={zoomValue}>{Math.round(tab.zoom * 100)} %</option>}
        {ZOOM_OPTIONS.map((z) => (
          <option key={z} value={String(z)}>
            {Math.round(z * 100)} %
          </option>
        ))}
      </select>
      <span className="w-12 text-xs text-muted-foreground tabular-nums" aria-hidden>
        {Math.round(tab.zoom * 100)} %
      </span>
      <IconButton
        label={t('toolbar.zoomIn')}
        shortcut="mod+plus"
        icon={<ZoomIn />}
        onClick={() => zoomStep(1)}
      />

      <Divider />

      <div role="group" aria-label={t('toolbar.viewMode')} className="flex items-center gap-0.5">
        {(['single', 'continuous', 'double'] as const).map((mode, index) => (
          <IconButton
            key={mode}
            label={t(`viewMode.${mode}`)}
            shortcut={`alt+${index + 1}`}
            icon={VIEW_MODE_ICONS[mode]}
            aria-pressed={viewMode === mode}
            className={cn(viewMode === mode && 'bg-accent text-accent-foreground')}
            onClick={() => setViewMode(mode)}
          />
        ))}
      </div>
      <IconButton
        label={t('toolbar.fullscreen')}
        shortcut="f11"
        icon={<Maximize />}
        onClick={() => void toggleFullscreen()}
      />

      <div className="flex-1" />

      <IconButton
        label={t('toolbar.search')}
        shortcut="mod+f"
        icon={<Search />}
        aria-pressed={searchOpen}
        onClick={() => setSearchOpen(!searchOpen)}
      />
      <IconButton
        label={t('toolbar.theme', { mode: t(`theme.${theme}`) })}
        shortcut="mod+shift+l"
        icon={<ThemeIcon />}
        onClick={cycleTheme}
      />
      <IconButton
        label={t('toolbar.commandPalette')}
        shortcut="mod+k"
        icon={<Terminal />}
        onClick={() => setPaletteOpen(true)}
      />
    </div>
  );
}

function Divider() {
  return <div className="mx-1 h-5 w-px bg-border" aria-hidden />;
}
