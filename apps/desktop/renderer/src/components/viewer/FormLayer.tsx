import { memo, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { FormFieldInfo, FormValue } from '@foliux-pdf/core';
import { useDocs } from '@/store/docs';
import { useUi } from '@/store/ui';
import { setFormValue } from '@/lib/forms';
import { cn } from '@/lib/utils';

interface FormLayerProps {
  tabId: string;
  pageNumber: number;
  /** Píxeles CSS por unidad PDF. */
  scale: number;
}

const BASE =
  'absolute box-border border border-blue-500/60 bg-blue-100/60 text-black outline-none ' +
  'focus:ring-2 focus:ring-blue-600 dark:bg-blue-300/20 dark:text-white';

/**
 * Los campos del formulario, dibujados como controles reales sobre la página. Lo que se escribe queda
 * pendiente en la pestaña y se pasa al PDF al guardar o al hacer otra operación.
 */
export const FormLayer = memo(function FormLayer({ tabId, pageNumber, scale }: FormLayerProps) {
  const form = useDocs((s) => s.tabs.find((t) => t.id === tabId)?.form);
  const values = useDocs((s) => s.tabs.find((t) => t.id === tabId)?.formValues);
  const tool = useUi((s) => s.tool);

  const widgets = useMemo(
    () =>
      (form ?? []).flatMap((field) =>
        field.widgets
          .filter((widget) => widget.page === pageNumber)
          .map((widget, index) => ({ field, widget, key: `${field.name}-${index}` })),
      ),
    [form, pageNumber],
  );
  if (widgets.length === 0) return null;

  // Con una herramienta de dibujo activa, los campos no deben quitar los clics a la página.
  const interactive = tool === 'select';

  return (
    <div className={cn('absolute inset-0 z-[3]', 'pointer-events-none')} data-form-layer>
      {widgets.map(({ field, widget, key }) => (
        <FieldControl
          key={key}
          tabId={tabId}
          field={field}
          option={widget.option}
          rect={widget.rect}
          scale={scale}
          interactive={interactive}
          value={
            values?.[field.name] !== undefined ? (values[field.name] as FormValue) : field.value
          }
        />
      ))}
    </div>
  );
});

function FieldControl({
  tabId,
  field,
  option,
  rect,
  scale,
  interactive,
  value,
}: {
  tabId: string;
  field: FormFieldInfo;
  option: string | undefined;
  rect: { x: number; y: number; width: number; height: number };
  scale: number;
  interactive: boolean;
  value: FormValue;
}) {
  const { t } = useTranslation();
  const set = (next: FormValue) => setFormValue(tabId, field, next);
  const style: React.CSSProperties = {
    left: rect.x * scale,
    top: rect.y * scale,
    width: rect.width * scale,
    height: rect.height * scale,
    fontSize: Math.max(7, Math.min(rect.height * 0.62, 14)) * scale,
    pointerEvents: interactive ? 'auto' : 'none',
  };
  const className = cn(BASE, field.required && 'border-red-500', field.readOnly && 'opacity-60');
  const label = field.name;

  switch (field.type) {
    case 'text':
      return field.multiline ? (
        <textarea
          aria-label={label}
          className={cn(className, 'resize-none px-1')}
          style={style}
          value={typeof value === 'string' ? value : ''}
          disabled={field.readOnly}
          onChange={(event) => set(event.target.value)}
        />
      ) : (
        <input
          aria-label={label}
          className={cn(className, 'px-1')}
          style={style}
          value={typeof value === 'string' ? value : ''}
          disabled={field.readOnly}
          onChange={(event) => set(event.target.value)}
        />
      );

    case 'checkbox':
      return (
        <input
          type="checkbox"
          aria-label={label}
          className={className}
          style={style}
          checked={value === true}
          disabled={field.readOnly}
          onChange={(event) => set(event.target.checked)}
        />
      );

    case 'radio':
      return (
        <input
          type="radio"
          aria-label={`${label}: ${option ?? ''}`}
          className={cn(className, 'rounded-full')}
          style={style}
          name={`${tabId}-${field.name}`}
          checked={value === option}
          disabled={field.readOnly}
          onChange={() => set(option ?? '')}
        />
      );

    case 'dropdown':
      return (
        <select
          aria-label={label}
          className={className}
          style={style}
          value={Array.isArray(value) ? (value[0] ?? '') : typeof value === 'string' ? value : ''}
          disabled={field.readOnly}
          onChange={(event) => set(event.target.value === '' ? [] : [event.target.value])}
        >
          <option value="" />
          {field.options.map((choice) => (
            <option key={choice} value={choice}>
              {choice}
            </option>
          ))}
        </select>
      );

    case 'list':
      return (
        <select
          multiple
          aria-label={label}
          className={className}
          style={style}
          value={Array.isArray(value) ? value : []}
          disabled={field.readOnly}
          onChange={(event) =>
            set(Array.from(event.target.selectedOptions, (selected) => selected.value))
          }
        >
          {field.options.map((choice) => (
            <option key={choice} value={choice}>
              {choice}
            </option>
          ))}
        </select>
      );

    case 'signature':
      return (
        <div
          className="absolute flex items-center justify-center border border-dashed border-blue-600/70 bg-blue-50/50 text-blue-700 dark:text-blue-300"
          style={{ ...style, pointerEvents: 'none' }}
        >
          {t('forms.signatureField')}
        </div>
      );

    default:
      return null;
  }
}
