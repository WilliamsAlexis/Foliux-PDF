import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import * as Dialog from '@radix-ui/react-dialog';
import { useTranslation } from 'react-i18next';
import {
  CREATABLE_FIELD_TYPES,
  FONT_FAMILIES,
  PRINT_LEVELS,
  parsePageRange,
  planSplit,
  validateFieldName,
  validateProtection,
  type AuditEntry,
  type CreatableFieldType,
  type FontFamily,
  type MetadataReport,
  type PrintLevel,
  type Protection,
} from '@foliux-pdf/core';
import { Button } from '@/components/ui/button';
import { useActiveTab, useDocs } from '@/store/docs';
import { useUi } from '@/store/ui';
import { applyHeaderFooter, applyWatermark, splitDocument, type SplitSettings } from '@/lib/edit';
import { notifyError } from '@/lib/notify';
import { createField, suggestFieldName } from '@/lib/forms';
import {
  chooseSignature,
  createCertificate,
  deleteSavedSignature,
  loadSavedSignatures,
  saveSignature,
  signDocument,
  type SavedSignature,
} from '@/lib/signing';
import { saveTab } from '@/lib/edit';
import { openPdfPath } from '@/lib/actions';
import {
  cleanMetadata,
  loadMetadata,
  redactMarked,
  setProtection,
  type CleanOptions,
} from '@/lib/security';

export const INPUT =
  'h-9 w-full rounded-md border border-input bg-background px-2.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50';

export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="font-medium">{label}</span>
      {children}
      {hint ? <span className="text-xs text-muted-foreground">{hint}</span> : null}
    </label>
  );
}

/** Contenedor común de los diálogos. */
export function DialogShell({
  open,
  title,
  description,
  onClose,
  onSubmit,
  submitLabel,
  error,
  busy,
  children,
}: {
  open: boolean;
  title: string;
  description: string;
  onClose: () => void;
  onSubmit: () => void;
  submitLabel: string;
  error: string | null;
  busy: boolean;
  children: React.ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <Dialog.Root open={open} onOpenChange={(value) => !value && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
        <Dialog.Content className="fixed top-[8%] left-1/2 z-50 max-h-[84vh] w-[520px] max-w-[calc(100vw-2rem)] -translate-x-1/2 overflow-y-auto rounded-xl border border-border bg-popover p-5 text-popover-foreground shadow-2xl">
          <Dialog.Title className="text-base font-semibold">{title}</Dialog.Title>
          <Dialog.Description className="mt-1 mb-4 text-sm text-muted-foreground">
            {description}
          </Dialog.Description>
          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              onSubmit();
            }}
          >
            {children}
            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
            <div className="mt-2 flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={onClose}>
                {t('dialogs.cancel')}
              </Button>
              <Button type="submit" disabled={busy}>
                {submitLabel}
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** Elegir a qué páginas se aplica algo: todas, impares, pares o un rango escrito. */
function PagesChooser({
  value,
  onChange,
}: {
  value: { kind: 'all' | 'odd' | 'even' | 'custom'; custom: string };
  onChange: (value: { kind: 'all' | 'odd' | 'even' | 'custom'; custom: string }) => void;
}) {
  const { t } = useTranslation();
  return (
    <Field
      label={t('dialogs.pages')}
      hint={value.kind === 'custom' ? t('dialogs.pagesHint') : undefined}
    >
      <div className="flex gap-2">
        <select
          aria-label={t('dialogs.pages')}
          value={value.kind}
          onChange={(event) =>
            onChange({ ...value, kind: event.target.value as typeof value.kind })
          }
          className={INPUT}
        >
          <option value="all">{t('dialogs.pagesAll')}</option>
          <option value="odd">{t('dialogs.pagesOdd')}</option>
          <option value="even">{t('dialogs.pagesEven')}</option>
          <option value="custom">{t('dialogs.pagesCustom')}</option>
        </select>
        {value.kind === 'custom' && (
          <input
            aria-label={t('dialogs.pagesCustom')}
            className={INPUT}
            placeholder="1-3, 5, 8-"
            value={value.custom}
            onChange={(event) => onChange({ ...value, custom: event.target.value })}
          />
        )}
      </div>
    </Field>
  );
}

type PagesValue = { kind: 'all' | 'odd' | 'even' | 'custom'; custom: string };
const pagesSpec = (value: PagesValue) => (value.kind === 'custom' ? value.custom : value.kind);

/** Valida el rango antes de enviarlo (así el error sale en el propio diálogo). */
function checkPages(value: PagesValue, total: number): string | null {
  try {
    if (parsePageRange(pagesSpec(value), total).length === 0) return 'empty';
    return null;
  } catch (error) {
    return (error as Error).message;
  }
}

// ---------------------------------------------------------------------------

function WatermarkDialog() {
  const { t } = useTranslation();
  const open = useUi((s) => s.toolDialog === 'watermark');
  const setDialog = useUi((s) => s.setToolDialog);
  const tab = useActiveTab();
  const [text, setText] = useState(() => t('watermark.defaultText'));
  const [fontSize, setFontSize] = useState(72);
  const [color, setColor] = useState('#888888');
  const [opacity, setOpacity] = useState(25);
  const [angle, setAngle] = useState(-45);
  const [imageWidth, setImageWidth] = useState(50);
  const [image, setImage] = useState<{ src: string; format: 'png' | 'jpeg'; name: string } | null>(
    null,
  );
  const [pages, setPages] = useState<PagesValue>({ kind: 'all', custom: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const pickImage = async () => {
    try {
      const picked = await window.foliux.openImageDialog();
      if (!picked) return;
      let binary = '';
      for (let i = 0; i < picked.data.length; i += 0x8000) {
        binary += String.fromCharCode(...picked.data.subarray(i, i + 0x8000));
      }
      setImage({
        src: `data:image/${picked.format};base64,${btoa(binary)}`,
        format: picked.format,
        name: picked.name,
      });
    } catch (e) {
      notifyError(t('errors.imageFailed'), e);
    }
  };

  const close = () => {
    setDialog(null);
    setError(null);
  };

  const submit = async () => {
    if (!tab) return;
    if (text.trim() === '' && !image) return setError(t('watermark.needContent'));
    const pageError = checkPages(pages, tab.numPages);
    if (pageError) return setError(pageError === 'empty' ? t('dialogs.noPages') : pageError);
    setBusy(true);
    const ok = await applyWatermark({
      text,
      image: image ? { src: image.src, format: image.format } : null,
      fontSize,
      color,
      opacity: opacity / 100,
      angle,
      imageWidth: imageWidth / 100,
      pages: pagesSpec(pages),
    });
    setBusy(false);
    if (ok) close();
  };

  return (
    <DialogShell
      open={open}
      title={t('watermark.title')}
      description={t('watermark.description')}
      onClose={close}
      onSubmit={() => void submit()}
      submitLabel={t('watermark.apply')}
      error={error}
      busy={busy}
    >
      <Field label={t('watermark.text')}>
        <input
          className={INPUT}
          value={text}
          maxLength={500}
          onChange={(event) => setText(event.target.value)}
          autoFocus
        />
      </Field>
      <div className="grid grid-cols-3 gap-3">
        <Field label={t('watermark.size')}>
          <input
            type="number"
            min={6}
            max={400}
            className={INPUT}
            value={fontSize}
            onChange={(event) => setFontSize(Number(event.target.value) || 72)}
          />
        </Field>
        <Field label={t('watermark.angle')}>
          <input
            type="number"
            min={-90}
            max={90}
            className={INPUT}
            value={angle}
            onChange={(event) => setAngle(Number(event.target.value) || 0)}
          />
        </Field>
        <Field label={t('watermark.color')}>
          <input
            type="color"
            className={`${INPUT} p-1`}
            value={color}
            onChange={(event) => setColor(event.target.value)}
          />
        </Field>
      </div>
      <Field label={t('watermark.opacity', { value: opacity })}>
        <input
          type="range"
          min={5}
          max={100}
          value={opacity}
          onChange={(event) => setOpacity(Number(event.target.value))}
        />
      </Field>
      <div className="flex items-end gap-2">
        <div className="min-w-0 flex-1">
          <Field label={t('watermark.image')} hint={image ? image.name : t('watermark.imageHint')}>
            <Button type="button" variant="outline" onClick={() => void pickImage()}>
              {t('watermark.chooseImage')}
            </Button>
          </Field>
        </div>
        {image && (
          <Button type="button" variant="ghost" onClick={() => setImage(null)}>
            {t('watermark.removeImage')}
          </Button>
        )}
      </div>
      {image && (
        <Field label={t('watermark.imageWidth', { value: imageWidth })}>
          <input
            type="range"
            min={5}
            max={100}
            value={imageWidth}
            onChange={(event) => setImageWidth(Number(event.target.value))}
          />
        </Field>
      )}
      <PagesChooser value={pages} onChange={setPages} />
    </DialogShell>
  );
}

// ---------------------------------------------------------------------------

function HeaderFooterDialog() {
  const { t } = useTranslation();
  const open = useUi((s) => s.toolDialog === 'headerFooter');
  const setDialog = useUi((s) => s.setToolDialog);
  const tab = useActiveTab();
  const [header, setHeader] = useState({ left: '', center: '', right: '' });
  const [footer, setFooter] = useState({
    left: '',
    center: t('headerFooter.defaultFooter'),
    right: '',
  });
  const [font, setFont] = useState<FontFamily>('sans');
  const [fontSize, setFontSize] = useState(10);
  const [color, setColor] = useState('#333333');
  const [margin, setMargin] = useState(36);
  const [startNumber, setStartNumber] = useState(1);
  const [pages, setPages] = useState<PagesValue>({ kind: 'all', custom: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const close = () => {
    setDialog(null);
    setError(null);
  };

  const submit = async () => {
    if (!tab) return;
    const everything = [...Object.values(header), ...Object.values(footer)];
    if (everything.every((value) => value.trim() === ''))
      return setError(t('headerFooter.needContent'));
    const pageError = checkPages(pages, tab.numPages);
    if (pageError) return setError(pageError === 'empty' ? t('dialogs.noPages') : pageError);
    setBusy(true);
    const ok = await applyHeaderFooter({
      header,
      footer,
      font,
      fontSize,
      color,
      margin,
      pages: pagesSpec(pages),
      startNumber,
    });
    setBusy(false);
    if (ok) close();
  };

  const row = (
    label: string,
    value: { left: string; center: string; right: string },
    set: (next: { left: string; center: string; right: string }) => void,
  ) => (
    <fieldset className="flex flex-col gap-1.5">
      <legend className="mb-1 text-sm font-medium">{label}</legend>
      <div className="grid grid-cols-3 gap-2">
        {(['left', 'center', 'right'] as const).map((side) => (
          <input
            key={side}
            aria-label={`${label}: ${t(`annotations.alignOptions.${side}`)}`}
            placeholder={t(`annotations.alignOptions.${side}`)}
            className={INPUT}
            value={value[side]}
            onChange={(event) => set({ ...value, [side]: event.target.value })}
          />
        ))}
      </div>
    </fieldset>
  );

  return (
    <DialogShell
      open={open}
      title={t('headerFooter.title')}
      description={t('headerFooter.description')}
      onClose={close}
      onSubmit={() => void submit()}
      submitLabel={t('headerFooter.apply')}
      error={error}
      busy={busy}
    >
      {row(t('headerFooter.header'), header, setHeader)}
      {row(t('headerFooter.footer'), footer, setFooter)}
      <p className="text-xs text-muted-foreground">{t('headerFooter.tokens')}</p>
      <div className="grid grid-cols-4 gap-3">
        <Field label={t('headerFooter.font')}>
          <select
            className={INPUT}
            value={font}
            onChange={(event) => setFont(event.target.value as FontFamily)}
          >
            {FONT_FAMILIES.map((family) => (
              <option key={family} value={family}>
                {t(`annotations.fonts.${family}`)}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('headerFooter.size')}>
          <input
            type="number"
            min={4}
            max={72}
            className={INPUT}
            value={fontSize}
            onChange={(event) => setFontSize(Number(event.target.value) || 10)}
          />
        </Field>
        <Field label={t('headerFooter.margin')}>
          <input
            type="number"
            min={0}
            max={300}
            className={INPUT}
            value={margin}
            onChange={(event) => setMargin(Number(event.target.value) || 0)}
          />
        </Field>
        <Field label={t('watermark.color')}>
          <input
            type="color"
            className={`${INPUT} p-1`}
            value={color}
            onChange={(event) => setColor(event.target.value)}
          />
        </Field>
      </div>
      <Field label={t('headerFooter.startNumber')}>
        <input
          type="number"
          min={0}
          className={INPUT}
          value={startNumber}
          onChange={(event) => setStartNumber(Math.max(0, Number(event.target.value) || 0))}
        />
      </Field>
      <PagesChooser value={pages} onChange={setPages} />
    </DialogShell>
  );
}

// ---------------------------------------------------------------------------

function SplitDialog() {
  const { t } = useTranslation();
  const open = useUi((s) => s.toolDialog === 'split');
  const setDialog = useUi((s) => s.setToolDialog);
  const tab = useActiveTab();
  const [mode, setMode] = useState<'each' | 'every' | 'ranges'>('every');
  const [every, setEvery] = useState(1);
  const [ranges, setRanges] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const close = () => {
    setDialog(null);
    setError(null);
  };

  const settings = (): SplitSettings =>
    mode === 'each' ? { mode } : mode === 'every' ? { mode, every } : { mode, ranges };

  const submit = async () => {
    if (!tab) return;
    try {
      planSplit(tab.numPages, settings());
    } catch (e) {
      return setError((e as Error).message);
    }
    setBusy(true);
    const ok = await splitDocument(settings());
    setBusy(false);
    if (ok) close();
  };

  const count = (() => {
    if (!tab) return 0;
    try {
      return planSplit(tab.numPages, settings()).length;
    } catch {
      return 0;
    }
  })();

  return (
    <DialogShell
      open={open}
      title={t('split.title')}
      description={t('split.description')}
      onClose={close}
      onSubmit={() => void submit()}
      submitLabel={t('split.apply')}
      error={error}
      busy={busy}
    >
      <fieldset className="flex flex-col gap-2">
        <legend className="sr-only">{t('split.mode')}</legend>
        {(['each', 'every', 'ranges'] as const).map((value) => (
          <label key={value} className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name="split-mode"
              checked={mode === value}
              onChange={() => setMode(value)}
            />
            {t(`split.modes.${value}`)}
          </label>
        ))}
      </fieldset>
      {mode === 'every' && (
        <Field label={t('split.every')}>
          <input
            type="number"
            min={1}
            className={INPUT}
            value={every}
            onChange={(event) => setEvery(Math.max(1, Number(event.target.value) || 1))}
          />
        </Field>
      )}
      {mode === 'ranges' && (
        <Field label={t('split.ranges')} hint={t('split.rangesHint')}>
          <input
            className={INPUT}
            placeholder="1-3; 4-6; 7-"
            value={ranges}
            onChange={(event) => setRanges(event.target.value)}
          />
        </Field>
      )}
      {count > 0 && (
        <p className="text-sm text-muted-foreground" aria-live="polite">
          {t('split.preview', { count })}
        </p>
      )}
    </DialogShell>
  );
}

// ---------------------------------------------------------------------------
// Fase 4: seguridad
// ---------------------------------------------------------------------------

/** Pide la contraseña de un PDF protegido al abrirlo. */
function PasswordDialog() {
  const { t } = useTranslation();
  const prompt = useUi((s) => s.passwordPrompt);
  const setPrompt = useUi((s) => s.setPasswordPrompt);
  const [password, setPassword] = useState('');
  const name = prompt?.path.split(/[\\/]/).pop() ?? '';

  const close = () => {
    setPrompt(null);
    setPassword('');
  };
  const submit = () => {
    if (!prompt) return;
    const { path } = prompt;
    const typed = password;
    close();
    void openPdfPath(path, typed);
  };

  return (
    <DialogShell
      open={prompt !== null}
      title={t('security.passwordTitle')}
      description={t('security.passwordDescription', { name })}
      onClose={close}
      onSubmit={submit}
      submitLabel={t('security.open')}
      error={prompt?.invalid ? t('security.passwordWrong') : null}
      busy={false}
    >
      <Field label={t('security.password')}>
        <input
          type="password"
          autoFocus
          className={INPUT}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          autoComplete="off"
        />
      </Field>
    </DialogShell>
  );
}

const SECURITY_DEFAULTS = {
  user: '',
  owner: '',
  print: 'full' as PrintLevel,
  copy: true,
  modify: true,
};

/** Contraseñas y permisos con los que se guardará el documento. */
function SecurityDialog() {
  const { t } = useTranslation();
  const open = useUi((s) => s.toolDialog === 'security');
  const setDialog = useUi((s) => s.setToolDialog);
  const tab = useActiveTab();
  const [form, setForm] = useState(SECURITY_DEFAULTS);
  const [confirmUser, setConfirmUser] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Al abrir, se parte de la protección actual del documento.
  useEffect(() => {
    if (!open) return;
    const current = tab?.protection;
    setForm(
      current
        ? {
            user: current.userPassword,
            owner: current.ownerPassword,
            print: current.permissions.print,
            copy: current.permissions.copy,
            modify: current.permissions.modify,
          }
        : SECURITY_DEFAULTS,
    );
    setConfirmUser(current?.userPassword ?? '');
    setError(null);
  }, [open, tab?.id, tab?.protection]);

  const close = () => setDialog(null);

  const apply = () => {
    if (!tab) return;
    const protection: Protection = {
      userPassword: form.user,
      ownerPassword: form.owner,
      permissions: { print: form.print, copy: form.copy, modify: form.modify },
    };
    if (form.user !== confirmUser) return setError(t('security.mismatch'));
    const problem = validateProtection(protection);
    if (problem) return setError(problem);
    setProtection(tab.id, protection);
    close();
  };

  return (
    <DialogShell
      open={open}
      title={t('security.title')}
      description={t('security.description')}
      onClose={close}
      onSubmit={apply}
      submitLabel={t('security.apply')}
      error={error}
      busy={false}
    >
      <Field label={t('security.userPassword')} hint={t('security.userPasswordHint')}>
        <input
          type="password"
          className={INPUT}
          autoComplete="off"
          value={form.user}
          onChange={(event) => setForm({ ...form, user: event.target.value })}
        />
      </Field>
      {form.user !== '' && (
        <Field label={t('security.confirm')}>
          <input
            type="password"
            className={INPUT}
            autoComplete="off"
            value={confirmUser}
            onChange={(event) => setConfirmUser(event.target.value)}
          />
        </Field>
      )}
      <Field label={t('security.ownerPassword')} hint={t('security.ownerPasswordHint')}>
        <input
          type="password"
          className={INPUT}
          autoComplete="off"
          value={form.owner}
          onChange={(event) => setForm({ ...form, owner: event.target.value })}
        />
      </Field>
      <fieldset className="flex flex-col gap-2 rounded-md border border-border p-3">
        <legend className="px-1 text-sm font-medium">{t('security.permissions')}</legend>
        <Field label={t('security.print')}>
          <select
            className={INPUT}
            value={form.print}
            onChange={(event) => setForm({ ...form, print: event.target.value as PrintLevel })}
          >
            {PRINT_LEVELS.map((level) => (
              <option key={level} value={level}>
                {t(`security.printLevels.${level}`)}
              </option>
            ))}
          </select>
        </Field>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={form.copy}
            onChange={(event) => setForm({ ...form, copy: event.target.checked })}
          />
          {t('security.copy')}
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={form.modify}
            onChange={(event) => setForm({ ...form, modify: event.target.checked })}
          />
          {t('security.modify')}
        </label>
      </fieldset>
      <p className="text-xs text-muted-foreground">{t('security.advisory')}</p>
      {tab?.protection && (
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            setProtection(tab.id, null);
            close();
          }}
        >
          {t('security.remove')}
        </Button>
      )}
    </DialogShell>
  );
}

// ---------------------------------------------------------------------------

function MetadataDialog() {
  const { t } = useTranslation();
  const open = useUi((s) => s.toolDialog === 'metadata');
  const setDialog = useUi((s) => s.setToolDialog);
  const [report, setReport] = useState<MetadataReport | null>(null);
  const [choice, setChoice] = useState<CleanOptions>({
    info: true,
    xmp: true,
    thumbnails: true,
    attachments: true,
    javascript: true,
  });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setReport(null);
    void loadMetadata().then(setReport);
  }, [open]);

  const close = () => setDialog(null);
  const submit = async () => {
    setBusy(true);
    const ok = await cleanMetadata(choice);
    setBusy(false);
    if (ok) {
      toast.success(t('metadata.done'));
      close();
    }
  };

  const rows: [string, string][] = report
    ? [
        [t('metadata.title'), report.title],
        [t('metadata.author'), report.author],
        [t('metadata.subject'), report.subject],
        [t('metadata.keywords'), report.keywords],
        [t('metadata.creator'), report.creator],
        [t('metadata.producer'), report.producer],
        [t('metadata.created'), report.created],
        [t('metadata.modified'), report.modified],
      ]
    : [];

  const toggle = (key: keyof CleanOptions, label: string, detail?: string) => (
    <label className="flex items-start gap-2 text-sm">
      <input
        type="checkbox"
        className="mt-1"
        checked={choice[key]}
        onChange={(event) => setChoice({ ...choice, [key]: event.target.checked })}
      />
      <span>
        {label}
        {detail ? <span className="block text-xs text-muted-foreground">{detail}</span> : null}
      </span>
    </label>
  );

  return (
    <DialogShell
      open={open}
      title={t('metadata.dialogTitle')}
      description={t('metadata.description')}
      onClose={close}
      onSubmit={() => void submit()}
      submitLabel={t('metadata.clean')}
      error={null}
      busy={busy || !report}
    >
      {!report ? (
        <p className="text-sm text-muted-foreground">{t('metadata.loading')}</p>
      ) : (
        <>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-md border border-border p-3 text-sm">
            {rows.map(([label, value]) => (
              <div key={label} className="contents">
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="min-w-0 break-words">{value || '—'}</dd>
              </div>
            ))}
          </dl>
          <div className="flex flex-col gap-2">
            {toggle('info', t('metadata.cleanInfo'))}
            {toggle(
              'xmp',
              t('metadata.cleanXmp'),
              report.hasXmp ? t('metadata.present') : t('metadata.absent'),
            )}
            {toggle(
              'thumbnails',
              t('metadata.cleanThumbnails'),
              t('metadata.count', { count: report.thumbnails }),
            )}
            {toggle(
              'attachments',
              t('metadata.cleanAttachments'),
              report.attachments.length > 0 ? report.attachments.join(', ') : t('metadata.absent'),
            )}
            {toggle(
              'javascript',
              t('metadata.cleanJavascript'),
              report.hasJavaScript ? t('metadata.present') : t('metadata.absent'),
            )}
          </div>
          <p className="text-xs text-muted-foreground">{t('metadata.note')}</p>
        </>
      )}
    </DialogShell>
  );
}

// ---------------------------------------------------------------------------

function RedactDialog() {
  const { t } = useTranslation();
  const open = useUi((s) => s.toolDialog === 'redact');
  const setDialog = useUi((s) => s.setToolDialog);
  const tab = useActiveTab();
  const [dpi, setDpi] = useState(200);
  const [format, setFormat] = useState<'png' | 'jpeg'>('png');
  const [clean, setClean] = useState(true);
  const [busy, setBusy] = useState(false);

  const marks = tab?.annotations.filter((a) => a.kind === 'redact') ?? [];
  const pages = new Set(marks.map((m) => m.page)).size;
  const close = () => setDialog(null);

  const submit = async () => {
    setBusy(true);
    close(); // el avance se ve en la capa de «ocupado» con su botón de cancelar
    await redactMarked({ dpi, format, cleanMetadata: clean });
    setBusy(false);
  };

  return (
    <DialogShell
      open={open}
      title={t('redact.title')}
      description={t('redact.description', { marks: marks.length, pages })}
      onClose={close}
      onSubmit={() => void submit()}
      submitLabel={t('redact.apply')}
      error={marks.length === 0 ? t('redact.none') : null}
      busy={busy || marks.length === 0}
    >
      <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
        <li>{t('redact.effect1')}</li>
        <li>{t('redact.effect2')}</li>
        <li>{t('redact.effect3')}</li>
      </ul>
      <div className="grid grid-cols-2 gap-3">
        <Field label={t('redact.resolution')}>
          <select className={INPUT} value={dpi} onChange={(e) => setDpi(Number(e.target.value))}>
            {[150, 200, 300].map((value) => (
              <option key={value} value={value}>
                {value} ppp
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('redact.format')}>
          <select
            className={INPUT}
            value={format}
            onChange={(e) => setFormat(e.target.value as 'png' | 'jpeg')}
          >
            <option value="png">{t('redact.png')}</option>
            <option value="jpeg">{t('redact.jpeg')}</option>
          </select>
        </Field>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={clean} onChange={(e) => setClean(e.target.checked)} />
        {t('redact.cleanMetadata')}
      </label>
    </DialogShell>
  );
}

// ---------------------------------------------------------------------------
// Fase 5: formularios y firmas
// ---------------------------------------------------------------------------

function FieldDialog() {
  const { t } = useTranslation();
  const open = useUi((s) => s.toolDialog === 'field');
  const draft = useUi((s) => s.fieldDraft);
  const setDialog = useUi((s) => s.setToolDialog);
  const setDraft = useUi((s) => s.setFieldDraft);
  const tab = useActiveTab();
  const [type, setType] = useState<CreatableFieldType>('text');
  const [name, setName] = useState('');
  const [optionsText, setOptionsText] = useState('');
  const [multiline, setMultiline] = useState(false);
  const [required, setRequired] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setName(suggestFieldName(tab));
      setError(null);
    }
  }, [open, tab]);

  const close = () => {
    setDialog(null);
    setDraft(null);
  };
  const needsOptions = type === 'dropdown' || type === 'list' || type === 'radio';

  const submit = async () => {
    if (!draft) return close();
    const problem = validateFieldName(name);
    if (problem) return setError(problem);
    const options = optionsText
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '');
    if (needsOptions && options.length < (type === 'radio' ? 2 : 1)) {
      return setError(t(type === 'radio' ? 'forms.needTwoOptions' : 'forms.needOptions'));
    }
    setBusy(true);
    const ok = await createField(draft.page, draft.rect, {
      type,
      name,
      options,
      multiline,
      required,
    });
    setBusy(false);
    if (ok) close();
  };

  return (
    <DialogShell
      open={open}
      title={t('forms.dialogTitle')}
      description={t('forms.dialogDescription')}
      onClose={close}
      onSubmit={() => void submit()}
      submitLabel={t('forms.create')}
      error={error}
      busy={busy}
    >
      <Field label={t('forms.type')}>
        <select
          className={INPUT}
          value={type}
          onChange={(e) => setType(e.target.value as CreatableFieldType)}
        >
          {CREATABLE_FIELD_TYPES.map((value) => (
            <option key={value} value={value}>
              {t(`forms.types.${value}`)}
            </option>
          ))}
        </select>
      </Field>
      <Field label={t('forms.name')} hint={t('forms.nameHint')}>
        <input className={INPUT} value={name} onChange={(e) => setName(e.target.value)} autoFocus />
      </Field>
      {needsOptions && (
        <Field label={t('forms.options')} hint={t('forms.optionsHint')}>
          <textarea
            className={`${INPUT} h-24 py-2`}
            value={optionsText}
            onChange={(e) => setOptionsText(e.target.value)}
          />
        </Field>
      )}
      {type === 'text' && (
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={multiline}
            onChange={(e) => setMultiline(e.target.checked)}
          />
          {t('forms.multiline')}
        </label>
      )}
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={required} onChange={(e) => setRequired(e.target.checked)} />
        {t('forms.required')}
      </label>
    </DialogShell>
  );
}

// ---------------------------------------------------------------------------

const SIGNATURE_FONTS = [
  '"Segoe Script", "Brush Script MT", cursive',
  '"Lucida Handwriting", "Apple Chancery", cursive',
  '"Segoe UI", Arial, sans-serif',
];

/** Recorta el espacio transparente alrededor del dibujo y devuelve la imagen resultante. */
function trimCanvas(source: HTMLCanvasElement): { src: string; ratio: number } | null {
  const context = source.getContext('2d');
  if (!context) return null;
  const { width, height } = source;
  const pixels = context.getImageData(0, 0, width, height).data;
  let [minX, minY, maxX, maxY] = [width, height, -1, -1];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if ((pixels[(y * width + x) * 4 + 3] ?? 0) > 8) {
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
    }
  }
  if (maxX < 0) return null; // no hay nada dibujado
  const pad = 6;
  const w = maxX - minX + 1 + pad * 2;
  const h = maxY - minY + 1 + pad * 2;
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  out.getContext('2d')?.drawImage(source, minX - pad, minY - pad, w, h, 0, 0, w, h);
  return { src: out.toDataURL('image/png'), ratio: w / h };
}

/** Firma visual: dibujada, escrita o con una imagen. Se coloca después como imagen en la página. */
function SignatureDialog() {
  const { t } = useTranslation();
  const open = useUi((s) => s.toolDialog === 'signature');
  const setDialog = useUi((s) => s.setToolDialog);
  const [mode, setMode] = useState<'draw' | 'type' | 'image'>('draw');
  const [typed, setTyped] = useState('');
  const [fontIndex, setFontIndex] = useState(0);
  const [color, setColor] = useState('#1a237e');
  const [image, setImage] = useState<{ src: string; ratio: number; format: 'png' | 'jpeg' } | null>(
    null,
  );
  const [saved, setSaved] = useState<SavedSignature[]>([]);
  const [error, setError] = useState<string | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);

  useEffect(() => {
    if (open) {
      setSaved(loadSavedSignatures());
      setError(null);
    }
  }, [open]);

  const clearCanvas = () => canvasRef.current?.getContext('2d')?.clearRect(0, 0, 520, 180);
  const close = () => setDialog(null);

  const point = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    return {
      x: ((event.clientX - box.left) / box.width) * 520,
      y: ((event.clientY - box.top) / box.height) * 180,
    };
  };
  const onDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const context = canvasRef.current?.getContext('2d');
    if (!context) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drawing.current = true;
    const p = point(event);
    context.strokeStyle = color;
    context.lineWidth = 3;
    context.lineCap = 'round';
    context.lineJoin = 'round';
    context.beginPath();
    context.moveTo(p.x, p.y);
    context.lineTo(p.x + 0.01, p.y);
    context.stroke();
  };
  const onMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current) return;
    const context = canvasRef.current?.getContext('2d');
    const p = point(event);
    context?.lineTo(p.x, p.y);
    context?.stroke();
  };
  const onUp = () => {
    drawing.current = false;
  };

  const pickImage = async () => {
    try {
      const picked = await window.foliux.openImageDialog();
      if (!picked) return;
      let binary = '';
      for (let i = 0; i < picked.data.length; i += 0x8000) {
        binary += String.fromCharCode(...picked.data.subarray(i, i + 0x8000));
      }
      const src = `data:image/${picked.format};base64,${btoa(binary)}`;
      const size = await new Promise<{ w: number; h: number }>((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
        img.onerror = () => reject(new Error(t('errors.imageUnreadable')));
        img.src = src;
      });
      setImage({ src, ratio: size.w / size.h, format: picked.format });
    } catch (e) {
      notifyError(t('errors.imageFailed'), e);
    }
  };

  /** Genera la imagen de la firma según la pestaña activa. */
  const build = (): { src: string; ratio: number; format: 'png' | 'jpeg'; name: string } | null => {
    if (mode === 'image') return image ? { ...image, name: t('signing.imageName') } : null;
    const canvas = document.createElement('canvas');
    canvas.width = 520;
    canvas.height = 180;
    if (mode === 'draw') {
      const drawn = canvasRef.current ? trimCanvas(canvasRef.current) : null;
      return drawn ? { ...drawn, format: 'png', name: t('signing.drawnName') } : null;
    }
    const context = canvas.getContext('2d');
    if (!context || typed.trim() === '') return null;
    context.fillStyle = color;
    context.font = `72px ${SIGNATURE_FONTS[fontIndex]}`;
    context.textBaseline = 'middle';
    context.fillText(typed.trim(), 20, 90, 480);
    const rendered = trimCanvas(canvas);
    return rendered ? { ...rendered, format: 'png', name: typed.trim() } : null;
  };

  const use = (remember: boolean) => {
    const built = build();
    if (!built) return setError(t('signing.empty'));
    const signature: SavedSignature = {
      id: `sig-${Date.now()}`,
      name: built.name,
      src: built.src,
      format: built.format,
      ratio: built.ratio,
    };
    if (remember) saveSignature(signature);
    chooseSignature(signature);
    close();
  };

  const tabs = ['draw', 'type', 'image'] as const;

  return (
    <DialogShell
      open={open}
      title={t('signing.visualTitle')}
      description={t('signing.visualDescription')}
      onClose={close}
      onSubmit={() => use(true)}
      submitLabel={t('signing.useSignature')}
      error={error}
      busy={false}
    >
      <div role="tablist" className="flex gap-1">
        {tabs.map((value) => (
          <Button
            key={value}
            type="button"
            role="tab"
            aria-selected={mode === value}
            variant={mode === value ? 'secondary' : 'ghost'}
            size="sm"
            onClick={() => setMode(value)}
          >
            {t(`signing.modes.${value}`)}
          </Button>
        ))}
        <input
          type="color"
          aria-label={t('watermark.color')}
          className="ml-auto h-8 w-10 rounded border border-input bg-background p-0.5"
          value={color}
          onChange={(event) => setColor(event.target.value)}
        />
      </div>

      {mode === 'draw' && (
        <div className="flex flex-col gap-2">
          <canvas
            ref={canvasRef}
            width={520}
            height={180}
            aria-label={t('signing.drawArea')}
            className="h-[140px] w-full touch-none rounded-md border border-dashed border-input bg-white"
            onPointerDown={onDown}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerCancel={onUp}
          />
          <Button type="button" variant="outline" size="sm" onClick={clearCanvas}>
            {t('signing.clear')}
          </Button>
        </div>
      )}
      {mode === 'type' && (
        <div className="flex flex-col gap-2">
          <input
            className={INPUT}
            value={typed}
            placeholder={t('signing.typePlaceholder')}
            onChange={(event) => setTyped(event.target.value)}
          />
          <div className="flex flex-col gap-1">
            {SIGNATURE_FONTS.map((family, index) => (
              <label
                key={family}
                className="flex cursor-pointer items-center gap-2 rounded-md border border-border px-3 py-1.5"
              >
                <input
                  type="radio"
                  checked={fontIndex === index}
                  onChange={() => setFontIndex(index)}
                />
                <span style={{ fontFamily: family, fontSize: 26, color }}>
                  {typed.trim() || t('signing.sample')}
                </span>
              </label>
            ))}
          </div>
        </div>
      )}
      {mode === 'image' && (
        <div className="flex flex-col items-start gap-2">
          <Button type="button" variant="outline" onClick={() => void pickImage()}>
            {t('signing.chooseImage')}
          </Button>
          {image && (
            <img
              src={image.src}
              alt=""
              className="max-h-24 rounded border border-border bg-white p-1"
            />
          )}
        </div>
      )}

      {saved.length > 0 && (
        <div className="flex flex-col gap-1">
          <p className="text-sm font-medium">{t('signing.saved')}</p>
          <ul className="flex flex-wrap gap-2">
            {saved.map((signature) => (
              <li
                key={signature.id}
                className="flex items-center gap-1 rounded-md border border-border p-1"
              >
                <button
                  type="button"
                  className="rounded bg-white p-1 hover:ring-2 hover:ring-ring"
                  aria-label={t('signing.useSaved', { name: signature.name })}
                  onClick={() => {
                    chooseSignature(signature);
                    close();
                  }}
                >
                  <img src={signature.src} alt="" className="h-9 max-w-[120px] object-contain" />
                </button>
                <button
                  type="button"
                  aria-label={t('signing.deleteSaved', { name: signature.name })}
                  className="rounded px-1 text-xs text-muted-foreground hover:bg-accent"
                  onClick={() => {
                    deleteSavedSignature(signature.id);
                    setSaved(loadSavedSignatures());
                  }}
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className="text-xs text-muted-foreground">{t('signing.visualNote')}</p>
    </DialogShell>
  );
}

// ---------------------------------------------------------------------------

function SignDialog() {
  const { t } = useTranslation();
  const open = useUi((s) => s.toolDialog === 'sign');
  const setDialog = useUi((s) => s.setToolDialog);
  const tab = useActiveTab();
  const [certificate, setCertificate] = useState<{ name: string; data: Uint8Array } | null>(null);
  const [passphrase, setPassphrase] = useState('');
  const [reason, setReason] = useState('');
  const [location, setLocation] = useState('');
  const [contact, setContact] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) setError(null);
  }, [open]);

  const close = () => {
    setDialog(null);
    setPassphrase('');
  };

  const submit = async () => {
    if (!certificate) return setError(t('signing.needCertificate'));
    if (tab?.protection) return setError(t('signing.protectedBlocked'));
    setBusy(true);
    close();
    await signDocument({ certificate: certificate.data, passphrase, reason, location, contact });
    setBusy(false);
  };

  return (
    <DialogShell
      open={open}
      title={t('signing.digitalTitle')}
      description={t('signing.digitalDescription')}
      onClose={close}
      onSubmit={() => void submit()}
      submitLabel={t('signing.sign')}
      error={error}
      busy={busy}
    >
      <div className="flex items-end gap-2">
        <div className="min-w-0 flex-1">
          <Field
            label={t('signing.certificate')}
            hint={certificate ? certificate.name : t('signing.certificateHint')}
          >
            <Button
              type="button"
              variant="outline"
              onClick={() =>
                void window.foliux
                  .openCertificateDialog()
                  .then((picked) => picked && setCertificate(picked))
                  .catch((e: unknown) => notifyError(t('errors.signFailed'), e))
              }
            >
              {t('signing.chooseCertificate')}
            </Button>
          </Field>
        </div>
        <Button type="button" variant="ghost" onClick={() => setDialog('certificate')}>
          {t('signing.createCertificate')}
        </Button>
      </div>
      <Field label={t('signing.passphrase')}>
        <input
          type="password"
          className={INPUT}
          autoComplete="off"
          value={passphrase}
          onChange={(event) => setPassphrase(event.target.value)}
        />
      </Field>
      <Field label={t('signing.reason')}>
        <input className={INPUT} value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label={t('signing.location')}>
          <input className={INPUT} value={location} onChange={(e) => setLocation(e.target.value)} />
        </Field>
        <Field label={t('signing.contact')}>
          <input className={INPUT} value={contact} onChange={(e) => setContact(e.target.value)} />
        </Field>
      </div>
      <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">
        <li>{t('signing.note1')}</li>
        <li>{t('signing.note2')}</li>
        <li>{t('signing.note3')}</li>
      </ul>
    </DialogShell>
  );
}

function CertificateDialog() {
  const { t } = useTranslation();
  const open = useUi((s) => s.toolDialog === 'certificate');
  const setDialog = useUi((s) => s.setToolDialog);
  const [form, setForm] = useState({
    commonName: '',
    organization: '',
    email: '',
    days: 365,
    passphrase: '',
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const close = () => {
    setDialog(null);
    setForm((current) => ({ ...current, passphrase: '' }));
  };
  const submit = async () => {
    if (form.commonName.trim() === '') return setError(t('signing.needName'));
    if (form.passphrase.length < 4) return setError(t('signing.passphraseShort'));
    setBusy(true);
    const ok = await createCertificate({ ...form, commonName: form.commonName.trim() });
    setBusy(false);
    if (ok) close();
  };

  return (
    <DialogShell
      open={open}
      title={t('signing.certTitle')}
      description={t('signing.certDescription')}
      onClose={close}
      onSubmit={() => void submit()}
      submitLabel={t('signing.certCreate')}
      error={error}
      busy={busy}
    >
      <Field label={t('signing.certName')}>
        <input
          className={INPUT}
          autoFocus
          value={form.commonName}
          onChange={(e) => setForm({ ...form, commonName: e.target.value })}
        />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label={t('signing.certOrganization')}>
          <input
            className={INPUT}
            value={form.organization}
            onChange={(e) => setForm({ ...form, organization: e.target.value })}
          />
        </Field>
        <Field label={t('signing.certEmail')}>
          <input
            className={INPUT}
            type="email"
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
          />
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label={t('signing.certDays')}>
          <input
            className={INPUT}
            type="number"
            min={1}
            max={3650}
            value={form.days}
            onChange={(e) => setForm({ ...form, days: Math.max(1, Number(e.target.value) || 365) })}
          />
        </Field>
        <Field label={t('signing.passphrase')}>
          <input
            className={INPUT}
            type="password"
            autoComplete="off"
            value={form.passphrase}
            onChange={(e) => setForm({ ...form, passphrase: e.target.value })}
          />
        </Field>
      </div>
      <p className="text-xs text-muted-foreground">{t('signing.certNote')}</p>
    </DialogShell>
  );
}

// ---------------------------------------------------------------------------

function AuditDialog() {
  const { t } = useTranslation();
  const open = useUi((s) => s.toolDialog === 'audit');
  const setDialog = useUi((s) => s.setToolDialog);
  const [data, setData] = useState<{ entries: AuditEntry[]; chainOk: boolean } | null>(null);

  useEffect(() => {
    if (!open) return;
    setData(null);
    window.foliux.audit
      .list()
      .then(setData)
      .catch((e: unknown) => notifyError(t('errors.signFailed'), e));
  }, [open, t]);

  const exportCsv = async () => {
    try {
      const saved = await window.foliux.audit.exportCsv();
      if (saved) toast.success(t('signing.exported', { name: saved.name }));
    } catch (e) {
      notifyError(t('errors.signFailed'), e);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={(value) => !value && setDialog(null)}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
        <Dialog.Content className="fixed top-[8%] left-1/2 z-50 max-h-[84vh] w-[860px] max-w-[calc(100vw-2rem)] -translate-x-1/2 overflow-y-auto rounded-xl border border-border bg-popover p-5 text-popover-foreground shadow-2xl">
          <Dialog.Title className="text-base font-semibold">{t('signing.auditTitle')}</Dialog.Title>
          <Dialog.Description className="mt-1 mb-3 text-sm text-muted-foreground">
            {t('signing.auditDescription')}
          </Dialog.Description>
          {data && (
            <p
              role="status"
              className={
                data.chainOk
                  ? 'mb-3 rounded-md bg-green-100 p-2 text-sm text-green-900 dark:bg-green-950 dark:text-green-200'
                  : 'mb-3 rounded-md bg-red-100 p-2 text-sm text-red-900 dark:bg-red-950 dark:text-red-200'
              }
            >
              {data.chainOk
                ? t('signing.chainOk', { count: data.entries.length })
                : t('signing.chainBroken')}
            </p>
          )}
          {!data ? (
            <p className="text-sm text-muted-foreground">{t('metadata.loading')}</p>
          ) : data.entries.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('signing.auditEmpty')}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="text-muted-foreground">
                  <tr>
                    <th className="p-1.5">#</th>
                    <th className="p-1.5">{t('signing.colDate')}</th>
                    <th className="p-1.5">{t('signing.colAction')}</th>
                    <th className="p-1.5">{t('signing.colFile')}</th>
                    <th className="p-1.5">{t('signing.colSigner')}</th>
                    <th className="p-1.5">{t('signing.colDetail')}</th>
                  </tr>
                </thead>
                <tbody>
                  {[...data.entries].reverse().map((entry) => (
                    <tr key={entry.id} className="border-t border-border align-top">
                      <td className="p-1.5 tabular-nums">{entry.id}</td>
                      <td className="p-1.5 whitespace-nowrap">
                        {new Date(entry.time).toLocaleString()}
                      </td>
                      <td className="p-1.5">{t(`signing.actions.${entry.action}`)}</td>
                      <td className="p-1.5 break-all">{entry.file}</td>
                      <td className="p-1.5">{entry.signer}</td>
                      <td className="p-1.5 break-words">{entry.detail}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="mt-3 text-xs text-muted-foreground">{t('signing.auditNote')}</p>
          <div className="mt-4 flex justify-end gap-2">
            <Button
              variant="outline"
              disabled={!data || data.entries.length === 0}
              onClick={() => void exportCsv()}
            >
              {t('signing.exportCsv')}
            </Button>
            <Button onClick={() => setDialog(null)}>{t('signing.closeAudit')}</Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// ---------------------------------------------------------------------------

/** Aviso al guardar un documento firmado: guardar con cambios invalida sus firmas. */
function SignatureWarningDialog() {
  const { t } = useTranslation();
  const tabId = useUi((s) => s.signatureWarning);
  const set = useUi((s) => s.setSignatureWarning);
  const tab = useDocs((s) => s.tabs.find((candidate) => candidate.id === tabId));

  const close = () => set(null);
  const proceed = () => {
    if (!tab) return;
    const id = tab.id;
    close();
    void saveTab(id, false, true);
  };

  return (
    <Dialog.Root open={tab !== undefined} onOpenChange={(value) => !value && close()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
        <Dialog.Content className="fixed top-[28%] left-1/2 z-50 w-[460px] max-w-[calc(100vw-2rem)] -translate-x-1/2 rounded-xl border border-border bg-popover p-5 text-popover-foreground shadow-2xl">
          <Dialog.Title className="text-base font-semibold">
            {t('signatures.warnTitle')}
          </Dialog.Title>
          <Dialog.Description className="mt-2 text-sm text-muted-foreground">
            {t('signatures.warnMessage', {
              name: tab?.name ?? '',
              count: tab?.signatures.length ?? 0,
            })}
          </Dialog.Description>
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="ghost" autoFocus onClick={close}>
              {t('dialogs.cancel')}
            </Button>
            <Button variant="outline" onClick={proceed}>
              {t('signatures.saveAnyway')}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** Todos los diálogos de las herramientas de edición. */
export function ToolDialogs() {
  return (
    <>
      <WatermarkDialog />
      <HeaderFooterDialog />
      <SplitDialog />
      <PasswordDialog />
      <SecurityDialog />
      <MetadataDialog />
      <RedactDialog />
      <FieldDialog />
      <SignatureDialog />
      <SignDialog />
      <CertificateDialog />
      <AuditDialog />
      <SignatureWarningDialog />
    </>
  );
}
