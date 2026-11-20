import { toast } from 'sonner';
import i18n from '@/i18n';
import { useUi } from '@/store/ui';

/** Sellos, fecha e iniciales: se dibujan como imagen y se colocan igual que una firma (clic en la página). */

export const STAMPS = [
  { id: 'approved', color: '#2f9e44' },
  { id: 'rejected', color: '#e03131' },
  { id: 'draft', color: '#1971c2' },
  { id: 'confidential', color: '#c2255c' },
  { id: 'reviewed', color: '#7048e8' },
  { id: 'urgent', color: '#e8590c' },
  { id: 'copy', color: '#495057' },
] as const;
export type StampId = (typeof STAMPS)[number]['id'];

export const INITIALS_STYLES = [
  { id: 'script', font: 'italic 90px "Brush Script MT", "Segoe Script", cursive' },
  { id: 'serif', font: 'italic 80px "Times New Roman", Times, serif' },
  { id: 'sans', font: 'bold 80px Arial, Helvetica, sans-serif' },
] as const;
export type InitialsStyleId = (typeof INITIALS_STYLES)[number]['id'];

export interface RenderedImage {
  src: string;
  /** ancho / alto */
  ratio: number;
}

function newCanvas(width: number, height: number): CanvasRenderingContext2D {
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(width);
  canvas.height = Math.ceil(height);
  const context = canvas.getContext('2d');
  if (!context) throw new Error(i18n.t('errors.imageFailed'));
  return context;
}

const done = (context: CanvasRenderingContext2D): RenderedImage => ({
  src: context.canvas.toDataURL('image/png'),
  ratio: context.canvas.width / context.canvas.height,
});

/** Sello rectangular con borde y texto en mayúsculas, como los de goma. */
export function renderStamp(text: string, color: string): RenderedImage {
  const font = 'bold 72px Arial, Helvetica, sans-serif';
  const measure = newCanvas(10, 10);
  measure.font = font;
  const textWidth = measure.measureText(text).width;
  const padX = 44;
  const padY = 30;
  const border = 9;
  const width = textWidth + padX * 2 + border * 2;
  const height = 72 + padY * 2 + border * 2;
  const context = newCanvas(width, height);
  context.strokeStyle = color;
  context.fillStyle = color;
  context.lineWidth = border;
  context.beginPath();
  context.roundRect(border / 2, border / 2, width - border, height - border, 22);
  context.stroke();
  context.font = font;
  context.textBaseline = 'middle';
  context.textAlign = 'center';
  context.fillText(text, width / 2, height / 2 + 3);
  return done(context);
}

/** Texto suelto (fecha, iniciales) sobre fondo transparente. */
export function renderText(text: string, font: string, color: string): RenderedImage {
  const measure = newCanvas(10, 10);
  measure.font = font;
  const metrics = measure.measureText(text);
  const size = Number(/(\d+)px/.exec(font)?.[1] ?? 72);
  const width = metrics.width + size * 0.4;
  const height = size * 1.5;
  const context = newCanvas(width, height);
  context.font = font;
  context.fillStyle = color;
  context.textBaseline = 'middle';
  context.textAlign = 'center';
  context.fillText(text, width / 2, height / 2);
  return done(context);
}

export const todayText = (date = new Date()): string =>
  date.toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric' });

/**
 * Deja la imagen lista para colocarla con un clic en la página (como la firma visual).
 * `width` es el ancho inicial en unidades PDF; luego se puede mover y cambiar de tamaño.
 */
export function armImage(image: RenderedImage, name: string, width: number, audit = false): void {
  useUi.getState().setPendingSignature({
    src: image.src,
    format: 'png',
    ratio: image.ratio,
    name,
    width,
    silent: !audit,
  });
  useUi.getState().setTool('signature');
  toast(i18n.t('stamps.placeHint'), { id: 'stamp-hint' });
}

export function armStamp(id: StampId): void {
  const stamp = STAMPS.find((s) => s.id === id);
  if (!stamp) return;
  const label = i18n.t(`stamps.names.${id}`).toUpperCase();
  armImage(renderStamp(label, stamp.color), label, 130);
}

export function armDate(): void {
  const text = todayText();
  armImage(renderText(text, 'bold 64px Arial, Helvetica, sans-serif', '#212529'), text, 80);
}

const INITIALS_KEY = 'foliux-initials';
export function loadInitials(): string {
  try {
    return window.localStorage.getItem(INITIALS_KEY) ?? '';
  } catch {
    return '';
  }
}
export function saveInitials(value: string): void {
  try {
    window.localStorage.setItem(INITIALS_KEY, value);
  } catch {
    // Sin almacenamiento disponible: simplemente no se recuerda.
  }
}

export function armInitials(text: string, style: InitialsStyleId): void {
  const found = INITIALS_STYLES.find((s) => s.id === style) ?? INITIALS_STYLES[0];
  armImage(renderText(text, found.font, '#1f2a44'), text, 60, true);
}
