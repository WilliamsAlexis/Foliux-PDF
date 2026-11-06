import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useTranslation } from 'react-i18next';
import { FULL_PERMISSIONS, validateProtection, type Protection } from '@foliux-pdf/core';
import { Button } from '@/components/ui/button';
import { DialogShell, Field, INPUT } from '@/components/ToolDialogs';
import { useUi } from '@/store/ui';
import { OCR_LANGUAGES, runOcr } from '@/lib/ocr';
import {
  exportPdfA,
  exportToImages,
  exportToOffice,
  exportToPresentation,
  importImages,
  importOffice,
  type PdfAOutcome,
} from '@/lib/convert';
import { cancelBatch, runBatch, setBatchFiles, useBatch, type BatchAction } from '@/lib/batch';
import { notifyError } from '@/lib/notify';
import { cn } from '@/lib/utils';

// ---------------------------------------------------------------------------
// OCR
// ---------------------------------------------------------------------------

function OcrDialog() {
  const { t } = useTranslation();
  const open = useUi((s) => s.toolDialog === 'ocr');
  const setDialog = useUi((s) => s.setToolDialog);
  const [scope, setScope] = useState<'scanned' | 'all'>('scanned');
  const [languages, setLanguages] = useState<string[]>(['spa', 'eng']);
  const [dpi, setDpi] = useState(200);
  const [error, setError] = useState<string | null>(null);

  const close = () => setDialog(null);
  const submit = () => {
    if (languages.length === 0) return setError(t('ocr.needLanguage'));
    close();
    void runOcr({ scope, languages, dpi });
  };

  return (
    <DialogShell
      open={open}
      title={t('ocr.title')}
      description={t('ocr.description')}
      onClose={close}
      onSubmit={submit}
      submitLabel={t('ocr.start')}
      error={error}
      busy={false}
    >
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-medium">{t('ocr.scope')}</legend>
        {(['scanned', 'all'] as const).map((value) => (
          <label key={value} className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name="ocr-scope"
              checked={scope === value}
              onChange={() => setScope(value)}
            />
            {t(`ocr.scopes.${value}`)}
          </label>
        ))}
      </fieldset>
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-medium">{t('ocr.languages')}</legend>
        {OCR_LANGUAGES.map(({ code, label }) => (
          <label key={code} className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={languages.includes(code)}
              onChange={(event) =>
                setLanguages(
                  event.target.checked ? [...languages, code] : languages.filter((l) => l !== code),
                )
              }
            />
            {label}
          </label>
        ))}
      </fieldset>
      <Field label={t('ocr.resolution')} hint={t('ocr.resolutionHint')}>
        <select
          className={INPUT}
          value={dpi}
          onChange={(event) => setDpi(Number(event.target.value))}
        >
          {[150, 200, 300].map((value) => (
            <option key={value} value={value}>
              {value} ppp
            </option>
          ))}
        </select>
      </Field>
      <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">
        <li>{t('ocr.note1')}</li>
        <li>{t('ocr.note2')}</li>
        <li>{t('ocr.note3')}</li>
      </ul>
    </DialogShell>
  );
}

// ---------------------------------------------------------------------------
// Convertir
// ---------------------------------------------------------------------------

function ConvertDialog() {
  const { t } = useTranslation();
  const open = useUi((s) => s.toolDialog === 'convert');
  const setDialog = useUi((s) => s.setToolDialog);
  const [office, setOffice] = useState<boolean | null>(null);
  const [imageFormat, setImageFormat] = useState<'png' | 'jpeg'>('png');
  const [dpi, setDpi] = useState(150);

  useEffect(() => {
    if (!open) return;
    setOffice(null);
    window.foliux.pdf
      .officeStatus()
      .then((status) => setOffice(status.libreOffice))
      .catch(() => setOffice(false));
  }, [open]);

  const run = (action: () => Promise<unknown>) => {
    setDialog(null);
    void action();
  };

  const Item = ({ label, hint, onClick }: { label: string; hint: string; onClick: () => void }) => (
    <Button
      variant="outline"
      onClick={onClick}
      className="h-auto w-full items-start justify-start px-3 py-2 text-left whitespace-normal"
    >
      <span>
        <span className="block font-medium">{label}</span>
        <span className="block text-xs font-normal text-muted-foreground">{hint}</span>
      </span>
    </Button>
  );

  return (
    <Dialog.Root open={open} onOpenChange={(value) => !value && setDialog(null)}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
        <Dialog.Content className="fixed top-[8%] left-1/2 z-50 max-h-[84vh] w-[560px] max-w-[calc(100vw-2rem)] -translate-x-1/2 overflow-y-auto rounded-xl border border-border bg-popover p-5 text-popover-foreground shadow-2xl">
          <Dialog.Title className="text-base font-semibold">{t('convert.title')}</Dialog.Title>
          <Dialog.Description className="mt-1 mb-4 text-sm text-muted-foreground">
            {t('convert.description')}
          </Dialog.Description>

          <h3 className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            {t('convert.fromPdf')}
          </h3>
          <div className="flex flex-col gap-2">
            <Item
              label={t('convert.toWord')}
              hint={t('convert.toWordHint')}
              onClick={() => run(() => exportToOffice('docx'))}
            />
            <Item
              label={t('convert.toExcel')}
              hint={t('convert.toExcelHint')}
              onClick={() => run(() => exportToOffice('xlsx'))}
            />
            <Item
              label={t('convert.toPowerPoint')}
              hint={t('convert.toPowerPointHint')}
              onClick={() => run(() => exportToPresentation())}
            />
            <div className="flex items-end gap-2 rounded-md border border-border p-3">
              <div className="min-w-0 flex-1">
                <p className="font-medium">{t('convert.toImages')}</p>
                <p className="text-xs text-muted-foreground">{t('convert.toImagesHint')}</p>
              </div>
              <select
                aria-label={t('redact.format')}
                className={cn(INPUT, 'w-24')}
                value={imageFormat}
                onChange={(event) => setImageFormat(event.target.value as 'png' | 'jpeg')}
              >
                <option value="png">PNG</option>
                <option value="jpeg">JPEG</option>
              </select>
              <select
                aria-label={t('ocr.resolution')}
                className={cn(INPUT, 'w-24')}
                value={dpi}
                onChange={(event) => setDpi(Number(event.target.value))}
              >
                {[96, 150, 200, 300].map((value) => (
                  <option key={value} value={value}>
                    {value} ppp
                  </option>
                ))}
              </select>
              <Button onClick={() => run(() => exportToImages(imageFormat, dpi))}>
                {t('convert.export')}
              </Button>
            </div>
          </div>

          <h3 className="mt-5 mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            {t('convert.toPdf')}
          </h3>
          <div className="flex flex-col gap-2">
            <Item
              label={t('convert.fromImages')}
              hint={t('convert.fromImagesHint')}
              onClick={() => run(importImages)}
            />
            <Item
              label={t('convert.fromOffice')}
              hint={
                office === false
                  ? t('convert.officeMissing')
                  : office === true
                    ? t('convert.fromOfficeHint')
                    : t('convert.checking')
              }
              onClick={() => run(importOffice)}
            />
          </div>
          <p className="mt-4 text-xs text-muted-foreground">{t('convert.note')}</p>
          <div className="mt-4 flex justify-end">
            <Button variant="ghost" onClick={() => setDialog(null)}>
              {t('closeDialog.cancel')}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// ---------------------------------------------------------------------------
// PDF/A
// ---------------------------------------------------------------------------

function PdfADialog() {
  const { t } = useTranslation();
  const open = useUi((s) => s.toolDialog === 'pdfa');
  const setDialog = useUi((s) => s.setToolDialog);
  const [outcome, setOutcome] = useState<PdfAOutcome | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) setOutcome(null);
  }, [open]);

  const close = () => setDialog(null);
  const submit = async () => {
    setBusy(true);
    setOutcome(await exportPdfA());
    setBusy(false);
  };
  const blocking = outcome?.issues.filter((issue) => issue.blocking) ?? [];

  return (
    <DialogShell
      open={open}
      title={t('pdfa.title')}
      description={t('pdfa.description')}
      onClose={close}
      onSubmit={() => void submit()}
      submitLabel={outcome ? t('pdfa.again') : t('pdfa.create')}
      error={null}
      busy={busy}
    >
      <p className="rounded-md bg-amber-100 p-2 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-200">
        {t('pdfa.honesty')}
      </p>
      {outcome && (
        <div className="flex flex-col gap-2 text-sm" role="status">
          <p className="font-medium">
            {blocking.length === 0
              ? t('pdfa.probable', { name: outcome.name })
              : t('pdfa.partial', { name: outcome.name })}
          </p>
          {outcome.fixed.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-muted-foreground uppercase">
                {t('pdfa.fixed')}
              </p>
              <ul className="list-disc pl-5 text-xs">
                {outcome.fixed.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </div>
          )}
          {outcome.issues.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-muted-foreground uppercase">
                {t('pdfa.issues')}
              </p>
              <ul className="list-disc pl-5 text-xs text-red-700 dark:text-red-300">
                {outcome.issues.map((issue) => (
                  <li key={issue.code}>{issue.message}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </DialogShell>
  );
}

// ---------------------------------------------------------------------------
// Lotes
// ---------------------------------------------------------------------------

const BATCH_ACTIONS: BatchAction[] = [
  'ocr',
  'optimize',
  'pdfa',
  'clean-metadata',
  'watermark',
  'protect',
];

function BatchDialog() {
  const { t } = useTranslation();
  const open = useUi((s) => s.toolDialog === 'batch');
  const setDialog = useUi((s) => s.setToolDialog);
  const { items, running, current, fraction } = useBatch();
  const [action, setAction] = useState<BatchAction>('optimize');
  const [folder, setFolder] = useState('');
  const [languages, setLanguages] = useState<string[]>(['spa', 'eng']);
  const [watermarkText, setWatermarkText] = useState(t('watermark.defaultText'));
  const [password, setPassword] = useState('');
  const [owner, setOwner] = useState('');
  const [error, setError] = useState<string | null>(null);

  const close = () => {
    if (!running) setDialog(null);
  };

  const pickFiles = async () => {
    try {
      const paths = await window.foliux.openPdfDialog();
      if (paths.length > 0) setBatchFiles(paths);
    } catch (e) {
      notifyError(t('errors.unexpected'), e);
    }
  };
  const pickFolder = async () => {
    try {
      const chosen = await window.foliux.chooseFolder();
      if (chosen) setFolder(chosen);
    } catch (e) {
      notifyError(t('errors.unexpected'), e);
    }
  };

  const submit = () => {
    setError(null);
    if (items.length === 0) return setError(t('batch.needFiles'));
    if (folder === '') return setError(t('batch.needFolder'));
    let protection: Protection | null = null;
    if (action === 'protect') {
      protection = {
        userPassword: password,
        ownerPassword: owner || password,
        permissions: FULL_PERMISSIONS,
      };
      const problem = validateProtection(protection);
      if (problem) return setError(problem);
    }
    if (action === 'ocr' && languages.length === 0) return setError(t('ocr.needLanguage'));
    void runBatch({ action, folder, languages, dpi: 200, watermarkText, protection });
  };

  const done = items.filter((i) => i.status === 'done').length;
  const failed = items.filter((i) => i.status === 'failed').length;

  return (
    <DialogShell
      open={open}
      title={t('batch.title')}
      description={t('batch.description')}
      onClose={close}
      onSubmit={submit}
      submitLabel={running ? t('batch.running') : t('batch.start')}
      error={error}
      busy={running}
    >
      <div className="flex items-center gap-2">
        <Button type="button" variant="outline" disabled={running} onClick={() => void pickFiles()}>
          {t('batch.chooseFiles')}
        </Button>
        <span className="text-sm text-muted-foreground">
          {t('batch.count', { count: items.length })}
        </span>
      </div>
      <Field label={t('batch.action')}>
        <select
          className={INPUT}
          value={action}
          disabled={running}
          onChange={(event) => setAction(event.target.value as BatchAction)}
        >
          {BATCH_ACTIONS.map((value) => (
            <option key={value} value={value}>
              {t(`batch.actions.${value}`)}
            </option>
          ))}
        </select>
      </Field>
      {action === 'watermark' && (
        <Field label={t('watermark.text')}>
          <input
            className={INPUT}
            value={watermarkText}
            onChange={(e) => setWatermarkText(e.target.value)}
          />
        </Field>
      )}
      {action === 'protect' && (
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('security.userPassword')}>
            <input
              type="password"
              className={INPUT}
              autoComplete="off"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
          <Field label={t('security.ownerPassword')}>
            <input
              type="password"
              className={INPUT}
              autoComplete="off"
              value={owner}
              onChange={(e) => setOwner(e.target.value)}
            />
          </Field>
        </div>
      )}
      {action === 'ocr' && (
        <div className="flex gap-4">
          {OCR_LANGUAGES.map(({ code, label }) => (
            <label key={code} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={languages.includes(code)}
                onChange={(event) =>
                  setLanguages(
                    event.target.checked
                      ? [...languages, code]
                      : languages.filter((l) => l !== code),
                  )
                }
              />
              {label}
            </label>
          ))}
        </div>
      )}
      <div className="flex items-end gap-2">
        <div className="min-w-0 flex-1">
          <Field label={t('batch.folder')} hint={folder || t('batch.folderHint')}>
            <Button
              type="button"
              variant="outline"
              disabled={running}
              onClick={() => void pickFolder()}
            >
              {t('batch.chooseFolder')}
            </Button>
          </Field>
        </div>
      </div>

      {items.length > 0 && (
        <ul
          className="max-h-56 overflow-y-auto rounded-md border border-border text-sm"
          aria-live="polite"
        >
          {items.map((item, index) => (
            <li
              key={item.path}
              className="flex items-start gap-2 border-b border-border px-3 py-1.5 last:border-b-0"
            >
              <span
                aria-hidden
                className={cn(
                  'mt-1.5 size-2 shrink-0 rounded-full',
                  item.status === 'done' && 'bg-green-500',
                  item.status === 'failed' && 'bg-red-500',
                  item.status === 'skipped' && 'bg-amber-500',
                  item.status === 'running' && 'animate-pulse bg-blue-500',
                  item.status === 'pending' && 'bg-muted-foreground/40',
                )}
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate">{item.name}</span>
                <span className="block text-xs text-muted-foreground">
                  {item.status === 'running' && index === current
                    ? t('batch.processing', { percent: Math.round(fraction * 100) })
                    : t(`batch.status.${item.status}`)}
                  {item.message ? ` — ${item.message}` : ''}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
      {!running && (done > 0 || failed > 0) && (
        <p role="status" className="text-sm font-medium">
          {t('batch.summary', { done, failed, total: items.length })}
        </p>
      )}
      {running && (
        <Button type="button" variant="outline" onClick={cancelBatch}>
          {t('dialogs.cancel')}
        </Button>
      )}
    </DialogShell>
  );
}

/** Diálogos de OCR, conversión, PDF/A y lotes. */
export function ConvertDialogs() {
  return (
    <>
      <OcrDialog />
      <ConvertDialog />
      <PdfADialog />
      <BatchDialog />
    </>
  );
}
