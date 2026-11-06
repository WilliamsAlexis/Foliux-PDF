import {
  ArrowUpRight,
  Circle,
  Highlighter,
  EyeOff,
  ImagePlus,
  Minus,
  Pencil,
  Square,
  StickyNote,
  Strikethrough,
  TextCursorInput,
  Trash2,
  Type,
  Underline,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  annotationBounds,
  sortAnnotations,
  type Annotation,
  type AnnotationKind,
} from '@foliux-pdf/core';
import { useDocs, type DocTab } from '@/store/docs';
import { deleteAnnotation, selectAnnotation } from '@/lib/edit';
import { cn } from '@/lib/utils';

const ICONS: Record<AnnotationKind, React.ReactNode> = {
  highlight: <Highlighter />,
  underline: <Underline />,
  strikeout: <Strikethrough />,
  ink: <Pencil />,
  rect: <Square />,
  ellipse: <Circle />,
  line: <Minus />,
  arrow: <ArrowUpRight />,
  note: <StickyNote />,
  freetext: <Type />,
  text: <TextCursorInput />,
  image: <ImagePlus />,
  redact: <EyeOff />,
};

/** Lista de todas las anotaciones del documento: sirve para localizarlas, seleccionarlas y borrarlas. */
export function AnnotationList({ tab }: { tab: DocTab }) {
  const { t } = useTranslation();
  const goToPage = useDocs((s) => s.goToPage);
  const items = sortAnnotations(tab.annotations);

  if (items.length === 0) {
    return <p className="p-4 text-sm text-muted-foreground">{t('annotations.empty')}</p>;
  }

  const open = (annotation: Annotation) => {
    selectAnnotation(tab.id, annotation.id);
    goToPage(tab.id, annotation.page, annotationBounds(annotation).y);
  };

  return (
    <ul className="flex flex-col p-1.5">
      {items.map((annotation) => {
        const selected = annotation.id === tab.selectedAnnotationId;
        return (
          <li key={annotation.id} className="group relative">
            <button
              type="button"
              onClick={() => open(annotation)}
              aria-current={selected ? 'true' : undefined}
              className={cn(
                'flex w-full items-start gap-2 rounded-md px-2 py-1.5 pr-8 text-left text-sm hover:bg-accent/60',
                selected && 'bg-accent',
              )}
            >
              <span
                aria-hidden
                className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded text-foreground [&_svg]:size-3.5"
                style={{ backgroundColor: `${annotation.color}55`, color: 'inherit' }}
              >
                {ICONS[annotation.kind]}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block font-medium">
                  {t(`annotations.tools.${annotation.kind}`)}{' '}
                  <span className="ml-0.5 text-xs font-normal text-muted-foreground tabular-nums">
                    {t('annotations.onPage', { page: annotation.page })}
                  </span>
                </span>
                {annotation.text ? (
                  <span className="line-clamp-2 block text-xs break-words text-muted-foreground">
                    {annotation.text}
                  </span>
                ) : null}
              </span>
            </button>
            <button
              type="button"
              aria-label={t('annotations.deleteOne', {
                type: t(`annotations.tools.${annotation.kind}`),
                page: annotation.page,
              })}
              onClick={() => deleteAnnotation(tab.id, annotation.id)}
              className="absolute top-1.5 right-1.5 flex size-6 items-center justify-center rounded opacity-0 hover:bg-background focus-visible:opacity-100 group-hover:opacity-100"
            >
              <Trash2 className="size-3.5" aria-hidden />
            </button>
          </li>
        );
      })}
    </ul>
  );
}
