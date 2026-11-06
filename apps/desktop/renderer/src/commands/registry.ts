import { useDocs, getActiveTab, isDirty } from '@/store/docs';
import { useUi, type Tool } from '@/store/ui';
import { isEditableTarget } from '@/lib/shortcuts';
import { startCompare, stepChange } from '@/lib/compare';
import { flattenFormFields } from '@/lib/forms';
import { useUpdate } from '@/store/update';
import { openNewDocumentDialog } from '@/lib/newdoc';
import { audioSummary, detectFormFields, extractTablesToExcel, findSensitiveData } from '@/lib/ai';
import { useCompare } from '@/store/compare';
import {
  applyPendingContent,
  deletePages,
  deleteSelectedAnnotation,
  duplicatePages,
  extractSelectedPages,
  hasPendingContent,
  insertBlankPage,
  insertPagesFromFile,
  mergeFiles,
  optimizeDocument,
  redo,
  requestCloseTab,
  rotatePages,
  saveActive,
  undo,
} from '@/lib/edit';
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
const canEditPages = () => hasDoc() && getActiveTab()?.busy === null;
const setTool = (tool: Tool) => useUi.getState().setTool(tool);
const isPaged = () => hasDoc() && useUi.getState().viewMode !== 'continuous';

export const commands: Command[] = [
  { id: 'file.new', label: 'commands.new', shortcuts: ['mod+n'], run: openNewDocumentDialog },
  { id: 'file.open', label: 'commands.open', shortcuts: ['mod+o'], run: openPdfDialog },
  {
    id: 'file.close',
    label: 'commands.close',
    shortcuts: ['mod+w'],
    enabled: hasDoc,
    run: () => {
      const tab = getActiveTab();
      if (tab) requestCloseTab(tab.id);
    },
  },
  {
    id: 'file.save',
    label: 'commands.save',
    shortcuts: ['mod+s'],
    enabled: () => {
      const tab = getActiveTab();
      return tab !== undefined && isDirty(tab) && tab.busy === null;
    },
    run: () => void saveActive(),
  },
  {
    id: 'file.saveAs',
    label: 'commands.saveAs',
    shortcuts: ['mod+shift+s'],
    enabled: () => hasDoc() && getActiveTab()?.busy === null,
    run: () => void saveActive(true),
  },
  { id: 'file.merge', label: 'commands.merge', run: mergeFiles },
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

  // --- Edición ---
  {
    id: 'edit.undo',
    label: 'commands.undo',
    shortcuts: ['mod+z'],
    // En un campo de texto, Ctrl+Z deshace el texto, no el documento.
    enabled: () =>
      (getActiveTab()?.history.length ?? 0) > 0 && !isEditableTarget(document.activeElement),
    run: undo,
  },
  {
    id: 'edit.redo',
    label: 'commands.redo',
    shortcuts: ['mod+shift+z', 'mod+y'],
    enabled: () =>
      (getActiveTab()?.future.length ?? 0) > 0 && !isEditableTarget(document.activeElement),
    run: redo,
  },
  {
    id: 'edit.delete',
    label: 'commands.deleteAnnotation',
    shortcuts: ['delete', 'backspace'],
    enabled: () => getActiveTab()?.selectedAnnotationId != null,
    run: deleteSelectedAnnotation,
  },
  {
    id: 'tool.cancel',
    label: 'commands.cancelTool',
    shortcuts: ['escape'],
    enabled: () => {
      const tab = getActiveTab();
      return (
        tab !== undefined &&
        (useUi.getState().tool !== 'select' || tab.selectedAnnotationId !== null) &&
        !useUi.getState().fullscreen &&
        !useUi.getState().searchOpen
      );
    },
    run: () => {
      const tab = getActiveTab();
      useUi.getState().setTool('select');
      if (tab) useDocs.getState().update(tab.id, { selectedAnnotationId: null });
    },
  },
  {
    id: 'tool.select',
    label: 'commands.tool.select',
    shortcuts: ['v'],
    enabled: hasDoc,
    run: () => setTool('select'),
  },
  {
    id: 'tool.highlight',
    label: 'commands.tool.highlight',
    shortcuts: ['h'],
    enabled: hasDoc,
    run: () => setTool('highlight'),
  },
  {
    id: 'tool.underline',
    label: 'commands.tool.underline',
    shortcuts: ['u'],
    enabled: hasDoc,
    run: () => setTool('underline'),
  },
  {
    id: 'tool.strikeout',
    label: 'commands.tool.strikeout',
    shortcuts: ['s'],
    enabled: hasDoc,
    run: () => setTool('strikeout'),
  },
  {
    id: 'tool.ink',
    label: 'commands.tool.ink',
    shortcuts: ['d'],
    enabled: hasDoc,
    run: () => setTool('ink'),
  },
  {
    id: 'tool.rect',
    label: 'commands.tool.rect',
    shortcuts: ['r'],
    enabled: hasDoc,
    run: () => setTool('rect'),
  },
  {
    id: 'tool.ellipse',
    label: 'commands.tool.ellipse',
    shortcuts: ['o'],
    enabled: hasDoc,
    run: () => setTool('ellipse'),
  },
  {
    id: 'tool.line',
    label: 'commands.tool.line',
    shortcuts: ['l'],
    enabled: hasDoc,
    run: () => setTool('line'),
  },
  {
    id: 'tool.arrow',
    label: 'commands.tool.arrow',
    shortcuts: ['a'],
    enabled: hasDoc,
    run: () => setTool('arrow'),
  },
  {
    id: 'tool.note',
    label: 'commands.tool.note',
    shortcuts: ['n'],
    enabled: hasDoc,
    run: () => setTool('note'),
  },
  {
    id: 'tool.freetext',
    label: 'commands.tool.freetext',
    shortcuts: ['t'],
    enabled: hasDoc,
    run: () => setTool('freetext'),
  },

  {
    id: 'tool.text',
    label: 'commands.tool.text',
    shortcuts: ['x'],
    enabled: hasDoc,
    run: () => setTool('text'),
  },
  {
    id: 'tool.edittext',
    label: 'commands.tool.edittext',
    shortcuts: ['e'],
    enabled: hasDoc,
    run: () => setTool('edittext'),
  },
  {
    id: 'tool.image',
    label: 'commands.tool.image',
    shortcuts: ['i'],
    enabled: hasDoc,
    run: () => setTool('image'),
  },
  {
    id: 'edit.apply',
    label: 'commands.applyContent',
    enabled: () => {
      const tab = getActiveTab();
      return tab !== undefined && tab.busy === null && hasPendingContent(tab);
    },
    run: () => void applyPendingContent(),
  },
  {
    id: 'dialog.watermark',
    label: 'commands.watermark',
    enabled: canEditPages,
    run: () => useUi.getState().setToolDialog('watermark'),
  },
  {
    id: 'dialog.headerFooter',
    label: 'commands.headerFooter',
    enabled: canEditPages,
    run: () => useUi.getState().setToolDialog('headerFooter'),
  },
  {
    id: 'dialog.split',
    label: 'commands.split',
    enabled: canEditPages,
    run: () => useUi.getState().setToolDialog('split'),
  },
  { id: 'file.optimize', label: 'commands.optimize', enabled: canEditPages, run: optimizeDocument },

  {
    id: 'tool.redact',
    label: 'commands.tool.redact',
    shortcuts: ['k'],
    enabled: hasDoc,
    run: () => setTool('redact'),
  },
  {
    id: 'dialog.security',
    label: 'commands.security',
    enabled: canEditPages,
    run: () => useUi.getState().setToolDialog('security'),
  },
  {
    id: 'dialog.metadata',
    label: 'commands.metadata',
    enabled: canEditPages,
    run: () => useUi.getState().setToolDialog('metadata'),
  },
  {
    id: 'dialog.redact',
    label: 'commands.redact',
    enabled: canEditPages,
    run: () => useUi.getState().setToolDialog('redact'),
  },
  {
    id: 'app.updates',
    label: 'commands.updates',
    run: () => useUpdate.getState().setDialogOpen(true),
  },
  {
    id: 'workspaces.open',
    label: 'commands.workspaces',
    enabled: hasDoc,
    run: () => useUi.getState().setSidebarTab('workspaces'),
  },
  {
    id: 'ai.open',
    label: 'commands.assistant',
    enabled: hasDoc,
    run: () => useUi.getState().setSidebarTab('assistant'),
  },
  { id: 'ai.tables', label: 'commands.aiTables', enabled: canEditPages, run: extractTablesToExcel },
  { id: 'ai.fields', label: 'commands.aiFields', enabled: canEditPages, run: detectFormFields },
  {
    id: 'ai.sensitive',
    label: 'commands.aiSensitive',
    enabled: canEditPages,
    run: findSensitiveData,
  },
  { id: 'ai.audio', label: 'commands.aiAudio', enabled: canEditPages, run: audioSummary },
  { id: 'compare.start', label: 'commands.compare', enabled: hasDoc, run: startCompare },
  {
    id: 'compare.next',
    label: 'commands.compareNext',
    shortcuts: ['f8'],
    enabled: () => useCompare.getState().changes.length > 0,
    run: () => stepChange(1),
  },
  {
    id: 'compare.previous',
    label: 'commands.comparePrevious',
    shortcuts: ['shift+f8'],
    enabled: () => useCompare.getState().changes.length > 0,
    run: () => stepChange(-1),
  },

  {
    id: 'tool.field',
    label: 'commands.tool.field',
    shortcuts: ['f'],
    enabled: hasDoc,
    run: () => setTool('field'),
  },
  {
    id: 'dialog.signature',
    label: 'commands.visualSignature',
    shortcuts: ['m'],
    enabled: canEditPages,
    run: () => useUi.getState().setToolDialog('signature'),
  },
  {
    id: 'dialog.sign',
    label: 'commands.digitalSignature',
    enabled: canEditPages,
    run: () => useUi.getState().setToolDialog('sign'),
  },
  {
    id: 'dialog.certificate',
    label: 'commands.certificate',
    run: () => useUi.getState().setToolDialog('certificate'),
  },
  {
    id: 'dialog.audit',
    label: 'commands.audit',
    run: () => useUi.getState().setToolDialog('audit'),
  },
  {
    id: 'forms.flatten',
    label: 'commands.flattenForm',
    enabled: () => (getActiveTab()?.form?.length ?? 0) > 0 && canEditPages(),
    run: () => void flattenFormFields(),
  },

  {
    id: 'dialog.ocr',
    label: 'commands.ocr',
    enabled: canEditPages,
    run: () => useUi.getState().setToolDialog('ocr'),
  },
  {
    id: 'dialog.convert',
    label: 'commands.convert',
    run: () => useUi.getState().setToolDialog('convert'),
  },
  {
    id: 'dialog.pdfa',
    label: 'commands.pdfa',
    enabled: canEditPages,
    run: () => useUi.getState().setToolDialog('pdfa'),
  },
  {
    id: 'dialog.batch',
    label: 'commands.batch',
    run: () => useUi.getState().setToolDialog('batch'),
  },

  // --- Páginas ---
  {
    id: 'pages.rotateRight',
    label: 'commands.rotateRight',
    shortcuts: ['mod+]'],
    enabled: canEditPages,
    run: () => void rotatePages(90),
  },
  {
    id: 'pages.rotateLeft',
    label: 'commands.rotateLeft',
    shortcuts: ['mod+['],
    enabled: canEditPages,
    run: () => void rotatePages(-90),
  },
  {
    id: 'pages.rotate180',
    label: 'commands.rotate180',
    enabled: canEditPages,
    run: () => void rotatePages(180),
  },
  {
    id: 'pages.delete',
    label: 'commands.deletePages',
    enabled: canEditPages,
    run: () => void deletePages(),
  },
  {
    id: 'pages.duplicate',
    label: 'commands.duplicatePages',
    enabled: canEditPages,
    run: () => void duplicatePages(),
  },
  {
    id: 'pages.insertBlank',
    label: 'commands.insertBlank',
    enabled: canEditPages,
    run: () => void insertBlankPage(),
  },
  {
    id: 'pages.insertFile',
    label: 'commands.insertFromFile',
    enabled: canEditPages,
    run: () => void insertPagesFromFile(),
  },
  {
    id: 'pages.extract',
    label: 'commands.extractPages',
    enabled: canEditPages,
    run: () => void extractSelectedPages(),
  },

  { id: 'app.theme', label: 'commands.theme', shortcuts: ['mod+shift+l'], run: cycleTheme },
  {
    id: 'app.palette',
    label: 'commands.palette',
    shortcuts: ['mod+k', 'mod+shift+p'],
    run: () => useUi.getState().setPaletteOpen(!useUi.getState().paletteOpen),
  },
];
