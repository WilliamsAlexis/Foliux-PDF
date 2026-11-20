import { useEffect, useMemo, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useTranslation } from 'react-i18next';
import { PageOpSchema, parsePageRange } from '@foliux-pdf/core';
import { Button } from '@/components/ui/button';
import {
  DialogShell,
  Field,
  INPUT,
  PagesChooser,
  checkPages,
  pagesSpec,
  type PagesValue,
} from '@/components/ToolDialogs';
import { useActiveTab } from '@/store/docs';
import { useUi } from '@/store/ui';
import {
  defaultConvertOptions,
  exportToImages,
  exportToOffice,
  exportToPresentation,
  exportToText,
} from '@/lib/convert';
import { runPageOp } from '@/lib/edit';
import {
  INITIALS_STYLES,
  STAMPS,
  armInitials,
  armStamp,
  loadInitials,
  renderStamp,
  renderText,
  saveInitials,
  type InitialsStyleId,
} from '@/lib/stamps';
import { cn } from '@/lib/utils';

// ---------------------------------------------------------------------------
// Convertir: cuadro de opciones (rango de páginas, calidad y nombre del archivo)
// ---------------------------------------------------------------------------

function ConvertOptionsDialog() {
  const { t } = useTranslation();
  const open = useUi((s) => s.toolDialog === 'convertOptions');
  const format = useUi((s) => s.convertFormat);
  const setDialog = useUi((s) => s.setToolDialog);
  const tab = useActiveTab();
  const [fileName, setFileName] = useState('');
  const [pages, setPages] = useState<PagesValue>({ kind: 'all', custom: '' });
  const [imageFormat, setImageFormat] = useState<'png' | 'jpeg'>('png');
  const [dpi, setDpi] = useState(150);
  const [quality, setQuality] = useState(0.9);
  const [includeImages, setIncludeImages] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open && tab) {
      setFileName(defaultConvertOptions(tab).fileName);
      setPages({ kind: 'all', custom: '' });
      setIncludeImages(true);
      setError(null);
    }
    // Solo al abrir: no se reinicia mientras se escribe.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const usesDpi = format === 'images' || format === 'pptx';
  const submit = () => {
    if (!tab) return;
    const problem = checkPages(pages, tab.numPages);
    if (problem) {
      setError(problem === 'empty' ? t('dialogs.noPages') : problem);
      return;
    }
    if (fileName.trim() === '') {
      setError(t('convert.needName'));
      return;
    }
    const options = {
      ...defaultConvertOptions(tab),
      pages: parsePageRange(pagesSpec(pages), tab.numPages),
      dpi,
      quality,
      fileName: fileName.trim(),
      includeImages,
    };
    setDialog(null);
    switch (format) {
      case 'docx':
      case 'xlsx':
        void exportToOffice(format, options);
        break;
      case 'pptx':
        void exportToPresentation(options);
        break;
      case 'images':
        void exportToImages(imageFormat, options);
        break;
      case 'txt':
      case 'html':
        void exportToText(format, options);
        break;
    }
  };

  return (
    <DialogShell
      open={open}
      title={t('convert.optionsTitle', { format: t(`convert.formats.${format}`) })}
      description={t(`convert.formatHints.${format}`)}
      onClose={() => setDialog(null)}
      onSubmit={submit}
      submitLabel={t('convert.convert')}
      error={error}
      busy={false}
    >
      <Field label={t('convert.fileName')} hint={t('convert.fileNameHint')}>
        <input
          className={INPUT}
          value={fileName}
          maxLength={120}
          onChange={(event) => setFileName(event.target.value)}
        />
      </Field>
      <PagesChooser value={pages} onChange={setPages} />
      {format === 'docx' && (
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-1"
            checked={includeImages}
            onChange={(event) => setIncludeImages(event.target.checked)}
          />
          <span>
            {t('convert.includeImages')}
            <span className="block text-xs text-muted-foreground">
              {t('convert.includeImagesHint')}
            </span>
          </span>
        </label>
      )}
      {format === 'images' && (
        <Field label={t('redact.format')}>
          <select
            className={INPUT}
            value={imageFormat}
            onChange={(event) => setImageFormat(event.target.value as 'png' | 'jpeg')}
          >
            <option value="png">{t('convert.pngOption')}</option>
            <option value="jpeg">{t('convert.jpegOption')}</option>
          </select>
        </Field>
      )}
      {usesDpi && (
        <Field label={t('ocr.resolution')}>
          <select
            className={INPUT}
            value={dpi}
            onChange={(event) => setDpi(Number(event.target.value))}
          >
            {[96, 150, 200, 300].map((value) => (
              <option key={value} value={value}>
                {value} ppp
              </option>
            ))}
          </select>
        </Field>
      )}
      {format === 'images' && imageFormat === 'jpeg' && (
        <Field label={t('convert.quality')}>
          <select
            className={INPUT}
            value={quality}
            onChange={(event) => setQuality(Number(event.target.value))}
          >
            <option value={0.6}>{t('convert.qualityLow')}</option>
            <option value={0.8}>{t('convert.qualityMedium')}</option>
            <option value={0.92}>{t('convert.qualityHigh')}</option>
          </select>
        </Field>
      )}
    </DialogShell>
  );
}

// ---------------------------------------------------------------------------
// Enlace
// ---------------------------------------------------------------------------

/** Convierte lo escrito en una dirección válida: añade https:// o mailto: cuando falta. */
function normalizeUrl(text: string): string {
  const value = text.trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return value;
  if (value.includes('@') && !value.includes('/')) return `mailto:${value}`;
  return `https://${value}`;
}

function LinkDialog() {
  const { t } = useTranslation();
  const open = useUi((s) => s.toolDialog === 'link');
  const zone = useUi((s) => s.zoneDraft);
  const setDialog = useUi((s) => s.setToolDialog);
  const setZone = useUi((s) => s.setZoneDraft);
  const tab = useActiveTab();
  const [kind, setKind] = useState<'url' | 'page'>('url');
  const [url, setUrl] = useState('');
  const [target, setTarget] = useState(1);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setKind('url');
      setUrl('');
      setTarget(1);
      setError(null);
    }
  }, [open]);

  const close = () => {
    setDialog(null);
    setZone(null);
  };

  const submit = async () => {
    if (!zone || !tab) return;
    const base = { type: 'addLink' as const, page: zone.page, rect: zone.rect };
    const op =
      kind === 'url' ? { ...base, url: normalizeUrl(url) } : { ...base, targetPage: target };
    if (kind === 'url' && url.trim() === '') {
      setError(t('link.needUrl'));
      return;
    }
    if (kind === 'page' && (target < 1 || target > tab.numPages)) {
      setError(t('link.badPage', { max: tab.numPages }));
      return;
    }
    if (!PageOpSchema.safeParse(op).success) {
      setError(t('link.badUrl'));
      return;
    }
    if (await runPageOp(op, { goTo: zone.page })) close();
  };

  return (
    <DialogShell
      open={open}
      title={t('link.title')}
      description={t('link.description')}
      onClose={close}
      onSubmit={() => void submit()}
      submitLabel={t('link.add')}
      error={error}
      busy={false}
    >
      <Field label={t('link.type')}>
        <select
          className={INPUT}
          value={kind}
          onChange={(event) => setKind(event.target.value as 'url' | 'page')}
        >
          <option value="url">{t('link.typeUrl')}</option>
          <option value="page">{t('link.typePage')}</option>
        </select>
      </Field>
      {kind === 'url' ? (
        <Field label={t('link.url')} hint={t('link.urlHint')}>
          <input
            className={INPUT}
            value={url}
            maxLength={2000}
            placeholder="https://…"
            autoFocus
            onChange={(event) => setUrl(event.target.value)}
          />
        </Field>
      ) : (
        <Field label={t('link.page')}>
          <input
            type="number"
            className={INPUT}
            min={1}
            max={tab?.numPages ?? 1}
            value={target}
            onChange={(event) => setTarget(Math.floor(Number(event.target.value)) || 1)}
          />
        </Field>
      )}
    </DialogShell>
  );
}

// ---------------------------------------------------------------------------
// Recorte
// ---------------------------------------------------------------------------

function CropDialog() {
  const { t } = useTranslation();
  const open = useUi((s) => s.toolDialog === 'crop');
  const zone = useUi((s) => s.zoneDraft);
  const setDialog = useUi((s) => s.setToolDialog);
  const setZone = useUi((s) => s.setZoneDraft);
  const [allPages, setAllPages] = useState(false);

  useEffect(() => {
    if (open) setAllPages(false);
  }, [open]);

  const close = () => {
    setDialog(null);
    setZone(null);
  };

  const submit = async () => {
    if (!zone) return;
    const ok = await runPageOp(
      { type: 'crop', page: zone.page, rect: zone.rect, allPages },
      { goTo: zone.page },
    );
    if (ok) close();
  };

  return (
    <DialogShell
      open={open}
      title={t('crop.title')}
      description={t('crop.description')}
      onClose={close}
      onSubmit={() => void submit()}
      submitLabel={t('crop.apply')}
      error={null}
      busy={false}
    >
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={allPages}
          onChange={(event) => setAllPages(event.target.checked)}
        />
        {t('crop.allPages')}
      </label>
      <p className="text-xs text-muted-foreground">{t('crop.note')}</p>
    </DialogShell>
  );
}

// ---------------------------------------------------------------------------
// Sellos e iniciales
// ---------------------------------------------------------------------------

function StampDialog() {
  const { t } = useTranslation();
  const open = useUi((s) => s.toolDialog === 'stamp');
  const setDialog = useUi((s) => s.setToolDialog);
  // Las vistas previas se dibujan una vez, al abrir.
  const previews = useMemo(
    () =>
      open
        ? STAMPS.map((stamp) => ({
            ...stamp,
            image: renderStamp(t(`stamps.names.${stamp.id}`).toUpperCase(), stamp.color),
          }))
        : [],
    [open, t],
  );

  return (
    <Dialog.Root open={open} onOpenChange={(value) => !value && setDialog(null)}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
        <Dialog.Content className="fixed top-[10%] left-1/2 z-50 max-h-[80vh] w-[520px] max-w-[calc(100vw-2rem)] -translate-x-1/2 overflow-y-auto rounded-xl border border-border bg-popover p-5 text-popover-foreground shadow-2xl">
          <Dialog.Title className="text-base font-semibold">{t('stamps.title')}</Dialog.Title>
          <Dialog.Description className="mt-1 mb-4 text-sm text-muted-foreground">
            {t('stamps.description')}
          </Dialog.Description>
          <div className="grid grid-cols-2 gap-3">
            {previews.map((stamp) => (
              <button
                key={stamp.id}
                type="button"
                aria-label={t(`stamps.names.${stamp.id}`)}
                onClick={() => {
                  setDialog(null);
                  armStamp(stamp.id);
                }}
                className="flex items-center justify-center rounded-lg border border-border bg-background p-3 hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              >
                <img src={stamp.image.src} alt="" className="max-h-14 max-w-full" />
              </button>
            ))}
          </div>
          <div className="mt-4 flex justify-end">
            <Button variant="ghost" onClick={() => setDialog(null)}>
              {t('dialogs.cancel')}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function InitialsDialog() {
  const { t } = useTranslation();
  const open = useUi((s) => s.toolDialog === 'initials');
  const setDialog = useUi((s) => s.setToolDialog);
  const [text, setText] = useState('');
  const [style, setStyle] = useState<InitialsStyleId>('script');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setText(loadInitials());
      setError(null);
    }
  }, [open]);

  const preview = useMemo(() => {
    const value = text.trim();
    if (!open || value === '') return null;
    const found = INITIALS_STYLES.find((s) => s.id === style) ?? INITIALS_STYLES[0];
    return renderText(value, found.font, '#1f2a44');
  }, [open, text, style]);

  return (
    <DialogShell
      open={open}
      title={t('initials.title')}
      description={t('initials.description')}
      onClose={() => setDialog(null)}
      onSubmit={() => {
        const value = text.trim();
        if (value === '') {
          setError(t('initials.empty'));
          return;
        }
        saveInitials(value);
        setDialog(null);
        armInitials(value, style);
      }}
      submitLabel={t('initials.use')}
      error={error}
      busy={false}
    >
      <Field label={t('initials.label')}>
        <input
          className={INPUT}
          value={text}
          maxLength={6}
          autoFocus
          placeholder="AB"
          onChange={(event) => setText(event.target.value)}
        />
      </Field>
      <Field label={t('initials.style')}>
        <select
          className={INPUT}
          value={style}
          onChange={(event) => setStyle(event.target.value as InitialsStyleId)}
        >
          {INITIALS_STYLES.map((s) => (
            <option key={s.id} value={s.id}>
              {t(`initials.styles.${s.id}`)}
            </option>
          ))}
        </select>
      </Field>
      <div
        className={cn(
          'flex h-20 items-center justify-center rounded-md border border-dashed border-border bg-background',
        )}
        aria-label={t('initials.preview')}
      >
        {preview ? (
          <img src={preview.src} alt="" className="max-h-16 max-w-full" />
        ) : (
          <span className="text-xs text-muted-foreground">{t('initials.preview')}</span>
        )}
      </div>
    </DialogShell>
  );
}

export function RibbonDialogs() {
  return (
    <>
      <ConvertOptionsDialog />
      <LinkDialog />
      <CropDialog />
      <StampDialog />
      <InitialsDialog />
    </>
  );
}
