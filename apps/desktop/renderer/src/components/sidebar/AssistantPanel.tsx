import { useEffect, useRef, useState } from 'react';
import {
  Eraser,
  FileSpreadsheet,
  KeyRound,
  Pause,
  Play,
  Presentation,
  ScanSearch,
  Send,
  ShieldAlert,
  Square,
  TextCursorInput,
  Volume2,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import type { DocTab } from '@/store/docs';
import { useAi } from '@/store/ai';
import { useDocs } from '@/store/docs';
import {
  askQuestion,
  audioSummary,
  cancelAi,
  clearChat,
  detectFormFields,
  extractTablesToExcel,
  findSensitiveData,
  pauseSpeech,
  questionAboutSelection,
  resumeSpeech,
  stopSpeech,
} from '@/lib/ai';
import { Bubble, RichText } from './ChatBits';

function ActionButton({
  icon,
  label,
  onClick,
  disabled,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  disabled: boolean;
}) {
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={onClick}
      disabled={disabled}
      className="h-auto justify-start gap-2 px-2 py-1.5 text-left whitespace-normal"
    >
      <span className="shrink-0">{icon}</span>
      <span className="text-xs font-medium">{label}</span>
    </Button>
  );
}

/** Asistente: conversación con el documento y acciones de IA (tablas, campos, redacción, presentación, audio). */
export function AssistantPanel({ tab }: { tab: DocTab }) {
  const { t } = useTranslation();
  const status = useAi((s) => s.status);
  const chat = useAi((s) => s.chats[tab.id]);
  const stream = useAi((s) => s.stream);
  const task = useAi((s) => s.task);
  const audio = useAi((s) => s.audio);
  const setKeyDialog = useAi((s) => s.setKeyDialog);
  const setSlidesDialog = useAi((s) => s.setSlidesDialog);
  const [draft, setDraft] = useState('');
  const endRef = useRef<HTMLDivElement>(null);

  const messages = chat ?? [];
  const working = stream !== null || task !== null;
  const busy = working || tab.busy !== null;
  const streaming = stream && stream.tabId === tab.id ? stream.text : null;

  // Al llegar texto nuevo, la conversación se desplaza al final.
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [messages.length, streaming]);

  if (!status?.configured) {
    return (
      <div className="flex flex-col gap-3 p-4 text-sm">
        <h3 className="font-semibold">{t('ai.title')}</h3>
        <p className="text-muted-foreground">{t('ai.intro')}</p>
        <p className="text-xs text-muted-foreground">{t('ai.privacy')}</p>
        <Button onClick={() => setKeyDialog(true)}>
          <KeyRound /> {t('ai.setKey')}
        </Button>
      </div>
    );
  }

  const send = (question: string) => {
    if (busy || question.trim() === '') return;
    setDraft('');
    void askQuestion(question);
  };

  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex flex-col gap-2 p-3">
          {messages.length === 0 && streaming === null && (
            <p className="text-sm text-muted-foreground">{t('ai.empty')}</p>
          )}
          {messages.map((message, index) => (
            <Bubble key={index} role={message.role}>
              {message.role === 'assistant' ? (
                <RichText
                  text={message.content}
                  onCite={(page) => useDocs.getState().goToPage(tab.id, page)}
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
                  onCite={(page) => useDocs.getState().goToPage(tab.id, page)}
                />
              )}
            </Bubble>
          )}
          <div ref={endRef} />
        </div>

        <div className="flex flex-wrap gap-1.5 px-3 pb-2">
          {(
            [
              ['ai.quickSummary', () => send(t('ai.promptSummary'))],
              ['ai.quickKeyPoints', () => send(t('ai.promptKeyPoints'))],
              [
                'ai.quickExplain',
                () => {
                  const q = questionAboutSelection(t('ai.promptExplain'));
                  if (q) send(q);
                },
              ],
              [
                'ai.quickTranslate',
                () => {
                  const q = questionAboutSelection(t('ai.promptTranslate'));
                  if (q) send(q);
                },
              ],
            ] as const
          ).map(([label, run]) => (
            <button
              key={label}
              type="button"
              disabled={busy}
              // Pulsar no debe quitar la selección del visor: es lo que se va a explicar o traducir.
              onMouseDown={(event) => event.preventDefault()}
              onClick={run}
              className="rounded-full border border-border px-2.5 py-1 text-xs hover:bg-accent disabled:opacity-50"
            >
              {t(label)}
            </button>
          ))}
        </div>
      </div>

      {task && task.tabId === tab.id && (
        <div
          role="status"
          className="flex shrink-0 items-center gap-2 border-t border-border px-3 py-2 text-xs"
        >
          <span
            aria-hidden
            className="size-3.5 shrink-0 animate-spin rounded-full border-2 border-primary border-t-transparent"
          />
          <span className="min-w-0 flex-1">{task.label}</span>
          {task.requestId !== '' && (
            <button type="button" onClick={cancelAi} className="underline">
              {t('dialogs.cancel')}
            </button>
          )}
        </div>
      )}

      {audio && audio.tabId === tab.id && audio.state !== 'stopped' && (
        <div className="shrink-0 border-t border-border px-3 py-2 text-xs">
          <div className="mb-1 flex items-center gap-1.5">
            <Volume2 className="size-3.5" aria-hidden />
            <span className="flex-1 font-medium">{t('ai.audioTitle')}</span>
            {audio.state === 'playing' ? (
              <button type="button" aria-label={t('ai.pause')} onClick={pauseSpeech}>
                <Pause className="size-4" />
              </button>
            ) : (
              <button type="button" aria-label={t('ai.resume')} onClick={resumeSpeech}>
                <Play className="size-4" />
              </button>
            )}
            <button type="button" aria-label={t('ai.stop')} onClick={stopSpeech}>
              <Square className="size-4" />
            </button>
          </div>
          <p className="max-h-24 overflow-y-auto text-muted-foreground">{audio.text}</p>
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
          placeholder={t('ai.placeholder')}
          aria-label={t('ai.placeholder')}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              send(draft);
            }
          }}
          className="min-h-[2.5rem] flex-1 resize-none rounded-md border border-input bg-background px-2 py-1.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        {stream ? (
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
            disabled={busy || draft.trim() === ''}
            aria-label={t('ai.send')}
          >
            <Send />
          </Button>
        )}
      </form>

      <details className="shrink-0 border-t border-border">
        <summary className="cursor-pointer px-3 py-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          {t('ai.actions')}
        </summary>
        <div className="flex flex-col px-1.5 pb-2">
          <ActionButton
            icon={<FileSpreadsheet />}
            label={t('ai.actionTables')}
            disabled={busy}
            onClick={() => void extractTablesToExcel()}
          />
          <ActionButton
            icon={<TextCursorInput />}
            label={t('ai.actionFields')}
            disabled={busy}
            onClick={() => void detectFormFields()}
          />
          <ActionButton
            icon={<ShieldAlert />}
            label={t('ai.actionSensitive')}
            disabled={busy}
            onClick={() => void findSensitiveData()}
          />
          <ActionButton
            icon={<Presentation />}
            label={t('ai.actionSlides')}
            disabled={busy}
            onClick={() => setSlidesDialog(true)}
          />
          <ActionButton
            icon={<Volume2 />}
            label={t('ai.actionAudio')}
            disabled={busy}
            onClick={() => void audioSummary()}
          />
          <ActionButton
            icon={<ScanSearch />}
            label={t('ai.settings')}
            disabled={false}
            onClick={() => setKeyDialog(true)}
          />
          <ActionButton
            icon={<Eraser />}
            label={t('ai.clearChat')}
            disabled={busy || messages.length === 0}
            onClick={() => clearChat(tab.id)}
          />
        </div>
      </details>
    </div>
  );
}
