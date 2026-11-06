import { useEffect } from 'react';
import { Toaster, toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import { TooltipProvider } from '@/components/ui/tooltip';
import { TitleBar } from '@/components/TitleBar';
import { Toolbar } from '@/components/Toolbar';
import { AnnotationBar } from '@/components/AnnotationBar';
import { ConfirmCloseDialog } from '@/components/ConfirmCloseDialog';
import { ToolDialogs } from '@/components/ToolDialogs';
import { ConvertDialogs } from '@/components/ConvertDialogs';
import { AiDialogs } from '@/components/AiDialogs';
import { UpdateDialog } from '@/components/UpdateDialog';
import { NewDocumentDialog } from '@/components/NewDocumentDialog';
import { Sidebar } from '@/components/sidebar/Sidebar';
import { Viewer } from '@/components/viewer/Viewer';
import { SearchPanel } from '@/components/SearchPanel';
import { CommandPalette } from '@/components/CommandPalette';
import { Welcome } from '@/components/Welcome';
import { DropOverlay } from '@/components/DropOverlay';
import { isDirty, useActiveTab, useDocs } from '@/store/docs';
import { useUi } from '@/store/ui';
import { useJob } from '@/store/job';
import { useTheme } from '@/hooks/useTheme';
import { useShortcuts } from '@/hooks/useShortcuts';
import { useFileDrop } from '@/hooks/useFileDrop';
import { openPdfPaths, refreshRecent } from '@/lib/actions';
import { notifyUnexpected } from '@/lib/notify';
import { initAi } from '@/lib/ai';
import { initUpdates } from '@/lib/updates';

export function App() {
  const { t } = useTranslation();
  const tab = useActiveTab();
  const fullscreen = useUi((s) => s.fullscreen);
  const searchOpen = useUi((s) => s.searchOpen);
  const setFullscreen = useUi((s) => s.setFullscreen);
  const setTheme = useUi((s) => s.setTheme);
  const cancelJob = useJob((s) => s.cancel);

  useTheme();
  useShortcuts();
  useFileDrop();

  // Arranque: preferencias, recientes y archivos recibidos al abrir la aplicación.
  useEffect(() => {
    void window.foliux.settings
      .get()
      .then((settings) => setTheme(settings.theme))
      .catch(notifyUnexpected);
    void refreshRecent();
    void window.foliux
      .getPendingFiles()
      .then((paths) => openPdfPaths(paths))
      .catch(notifyUnexpected);

    // Archivos que llegan con la aplicación ya abierta (doble clic en un .pdf, otra instancia)
    const offOpen = window.foliux.onOpenFiles((paths) => void openPdfPaths(paths));
    const offFullscreen = window.foliux.onFullscreenChange((value) => {
      setFullscreen(value);
      if (value) toast(t('fullscreen.hint'), { id: 'fullscreen-hint', duration: 2500 });
    });
    return () => {
      offOpen();
      offFullscreen();
    };
  }, [setFullscreen, setTheme, t]);

  // Asistente de IA: estado de la clave y recepción del texto que va llegando.
  useEffect(() => initAi(), []);

  // Actualizaciones: avisa al encontrar una versión nueva (la búsqueda del inicio es silenciosa).
  useEffect(() => {
    const ready = initUpdates();
    return () => void ready.then((off) => off());
  }, []);

  // Los errores no controlados se anotan en el registro y se avisa al usuario.
  useEffect(() => {
    const onError = (event: ErrorEvent) => {
      window.foliux.log('error', `${event.message} (${event.filename}:${event.lineno})`);
      notifyUnexpected(event.error ?? event.message);
    };
    const onRejection = (event: PromiseRejectionEvent) => {
      window.foliux.log('error', `Promesa rechazada: ${String(event.reason)}`);
      notifyUnexpected(event.reason);
    };
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);
    return () => {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onRejection);
    };
  }, []);

  // Con cambios sin guardar, cerrar la ventana pide confirmación (la pregunta la hace el proceso principal).
  useEffect(() => {
    const update = () => {
      const dirty = useDocs.getState().tabs.some(isDirty);
      window.onbeforeunload = dirty
        ? (event) => {
            event.returnValue = false;
          }
        : null;
    };
    update();
    const unsubscribe = useDocs.subscribe(update);
    return () => {
      unsubscribe();
      window.onbeforeunload = null;
    };
  }, []);

  useEffect(() => {
    document.title = tab ? `${tab.name} — ${t('app.name')}` : t('app.name');
  }, [tab, t]);

  return (
    <TooltipProvider delayDuration={400}>
      <div className="flex h-screen flex-col bg-background text-foreground">
        {!fullscreen && <TitleBar />}
        {!fullscreen && tab && <Toolbar tab={tab} />}
        {!fullscreen && tab && <AnnotationBar tab={tab} />}

        <div className="flex min-h-0 flex-1">
          {!fullscreen && tab && <Sidebar tab={tab} />}
          <main className="relative min-w-0 flex-1 bg-viewer">
            {tab ? (
              <>
                <Viewer key={tab.id} tab={tab} />
                {searchOpen && !fullscreen && <SearchPanel key={tab.id} tab={tab} />}
                {tab.busy && (
                  <div
                    role="status"
                    aria-live="polite"
                    className="absolute inset-0 z-30 flex items-center justify-center bg-background/60 backdrop-blur-[1px]"
                  >
                    <div className="flex items-center gap-3 rounded-lg border border-border bg-popover px-4 py-3 text-sm shadow-lg">
                      <span
                        aria-hidden
                        className="size-4 animate-spin rounded-full border-2 border-primary border-t-transparent"
                      />
                      {tab.busy}
                      {cancelJob && (
                        <button
                          type="button"
                          onClick={cancelJob}
                          className="ml-2 rounded-md border border-border px-2 py-1 text-xs hover:bg-accent"
                        >
                          {t('dialogs.cancel')}
                        </button>
                      )}
                    </div>
                  </div>
                )}
                {fullscreen && (
                  <div
                    aria-live="polite"
                    className="pointer-events-none absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full bg-black/60 px-3 py-1 text-xs text-white tabular-nums"
                  >
                    {tab.page} / {tab.numPages}
                  </div>
                )}
              </>
            ) : (
              <div className="h-full bg-background">
                <Welcome />
              </div>
            )}
          </main>
        </div>
      </div>

      <ConfirmCloseDialog />
      <ToolDialogs />
      <ConvertDialogs />
      <AiDialogs />
      <UpdateDialog />
      <NewDocumentDialog />
      <CommandPalette />
      <DropOverlay />
      <Toaster position="bottom-right" richColors closeButton />
    </TooltipProvider>
  );
}
