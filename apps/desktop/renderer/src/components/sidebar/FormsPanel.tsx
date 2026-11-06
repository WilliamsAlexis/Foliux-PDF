import { Eraser, FormInput, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { FormFieldInfo, FormValue } from '@foliux-pdf/core';
import { Button } from '@/components/ui/button';
import type { DocTab } from '@/store/docs';
import { useUi } from '@/store/ui';
import { currentValue, deleteField, flattenFormFields, goToField, hintField } from '@/lib/forms';

function summary(value: FormValue): string {
  if (typeof value === 'boolean') return value ? '✓' : '—';
  if (Array.isArray(value)) return value.join(', ') || '—';
  return value || '—';
}

/** Campos del formulario: lista, crear, borrar y aplanar. */
export function FormsPanel({ tab }: { tab: DocTab }) {
  const { t } = useTranslation();
  const setTool = useUi((s) => s.setTool);
  const fields = tab.form ?? [];
  const busy = tab.busy !== null;

  return (
    <div className="flex flex-col">
      <div className="flex flex-col gap-2 border-b border-border p-3">
        <Button
          size="sm"
          disabled={busy}
          onClick={() => {
            setTool('field');
            hintField();
          }}
        >
          <FormInput /> {t('forms.add')}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy || fields.length === 0}
          onClick={() => void flattenFormFields()}
        >
          <Eraser /> {t('forms.flatten')}
        </Button>
        <p className="text-xs text-muted-foreground">{t('forms.flattenHint')}</p>
      </div>

      {tab.form === null ? (
        <p className="p-4 text-sm text-muted-foreground">{t('forms.loading')}</p>
      ) : fields.length === 0 ? (
        <p className="p-4 text-sm text-muted-foreground">{t('forms.empty')}</p>
      ) : (
        <ul className="flex flex-col p-1.5">
          {fields.map((field: FormFieldInfo) => (
            <li key={field.name} className="group relative">
              <button
                type="button"
                onClick={() => goToField(tab.id, field)}
                className="flex w-full flex-col rounded-md px-2 py-1.5 pr-8 text-left text-sm hover:bg-accent/60"
              >
                <span className="font-medium break-all">{field.name}</span>
                <span className="text-xs text-muted-foreground">
                  {t(`forms.types.${field.type}`)} · {summary(currentValue(tab, field))}
                </span>
              </button>
              <button
                type="button"
                aria-label={t('forms.delete', { name: field.name })}
                disabled={busy}
                onClick={() => void deleteField(field.name)}
                className="absolute top-1.5 right-1.5 flex size-6 items-center justify-center rounded opacity-0 hover:bg-background focus-visible:opacity-100 group-hover:opacity-100"
              >
                <Trash2 className="size-3.5" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
