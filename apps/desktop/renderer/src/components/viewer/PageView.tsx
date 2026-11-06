import { memo, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Annotation, IPdfDocument, SearchHit } from '@foliux-pdf/core';
import { cn, isAbortError } from '@/lib/utils';
import { notifyError } from '@/lib/notify';
import type { DiffMark } from '@/store/compare';
import { AnnotationLayer } from './AnnotationLayer';
import { FormLayer } from './FormLayer';

interface PageViewProps {
  tabId: string;
  doc: IPdfDocument;
  /** Anotaciones de esta página. */
  annotations: Annotation[];
  /** Diferencias con otra versión (comparación de documentos). */
  diff?: DiffMark[];
  currentChange?: number;
  pageNumber: number;
  /** Tamaño de la página en unidades PDF (a escala 1). */
  width: number;
  height: number;
  /** Píxeles CSS por unidad PDF. */
  scale: number;
  /** Elemento con scroll respecto al que se decide si la página es visible (modo continuo). */
  scrollRoot?: HTMLElement | null;
  /** Renderizar siempre (modos de una o dos páginas). */
  eager?: boolean;
  hits: SearchHit[];
  /** Coincidencia seleccionada, para resaltarla de otro color. */
  currentHit: SearchHit | null;
}

/**
 * Una página del documento. Mientras no está cerca de la pantalla solo ocupa su espacio (placeholder);
 * al acercarse se dibuja el canvas y la capa de texto, y al alejarse se liberan para ahorrar memoria.
 */
export const PageView = memo(function PageView({
  tabId,
  doc,
  annotations,
  diff,
  currentChange = -1,
  pageNumber,
  width,
  height,
  scale,
  scrollRoot,
  eager = false,
  hits,
  currentHit,
}: PageViewProps) {
  const { t } = useTranslation();
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasHost = useRef<HTMLDivElement>(null);
  const textHost = useRef<HTMLDivElement>(null);
  const hasRendered = useRef(false);
  const [visible, setVisible] = useState(eager);
  const [failed, setFailed] = useState(false);
  const [rendered, setRendered] = useState(false);

  const pixelWidth = Math.floor(width * scale);
  const pixelHeight = Math.floor(height * scale);

  // Visibilidad: se renderiza con un margen de ~1,5 pantallas para que el scroll no muestre huecos.
  useEffect(() => {
    if (eager) {
      setVisible(true);
      return;
    }
    const element = rootRef.current;
    if (!element) return;
    const observer = new IntersectionObserver(
      ([entry]) => setVisible(entry?.isIntersecting ?? false),
      {
        root: scrollRoot ?? null,
        rootMargin: '150% 0px',
      },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [eager, scrollRoot]);

  // Dibujo de la página (cancelable: si cambia el zoom o se aleja, se aborta el trabajo en curso).
  useEffect(() => {
    const canvasElement = canvasHost.current;
    const textElement = textHost.current;
    if (!canvasElement || !textElement) return;

    if (!visible) {
      canvasElement.replaceChildren();
      textElement.replaceChildren();
      hasRendered.current = false;
      setRendered(false);
      return;
    }

    const controller = new AbortController();
    // La primera vez se dibuja de inmediato; al cambiar el zoom se espera un instante para no
    // repintar en cada paso de la rueda del ratón (mientras tanto el canvas anterior se estira).
    const delay = hasRendered.current ? 90 : 0;
    const timer = window.setTimeout(() => {
      const options = { scale, signal: controller.signal };
      Promise.all([doc.renderPage(pageNumber, options), doc.renderTextLayer(pageNumber, options)])
        .then(([canvas, text]) => {
          canvas.style.width = '100%';
          canvas.style.height = '100%';
          canvas.style.display = 'block';
          canvasElement.replaceChildren(canvas);
          textElement.replaceChildren(text);
          hasRendered.current = true;
          setRendered(true);
          setFailed(false);
        })
        .catch((error: unknown) => {
          if (isAbortError(error)) return;
          setFailed(true);
          notifyError(t('errors.renderFailed'), error);
        });
    }, delay);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [doc, pageNumber, scale, visible, t]);

  return (
    <div
      ref={rootRef}
      data-page-number={pageNumber}
      className="pdf-page relative shrink-0 overflow-hidden bg-white shadow-[0_1px_3px_rgb(0_0_0/0.25),0_4px_14px_rgb(0_0_0/0.12)]"
      style={{ width: pixelWidth, height: pixelHeight }}
    >
      <div ref={canvasHost} className="absolute inset-0" />
      <div ref={textHost} className="absolute inset-0" />

      {/* Resaltado de las coincidencias de búsqueda */}
      {hits.map((hit) =>
        hit.rects.map((rect, i) => (
          <div
            key={`${hit.rects[0]?.x}-${hit.rects[0]?.y}-${i}`}
            aria-hidden
            className={cn(
              'pointer-events-none absolute z-[2] rounded-[2px] mix-blend-multiply',
              hit === currentHit ? 'bg-orange-400/60 ring-1 ring-orange-500' : 'bg-yellow-300/60',
            )}
            style={{
              left: rect.x * scale,
              top: rect.y * scale,
              width: rect.width * scale,
              height: rect.height * scale,
            }}
          />
        )),
      )}

      {/* Diferencias con la otra versión: rojo = eliminado, verde = añadido, ámbar = modificado */}
      {diff?.map((mark, i) => (
        <div
          key={`diff-${i}`}
          aria-hidden
          className={cn(
            'pointer-events-none absolute z-[2] rounded-[2px] mix-blend-multiply',
            mark.kind === 'removed' && 'bg-red-400/50',
            mark.kind === 'added' && 'bg-green-400/50',
            mark.kind === 'changed' && 'bg-amber-400/55',
            mark.change === currentChange && 'ring-2 ring-blue-600',
          )}
          style={{
            left: mark.rect.x * scale,
            top: mark.rect.y * scale,
            width: mark.rect.width * scale,
            height: mark.rect.height * scale,
          }}
        />
      ))}

      <AnnotationLayer
        tabId={tabId}
        pageNumber={pageNumber}
        width={width}
        height={height}
        scale={scale}
        annotations={annotations}
      />

      <FormLayer tabId={tabId} pageNumber={pageNumber} scale={scale} />

      {!rendered && !failed ? (
        <div className="absolute inset-0 flex items-center justify-center text-sm text-neutral-400">
          {t('page.placeholder', { page: pageNumber })}
        </div>
      ) : null}
      {failed ? (
        <div className="absolute inset-0 flex items-center justify-center text-sm text-red-600">
          {t('errors.renderFailed')}
        </div>
      ) : null}
    </div>
  );
});
