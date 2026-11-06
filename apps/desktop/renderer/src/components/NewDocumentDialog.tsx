import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  MAX_NEW_PAGES,
  NewDocumentSchema,
  PAGE_PRESETS,
  pageSizeFor,
  type PagePresetId,
} from '@foliux-pdf/core';
import { DialogShell, Field, INPUT } from '@/components/ToolDialogs';
import { useUi } from '@/store/ui';
import { createNewDocument } from '@/lib/newdoc';

type Choice = PagePresetId | 'custom';

/** Nuevo PDF: papel, orientación y número de páginas. */
export function NewDocumentDialog() {
  const { t } = useTranslation();
  const open = useUi((s) => s.toolDialog === 'newDocument');
  const setDialog = useUi((s) => s.setToolDialog);
  const [choice, setChoice] = useState<Choice>('a4');
  const [orientation, setOrientation] = useState<'portrait' | 'landscape'>('portrait');
  const [pages, setPages] = useState(1);
  // Medidas a mano, en milímetros
  const [customW, setCustomW] = useState(210);
  const [customH, setCustomH] = useState(297);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  useEffect(() => {
    if (open) setError(null);
  }, [open]);

  const submit = async () => {
    const size =
      choice === 'custom'
        ? { width: (customW / 25.4) * 72, height: (customH / 25.4) * 72 }
        : pageSizeFor(choice, orientation);
    const parsed = NewDocumentSchema.safeParse({ ...size, pages });
    if (!parsed.success) {
      setError(t('newDocument.invalid', { max: MAX_NEW_PAGES }));
      return;
    }
    setWorking(true);
    try {
      if (await createNewDocument(parsed.data)) setDialog(null);
    } finally {
      setWorking(false);
    }
  };

  return (
    <DialogShell
      open={open}
      title={t('newDocument.title')}
      description={t('newDocument.description')}
      onClose={() => setDialog(null)}
      onSubmit={() => void submit()}
      submitLabel={t('newDocument.create')}
      error={error}
      busy={working}
    >
      <Field label={t('newDocument.paper')}>
        <select
          className={INPUT}
          value={choice}
          onChange={(event) => setChoice(event.target.value as Choice)}
        >
          {PAGE_PRESETS.map((preset) => (
            <option key={preset.id} value={preset.id}>
              {preset.label}
            </option>
          ))}
          <option value="custom">{t('newDocument.custom')}</option>
        </select>
      </Field>

      {choice === 'custom' ? (
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('newDocument.widthMm')}>
            <input
              type="number"
              min={25}
              max={5000}
              value={customW}
              onChange={(event) => setCustomW(Number(event.target.value))}
              className={INPUT}
            />
          </Field>
          <Field label={t('newDocument.heightMm')}>
            <input
              type="number"
              min={25}
              max={5000}
              value={customH}
              onChange={(event) => setCustomH(Number(event.target.value))}
              className={INPUT}
            />
          </Field>
        </div>
      ) : (
        <Field label={t('newDocument.orientation')}>
          <select
            className={INPUT}
            value={orientation}
            onChange={(event) => setOrientation(event.target.value as 'portrait' | 'landscape')}
          >
            <option value="portrait">{t('newDocument.portrait')}</option>
            <option value="landscape">{t('newDocument.landscape')}</option>
          </select>
        </Field>
      )}

      <Field label={t('newDocument.pages')}>
        <input
          type="number"
          min={1}
          max={MAX_NEW_PAGES}
          value={pages}
          onChange={(event) => setPages(Math.floor(Number(event.target.value)) || 1)}
          className={INPUT}
        />
      </Field>
      <p className="text-xs text-muted-foreground">{t('newDocument.hint')}</p>
    </DialogShell>
  );
}
