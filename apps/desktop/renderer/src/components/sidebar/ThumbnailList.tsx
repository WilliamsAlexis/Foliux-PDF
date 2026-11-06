import { memo, useEffect, useRef, useState } from 'react';
import { Copy, FileInput, FileOutput, FilePlus, RotateCcw, RotateCw, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { IPdfDocument } from '@foliux-pdf/core';
import { useDocs, type DocTab } from '@/store/docs';
import { IconButton } from '@/components/IconButton';
import {
  deletePages,
  duplicatePages,
  extractSelectedPages,
  insertBlankPage,
  insertPagesFromFile,
  movePages,
  rotatePages,
  setPageSelection,
  targetPages,
} from '@/lib/edit';
import { cn, isAbortError } from '@/lib/utils';

const THUMB_WIDTH = 150; // ancho de la miniatura (px)
const DRAG_TYPE = 'application/x-foliux-pages';

export function ThumbnailList({ tab }: { tab: DocTab }) {
  const { t } = useTranslation();
  const goToPage = useDocs((s) => s.goToPage);
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  /** Posición de inserción mientras se arrastra (1 = antes de la primera, total + 1 = al final). */
  const [dropAt, setDropAt] = useState<number | null>(null);
  const anchor = useRef(1);
  const disabled = tab.busy !== null;
  const selection = tab.pageSelection;
  const affected = targetPages(tab).length;

  const select = (page: number, event: React.MouseEvent) => {
    if (event.shiftKey) {
      const [from, to] = [Math.min(anchor.current, page), Math.max(anchor.current, page)];
      setPageSelection(
        tab.id,
        Array.from({ length: to - from + 1 }, (_, i) => from + i),
      );
    } else if (event.ctrlKey || event.metaKey) {
      anchor.current = page;
      setPageSelection(
        tab.id,
        selection.includes(page) ? selection.filter((p) => p !== page) : [...selection, page],
      );
    } else {
      anchor.current = page;
      setPageSelection(tab.id, [page]);
    }
    goToPage(tab.id, page);
  };

  return (
    <div className="flex min-h-full flex-col">
      <div
        role="toolbar"
        aria-label={t('pages.toolbar')}
        className="sticky top-0 z-10 flex flex-wrap items-center gap-0.5 border-b border-border bg-background p-1.5"
      >
        <IconButton
          label={t('pages.rotateLeft')}
          shortcut="mod+["
          icon={<RotateCcw />}
          disabled={disabled}
          onClick={() => void rotatePages(-90)}
        />
        <IconButton
          label={t('pages.rotateRight')}
          shortcut="mod+]"
          icon={<RotateCw />}
          disabled={disabled}
          onClick={() => void rotatePages(90)}
        />
        <IconButton
          label={t('pages.duplicate')}
          icon={<Copy />}
          disabled={disabled}
          onClick={() => void duplicatePages()}
        />
        <IconButton
          label={t('pages.insertBlank')}
          icon={<FilePlus />}
          disabled={disabled}
          onClick={() => void insertBlankPage()}
        />
        <IconButton
          label={t('pages.insertFromFile')}
          icon={<FileInput />}
          disabled={disabled}
          onClick={() => void insertPagesFromFile()}
        />
        <IconButton
          label={t('pages.extract')}
          icon={<FileOutput />}
          disabled={disabled}
          onClick={() => void extractSelectedPages()}
        />
        <IconButton
          label={t('pages.delete')}
          icon={<Trash2 />}
          disabled={disabled || affected >= tab.numPages}
          onClick={() => void deletePages()}
        />
        <p className="w-full px-1 pt-1 text-xs text-muted-foreground" aria-live="polite">
          {selection.length > 1
            ? t('pages.selected', { count: selection.length })
            : t('pages.hint')}
        </p>
      </div>

      <div
        ref={setRoot}
        className="flex flex-col items-center gap-3 p-3"
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropAt(null);
        }}
      >
        {tab.sizes.map((size, index) => {
          const page = index + 1;
          return (
            <Thumbnail
              key={index}
              doc={tab.doc}
              pageNumber={page}
              aspect={size.height / size.width}
              width={size.width}
              current={tab.page === page}
              selected={selection.includes(page)}
              dropBefore={dropAt === page}
              dropAfter={dropAt === page + 1 && page === tab.numPages}
              root={root?.parentElement?.parentElement ?? null}
              onSelect={(event) => select(page, event)}
              onDragStart={(event) => {
                const pages = selection.includes(page) ? selection : [page];
                if (!selection.includes(page)) setPageSelection(tab.id, [page]);
                event.dataTransfer.setData(DRAG_TYPE, JSON.stringify(pages));
                event.dataTransfer.effectAllowed = 'move';
              }}
              onDragOver={(event) => {
                if (!event.dataTransfer.types.includes(DRAG_TYPE)) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = 'move';
                const box = event.currentTarget.getBoundingClientRect();
                setDropAt(event.clientY < box.top + box.height / 2 ? page : page + 1);
              }}
              onDrop={(event) => {
                if (!event.dataTransfer.types.includes(DRAG_TYPE)) return;
                event.preventDefault();
                const target = dropAt ?? page;
                setDropAt(null);
                try {
                  const pages = JSON.parse(event.dataTransfer.getData(DRAG_TYPE)) as number[];
                  if (Array.isArray(pages)) void movePages(pages, target);
                } catch {
                  // Datos de arrastre ajenos: se ignoran.
                }
              }}
              onDragEnd={() => setDropAt(null)}
            />
          );
        })}
      </div>
    </div>
  );
}

interface ThumbnailProps {
  doc: IPdfDocument;
  pageNumber: number;
  aspect: number;
  width: number;
  current: boolean;
  selected: boolean;
  dropBefore: boolean;
  dropAfter: boolean;
  root: HTMLElement | null;
  onSelect: (event: React.MouseEvent) => void;
  onDragStart: (event: React.DragEvent) => void;
  onDragOver: (event: React.DragEvent) => void;
  onDrop: (event: React.DragEvent) => void;
  onDragEnd: () => void;
}

/** Miniatura: se dibuja solo cuando es visible y se libera al alejarse. */
const Thumbnail = memo(function Thumbnail({
  doc,
  pageNumber,
  aspect,
  width,
  current,
  selected,
  dropBefore,
  dropAfter,
  root,
  onSelect,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}: ThumbnailProps) {
  const { t } = useTranslation();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const height = Math.round(THUMB_WIDTH * aspect);

  useEffect(() => {
    const element = buttonRef.current;
    if (!element) return;
    const observer = new IntersectionObserver(
      ([entry]) => setVisible(entry?.isIntersecting ?? false),
      {
        root,
        rootMargin: '200px 0px',
      },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [root]);

  useEffect(() => {
    const container = host.current;
    if (!container) return;
    if (!visible) {
      container.replaceChildren();
      return;
    }
    const controller = new AbortController();
    doc
      .renderPage(pageNumber, { scale: THUMB_WIDTH / width, signal: controller.signal })
      .then((canvas) => {
        canvas.style.width = '100%';
        canvas.style.height = '100%';
        canvas.style.display = 'block';
        container.replaceChildren(canvas);
      })
      .catch((error: unknown) => {
        if (!isAbortError(error)) container.replaceChildren();
      });
    return () => controller.abort();
  }, [doc, pageNumber, width, visible]);

  // La miniatura de la página actual se mantiene a la vista en la lista.
  useEffect(() => {
    if (current) buttonRef.current?.scrollIntoView({ block: 'nearest' });
  }, [current]);

  return (
    <button
      ref={buttonRef}
      type="button"
      draggable
      onClick={onSelect}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
      aria-label={t('sidebar.pageLabel', { page: pageNumber })}
      aria-current={current ? 'page' : undefined}
      aria-pressed={selected}
      className={cn(
        'relative flex flex-col items-center gap-1 rounded-md p-1.5 hover:bg-accent/60',
        selected && 'bg-primary/15 hover:bg-primary/20',
      )}
    >
      {dropBefore && (
        <span aria-hidden className="absolute -top-2 right-0 left-0 h-1 rounded bg-primary" />
      )}
      <div
        ref={host}
        className={cn(
          'overflow-hidden bg-white shadow-sm ring-1 ring-border transition-shadow',
          current && 'ring-2 ring-primary',
        )}
        style={{ width: THUMB_WIDTH, height }}
      />
      <span
        className={cn(
          'text-xs tabular-nums',
          current ? 'font-semibold text-primary' : 'text-muted-foreground',
        )}
      >
        {pageNumber}
      </span>
      {dropAfter && (
        <span aria-hidden className="absolute right-0 -bottom-2 left-0 h-1 rounded bg-primary" />
      )}
    </button>
  );
});
