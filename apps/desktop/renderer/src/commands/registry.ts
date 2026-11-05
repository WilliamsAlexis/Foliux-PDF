import { useDocs, getActiveTab } from '@/store/docs';
import { useUi } from '@/store/ui';
import {
  cycleTab,
  cycleTheme,
  goToPage,
  openPdfDialog,
  setZoom,
  setZoomMode,
  stepHit,
  stepPages,
  toggleFullscreen,
  zoomStep,
} from '@/lib/actions';

/** Un comando de la aplicación: lo usan los atajos de teclado y la paleta (Ctrl+K). */
export interface Command {
  id: string;
  /** Clave de traducción del nombre (commands.*). */
  label: string;
  /** Uno o varios atajos, en formato 'mod+shift+k'. El primero es el que se muestra. */
  shortcuts?: string[];
  /** Si devuelve false, el comando no se ofrece ni se ejecuta. */
  enabled?: () => boolean;
  run: () => void | Promise<void>;
  /** Si es true, también funciona escribiendo en un campo de texto sin pulsar Ctrl. */
  allowInInput?: boolean;
}

const hasDoc = () => getActiveTab() !== undefined;
const isPaged = () => hasDoc() && useUi.getState().viewMode !== 'continuous';

export const commands: Command[] = [
  { id: 'file.open', label: 'commands.open', shortcuts: ['mod+o'], run: openPdfDialog },
  {
    id: 'file.close',
    label: 'commands.close',
    shortcuts: ['mod+w'],
    enabled: hasDoc,
    run: () => {
      const tab = getActiveTab();
      if (tab) useDocs.getState().closeTab(tab.id);
    },
  },
  {
    id: 'tab.next',
    label: 'commands.nextTab',
    shortcuts: ['ctrl+tab'],
    enabled: () => useDocs.getState().tabs.length > 1,
    run: () => cycleTab(1),
  },
  {
    id: 'tab.previous',
    label: 'commands.previousTab',
    shortcuts: ['ctrl+shift+tab'],
    enabled: () => useDocs.getState().tabs.length > 1,
    run: () => cycleTab(-1),
  },

  {
    id: 'view.zoomIn',
    label: 'commands.zoomIn',
    shortcuts: ['mod+plus', 'mod+='],
    enabled: hasDoc,
    run: () => zoomStep(1),
  },
  {
    id: 'view.zoomOut',
    label: 'commands.zoomOut',
    shortcuts: ['mod+-'],
    enabled: hasDoc,
    run: () => zoomStep(-1),
  },
  {
    id: 'view.zoomReset',
    label: 'commands.zoomReset',
    shortcuts: ['mod+0'],
    enabled: hasDoc,
    run: () => setZoom(1),
  },
  {
    id: 'view.fitWidth',
    label: 'commands.fitWidth',
    shortcuts: ['mod+1'],
    enabled: hasDoc,
    run: () => setZoomMode('fit-width'),
  },
  {
    id: 'view.fitPage',
    label: 'commands.fitPage',
    shortcuts: ['mod+2'],
    enabled: hasDoc,
    run: () => setZoomMode('fit-page'),
  },

  {
    id: 'view.single',
    label: 'commands.single',
    shortcuts: ['alt+1'],
    enabled: hasDoc,
    run: () => useUi.getState().setViewMode('single'),
  },
  {
    id: 'view.continuous',
    label: 'commands.continuous',
    shortcuts: ['alt+2'],
    enabled: hasDoc,
    run: () => useUi.getState().setViewMode('continuous'),
  },
  {
    id: 'view.double',
    label: 'commands.double',
    shortcuts: ['alt+3'],
    enabled: hasDoc,
    run: () => useUi.getState().setViewMode('double'),
  },
  {
    id: 'view.fullscreen',
    label: 'commands.fullscreen',
    shortcuts: ['f11'],
    enabled: hasDoc,
    run: toggleFullscreen,
  },
  {
    id: 'view.exitFullscreen',
    label: 'commands.exitFullscreen',
    shortcuts: ['escape'],
    enabled: () => useUi.getState().fullscreen,
    run: toggleFullscreen,
    allowInInput: true,
  },
  {
    id: 'view.sidebar',
    label: 'commands.sidebar',
    shortcuts: ['mod+b'],
    enabled: hasDoc,
    run: () => useUi.getState().toggleSidebar(),
  },

  // En modo continuo las flechas y AvPág desplazan el documento de forma natural;
  // en los modos de página, cambian de página.
  {
    id: 'nav.next',
    label: 'commands.nextPage',
    shortcuts: ['pagedown', 'arrowright'],
    enabled: isPaged,
    run: () => stepPages(1),
  },
  {
    id: 'nav.previous',
    label: 'commands.previousPage',
    shortcuts: ['pageup', 'arrowleft'],
    enabled: isPaged,
    run: () => stepPages(-1),
  },
  {
    id: 'nav.first',
    label: 'commands.firstPage',
    shortcuts: ['home'],
    enabled: hasDoc,
    run: () => goToPage(1),
  },
  {
    id: 'nav.last',
    label: 'commands.lastPage',
    shortcuts: ['end'],
    enabled: hasDoc,
    run: () => goToPage(getActiveTab()?.numPages ?? 1),
  },
  {
    id: 'nav.goTo',
    label: 'commands.goToPage',
    shortcuts: ['mod+g'],
    enabled: hasDoc,
    run: () => window.dispatchEvent(new CustomEvent('foliux:focus-page')),
  },

  {
    id: 'search.find',
    label: 'commands.find',
    shortcuts: ['mod+f'],
    enabled: hasDoc,
    run: () => {
      useUi.getState().setSearchOpen(true);
      window.dispatchEvent(new CustomEvent('foliux:focus-search'));
    },
  },
  {
    id: 'search.next',
    label: 'commands.findNext',
    shortcuts: ['f3'],
    enabled: hasDoc,
    run: () => stepHit(1),
  },
  {
    id: 'search.previous',
    label: 'commands.findPrevious',
    shortcuts: ['shift+f3'],
    enabled: hasDoc,
    run: () => stepHit(-1),
  },
  {
    id: 'search.close',
    label: 'commands.closeSearch',
    shortcuts: ['escape'],
    enabled: () => useUi.getState().searchOpen && !useUi.getState().fullscreen,
    run: () => useUi.getState().setSearchOpen(false),
    allowInInput: true,
  },

  { id: 'app.theme', label: 'commands.theme', shortcuts: ['mod+shift+l'], run: cycleTheme },
  {
    id: 'app.palette',
    label: 'commands.palette',
    shortcuts: ['mod+k', 'mod+shift+p'],
    run: () => useUi.getState().setPaletteOpen(!useUi.getState().paletteOpen),
  },
];
