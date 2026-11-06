import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AI_MODELS, type AiModelId } from '@foliux-pdf/core';
import { useAi, type FieldCandidate, type SensitiveCandidate } from '@/store/ai';
import { DialogShell, Field, INPUT } from '@/components/ToolDialogs';
import {
  changeModel,
  closeReview,
  createDetectedFields,
  makePresentation,
  markSensitiveForRedaction,
  removeApiKey,
  saveApiKey,
} from '@/lib/ai';
import { toast } from 'sonner';
import i18n from '@/i18n';
import { notifyError } from '@/lib/notify';

/** Clave de la API y modelo. La clave se cifra en el equipo y solo la lee el proceso principal. */
function KeyDialog() {
  const { t } = useTranslation();
  const open = useAi((s) => s.keyDialog);
  const status = useAi((s) => s.status);
  const setOpen = useAi((s) => s.setKeyDialog);
  const [key, setKey] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  useEffect(() => {
    if (open) {
      setKey('');
      setError(null);
    }
  }, [open]);

  const submit = async () => {
    if (key.trim() === '') {
      // Sin clave nueva, el botón solo cierra (el modelo se cambia al elegirlo).
      setOpen(false);
      return;
    }
    setWorking(true);
    try {
      await saveApiKey(key);
      setOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setWorking(false);
    }
  };

  return (
    <DialogShell
      open={open}
      title={t('ai.keyTitle')}
      description={t('ai.keyDescription')}
      onClose={() => setOpen(false)}
      onSubmit={() => void submit()}
      submitLabel={key.trim() === '' ? t('dialogs.close') : t('ai.saveKey')}
      error={error}
      busy={working}
    >
      <Field label={t('ai.keyLabel')} hint={status?.configured ? t('ai.keyConfigured') : undefined}>
        <input
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={key}
          placeholder="sk-ant-…"
          onChange={(event) => setKey(event.target.value)}
          className={INPUT}
        />
      </Field>
      {status && !status.secureStorage && (
        <p className="text-xs text-destructive">{t('ai.noSecureStorage')}</p>
      )}
      <Field label={t('ai.model')} hint={AI_MODELS.find((m) => m.id === status?.model)?.hint}>
        <select
          className={INPUT}
          value={status?.model ?? ''}
          onChange={(event) => void changeModel(event.target.value as AiModelId)}
        >
          {AI_MODELS.map((model) => (
            <option key={model.id} value={model.id}>
              {model.label}
            </option>
          ))}
        </select>
      </Field>
      <p className="text-xs text-muted-foreground">{t('ai.keyHelp')}</p>
      {status?.configured && (
        <button
          type="button"
          className="self-start text-xs text-destructive underline"
          onClick={() => {
            void removeApiKey().catch((e) => notifyError(t('ai.failed'), e));
          }}
        >
          {t('ai.removeKey')}
        </button>
      )}
    </DialogShell>
  );
}

/** Aviso antes de enviar un documento a la API: es un servicio externo y cuesta dinero. */
function ConsentDialog() {
  const { t } = useTranslation();
  const prompt = useAi((s) => s.consentPrompt);
  const setPrompt = useAi((s) => s.setConsentPrompt);
  const model = useAi((s) => s.status?.model);

  const answer = (accepted: boolean) => {
    prompt?.resolve(accepted);
    setPrompt(null);
  };

  return (
    <DialogShell
      open={prompt !== null}
      title={t('ai.consentTitle')}
      description={
        prompt?.documentCount
          ? t('ai.consentWorkspaceDescription', {
              name: prompt.documentName,
              count: prompt.documentCount,
            })
          : t('ai.consentDescription', { name: prompt?.documentName ?? '' })
      }
      onClose={() => answer(false)}
      onSubmit={() => answer(true)}
      submitLabel={t('ai.consentAccept')}
      error={null}
      busy={false}
    >
      <ul className="list-disc pl-5 text-sm">
        <li>{t('ai.consentTokens', { tokens: (prompt?.tokens ?? 0).toLocaleString('es') })}</li>
        <li>{t('ai.consentModel', { model })}</li>
        <li>{prompt?.documentCount ? t('ai.consentStoredWorkspace') : t('ai.consentStored')}</li>
      </ul>
      {prompt?.truncated && (
        <p role="alert" className="text-sm text-destructive">
          {t('ai.consentTruncated', {
            included: prompt.includedPages,
            total: prompt.totalPages,
          })}
        </p>
      )}
    </DialogShell>
  );
}

function SlidesDialog() {
  const { t } = useTranslation();
  const open = useAi((s) => s.slidesDialog);
  const setOpen = useAi((s) => s.setSlidesDialog);
  const [count, setCount] = useState(10);

  return (
    <DialogShell
      open={open}
      title={t('ai.slidesTitle')}
      description={t('ai.slidesDescription')}
      onClose={() => setOpen(false)}
      onSubmit={() => {
        setOpen(false);
        void makePresentation(count);
      }}
      submitLabel={t('ai.slidesCreate')}
      error={null}
      busy={false}
    >
      <Field label={t('ai.slidesCount')}>
        <input
          type="number"
          min={3}
          max={40}
          value={count}
          onChange={(event) =>
            setCount(Math.min(40, Math.max(3, Number(event.target.value) || 10)))
          }
          className={INPUT}
        />
      </Field>
    </DialogShell>
  );
}

/** Lista de lo que propone la IA, para marcar qué se acepta antes de tocar el documento. */
function ReviewDialog() {
  const { t } = useTranslation();
  const review = useAi((s) => s.review);
  const [fields, setFields] = useState<FieldCandidate[]>([]);
  const [sensitive, setSensitive] = useState<SensitiveCandidate[]>([]);
  const [working, setWorking] = useState(false);

  useEffect(() => {
    if (review?.kind === 'fields') setFields(review.items);
    if (review?.kind === 'sensitive') setSensitive(review.items);
  }, [review]);

  if (!review) return null;

  const isFields = review.kind === 'fields';
  const chosen = isFields ? fields.filter((f) => f.checked) : sensitive.filter((s) => s.checked);

  const submit = async () => {
    if (chosen.length === 0) {
      closeReview();
      return;
    }
    setWorking(true);
    try {
      if (isFields) {
        const ok = await createDetectedFields(fields.filter((f) => f.checked));
        if (ok) closeReview();
      } else {
        const marks = await markSensitiveForRedaction(sensitive.filter((s) => s.checked));
        toast.success(i18n.t('ai.sensitiveMarked', { count: marks }));
        closeReview();
      }
    } finally {
      setWorking(false);
    }
  };

  const setAll = (value: boolean) => {
    if (isFields) setFields((list) => list.map((f) => ({ ...f, checked: f.located && value })));
    else setSensitive((list) => list.map((s) => ({ ...s, checked: s.occurrences > 0 && value })));
  };

  return (
    <DialogShell
      open
      title={isFields ? t('ai.reviewFieldsTitle') : t('ai.reviewSensitiveTitle')}
      description={isFields ? t('ai.reviewFieldsDescription') : t('ai.reviewSensitiveDescription')}
      onClose={closeReview}
      onSubmit={() => void submit()}
      submitLabel={
        isFields
          ? t('ai.reviewFieldsAccept', { count: chosen.length })
          : t('ai.reviewSensitiveAccept', { count: chosen.length })
      }
      error={null}
      busy={working}
    >
      <div className="flex gap-3 text-xs">
        <button type="button" className="underline" onClick={() => setAll(true)}>
          {t('ai.selectAll')}
        </button>
        <button type="button" className="underline" onClick={() => setAll(false)}>
          {t('ai.selectNone')}
        </button>
      </div>
      <ul className="max-h-[46vh] divide-y divide-border overflow-y-auto rounded-md border border-border">
        {isFields
          ? fields.map((item) => (
              <li key={item.id} className="flex items-start gap-2 px-2.5 py-1.5 text-sm">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={item.checked}
                  disabled={!item.located}
                  aria-label={item.label}
                  onChange={(event) =>
                    setFields((list) =>
                      list.map((f) =>
                        f.id === item.id ? { ...f, checked: event.target.checked } : f,
                      ),
                    )
                  }
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{item.label}</span>
                  <span className="block text-xs text-muted-foreground">
                    {t(`ai.fieldType.${item.type}`)} · {t('ai.pageN', { page: item.page })}
                    {item.options.length > 0 ? ` · ${item.options.join(', ')}` : ''}
                    {!item.located ? ` · ${t('ai.notLocated')}` : ''}
                  </span>
                </span>
              </li>
            ))
          : sensitive.map((item) => (
              <li key={item.id} className="flex items-start gap-2 px-2.5 py-1.5 text-sm">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={item.checked}
                  disabled={item.occurrences === 0}
                  aria-label={item.text}
                  onChange={(event) =>
                    setSensitive((list) =>
                      list.map((s) =>
                        s.id === item.id ? { ...s, checked: event.target.checked } : s,
                      ),
                    )
                  }
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{item.text}</span>
                  <span className="block text-xs text-muted-foreground">
                    {t(`ai.category.${item.category}`)}
                    {item.reason ? ` · ${item.reason}` : ''} ·{' '}
                    {item.occurrences > 0
                      ? t('ai.occurrences', { count: item.occurrences })
                      : t('ai.notLocated')}
                  </span>
                </span>
              </li>
            ))}
      </ul>
      <p className="text-xs text-muted-foreground">
        {isFields ? t('ai.reviewFieldsNote') : t('ai.reviewSensitiveNote')}
      </p>
    </DialogShell>
  );
}

export function AiDialogs() {
  return (
    <>
      <KeyDialog />
      <ConsentDialog />
      <SlidesDialog />
      <ReviewDialog />
    </>
  );
}
