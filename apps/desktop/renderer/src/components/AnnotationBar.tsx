import { Bold, Italic } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { ANNOTATION_DEFAULTS, FONT_FAMILIES } from '@foliux-pdf/core';
import type { DocTab } from '@/store/docs';
import { useUi } from '@/store/ui';
import { IconButton } from '@/components/IconButton';
import { restyleSelected } from '@/lib/edit';
import { cn } from '@/lib/utils';

const COLORS = [
  '#ffd400',
  '#ff9f1c',
  '#e03131',
  '#d6336c',
  '#7048e8',
  '#1971c2',
  '#2f9e44',
  '#212529',
];
const STROKE_WIDTHS = [1, 2, 3, 5, 8];
const FONT_SIZES = [10, 12, 14, 18, 24];

function Divider() {
  return <div className="mx-1 h-5 w-px shrink-0 bg-border" aria-hidden />;
}

/**
 * Controles de estilo (color, grosor, tipografía) que se muestran al final de la barra secundaria de las
 * acciones de anotación. Se adaptan a lo seleccionado o a la herramienta activa.
 */
export function StyleControls({ tab }: { tab: DocTab }) {
  const { t } = useTranslation();
  const tool = useUi((s) => s.tool);
  const color = useUi((s) => s.color);
  const setColor = useUi((s) => s.setColor);
  const strokeWidth = useUi((s) => s.strokeWidth);
  const setStrokeWidth = useUi((s) => s.setStrokeWidth);

  const selected = tab.annotations.find((a) => a.id === tab.selectedAnnotationId);
  // Herramientas que no crean una anotación con estilo (campo, firma, enlace, recorte...) no muestran controles.
  const toolSubject =
    tool === 'edittext'
      ? 'text'
      : tool === 'field' || tool === 'signature' || tool === 'link' || tool === 'crop'
        ? 'select'
        : tool;
  const subject = selected?.kind ?? toolSubject;
  const showStyle =
    (selected !== undefined && selected.kind !== 'image' && selected.kind !== 'redact') ||
    (selected === undefined &&
      tool !== 'select' &&
      tool !== 'image' &&
      tool !== 'redact' &&
      tool !== 'field' &&
      tool !== 'signature' &&
      tool !== 'link' &&
      tool !== 'crop');
  if (!showStyle) return null;

  const showStroke =
    selected !== undefined
      ? 'strokeWidth' in selected
      : ['ink', 'rect', 'ellipse', 'line', 'arrow'].includes(tool);
  const isTextual = selected
    ? selected.kind === 'freetext' || selected.kind === 'text'
    : tool === 'freetext' || tool === 'text' || tool === 'edittext';
  const textItem = selected?.kind === 'text' ? selected : undefined;

  const currentColor =
    selected?.color ?? color ?? (subject === 'select' ? '' : ANNOTATION_DEFAULTS[subject].color);
  const currentStroke = selected && 'strokeWidth' in selected ? selected.strokeWidth : strokeWidth;
  const currentFont =
    selected?.kind === 'freetext' || selected?.kind === 'text' ? selected.fontSize : 12;

  return (
    <>
      <Divider />
      <div
        role="group"
        aria-label={t('annotations.color')}
        className="flex shrink-0 items-center gap-1 px-1"
      >
        {COLORS.map((value) => (
          <button
            key={value}
            type="button"
            aria-label={t('annotations.colorOption', { color: value })}
            aria-pressed={currentColor.toLowerCase() === value}
            onClick={() => {
              setColor(value);
              restyleSelected({ color: value });
            }}
            className={cn(
              'size-5 rounded-full border border-black/15 transition-transform hover:scale-110 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
              currentColor.toLowerCase() === value &&
                'ring-2 ring-primary ring-offset-1 ring-offset-background',
            )}
            style={{ backgroundColor: value }}
          />
        ))}
      </div>
      {showStroke && (
        <select
          aria-label={t('annotations.strokeWidth')}
          value={currentStroke}
          onChange={(event) => {
            const width = Number(event.target.value);
            setStrokeWidth(width);
            restyleSelected({ strokeWidth: width });
          }}
          className="h-8 shrink-0 rounded-md border border-input bg-background px-1.5 text-sm"
        >
          {(STROKE_WIDTHS.includes(currentStroke)
            ? STROKE_WIDTHS
            : [...STROKE_WIDTHS, currentStroke].sort((a, b) => a - b)
          ).map((w) => (
            <option key={w} value={w}>
              {t('annotations.strokeOption', { width: w })}
            </option>
          ))}
        </select>
      )}
      {textItem && (
        <>
          <select
            aria-label={t('annotations.fontFamily')}
            value={textItem.font}
            onChange={(event) =>
              restyleSelected({ font: event.target.value as (typeof FONT_FAMILIES)[number] })
            }
            className="h-8 shrink-0 rounded-md border border-input bg-background px-1.5 text-sm"
          >
            {FONT_FAMILIES.map((family) => (
              <option key={family} value={family}>
                {t(`annotations.fonts.${family}`)}
              </option>
            ))}
          </select>
          <IconButton
            label={t('annotations.bold')}
            icon={<Bold />}
            aria-pressed={textItem.bold}
            className={cn(textItem.bold && 'bg-accent text-accent-foreground')}
            onClick={() => restyleSelected({ bold: !textItem.bold })}
          />
          <IconButton
            label={t('annotations.italic')}
            icon={<Italic />}
            aria-pressed={textItem.italic}
            className={cn(textItem.italic && 'bg-accent text-accent-foreground')}
            onClick={() => restyleSelected({ italic: !textItem.italic })}
          />
          <select
            aria-label={t('annotations.align')}
            value={textItem.align}
            onChange={(event) =>
              restyleSelected({ align: event.target.value as 'left' | 'center' | 'right' })
            }
            className="h-8 shrink-0 rounded-md border border-input bg-background px-1.5 text-sm"
          >
            {(['left', 'center', 'right'] as const).map((align) => (
              <option key={align} value={align}>
                {t(`annotations.alignOptions.${align}`)}
              </option>
            ))}
          </select>
        </>
      )}
      {isTextual && (
        <select
          aria-label={t('annotations.fontSize')}
          value={currentFont}
          disabled={!selected}
          onChange={(event) => restyleSelected({ fontSize: Number(event.target.value) })}
          className="h-8 shrink-0 rounded-md border border-input bg-background px-1.5 text-sm disabled:opacity-50"
        >
          {(FONT_SIZES.includes(currentFont) ? FONT_SIZES : [...FONT_SIZES, currentFont]).map(
            (size) => (
              <option key={size} value={size}>
                {size} pt
              </option>
            ),
          )}
        </select>
      )}
    </>
  );
}
