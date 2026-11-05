import { memo, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { IPdfDocument } from '@foliux-pdf/core';
import { useDocs, type DocTab } from '@/store/docs';
import { cn, isAbortError } from '@/lib/utils';

const THUMB_WIDTH = 150; // ancho de la miniatura (px)

export function ThumbnailList({ tab }: { tab: DocTab }) {
  const goToPage = useDocs((s) => s.goToPage);
  const [root, setRoot] = useState<HTMLDivElement | null>(null);

  return (
    <div ref={setRoot} className="flex flex-col items-center gap-3 p-3">
      {tab.sizes.map((size, index) => (
        <Thumbnail
          key={index}
          doc={tab.doc}
          pageNumber={index + 1}
          aspect={size.height / size.width}
          width={size.width}
          current={tab.page === index + 1}
          root={root?.parentElement ?? null}
          onSelect={() => goToPage(tab.id, index + 1)}
        />
      ))}
    </div>
  );
}

interface ThumbnailProps {
  doc: IPdfDocument;
  pageNumber: number;
  aspect: number;
  width: number;
  current: boolean;
  root: HTMLElement | null;
  onSelect: () => void;
}

/** Miniatura: se dibuja solo cuando es visible y se libera al alejarse. */
const Thumbnail = memo(function Thumbnail({
  doc,
  pageNumber,
  aspect,
  width,
  current,
  root,
  onSelect,
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
      onClick={onSelect}
      aria-label={t('sidebar.pageLabel', { page: pageNumber })}
      aria-current={current ? 'page' : undefined}
      className="flex flex-col items-center gap-1 rounded-md p-1.5 hover:bg-accent/60"
    >
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
    </button>
  );
});
