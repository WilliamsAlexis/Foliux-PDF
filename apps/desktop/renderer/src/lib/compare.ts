import { toast } from 'sonner';
import {
  DiffTooLargeError,
  compareTokens,
  type DiffToken,
  type IPdfDocument,
} from '@foliux-pdf/core';
import i18n from '@/i18n';
import { useDocs } from '@/store/docs';
import { useCompare } from '@/store/compare';
import { useJob } from '@/store/job';
import { useUi } from '@/store/ui';
import { notifyError } from './notify';
import { openPdfPath } from './actions';
import { isAbortError } from './utils';

/**
 * Comparación de dos versiones de un documento por texto. La versión A es la pestaña activa y la B
 * la que se elige. No detecta cambios que sean solo de imágenes, gráficos o formato.
 */

const abortError = () => new DOMException('Comparación cancelada', 'AbortError');

/** Todas las palabras del documento con su página; informa del avance (0 a 1) y se puede cancelar. */
async function collectTokens(
  doc: IPdfDocument,
  signal: AbortSignal,
  onProgress: (fraction: number) => void,
): Promise<DiffToken[]> {
  const tokens: DiffToken[] = [];
  for (let page = 1; page <= doc.numPages; page++) {
    if (signal.aborted) throw abortError();
    for (const word of await doc.getWords(page)) tokens.push({ ...word, page });
    onProgress(page / doc.numPages);
    // Se cede el hilo de vez en cuando para que la interfaz siga respondiendo.
    if (page % 5 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return tokens;
}

export function cancelCompare(): void {
  useJob.getState().cancel?.();
}

export function closeCompare(): void {
  cancelCompare();
  useCompare.getState().reset();
}

async function runCompare(tabAId: string, tabBId: string): Promise<void> {
  const compare = useCompare.getState();
  const tabA = useDocs.getState().tabs.find((t) => t.id === tabAId);
  const tabB = useDocs.getState().tabs.find((t) => t.id === tabBId);
  if (!tabA || !tabB) return;

  const controller = new AbortController();
  useJob.getState().setCancel(() => controller.abort());
  compare.set({
    status: 'running',
    progress: 0,
    error: null,
    tabA: tabAId,
    tabB: tabBId,
    changes: [],
    current: -1,
  });
  useUi.getState().setSidebarTab('compare');

  try {
    const tokensA = await collectTokens(tabA.doc, controller.signal, (f) =>
      useCompare.getState().set({ progress: f * 0.45 }),
    );
    const tokensB = await collectTokens(tabB.doc, controller.signal, (f) =>
      useCompare.getState().set({ progress: 0.45 + f * 0.45 }),
    );
    useCompare.getState().set({ progress: 0.9 });
    await new Promise((resolve) => setTimeout(resolve, 0)); // deja pintar el avance antes del cálculo
    if (controller.signal.aborted) throw abortError();

    const changes = compareTokens(tokensA, tokensB);
    useCompare.getState().set({ status: 'done', progress: 1, changes });
    useDocs.getState().setActive(tabAId);
    toast.success(
      changes.length === 0
        ? i18n.t('compare.identical')
        : i18n.t('compare.found', { count: changes.length }),
    );
  } catch (error) {
    if (isAbortError(error)) {
      useCompare.getState().reset();
      toast.info(i18n.t('compare.cancelled'));
    } else if (error instanceof DiffTooLargeError) {
      useCompare.getState().set({ status: 'error', error: error.message });
    } else {
      useCompare.getState().set({ status: 'error', error: String(error) });
      notifyError(i18n.t('errors.compareFailed'), error);
    }
  } finally {
    useJob.getState().setCancel(null);
  }
}

/** Elige el segundo documento (se abre en una pestaña) y compara con el activo. */
export async function startCompare(): Promise<void> {
  const a = useDocs.getState().tabs.find((t) => t.id === useDocs.getState().activeId);
  if (!a) return;
  try {
    const [path] = await window.foliux.openPdfDialog();
    if (!path) return;
    if (path.toLowerCase() === a.path.toLowerCase()) {
      toast.warning(i18n.t('compare.sameFile'));
      return;
    }
    await openPdfPath(path);
    const b = useDocs.getState().tabs.find((t) => t.path.toLowerCase() === path.toLowerCase());
    if (!b) {
      // Si pidió contraseña, el documento aún no está abierto: se vuelve a intentar al abrirlo.
      toast.info(i18n.t('compare.openFirst'));
      return;
    }
    await runCompare(a.id, b.id);
  } catch (error) {
    notifyError(i18n.t('errors.compareFailed'), error);
  }
}

/** Se desplaza al cambio indicado, en la pestaña que corresponda. */
export function goToChange(index: number): void {
  const { changes, tabA, tabB, set } = useCompare.getState();
  const change = changes[index];
  if (!change) return;
  const useB = change.kind === 'added';
  const tabId = useB ? tabB : tabA;
  const piece = (useB ? change.b : change.a)[0];
  if (!tabId || !piece) return;
  set({ current: index });
  const docs = useDocs.getState();
  docs.setActive(tabId);
  docs.goToPage(tabId, piece.page, piece.rects[0]?.y);
}

export function stepChange(direction: 1 | -1): void {
  const { changes, current } = useCompare.getState();
  if (changes.length === 0) return;
  goToChange((current + direction + changes.length) % changes.length);
}
