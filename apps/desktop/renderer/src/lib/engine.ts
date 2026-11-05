import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { createPdfJsEngine } from '@foliux-pdf/services/pdf';

// PDF.js trabaja en un Worker propio para no bloquear la interfaz.
pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

/**
 * Motor PDF de la aplicación. El resto del código solo conoce la interfaz IPdfEngine,
 * así que cambiar de librería es cuestión de sustituir esta línea.
 * Los recursos de PDF.js (fuentes, CMaps, WASM) se sirven desde la propia aplicación (ver copy-pdfjs-assets).
 */
export const pdfEngine = createPdfJsEngine({
  pdfjs,
  assetsBaseUrl: new URL('./pdfjs/', document.baseURI).href,
});
