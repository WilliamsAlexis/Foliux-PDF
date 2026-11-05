import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { SearchHit } from '@foliux-pdf/core';
import { useDocs, type DocTab } from '@/store/docs';
import { useUi } from '@/store/ui';
import {
  CSS_UNITS,
  PAGE_GAP,
  VIEW_PADDING,
  computePageTops,
  computeZoom,
  pageAtOffset,
  pagesInView,
} from '@/lib/layout';
import { zoomByFactor } from '@/lib/actions';
import { PageView } from './PageView';

/** Último scroll de cada pestaña, para recuperarlo al volver a ella (no necesita ser reactivo). */
const scrollMemory = new Map<string, number>();

function useElementSize<T extends HTMLElement>(): [
  React.RefObject<T | null>,
  { width: number; height: number },
] {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, size];
}

/** Agrupa las coincidencias por página para pasárselas a cada PageView. */
function useHitsByPage(tab: DocTab): {
  byPage: Map<number, SearchHit[]>;
  current: SearchHit | null;
} {
  const { hits, current } = tab.search;
  return useMemo(() => {
    const byPage = new Map<number, SearchHit[]>();
    for (const hit of hits) {
      const list = byPage.get(hit.pageNumber);
      if (list) list.push(hit);
      else byPage.set(hit.pageNumber, [hit]);
    }
    return { byPage, current: hits[current] ?? null };
  }, [hits, current]);
}

export function Viewer({ tab }: { tab: DocTab }) {
  const viewMode = useUi((s) => s.viewMode);
  const update = useDocs((s) => s.update);
  const [boxRef, box] = useElementSize<HTMLDivElement>();

  // Zoom real según el modo (manual, ajustar al ancho o a la página) y el tamaño disponible.
  const zoom = computeZoom({
    zoomMode: tab.zoomMode,
    customZoom: tab.customZoom,
    sizes: tab.sizes,
    page: tab.page,
    viewMode,
    width: box.width,
    height: box.height,
  });
  useEffect(() => {
    if (Math.abs(zoom - tab.zoom) > 0.0005) update(tab.id, { zoom });
  }, [zoom, tab.zoom, tab.id, update]);

  // Ctrl + rueda = zoom (también el gesto de pellizco del trackpad, que llega como Ctrl + rueda).
  useEffect(() => {
    const element = boxRef.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      zoomByFactor(event.deltaY < 0 ? 1.1 : 1 / 1.1);
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, [boxRef]);

  const scale = zoom * CSS_UNITS;

  return (
    <div ref={boxRef} className="h-full w-full">
      {box.width > 0 &&
        (viewMode === 'continuous' ? (
          <ContinuousView tab={tab} scale={scale} />
        ) : (
          <PagedView tab={tab} scale={scale} viewMode={viewMode} />
        ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Modo continuo: todas las páginas en una columna con scroll
// ---------------------------------------------------------------------------

function ContinuousView({ tab, scale }: { tab: DocTab; scale: number }) {
  const { doc, sizes } = tab;
  const setPageFromScroll = useDocs((s) => s.setPageFromScroll);
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  const tops = useMemo(() => computePageTops(sizes, scale), [sizes, scale]);
  const { byPage, current } = useHitsByPage(tab);

  // Ancla para mantener la posición al cambiar el zoom: página visible y fracción recorrida de ella.
  const anchor = useRef({ page: 1, fraction: 0 });
  const previousScale = useRef(scale);
  const latest = useRef({ tops, scale, tabId: tab.id });
  latest.current = { tops, scale, tabId: tab.id };

  const handleScroll = useCallback(() => {
    if (!scrollEl) return;
    const { tops: currentTops, scale: currentScale, tabId } = latest.current;
    const y = scrollEl.scrollTop;
    scrollMemory.set(tabId, y);

    // La "página actual" es la que cruza el 35 % superior de la pantalla.
    const probe = y + scrollEl.clientHeight * 0.35;
    const page = pageAtOffset(currentTops, probe);
    const top = currentTops[page - 1] ?? 0;
    const pageHeight = Math.max(1, Math.floor((sizes[page - 1]?.height ?? 1) * currentScale));
    anchor.current = { page, fraction: (y - top) / pageHeight };
    setPageFromScroll(tabId, page);
  }, [scrollEl, sizes, setPageFromScroll]);

  // Al abrir o volver a una pestaña: recuperar la posición guardada (o ir a la página actual).
  useLayoutEffect(() => {
    if (!scrollEl) return;
    const saved = scrollMemory.get(tab.id);
    scrollEl.scrollTop = saved ?? Math.max(0, (tops[tab.page - 1] ?? 0) - VIEW_PADDING);
    handleScroll();
    // Solo al montar para esta pestaña
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollEl, tab.id]);

  // Al cambiar el zoom: mantener la misma zona del documento a la vista.
  useLayoutEffect(() => {
    if (!scrollEl || previousScale.current === scale) return;
    previousScale.current = scale;
    const { page, fraction } = anchor.current;
    const top = tops[page - 1] ?? 0;
    const pageHeight = Math.floor((sizes[page - 1]?.height ?? 1) * scale);
    scrollEl.scrollTop = top + fraction * pageHeight;
  }, [scale, scrollEl, tops, sizes]);

  // Peticiones de navegación (miniaturas, marcadores, búsqueda, teclado...).
  const request = tab.scrollRequest;
  useEffect(() => {
    if (!scrollEl || !request) return;
    const top = tops[request.page - 1] ?? 0;
    const offset =
      request.y !== undefined
        ? top + request.y * scale - scrollEl.clientHeight * 0.35 // deja la coincidencia a un tercio de la pantalla
        : top - VIEW_PADDING / 2;
    scrollEl.scrollTo({ top: Math.max(0, offset) });
    // Solo reacciona a una petición nueva
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request?.nonce, scrollEl]);

  return (
    <div
      ref={setScrollEl}
      tabIndex={0}
      role="document"
      aria-label={tab.name}
      onScroll={handleScroll}
      className="h-full overflow-auto bg-viewer outline-none"
    >
      <div
        className="mx-auto flex min-w-full flex-col items-center"
        style={{
          width: 'max-content',
          padding: `${VIEW_PADDING}px`,
          gap: PAGE_GAP,
          boxSizing: 'border-box',
        }}
      >
        {sizes.map((size, index) => (
          <PageView
            key={index}
            doc={doc}
            pageNumber={index + 1}
            width={size.width}
            height={size.height}
            scale={scale}
            scrollRoot={scrollEl}
            hits={byPage.get(index + 1) ?? EMPTY_HITS}
            currentHit={current}
          />
        ))}
      </div>
    </div>
  );
}

const EMPTY_HITS: SearchHit[] = [];

// ---------------------------------------------------------------------------
// Modos de una y de dos páginas
// ---------------------------------------------------------------------------

function PagedView({
  tab,
  scale,
  viewMode,
}: {
  tab: DocTab;
  scale: number;
  viewMode: 'single' | 'double';
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const { byPage, current } = useHitsByPage(tab);
  const visiblePages = pagesInView(tab.page, tab.numPages, viewMode);
  const firstVisible = visiblePages[0] ?? 1;

  // Al cambiar de página se vuelve al principio; si hay una petición con altura (búsqueda), se baja hasta ella.
  const request = tab.scrollRequest;
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    if (request && request.y !== undefined && visiblePages.includes(request.page)) {
      element.scrollTop = Math.max(0, request.y * scale - element.clientHeight * 0.35);
    } else {
      element.scrollTop = 0;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firstVisible, request?.nonce]);

  return (
    <div
      ref={scrollRef}
      tabIndex={0}
      role="document"
      aria-label={tab.name}
      className="h-full overflow-auto bg-viewer outline-none"
    >
      <div
        className="flex min-h-full min-w-full items-center justify-center"
        style={{
          width: 'max-content',
          padding: VIEW_PADDING,
          gap: PAGE_GAP,
          boxSizing: 'border-box',
        }}
      >
        {visiblePages.map((pageNumber) => {
          const size = tab.sizes[pageNumber - 1];
          if (!size) return null;
          return (
            <PageView
              key={pageNumber}
              doc={tab.doc}
              pageNumber={pageNumber}
              width={size.width}
              height={size.height}
              scale={scale}
              eager
              hits={byPage.get(pageNumber) ?? EMPTY_HITS}
              currentHit={current}
            />
          );
        })}
      </div>
    </div>
  );
}
