import { toast } from 'sonner';
import {
  FoliuxError,
  MAX_DOCUMENT_CHARS,
  buildWorkspaceText,
  estimateTokens,
  type PageWord,
  type WorkspaceView,
} from '@foliux-pdf/core';
import i18n from '@/i18n';
import { getActiveTab, useDocs } from '@/store/docs';
import { useAi } from '@/store/ai';
import { getActiveWorkspace, useWorkspaces } from '@/store/workspaces';
import { notifyError } from './notify';
import { openPdfPath } from './actions';
import { pdfEngine } from './engine';
import { ensureApiKey, requestConsent, runChat } from './ai';
import { tick } from './raster';

/** Espacios de trabajo: grupos de documentos por proyecto y consultas a la IA sobre todos a la vez. */

export const chatKeyOf = (workspaceId: string) => `ws:${workspaceId}`;

async function guarded<T>(work: () => Promise<T>): Promise<T | null> {
  try {
    return await work();
  } catch (error) {
    notifyError(i18n.t('workspaces.failed'), error);
    return null;
  }
}

export async function refreshWorkspaces(): Promise<void> {
  const list = await guarded(() => window.foliux.workspaces.list());
  if (list) useWorkspaces.getState().setWorkspaces(list);
}

export async function createWorkspace(name: string): Promise<boolean> {
  const created = await guarded(() => window.foliux.workspaces.create(name));
  if (!created) return false;
  useWorkspaces.getState().upsert(created);
  useWorkspaces.getState().setActiveId(created.id);
  return true;
}

export async function renameWorkspace(id: string, name: string): Promise<boolean> {
  const updated = await guarded(() => window.foliux.workspaces.rename(id, name));
  if (updated) useWorkspaces.getState().upsert(updated);
  return updated !== null;
}

export async function deleteWorkspace(id: string): Promise<void> {
  const done = await guarded(async () => {
    await window.foliux.workspaces.delete(id);
    return true;
  });
  if (!done) return;
  useAi.getState().setChat(chatKeyOf(id), []);
  await refreshWorkspaces();
}

export async function addPathsToWorkspace(id: string, paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  const before =
    useWorkspaces.getState().workspaces.find((w) => w.id === id)?.documents.length ?? 0;
  const updated = await guarded(() => window.foliux.workspaces.addDocuments(id, paths));
  if (!updated) return;
  useWorkspaces.getState().upsert(updated);
  const added = updated.documents.length - before;
  if (added === 0) toast.info(i18n.t('workspaces.alreadyThere'));
  else toast.success(i18n.t('workspaces.added', { count: added }));
}

/** «Añadir PDF…»: elige archivos y los suma al espacio. */
export async function addFilesToWorkspace(id: string): Promise<void> {
  const paths = await guarded(() => window.foliux.openPdfDialog());
  if (paths) await addPathsToWorkspace(id, paths);
}

/** Suma al espacio los documentos que están abiertos (los que ya existen como archivo). */
export async function addOpenTabsToWorkspace(id: string): Promise<void> {
  const paths = useDocs
    .getState()
    .tabs.map((tab) => tab.path)
    .filter((path) => path !== '');
  if (paths.length === 0) {
    toast.info(i18n.t('workspaces.noOpenFiles'));
    return;
  }
  await addPathsToWorkspace(id, paths);
}

export async function removeFromWorkspace(id: string, path: string): Promise<void> {
  const updated = await guarded(() => window.foliux.workspaces.removeDocument(id, path));
  if (updated) useWorkspaces.getState().upsert(updated);
}

/** Abre un documento del espacio (y, si se pide, va a una página). */
export async function openWorkspaceDocument(path: string, page?: number): Promise<void> {
  await openPdfPath(path);
  const tab = useDocs.getState().tabs.find((t) => t.path.toLowerCase() === path.toLowerCase());
  if (tab && page !== undefined) {
    useDocs.getState().goToPage(tab.id, Math.min(Math.max(1, page), tab.numPages));
  }
}

export async function openAllWorkspaceDocuments(workspace: WorkspaceView): Promise<void> {
  for (const doc of workspace.documents) if (doc.exists) await openPdfPath(doc.path);
}

/** Salto desde una cita «[nombre.pdf, p. 3]» de una respuesta del espacio. */
export async function goToCitation(docName: string | null, page: number): Promise<void> {
  const workspace = getActiveWorkspace();
  if (!workspace || !docName) {
    const tab = getActiveTab();
    if (tab) useDocs.getState().goToPage(tab.id, page);
    return;
  }
  const wanted = docName.trim().toLowerCase();
  const doc =
    workspace.documents.find((d) => d.name.toLowerCase() === wanted) ??
    workspace.documents.find((d) => d.name.toLowerCase().replace(/\.pdf$/, '') === wanted);
  if (!doc) {
    toast.info(i18n.t('workspaces.citationNotFound', { name: docName }));
    return;
  }
  if (!doc.exists) {
    toast.error(i18n.t('workspaces.missing', { name: doc.name }));
    return;
  }
  await openWorkspaceDocument(doc.path, page);
}

// ---------------------------------------------------------------------------
// Preguntar a la IA por todo el espacio
// ---------------------------------------------------------------------------

interface CachedWords {
  size: number;
  pages: PageWord[][];
}
// Extraer el texto es lo costoso: se reutiliza mientras el archivo conserve su tamaño.
const wordsCache = new Map<string, CachedWords>();

async function wordsOf(path: string): Promise<PageWord[][]> {
  const file = await window.foliux.readPdf(path);
  const cached = wordsCache.get(path.toLowerCase());
  if (cached && cached.size === file.data.byteLength) return cached.pages;
  const doc = await pdfEngine.load(file.data);
  try {
    const pages: PageWord[][] = [];
    for (let page = 1; page <= doc.numPages; page++) {
      pages.push(await doc.getWords(page));
      if (page % 5 === 0) await tick();
    }
    wordsCache.set(path.toLowerCase(), { size: file.data.byteLength, pages });
    // La caché guarda todo el texto en memoria: se limita a los últimos documentos leídos.
    if (wordsCache.size > 30) wordsCache.delete(wordsCache.keys().next().value as string);
    return pages;
  } finally {
    void doc.destroy().catch(() => undefined);
  }
}

export async function askWorkspace(question: string): Promise<void> {
  const text = question.trim();
  const workspace = getActiveWorkspace();
  const ai = useAi.getState();
  if (text === '' || !workspace || ai.stream || ai.task) return;

  const available = workspace.documents.filter((d) => d.exists);
  if (available.length === 0) {
    toast.error(i18n.t('workspaces.empty'));
    return;
  }
  if (!(await ensureApiKey())) return;

  // 1) Leer el texto de cada documento (los protegidos o ilegibles se saltan y se avisa).
  const documents: { name: string; pages: { words: PageWord[] }[] }[] = [];
  const skipped: string[] = [];
  for (const [index, doc] of available.entries()) {
    ai.setTask({
      tabId: chatKeyOf(workspace.id),
      requestId: '',
      label: i18n.t('workspaces.reading', { done: index + 1, total: available.length }),
    });
    try {
      const pages = await wordsOf(doc.path);
      documents.push({ name: doc.name, pages: pages.map((words) => ({ words })) });
    } catch (error) {
      skipped.push(
        error instanceof FoliuxError && error.code === 'PASSWORD_REQUIRED'
          ? i18n.t('workspaces.protected', { name: doc.name })
          : doc.name,
      );
    }
  }
  useAi.getState().setTask(null);
  if (skipped.length > 0) {
    toast.warning(i18n.t('workspaces.skipped', { count: skipped.length }), {
      description: skipped.join(', '),
    });
  }

  const built = buildWorkspaceText(documents, MAX_DOCUMENT_CHARS);
  if (built.text.replace(/=== Documento[^\n]*\n|\[Página \d+\]/g, '').trim() === '') {
    toast.error(i18n.t('ai.noText'));
    return;
  }

  // 2) Permiso para enviar: se pide de nuevo si cambia el conjunto de documentos.
  const consentKey = `${chatKeyOf(workspace.id)}|${documents.map((d) => d.name).join('|')}`;
  if (!useAi.getState().consented.includes(consentKey)) {
    const accepted = await requestConsent({
      tabId: consentKey,
      documentName: workspace.name,
      tokens: estimateTokens(built.text),
      includedPages: built.includedPages,
      totalPages: built.totalPages,
      truncated: built.truncated,
      documentCount: documents.length,
    });
    if (!accepted) return;
    useAi.getState().addConsent(consentKey);
  }

  // 3) Preguntar.
  const cut = built.documents.filter((d) => d.truncated).map((d) => d.name);
  await runChat(
    chatKeyOf(workspace.id),
    { documentName: workspace.name, documentText: built.text, totalPages: built.totalPages },
    text,
    {
      workspace: true,
      truncatedAlready: built.truncated,
      onTruncated: () =>
        toast.info(i18n.t('workspaces.truncated', { count: cut.length }), {
          id: 'ws-truncated',
          description: cut.join(', '),
        }),
    },
  );
}
