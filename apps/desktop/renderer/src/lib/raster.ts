import type { IPdfDocument, PageSize } from '@foliux-pdf/core';

/** Máximo de píxeles de una imagen de página (por encima, el navegador falla o se queda sin memoria). */
const MAX_PIXELS = 36_000_000;

/** Dibuja una página a la resolución pedida (en puntos por pulgada), sin pasar del máximo de píxeles. */
export async function renderPageCanvas(
  doc: IPdfDocument,
  pageNumber: number,
  size: PageSize,
  dpi: number,
  signal?: AbortSignal,
): Promise<{ canvas: HTMLCanvasElement; pixelsPerUnit: number }> {
  const scale = Math.min(dpi / 72, Math.sqrt(MAX_PIXELS / (size.width * size.height)));
  const canvas = await doc.renderPage(pageNumber, { scale, outputScale: 1, signal });
  return { canvas, pixelsPerUnit: canvas.width / size.width };
}

export function canvasToBytes(
  canvas: HTMLCanvasElement,
  format: 'png' | 'jpeg',
  quality = 0.9,
): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) return reject(new Error('No se pudo generar la imagen de la página.'));
        void blob.arrayBuffer().then((buffer) => resolve(new Uint8Array(buffer)));
      },
      format === 'png' ? 'image/png' : 'image/jpeg',
      quality,
    );
  });
}

/** Cede el hilo para que la interfaz pinte el avance entre trabajos pesados. */
export const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
