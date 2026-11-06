import { memo, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  NOTE_SIZE,
  annotationAt,
  annotationBounds,
  isTextMarkup,
  rectFromPoints,
  type Annotation,
  type AnnotationOf,
  type AnnotationPoint,
  type FontFamily,
  type Rect,
} from '@foliux-pdf/core';
import { useDocs } from '@/store/docs';
import { useUi, type Tool } from '@/store/ui';
import {
  addAnnotations,
  createAnnotation,
  createTextItem,
  finishTextEdit,
  moveAnnotation,
  placeImage,
  selectAnnotation,
} from '@/lib/edit';
import { placeSignature } from '@/lib/signing';
import { clamp } from '@/lib/utils';

interface AnnotationLayerProps {
  tabId: string;
  pageNumber: number;
  /** Tamaño de la página en unidades PDF. */
  width: number;
  height: number;
  /** Píxeles CSS por unidad PDF. */
  scale: number;
  /** Anotaciones de esta página. */
  annotations: Annotation[];
}

/** Herramientas que se usan arrastrando o pulsando sobre la página (no sobre texto seleccionado). */
const DRAW_TOOLS: ReadonlySet<Tool> = new Set([
  'ink',
  'rect',
  'ellipse',
  'line',
  'arrow',
  'note',
  'freetext',
  'text',
  'image',
  'redact',
  'field',
  'signature',
]);

/** Fuentes del navegador que se parecen a las 14 estándar de PDF (así lo que se ve es lo que se guarda). */
const FONT_CSS: Record<FontFamily, string> = {
  sans: 'Helvetica, Arial, sans-serif',
  serif: '"Times New Roman", Times, serif',
  mono: '"Courier New", Courier, monospace',
};

const inRect = (p: AnnotationPoint, r: Rect) =>
  p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height;

/** Estilo CSS de un texto permanente (el cuadro de texto de PDF.js se parece lo bastante a lo que se escribirá). */
function permanentTextStyle(a: AnnotationOf<'text'>, scale: number): React.CSSProperties {
  return {
    fontSize: a.fontSize * scale,
    fontFamily: FONT_CSS[a.font],
    fontWeight: a.bold ? 700 : 400,
    fontStyle: a.italic ? 'italic' : 'normal',
    textAlign: a.align,
    color: a.color,
    backgroundColor: a.background ?? undefined,
    opacity: a.opacity,
    transform: a.angle ? `rotate(${a.angle}deg)` : undefined,
    whiteSpace: a.nowrap ? 'pre' : 'pre-wrap',
    overflow: a.nowrap ? 'visible' : 'hidden',
  };
}

/**
 * Color de fondo alrededor de un fragmento de texto, leído de la página dibujada: se toman cuatro
 * muestras justo fuera del fragmento y se usa la mediana de cada canal (robusta si una cae sobre una línea).
 */
function sampleBackground(host: HTMLElement, fragment: DOMRect, page: DOMRect): string {
  const canvas = host.querySelector('canvas');
  const context = canvas?.getContext('2d');
  if (!canvas || !context) return '#ffffff';
  const sx = canvas.width / page.width;
  const sy = canvas.height / page.height;
  const points = [
    [fragment.left - 3, fragment.top + fragment.height / 2],
    [fragment.right + 3, fragment.top + fragment.height / 2],
    [fragment.left + fragment.width / 2, fragment.top - 3],
    [fragment.left + fragment.width / 2, fragment.bottom + 3],
  ] as const;
  const samples: number[][] = [];
  for (const [x, y] of points) {
    const px = Math.round((x - page.left) * sx);
    const py = Math.round((y - page.top) * sy);
    if (px < 0 || py < 0 || px >= canvas.width || py >= canvas.height) continue;
    const data = context.getImageData(px, py, 1, 1).data;
    samples.push([data[0] ?? 255, data[1] ?? 255, data[2] ?? 255]);
  }
  if (samples.length === 0) return '#ffffff';
  const median = (channel: number) => {
    const sorted = samples.map((sample) => sample[channel] ?? 255).sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)] ?? 255;
  };
  return `#${[0, 1, 2].map((c) => median(c).toString(16).padStart(2, '0')).join('')}`;
}

const SELECTION_COLOR = '#2563eb';
const DEFAULT_TEXT_BOX = { width: 160, height: 40 };

/**
 * Dibuja las anotaciones de una página y recibe la interacción: crear (dibujar), seleccionar,
 * mover y editar el texto. Las coordenadas son unidades PDF; el SVG las escala al zoom actual.
 */
export const AnnotationLayer = memo(function AnnotationLayer({
  tabId,
  pageNumber,
  width,
  height,
  scale,
  annotations,
}: AnnotationLayerProps) {
  const tool = useUi((s) => s.tool);
  const editingId = useUi((s) => s.editingAnnotationId);
  const selectedId = useDocs(
    (s) => s.tabs.find((t) => t.id === tabId)?.selectedAnnotationId ?? null,
  );

  const rootRef = useRef<HTMLDivElement>(null);
  const latest = useRef({ annotations, width, tabId, pageNumber });
  latest.current = { annotations, width, tabId, pageNumber };

  const [draft, setDraft] = useState<Annotation | null>(null);
  /** Imágenes ya presentes en la página (solo con la herramienta de imagen, para poder reemplazarlas). */
  const [imageRects, setImageRects] = useState<Rect[]>([]);
  const [drag, setDrag] = useState<{ id: string; dx: number; dy: number } | null>(null);
  const gesture = useRef<{ start: AnnotationPoint; points: AnnotationPoint[] } | null>(null);
  const dragStart = useRef<{ id: string; start: AnnotationPoint } | null>(null);

  /** Posición del puntero en unidades PDF de esta página. */
  const toUnits = (event: { clientX: number; clientY: number }, clampToPage = false) => {
    const box = rootRef.current?.getBoundingClientRect();
    if (!box || box.width === 0) return { x: 0, y: 0 };
    const k = box.width / width;
    const x = (event.clientX - box.left) / k;
    const y = (event.clientY - box.top) / k;
    return clampToPage ? { x: clamp(x, 0, width), y: clamp(y, 0, height) } : { x, y };
  };

  // Seleccionar al pulsar (resaltados, subrayados y figuras huecas no interceptan el ratón para no
  // impedir seleccionar el texto de debajo, así que se localizan por geometría) y editar al hacer doble clic.
  useEffect(() => {
    const host = rootRef.current?.parentElement;
    if (!host) return;

    const locate = (event: MouseEvent): Annotation | undefined => {
      const box = host.getBoundingClientRect();
      const k = box.width / latest.current.width;
      const point = { x: (event.clientX - box.left) / k, y: (event.clientY - box.top) / k };
      return annotationAt(latest.current.annotations, latest.current.pageNumber, point, 5 / k);
    };
    const ignore = (event: MouseEvent) =>
      useUi.getState().tool !== 'select' || (event.target as HTMLElement).closest('textarea');

    // «Editar texto»: al pulsar un fragmento del texto original se crea un cuadro que lo cubre y se abre para escribir.
    const editTextAt = (event: MouseEvent) => {
      const span = (event.target as Element).closest<HTMLElement>('.textLayer span');
      const original = span?.textContent ?? '';
      if (!span || original.trim() === '') return;
      const page = host.getBoundingClientRect();
      const k = page.width / latest.current.width;
      const box = span.getBoundingClientRect();
      const style = getComputedStyle(span);
      const family = style.fontFamily.toLowerCase();
      const font: FontFamily = family.includes('mono')
        ? 'mono'
        : family.includes('serif') && !family.includes('sans')
          ? 'serif'
          : 'sans';
      const item = createTextItem(
        latest.current.pageNumber,
        {
          x: (box.left - page.left) / k - 2,
          y: (box.top - page.top) / k - 2,
          width: box.width / k + 4,
          height: box.height / k + 4,
        },
        {
          text: original,
          fontSize: Math.round((Number.parseFloat(style.fontSize) / k) * 10) / 10,
          font,
          nowrap: true,
          background: sampleBackground(host, box, page),
          color: '#000000',
        },
      );
      addAnnotations(latest.current.tabId, [item]);
      // Primero se cambia de herramienta (eso cierra cualquier edición) y después se abre el editor.
      useUi.getState().setTool('select');
      useUi.getState().setEditingAnnotation(item.id);
    };

    const onClick = (event: MouseEvent) => {
      if (useUi.getState().tool === 'edittext') {
        editTextAt(event);
        return;
      }
      if (ignore(event)) return;
      // Un clic que termina una selección de texto no deselecciona la anotación.
      if (window.getSelection()?.isCollapsed === false) return;
      selectAnnotation(latest.current.tabId, locate(event)?.id ?? null);
    };
    const onDoubleClick = (event: MouseEvent) => {
      if (ignore(event)) return;
      const hit = locate(event);
      if (
        hit &&
        (isTextMarkup(hit) || hit.kind === 'note' || hit.kind === 'freetext' || hit.kind === 'text')
      ) {
        selectAnnotation(latest.current.tabId, hit.id);
        useUi.getState().setEditingAnnotation(hit.id);
      }
    };
    host.addEventListener('click', onClick);
    host.addEventListener('dblclick', onDoubleClick);
    return () => {
      host.removeEventListener('click', onClick);
      host.removeEventListener('dblclick', onDoubleClick);
    };
  }, []);

  useEffect(() => {
    if (tool !== 'image') {
      setImageRects([]);
      return;
    }
    let cancelled = false;
    const doc = useDocs.getState().tabs.find((t) => t.id === tabId)?.doc;
    doc
      ?.getImageRects(pageNumber)
      .then((rects) => !cancelled && setImageRects(rects))
      .catch(() => !cancelled && setImageRects([]));
    return () => {
      cancelled = true;
    };
  }, [tool, tabId, pageNumber]);

  // --- Crear anotaciones dibujando ---------------------------------------------------------

  const buildDraft = (
    kind: Tool,
    start: AnnotationPoint,
    current: AnnotationPoint,
    points: AnnotationPoint[],
  ): Annotation | null => {
    switch (kind) {
      case 'ink':
        return createAnnotation('ink', pageNumber, { strokes: [points] });
      case 'rect':
      case 'ellipse':
        return createAnnotation(kind, pageNumber, { rect: rectFromPoints(start, current) });
      case 'line':
      case 'arrow':
        return createAnnotation(kind, pageNumber, { from: start, to: current });
      case 'freetext':
        return createAnnotation('freetext', pageNumber, {
          rect: rectFromPoints(start, current),
          fontSize: 12,
        });
      case 'text':
        return createTextItem(pageNumber, rectFromPoints(start, current));
      case 'redact':
        return createAnnotation('redact', pageNumber, { rect: rectFromPoints(start, current) });
      case 'field':
        // Solo es la silueta mientras se dibuja; el campo real lo crea el diálogo.
        return createAnnotation('rect', pageNumber, { rect: rectFromPoints(start, current) });
      default:
        return null;
    }
  };

  const onDrawDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const point = toUnits(event, true);

    if (tool === 'note') {
      const note = createAnnotation('note', pageNumber, {
        at: { x: clamp(point.x, 0, width - NOTE_SIZE), y: clamp(point.y, 0, height - NOTE_SIZE) },
      });
      addAnnotations(tabId, [note]);
      // Primero se cambia de herramienta (eso cierra cualquier edición) y después se abre el editor.
      useUi.getState().setTool('select');
      useUi.getState().setEditingAnnotation(note.id);
      return;
    }
    if (tool === 'signature') {
      placeSignature(tabId, pageNumber, point);
      return;
    }
    if (tool === 'image') {
      // Sobre una imagen existente la reemplaza; en otro sitio, añade una nueva en ese punto.
      const hit = imageRects
        .filter((rect) => inRect(point, rect))
        .sort((a, b) => a.width * a.height - b.width * b.height)[0];
      void placeImage(tabId, pageNumber, hit ? { replace: hit } : { at: point, pageWidth: width });
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    gesture.current = { start: point, points: [point] };
    setDraft(buildDraft(tool, point, point, [point]));
  };

  const onDrawMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const current = gesture.current;
    if (!current) return;
    const point = toUnits(event, true);
    if (tool === 'ink') {
      const last = current.points[current.points.length - 1];
      if (last && Math.hypot(point.x - last.x, point.y - last.y) < 0.6) return;
      current.points.push(point);
    }
    setDraft(buildDraft(tool, current.start, point, current.points));
  };

  const onDrawUp = (event: React.PointerEvent<HTMLDivElement>) => {
    const current = gesture.current;
    gesture.current = null;
    setDraft(null);
    if (!current) return;
    const end = toUnits(event, true);
    const moved = Math.hypot(end.x - current.start.x, end.y - current.start.y);

    if (tool === 'ink') {
      const final = buildDraft('ink', current.start, end, current.points);
      if (final) addAnnotations(tabId, [final]);
      return;
    }
    if (tool === 'freetext' || tool === 'text') {
      // Un simple clic crea un cuadro de tamaño estándar.
      const rect =
        moved < 6
          ? {
              x: clamp(current.start.x, 0, width - DEFAULT_TEXT_BOX.width),
              y: clamp(current.start.y, 0, height - DEFAULT_TEXT_BOX.height),
              ...DEFAULT_TEXT_BOX,
            }
          : rectFromPoints(current.start, end);
      const box =
        tool === 'text'
          ? createTextItem(pageNumber, rect)
          : createAnnotation('freetext', pageNumber, { rect, fontSize: 12 });
      addAnnotations(tabId, [box]);
      useUi.getState().setTool('select');
      useUi.getState().setEditingAnnotation(box.id);
      return;
    }
    if (tool === 'field') {
      if (moved < 6) return;
      useUi.getState().setTool('select');
      useUi
        .getState()
        .setFieldDraft({ page: pageNumber, rect: rectFromPoints(current.start, end) });
      useUi.getState().setToolDialog('field');
      return;
    }
    // Una figura sin tamaño (clic suelto) se descarta.
    if (moved < 3) return;
    const final = buildDraft(tool, current.start, end, current.points);
    if (final) addAnnotations(tabId, [final]);
  };

  // --- Mover anotaciones ---------------------------------------------------------------------

  const onShapeDown = (annotation: Annotation) => (event: React.PointerEvent) => {
    if (tool !== 'select' || event.button !== 0) return;
    event.stopPropagation();
    selectAnnotation(tabId, annotation.id);
    dragStart.current = { id: annotation.id, start: toUnits(event) };
    (event.currentTarget as Element).setPointerCapture(event.pointerId);
  };
  const onShapeMove = (event: React.PointerEvent) => {
    const current = dragStart.current;
    if (!current) return;
    const point = toUnits(event);
    setDrag({ id: current.id, dx: point.x - current.start.x, dy: point.y - current.start.y });
  };
  const onShapeUp = (event: React.PointerEvent) => {
    const current = dragStart.current;
    dragStart.current = null;
    setDrag(null);
    if (!current) return;
    const point = toUnits(event);
    const dx = point.x - current.start.x;
    const dy = point.y - current.start.y;
    if (Math.hypot(dx, dy) > 0.5) moveAnnotation(tabId, current.id, dx, dy);
  };
  const shapeEvents = (annotation: Annotation) => ({
    onPointerDown: onShapeDown(annotation),
    onPointerMove: onShapeMove,
    onPointerUp: onShapeUp,
    onPointerCancel: onShapeUp,
  });

  // --- Dibujo ----------------------------------------------------------------------------------

  const shown = draft ? [...annotations, draft] : annotations;
  const highlights = shown.filter((a) => a.kind === 'highlight');
  const others = shown.filter((a) => a.kind !== 'highlight');
  const editing = editingId ? annotations.find((a) => a.id === editingId) : undefined;
  const selected = selectedId ? annotations.find((a) => a.id === selectedId) : undefined;
  const offsetOf = (a: Annotation) => (drag && drag.id === a.id ? drag : null);

  return (
    <div ref={rootRef} className="absolute inset-0" data-annotation-layer>
      {/* Los resaltados se mezclan con la página (multiplicar), como un rotulador de verdad. */}
      <svg
        aria-hidden
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        className="pointer-events-none absolute inset-0 z-[1] h-full w-full mix-blend-multiply"
      >
        {highlights.map((a) =>
          a.kind === 'highlight'
            ? a.rects.map((r, i) => (
                <rect
                  key={`${a.id}-${i}`}
                  x={r.x}
                  y={r.y}
                  width={r.width}
                  height={r.height}
                  fill={a.color}
                  fillOpacity={a.opacity}
                />
              ))
            : null,
        )}
      </svg>

      <svg
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        role="group"
        aria-label={`Anotaciones de la página ${pageNumber}`}
        className="pointer-events-none absolute inset-0 z-[3] h-full w-full"
      >
        {others.map((a) => {
          const offset = offsetOf(a);
          return (
            <g
              key={a.id}
              transform={offset ? `translate(${offset.dx} ${offset.dy})` : undefined}
              opacity={a.id === draft?.id ? 0.85 : undefined}
            >
              <Shape annotation={a} events={shapeEvents(a)} />
            </g>
          );
        })}
        {selected && selected.kind !== 'freetext' && selected.kind !== 'text' ? (
          <SelectionBox annotation={selected} scale={scale} offset={offsetOf(selected)} />
        ) : null}
      </svg>

      {/* Cuadros de texto (HTML para que el texto se ajuste y se pueda editar) */}
      <div className="pointer-events-none absolute inset-0 z-[3]">
        {shown
          .filter((a) => a.kind === 'freetext' || a.kind === 'text')
          .map((a) => {
            if (a.kind !== 'freetext' && a.kind !== 'text') return null;
            const offset = offsetOf(a);
            const isSelected = a.id === selectedId;
            return (
              <div
                key={a.id}
                {...shapeEvents(a)}
                className="pointer-events-auto absolute"
                style={{
                  left: (a.rect.x + (offset?.dx ?? 0)) * scale,
                  top: (a.rect.y + (offset?.dy ?? 0)) * scale,
                  width: a.rect.width * scale,
                  height: a.rect.height * scale,
                  padding: 2 * scale,
                  fontSize: a.fontSize * scale,
                  lineHeight: 1.2,
                  color: a.color,
                  fontFamily: 'Helvetica, Arial, sans-serif',
                  overflowWrap: 'anywhere',
                  ...(a.kind === 'text' ? permanentTextStyle(a, scale) : {}),
                  cursor: tool === 'select' ? 'move' : undefined,
                  outline:
                    isSelected || a.id === draft?.id
                      ? `1.5px dashed ${SELECTION_COLOR}`
                      : undefined,
                  visibility: a.id === editingId ? 'hidden' : undefined,
                  ...(a.kind === 'freetext'
                    ? { overflow: 'hidden', whiteSpace: 'pre-wrap' as const }
                    : {}),
                }}
              >
                {a.text}
              </div>
            );
          })}
      </div>

      {/* Captura del ratón para las herramientas de dibujo */}
      {DRAW_TOOLS.has(tool) && (
        <div
          className="absolute inset-0 z-[4] cursor-crosshair touch-none"
          onPointerDown={onDrawDown}
          onPointerMove={onDrawMove}
          onPointerUp={onDrawUp}
          onPointerCancel={onDrawUp}
        >
          {imageRects.map((rect, index) => (
            <div
              key={index}
              aria-hidden
              data-image-rect
              className="pointer-events-none absolute border-2 border-dashed border-blue-600 bg-blue-500/10"
              style={{
                left: rect.x * scale,
                top: rect.y * scale,
                width: rect.width * scale,
                height: rect.height * scale,
              }}
            />
          ))}
        </div>
      )}

      {editing ? (
        <TextEditor
          key={editing.id}
          annotation={editing}
          scale={scale}
          pageWidth={width}
          pageHeight={height}
          onDone={(text) => finishTextEdit(tabId, editing.id, text)}
        />
      ) : null}
    </div>
  );
});

// ---------------------------------------------------------------------------

interface ShapeEvents {
  onPointerDown: (event: React.PointerEvent) => void;
  onPointerMove: (event: React.PointerEvent) => void;
  onPointerUp: (event: React.PointerEvent) => void;
  onPointerCancel: (event: React.PointerEvent) => void;
}

/** Una anotación en SVG. Solo el trazo (o el icono) recibe el ratón, para no tapar el texto de debajo. */
function Shape({ annotation: a, events }: { annotation: Annotation; events: ShapeEvents }) {
  const tool = useUi((s) => s.tool);
  const interactive = tool === 'select';
  const hit = {
    ...events,
    style: { pointerEvents: interactive ? ('stroke' as const) : ('none' as const), cursor: 'move' },
  };

  switch (a.kind) {
    case 'highlight':
      return null;

    case 'underline':
    case 'strikeout':
      return (
        <g stroke={a.color} strokeWidth={1.2} opacity={a.opacity}>
          {a.rects.map((r, i) => {
            const y = a.kind === 'underline' ? r.y + r.height - 1 : r.y + r.height * 0.55;
            return <line key={i} x1={r.x} x2={r.x + r.width} y1={y} y2={y} />;
          })}
        </g>
      );

    case 'ink': {
      const path = a.strokes
        .map((stroke) =>
          stroke.length === 1
            ? `M${stroke[0]!.x} ${stroke[0]!.y}l0.01 0`
            : `M${stroke.map((p) => `${p.x} ${p.y}`).join('L')}`,
        )
        .join('');
      return (
        <g>
          <path
            d={path}
            fill="none"
            stroke={a.color}
            strokeWidth={a.strokeWidth}
            strokeLinecap="round"
            strokeLinejoin="round"
            opacity={a.opacity}
          />
          <path
            d={path}
            fill="none"
            stroke="transparent"
            strokeWidth={Math.max(a.strokeWidth, 8)}
            strokeLinecap="round"
            {...hit}
          />
        </g>
      );
    }

    case 'rect':
      return (
        <rect
          x={a.rect.x}
          y={a.rect.y}
          width={a.rect.width}
          height={a.rect.height}
          fill="none"
          stroke={a.color}
          strokeWidth={a.strokeWidth}
          opacity={a.opacity}
          {...hit}
          // El borde fino es difícil de pulsar: se ensancha el área sensible sin cambiar el dibujo.
          style={{ ...hit.style, strokeLinejoin: 'miter' }}
        />
      );

    case 'ellipse':
      return (
        <ellipse
          cx={a.rect.x + a.rect.width / 2}
          cy={a.rect.y + a.rect.height / 2}
          rx={a.rect.width / 2}
          ry={a.rect.height / 2}
          fill="none"
          stroke={a.color}
          strokeWidth={a.strokeWidth}
          opacity={a.opacity}
          {...hit}
        />
      );

    case 'line':
    case 'arrow': {
      const dx = a.to.x - a.from.x;
      const dy = a.to.y - a.from.y;
      const length = Math.hypot(dx, dy) || 1;
      const ux = dx / length;
      const uy = dy / length;
      const head = Math.min(length, Math.max(8, a.strokeWidth * 4));
      const angle = (28 * Math.PI) / 180;
      const wing = (sign: number) => ({
        x: a.to.x - head * (ux * Math.cos(angle * sign) - uy * Math.sin(angle * sign)),
        y: a.to.y - head * (ux * Math.sin(angle * sign) + uy * Math.cos(angle * sign)),
      });
      const left = wing(1);
      const right = wing(-1);
      const base =
        a.kind === 'arrow' ? { x: a.to.x - ux * head * 0.8, y: a.to.y - uy * head * 0.8 } : a.to;
      return (
        <g opacity={a.opacity}>
          <line
            x1={a.from.x}
            y1={a.from.y}
            x2={base.x}
            y2={base.y}
            stroke={a.color}
            strokeWidth={a.strokeWidth}
            strokeLinecap="round"
          />
          {a.kind === 'arrow' && (
            <polygon
              points={`${a.to.x},${a.to.y} ${left.x},${left.y} ${right.x},${right.y}`}
              fill={a.color}
              stroke={a.color}
              strokeWidth={a.strokeWidth / 2}
              strokeLinejoin="round"
            />
          )}
          <line
            x1={a.from.x}
            y1={a.from.y}
            x2={a.to.x}
            y2={a.to.y}
            stroke="transparent"
            strokeWidth={Math.max(a.strokeWidth, 8)}
            {...hit}
          />
        </g>
      );
    }

    case 'note': {
      const { x, y } = a.at;
      const s = NOTE_SIZE;
      return (
        <g {...events} style={{ pointerEvents: interactive ? 'all' : 'none', cursor: 'move' }}>
          <title>{a.text}</title>
          <rect
            x={x + 0.5}
            y={y + 0.5}
            width={s - 1}
            height={s - 1}
            rx={2}
            fill={a.color}
            stroke="#404040"
          />
          {[0, 1, 2].map((i) => (
            <line
              key={i}
              x1={x + s * 0.22}
              x2={x + s * 0.78}
              y1={y + s * (0.3 + i * 0.2)}
              y2={y + s * (0.3 + i * 0.2)}
              stroke="#404040"
            />
          ))}
        </g>
      );
    }

    case 'redact':
      return (
        <rect
          x={a.rect.x}
          y={a.rect.y}
          width={a.rect.width}
          height={a.rect.height}
          fill={a.color}
          fillOpacity={0.3}
          stroke={a.color}
          strokeWidth={1.5}
          strokeDasharray="5 3"
          {...events}
          style={{ pointerEvents: interactive ? 'all' : 'none', cursor: 'move' }}
        />
      );

    case 'image':
      return (
        <image
          href={a.src}
          x={a.rect.x}
          y={a.rect.y}
          width={a.rect.width}
          height={a.rect.height}
          preserveAspectRatio="none"
          opacity={a.opacity}
          {...events}
          style={{ pointerEvents: interactive ? 'all' : 'none', cursor: 'move' }}
        />
      );

    case 'freetext':
    case 'text':
      // Se dibujan en HTML (ver más arriba).
      return null;
  }
}

/** Contorno punteado de la anotación seleccionada (grosor constante en pantalla). */
function SelectionBox({
  annotation,
  scale,
  offset,
}: {
  annotation: Annotation;
  scale: number;
  offset: { dx: number; dy: number } | null;
}) {
  const b = annotationBounds(annotation);
  return (
    <rect
      x={b.x + (offset?.dx ?? 0) - 2 / scale}
      y={b.y + (offset?.dy ?? 0) - 2 / scale}
      width={b.width + 4 / scale}
      height={b.height + 4 / scale}
      fill="none"
      stroke={SELECTION_COLOR}
      strokeWidth={1.5 / scale}
      strokeDasharray={`${4 / scale} ${3 / scale}`}
      pointerEvents="none"
    />
  );
}

// ---------------------------------------------------------------------------

/** Cuadro para escribir el texto de una nota, un comentario o un cuadro de texto. */
function TextEditor({
  annotation,
  scale,
  pageWidth,
  pageHeight,
  onDone,
}: {
  annotation: Annotation;
  scale: number;
  pageWidth: number;
  pageHeight: number;
  onDone: (text: string | null) => void;
}) {
  const { t } = useTranslation();
  const [value, setValue] = useState(annotation.text);
  const ref = useRef<HTMLTextAreaElement>(null);
  const finished = useRef(false);

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  const finish = (text: string | null) => {
    if (finished.current) return;
    finished.current = true;
    onDone(text);
  };

  const b = annotationBounds(annotation);
  const isFree = annotation.kind === 'freetext' || annotation.kind === 'text';
  const style: React.CSSProperties = isFree
    ? {
        left: b.x * scale,
        top: b.y * scale,
        // Un texto de una sola línea (reemplazo) puede crecer más allá del cuadro original al escribir.
        width: annotation.kind === 'text' && annotation.nowrap ? undefined : b.width * scale,
        minWidth: b.width * scale,
        height: b.height * scale,
        padding: 2 * scale,
        fontSize: annotation.fontSize * scale,
        lineHeight: 1.2,
        color: annotation.color,
        fontFamily:
          annotation.kind === 'text' ? FONT_CSS[annotation.font] : 'Helvetica, Arial, sans-serif',
        fontWeight: annotation.kind === 'text' && annotation.bold ? 700 : 400,
        fontStyle: annotation.kind === 'text' && annotation.italic ? 'italic' : 'normal',
        textAlign: annotation.kind === 'text' ? annotation.align : undefined,
        whiteSpace: annotation.kind === 'text' && annotation.nowrap ? 'pre' : undefined,
      }
    : {
        left: clamp(b.x * scale, 0, Math.max(0, pageWidth * scale - 248)),
        top: clamp((b.y + b.height) * scale + 6, 0, Math.max(0, pageHeight * scale - 110)),
        width: 240,
        height: 96,
      };

  return (
    <textarea
      ref={ref}
      value={value}
      onChange={(event) => setValue(event.target.value)}
      onBlur={() => finish(value)}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === 'Escape') {
          event.preventDefault();
          finish(null);
        } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
          event.preventDefault();
          finish(value);
        }
      }}
      aria-label={isFree ? t('annotations.textBoxLabel') : t('annotations.commentLabel')}
      placeholder={
        isFree ? t('annotations.textBoxPlaceholder') : t('annotations.commentPlaceholder')
      }
      className={
        isFree
          ? 'absolute z-[5] resize-none border border-dashed border-blue-600 bg-white/80 outline-none'
          : 'absolute z-[5] resize-none rounded-md border border-border bg-popover p-2 text-sm text-popover-foreground shadow-lg outline-none focus:ring-2 focus:ring-ring'
      }
      style={style}
    />
  );
}
