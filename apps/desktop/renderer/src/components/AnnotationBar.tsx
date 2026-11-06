import {
  ArrowUpRight,
  Bold,
  Circle,
  FormInput,
  EyeOff,
  Highlighter,
  ImagePlus,
  Italic,
  Minus,
  MousePointer2,
  Pencil,
  PenLine,
  PenTool,
  Redo2,
  Square,
  StickyNote,
  Strikethrough,
  TextCursorInput,
  Trash2,
  Type,
  Underline,
  Undo2,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ANNOTATION_DEFAULTS, FONT_FAMILIES } from '@foliux-pdf/core';
import { useActiveTab, type DocTab } from '@/store/docs';
import { useUi, type Tool } from '@/store/ui';
import { IconButton } from '@/components/IconButton';
import { deleteSelectedAnnotation, redo, restyleSelected, undo } from '@/lib/edit';
import { cn } from '@/lib/utils';

interface ToolDef {
  tool: Tool;
  icon: React.ReactNode;
  shortcut: string;
}

const TOOL_GROUPS: ToolDef[][] = [
  [{ tool: 'select', icon: <MousePointer2 />, shortcut: 'v' }],
  [
    { tool: 'highlight', icon: <Highlighter />, shortcut: 'h' },
    { tool: 'underline', icon: <Underline />, shortcut: 'u' },
    { tool: 'strikeout', icon: <Strikethrough />, shortcut: 's' },
  ],
  [
    { tool: 'ink', icon: <Pencil />, shortcut: 'd' },
    { tool: 'rect', icon: <Square />, shortcut: 'r' },
    { tool: 'ellipse', icon: <Circle />, shortcut: 'o' },
    { tool: 'line', icon: <Minus />, shortcut: 'l' },
    { tool: 'arrow', icon: <ArrowUpRight />, shortcut: 'a' },
  ],
  [
    { tool: 'note', icon: <StickyNote />, shortcut: 'n' },
    { tool: 'freetext', icon: <Type />, shortcut: 't' },
  ],
  // Contenido permanente: se incorpora a las páginas al guardar o al aplicar los cambios.
  [
    { tool: 'text', icon: <TextCursorInput />, shortcut: 'x' },
    { tool: 'edittext', icon: <PenLine />, shortcut: 'e' },
    { tool: 'image', icon: <ImagePlus />, shortcut: 'i' },
    { tool: 'redact', icon: <EyeOff />, shortcut: 'k' },
    { tool: 'field', icon: <FormInput />, shortcut: 'f' },
    { tool: 'signature', icon: <PenTool />, shortcut: 'm' },
  ],
];

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

/** Segunda barra: herramientas de anotación, color y grosor, deshacer/rehacer. */
export function AnnotationBar({ tab }: { tab: DocTab }) {
  const { t } = useTranslation();
  const tool = useUi((s) => s.tool);
  const setTool = useUi((s) => s.setTool);
  const color = useUi((s) => s.color);
  const setColor = useUi((s) => s.setColor);
  const strokeWidth = useUi((s) => s.strokeWidth);
  const setStrokeWidth = useUi((s) => s.setStrokeWidth);
  const active = useActiveTab();

  const selected = active?.annotations.find((a) => a.id === active.selectedAnnotationId);
  // Herramientas que no crean una anotación (campo, firma...) no muestran color ni grosor.
  const toolSubject =
    tool === 'edittext' ? 'text' : tool === 'field' || tool === 'signature' ? 'select' : tool;
  const subject = selected?.kind ?? toolSubject;
  const showStyle =
    (selected !== undefined && selected.kind !== 'image' && selected.kind !== 'redact') ||
    (selected === undefined &&
      tool !== 'select' &&
      tool !== 'image' &&
      tool !== 'redact' &&
      tool !== 'field' &&
      tool !== 'signature');
  const showStroke =
    selected !== undefined
      ? 'strokeWidth' in selected
      : ['ink', 'rect', 'ellipse', 'line', 'arrow'].includes(tool);
  const isTextual = selected
    ? selected.kind === 'freetext' || selected.kind === 'text'
    : tool === 'freetext' || tool === 'text' || tool === 'edittext';
  const showFont = isTextual;
  const textItem = selected?.kind === 'text' ? selected : undefined;

  const currentColor =
    selected?.color ?? color ?? (subject === 'select' ? '' : ANNOTATION_DEFAULTS[subject].color);
  const currentStroke = selected && 'strokeWidth' in selected ? selected.strokeWidth : strokeWidth;
  const currentFont =
    selected?.kind === 'freetext' || selected?.kind === 'text' ? selected.fontSize : 12;

  return (
    <div
      role="toolbar"
      aria-label={t('annotations.label')}
      className="flex h-10 shrink-0 items-center gap-1 overflow-x-auto border-b border-border bg-background px-2"
    >
      {TOOL_GROUPS.map((group, index) => (
        <div key={index} className="flex items-center gap-0.5">
          {index > 0 && <Divider />}
          {group.map(({ tool: id, icon, shortcut }) => (
            <IconButton
              key={id}
              label={t(`annotations.tools.${id}`)}
              shortcut={shortcut}
              icon={icon}
              aria-pressed={tool === id}
              className={cn(tool === id && 'bg-accent text-accent-foreground')}
              onClick={() => {
                setTool(id);
                if (id === 'image') toast(t('annotations.imageHint'), { id: 'image-hint' });
                if (id === 'redact') toast(t('annotations.redactHint'), { id: 'redact-hint' });
                if (id === 'field') toast(t('forms.hint'), { id: 'field-hint' });
                if (id === 'signature') {
                  // La firma se elige primero (dibujar, escribir o imagen) y luego se coloca con un clic.
                  if (!useUi.getState().pendingSignature) {
                    setTool('select');
                    useUi.getState().setToolDialog('signature');
                  } else {
                    toast(t('signing.placeHint'), { id: 'signature-hint' });
                  }
                }
                if (id === 'edittext')
                  toast(t('annotations.editTextHint'), { id: 'edittext-hint' });
              }}
            />
          ))}
        </div>
      ))}

      {showStyle && (
        <>
          <Divider />
          <div
            role="group"
            aria-label={t('annotations.color')}
            className="flex items-center gap-1 px-1"
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
              className="h-8 rounded-md border border-input bg-background px-1.5 text-sm"
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
                className="h-8 rounded-md border border-input bg-background px-1.5 text-sm"
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
                className="h-8 rounded-md border border-input bg-background px-1.5 text-sm"
              >
                {(['left', 'center', 'right'] as const).map((align) => (
                  <option key={align} value={align}>
                    {t(`annotations.alignOptions.${align}`)}
                  </option>
                ))}
              </select>
            </>
          )}
          {showFont && (
            <select
              aria-label={t('annotations.fontSize')}
              value={currentFont}
              disabled={!selected}
              onChange={(event) => restyleSelected({ fontSize: Number(event.target.value) })}
              className="h-8 rounded-md border border-input bg-background px-1.5 text-sm disabled:opacity-50"
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
      )}

      <div className="flex-1" />

      <IconButton
        label={t('annotations.undo')}
        shortcut="mod+z"
        icon={<Undo2 />}
        disabled={tab.history.length === 0 || tab.busy !== null}
        onClick={() => void undo()}
      />
      <IconButton
        label={t('annotations.redo')}
        shortcut="mod+shift+z"
        icon={<Redo2 />}
        disabled={tab.future.length === 0 || tab.busy !== null}
        onClick={() => void redo()}
      />
      <IconButton
        label={t('annotations.delete')}
        shortcut="delete"
        icon={<Trash2 />}
        disabled={!selected}
        onClick={deleteSelectedAnnotation}
      />
    </div>
  );
}

function Divider() {
  return <div className="mx-1 h-5 w-px shrink-0 bg-border" aria-hidden />;
}
