import { useEffect, useState } from 'react';
import { Highlighter, Strikethrough, Underline } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useUi } from '@/store/ui';
import { createMarkupFromSelection } from '@/lib/edit';
import { cn } from '@/lib/utils';

type MarkupKind = 'highlight' | 'underline' | 'strikeout';

const MARKUPS: { kind: MarkupKind; icon: React.ReactNode }[] = [
  { kind: 'highlight', icon: <Highlighter /> },
  { kind: 'underline', icon: <Underline /> },
  { kind: 'strikeout', icon: <Strikethrough /> },
];

function selectionIsInPage(selection: Selection): boolean {
  if (selection.rangeCount === 0 || selection.isCollapsed) return false;
  const range = selection.getRangeAt(0);
  const inPage = (node: Node) => node.parentElement?.closest('.pdf-page') != null;
  return inPage(range.startContainer) || inPage(range.endContainer);
}

/**
 * Al seleccionar texto aparece una barrita flotante para resaltarlo, subrayarlo o tacharlo.
 * Si hay una herramienta de marcado activa, se aplica directamente al soltar el ratón.
 */
export function SelectionBar() {
  const { t } = useTranslation();
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);

  useEffect(() => {
    const hide = () => setPosition(null);

    const onMouseUp = (event: MouseEvent) => {
      if ((event.target as HTMLElement).closest('[data-selection-bar]')) return;
      // La selección se consolida justo después de soltar el ratón.
      window.setTimeout(() => {
        const selection = window.getSelection();
        if (!selection || !selectionIsInPage(selection)) {
          hide();
          return;
        }
        const tool = useUi.getState().tool;
        if (tool === 'highlight' || tool === 'underline' || tool === 'strikeout') {
          createMarkupFromSelection(tool);
          hide();
          return;
        }
        if (tool !== 'select') return;
        const box = selection.getRangeAt(0).getBoundingClientRect();
        setPosition({
          left: Math.min(Math.max(box.left + box.width / 2, 90), window.innerWidth - 90),
          top: Math.min(box.bottom + 8, window.innerHeight - 52),
        });
      }, 0);
    };
    const onMouseDown = (event: MouseEvent) => {
      if (!(event.target as HTMLElement).closest('[data-selection-bar]')) hide();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') hide();
    };

    document.addEventListener('mouseup', onMouseUp);
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', hide);
    document.addEventListener('scroll', hide, true);
    return () => {
      document.removeEventListener('mouseup', onMouseUp);
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', hide);
      document.removeEventListener('scroll', hide, true);
    };
  }, []);

  if (!position) return null;

  return (
    <div
      data-selection-bar
      role="toolbar"
      aria-label={t('annotations.selectionBar')}
      // mousedown no debe quitar la selección de texto
      onMouseDown={(event) => event.preventDefault()}
      className="fixed z-50 flex -translate-x-1/2 gap-0.5 rounded-lg border border-border bg-popover p-1 shadow-lg"
      style={{ left: position.left, top: position.top }}
    >
      {MARKUPS.map(({ kind, icon }) => (
        <button
          key={kind}
          type="button"
          title={t(`annotations.tools.${kind}`)}
          aria-label={t(`annotations.tools.${kind}`)}
          onClick={() => {
            createMarkupFromSelection(kind);
            setPosition(null);
          }}
          className={cn(
            'inline-flex size-8 items-center justify-center rounded-md text-popover-foreground',
            'hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
            '[&_svg]:size-4',
          )}
        >
          {icon}
        </button>
      ))}
    </div>
  );
}
