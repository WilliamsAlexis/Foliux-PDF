import { useEffect, useRef, useState } from 'react';
import { FilePlus2, FolderOpen, Pencil, Plus, Send, Square, Trash2, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { INPUT } from '@/components/ToolDialogs';
import { useAi } from '@/store/ai';
import { useWorkspaces } from '@/store/workspaces';
import { cancelAi, clearChat } from '@/lib/ai';
import {
  addFilesToWorkspace,
  addOpenTabsToWorkspace,
  askWorkspace,
  chatKeyOf,
  createWorkspace,
  deleteWorkspace,
  goToCitation,
  openAllWorkspaceDocuments,
  openWorkspaceDocument,
  refreshWorkspaces,
  removeFromWorkspace,
  renameWorkspace,
} from '@/lib/workspaces';
import { Bubble, RichText } from './ChatBits';

/** Espacios de trabajo: documentos agrupados por proyecto y conversación con todos a la vez. */
export function WorkspacePanel() {
  const { t } = useTranslation();
  const workspaces = useWorkspaces((s) => s.workspaces);
  const activeId = useWorkspaces((s) => s.activeId);
  const loaded = useWorkspaces((s) => s.loaded);
  const setActiveId = useWorkspaces((s) => s.setActiveId);
  const stream = useAi((s) => s.stream);
  const task = useAi((s) => s.task);
  const status = useAi((s) => s.status);
  const setKeyDialog = useAi((s) => s.setKeyDialog);

  const active = workspaces.find((w) => w.id === activeId);
  const key = active ? chatKeyOf(active.id) : '';
  const chat = useAi((s) => s.chats[key]);
  const messages = chat ?? [];
  const streaming = stream && stream.tabId === key ? stream.text : null;
  const working = stream !== null || task !== null;

  const [mode, setMode] = useState<'idle' | 'create' | 'rename'>('idle');
  const [name, setName] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [draft, setDraft] = useState('');
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void refreshWorkspaces();
  }, []);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [messages.length, streaming]);
  // Cambiar de espacio cancela cualquier edición del nombre y la confirmación de borrado.
  useEffect(() => {
    setMode('idle');
    setConfirmDelete(false);
  }, [activeId]);

  const submitName = async () => {
    const ok =
      mode === 'create'
        ? await createWorkspace(name)
        : active
          ? await renameWorkspace(active.id, name)
          : false;
    if (ok) {
      setMode('idle');
      setName('');
    }
  };

  const send = (question: string) => {
    if (working || question.trim() === '') return;
    setDraft('');
    void askWorkspace(question);
  };

  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 space-y-2 border-b border-border p-3">
        <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          {t('workspaces.title')}
        </h3>

        {mode !== 'idle' ? (
          <form
            className="flex gap-1.5"
            onSubmit={(event) => {
              event.preventDefault();
              void submitName();
            }}
          >
            <input
              autoFocus
              value={name}
              maxLength={80}
              placeholder={t('workspaces.namePlaceholder')}
              aria-label={t('workspaces.namePlaceholder')}
              onChange={(event) => setName(event.target.value)}
              className={INPUT}
            />
            <Button type="submit" size="sm">
              {t('workspaces.save')}
            </Button>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              onClick={() => setMode('idle')}
              aria-label={t('dialogs.cancel')}
            >
              <X />
            </Button>
          </form>
        ) : (
          <div className="flex gap-1.5">
            <select
              className={INPUT}
              value={activeId ?? ''}
              aria-label={t('workspaces.title')}
              disabled={workspaces.length === 0}
              onChange={(event) => setActiveId(event.target.value)}
            >
              {workspaces.length === 0 && <option value="">{t('workspaces.none')}</option>}
              {workspaces.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
            <Button
              size="icon"
              variant="outline"
              aria-label={t('workspaces.new')}
              title={t('workspaces.new')}
              onClick={() => {
                setName('');
                setMode('create');
              }}
            >
              <Plus />
            </Button>
            {active && (
              <Button
                size="icon"
                variant="outline"
                aria-label={t('workspaces.rename')}
                title={t('workspaces.rename')}
                onClick={() => {
                  setName(active.name);
                  setMode('rename');
                }}
              >
                <Pencil />
              </Button>
            )}
          </div>
        )}

        {!active && loaded && mode === 'idle' && (
          <p className="text-xs text-muted-foreground">{t('workspaces.intro')}</p>
        )}
      </div>

      {active && (
        <>
          <div className="shrink-0 border-b border-border">
            <ul className="max-h-40 overflow-y-auto">
              {active.documents.length === 0 && (
                <li className="px-3 py-2 text-xs text-muted-foreground">
                  {t('workspaces.noDocuments')}
                </li>
              )}
              {active.documents.map((doc) => (
                <li key={doc.path} className="group flex items-center gap-1 px-2 py-0.5">
                  <button
                    type="button"
                    title={doc.path}
                    disabled={!doc.exists}
                    onClick={() => void openWorkspaceDocument(doc.path)}
                    className="min-w-0 flex-1 truncate rounded px-1 py-1 text-left text-sm hover:bg-accent disabled:opacity-60 disabled:hover:bg-transparent"
                  >
                    {doc.name}
                    {!doc.exists && (
                      <span className="ml-1 text-xs text-destructive">
                        {t('workspaces.missingTag')}
                      </span>
                    )}
                  </button>
                  <button
                    type="button"
                    aria-label={t('workspaces.removeDoc', { name: doc.name })}
                    title={t('workspaces.removeDoc', { name: doc.name })}
                    onClick={() => void removeFromWorkspace(active.id, doc.path)}
                    className="rounded p-1 text-muted-foreground opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 hover:bg-accent"
                  >
                    <X className="size-3.5" />
                  </button>
                </li>
              ))}
            </ul>
            <div className="flex flex-wrap gap-1 px-2 py-1.5">
              <Button size="sm" variant="ghost" onClick={() => void addFilesToWorkspace(active.id)}>
                <FilePlus2 /> {t('workspaces.addFiles')}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void addOpenTabsToWorkspace(active.id)}
              >
                <Plus /> {t('workspaces.addOpen')}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={active.documents.length === 0}
                onClick={() => void openAllWorkspaceDocuments(active)}
              >
                <FolderOpen /> {t('workspaces.openAll')}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className={confirmDelete ? 'text-destructive' : undefined}
                onClick={() => {
                  if (!confirmDelete) setConfirmDelete(true);
                  else void deleteWorkspace(active.id);
                }}
                onBlur={() => setConfirmDelete(false)}
              >
                <Trash2 /> {confirmDelete ? t('workspaces.confirmDelete') : t('workspaces.delete')}
              </Button>
            </div>
          </div>

          {!status?.configured ? (
            <div className="space-y-2 p-3 text-sm">
              <p className="text-muted-foreground">{t('workspaces.needKey')}</p>
              <Button onClick={() => setKeyDialog(true)}>{t('ai.setKey')}</Button>
            </div>
          ) : (
            <>
              <div className="min-h-0 flex-1 overflow-y-auto">
                <div className="flex flex-col gap-2 p-3">
                  {messages.length === 0 && streaming === null && (
                    <p className="text-sm text-muted-foreground">{t('workspaces.chatEmpty')}</p>
                  )}
                  {messages.map((message, index) => (
                    <Bubble key={index} role={message.role}>
                      {message.role === 'assistant' ? (
                        <RichText
                          text={message.content}
                          onCite={(page, doc) => void goToCitation(doc, page)}
                        />
                      ) : (
                        message.content
                      )}
                    </Bubble>
                  ))}
                  {streaming !== null && (
                    <Bubble role="assistant">
                      {streaming === '' ? (
                        <span className="text-muted-foreground">{t('ai.thinking')}</span>
                      ) : (
                        <RichText
                          text={streaming}
                          onCite={(page, doc) => void goToCitation(doc, page)}
                        />
                      )}
                    </Bubble>
                  )}
                  <div ref={endRef} />
                </div>
                <div className="flex flex-wrap gap-1.5 px-3 pb-2">
                  {(
                    [
                      'workspaces.quickSummary',
                      'workspaces.quickCompare',
                      'workspaces.quickRepeated',
                    ] as const
                  ).map((label) => (
                    <button
                      key={label}
                      type="button"
                      disabled={working || active.documents.length === 0}
                      onClick={() => send(t(`${label}Prompt`))}
                      className="rounded-full border border-border px-2.5 py-1 text-xs hover:bg-accent disabled:opacity-50"
                    >
                      {t(label)}
                    </button>
                  ))}
                  {messages.length > 0 && (
                    <button
                      type="button"
                      disabled={working}
                      onClick={() => clearChat(key)}
                      className="rounded-full px-2.5 py-1 text-xs text-muted-foreground underline"
                    >
                      {t('ai.clearChat')}
                    </button>
                  )}
                </div>
              </div>

              {task && task.tabId === key && (
                <div
                  role="status"
                  className="flex shrink-0 items-center gap-2 border-t border-border px-3 py-2 text-xs"
                >
                  <span
                    aria-hidden
                    className="size-3.5 shrink-0 animate-spin rounded-full border-2 border-primary border-t-transparent"
                  />
                  <span className="min-w-0 flex-1">{task.label}</span>
                </div>
              )}

              <form
                className="flex shrink-0 items-end gap-1.5 border-t border-border p-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  send(draft);
                }}
              >
                <textarea
                  value={draft}
                  rows={2}
                  maxLength={50000}
                  placeholder={t('workspaces.placeholder')}
                  aria-label={t('workspaces.placeholder')}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault();
                      send(draft);
                    }
                  }}
                  className="min-h-[2.5rem] flex-1 resize-none rounded-md border border-input bg-background px-2 py-1.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
                {stream && stream.tabId === key ? (
                  <Button
                    type="button"
                    size="icon"
                    variant="outline"
                    onClick={cancelAi}
                    aria-label={t('ai.stop')}
                  >
                    <Square />
                  </Button>
                ) : (
                  <Button
                    type="submit"
                    size="icon"
                    disabled={working || draft.trim() === '' || active.documents.length === 0}
                    aria-label={t('ai.send')}
                  >
                    <Send />
                  </Button>
                )}
              </form>
            </>
          )}
        </>
      )}
    </div>
  );
}
