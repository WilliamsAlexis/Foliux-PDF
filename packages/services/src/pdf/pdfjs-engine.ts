import type * as PdfJs from 'pdfjs-dist';
import { FoliuxError } from '@foliux-pdf/core';
import type {
  IPdfDocument,
  IPdfEngine,
  LoadPdfOptions,
  OutlineItem,
  PageSize,
  PageWord,
  PdfMetadata,
  Rect,
  RenderPageOptions,
  SearchHit,
  SearchOptions,
} from '@foliux-pdf/core';
import { buildContext, findMatches } from './text-search';

type PdfJsModule = typeof PdfJs;
type PDFDocumentProxy = PdfJs.PDFDocumentProxy;

export interface PdfJsEngineOptions {
  /** Módulo pdfjs-dist ya importado (en pruebas se pasa la versión "legacy" para Node). */
  pdfjs: PdfJsModule;
  /** URL base de los recursos de PDF.js (cmaps/, standard_fonts/, wasm/, iccs/). Termina en "/". */
  assetsBaseUrl?: string;
}

/** Máximo de píxeles de un canvas (por encima, los navegadores fallan o se quedan sin memoria). */
const MAX_CANVAS_PIXELS = 36_000_000;

/** Motor PDF basado en PDF.js (Apache 2.0). */
export function createPdfJsEngine(options: PdfJsEngineOptions): IPdfEngine {
  return {
    async load(data: Uint8Array, loadOptions?: LoadPdfOptions): Promise<IPdfDocument> {
      const base = options.assetsBaseUrl;
      const task = options.pdfjs.getDocument({
        // PDF.js toma posesión del buffer; se pasa una copia para no dejar "desconectado" el original.
        data: data.slice(),
        password: loadOptions?.password,
        enableXfa: false,
        ...(base
          ? {
              cMapUrl: `${base}cmaps/`,
              cMapPacked: true,
              standardFontDataUrl: `${base}standard_fonts/`,
              wasmUrl: `${base}wasm/`,
              iccUrl: `${base}iccs/`,
            }
          : {}),
      });

      try {
        const proxy = await task.promise;
        return new PdfJsDocument(proxy, options.pdfjs);
      } catch (error) {
        await task.destroy().catch(() => undefined);
        throw translateLoadError(error);
      }
    },
  };
}

function translateLoadError(error: unknown): FoliuxError {
  const name = (error as { name?: string } | null)?.name;
  if (name === 'PasswordException') {
    return new FoliuxError(
      'PDF_ENCRYPTED',
      'Este PDF está protegido con contraseña. El soporte de contraseñas llegará en la Fase 4.',
      { cause: error },
    );
  }
  if (name === 'InvalidPDFException' || name === 'FormatError' || name === 'MissingPDFException') {
    return new FoliuxError('PDF_CORRUPT', 'El archivo está dañado o no es un PDF válido.', {
      cause: error,
    });
  }
  return new FoliuxError('PDF_CORRUPT', 'No se pudo abrir el PDF. Puede estar dañado.', {
    cause: error,
  });
}

function abortError(): DOMException {
  return new DOMException('Operación cancelada', 'AbortError');
}

interface TextRun {
  /** Posición de inicio y fin del fragmento dentro del texto completo de la página. */
  start: number;
  end: number;
  str: string;
  transform: number[];
  width: number;
  height: number;
}

interface PageText {
  full: string;
  runs: TextRun[];
}

class PdfJsDocument implements IPdfDocument {
  readonly numPages: number;
  private readonly textCache = new Map<number, PageText>();

  constructor(
    private readonly proxy: PDFDocumentProxy,
    private readonly pdfjs: PdfJsModule,
  ) {
    this.numPages = proxy.numPages;
  }

  async getPageSizes(): Promise<PageSize[]> {
    const sizes: PageSize[] = new Array<PageSize>(this.numPages);
    const batch = 64;
    for (let first = 1; first <= this.numPages; first += batch) {
      const last = Math.min(this.numPages, first + batch - 1);
      await Promise.all(
        Array.from({ length: last - first + 1 }, async (_, i) => {
          const pageNumber = first + i;
          const page = await this.proxy.getPage(pageNumber);
          const viewport = page.getViewport({ scale: 1 });
          sizes[pageNumber - 1] = { width: viewport.width, height: viewport.height };
          page.cleanup();
        }),
      );
    }
    return sizes;
  }

  async renderPage(pageNumber: number, options: RenderPageOptions): Promise<HTMLCanvasElement> {
    if (options.signal?.aborted) throw abortError();
    const page = await this.proxy.getPage(pageNumber);
    if (options.signal?.aborted) throw abortError();

    const viewport = page.getViewport({ scale: options.scale });
    let outputScale = options.outputScale ?? (globalThis.devicePixelRatio || 1);
    const pixels = viewport.width * viewport.height * outputScale * outputScale;
    if (pixels > MAX_CANVAS_PIXELS) outputScale *= Math.sqrt(MAX_CANVAS_PIXELS / pixels);

    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.floor(viewport.width * outputScale));
    canvas.height = Math.max(1, Math.floor(viewport.height * outputScale));
    canvas.style.width = `${Math.floor(viewport.width)}px`;
    canvas.style.height = `${Math.floor(viewport.height)}px`;

    const renderTask = page.render({
      canvas,
      viewport,
      transform: outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : undefined,
    });
    const onAbort = () => renderTask.cancel();
    options.signal?.addEventListener('abort', onAbort, { once: true });

    try {
      await renderTask.promise;
    } catch (error) {
      if ((error as { name?: string } | null)?.name === 'RenderingCancelledException') {
        throw abortError();
      }
      throw error;
    } finally {
      options.signal?.removeEventListener('abort', onAbort);
    }
    return canvas;
  }

  async renderTextLayer(pageNumber: number, options: RenderPageOptions): Promise<HTMLElement> {
    if (options.signal?.aborted) throw abortError();
    const page = await this.proxy.getPage(pageNumber);
    const viewport = page.getViewport({ scale: options.scale });

    const container = document.createElement('div');
    container.className = 'textLayer';
    container.style.setProperty('--scale-factor', String(viewport.scale));

    const textLayer = new this.pdfjs.TextLayer({
      textContentSource: page.streamTextContent(),
      container,
      viewport,
    });
    const onAbort = () => textLayer.cancel();
    options.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      await textLayer.render();
    } catch (error) {
      if (options.signal?.aborted) throw abortError();
      throw error;
    } finally {
      options.signal?.removeEventListener('abort', onAbort);
    }
    if (options.signal?.aborted) throw abortError();
    return container;
  }

  /** Texto de una página con la posición de cada fragmento (se guarda en caché). */
  private async getPageText(pageNumber: number): Promise<PageText> {
    const cached = this.textCache.get(pageNumber);
    if (cached) return cached;

    const page = await this.proxy.getPage(pageNumber);
    const content = await page.getTextContent();
    const runs: TextRun[] = [];
    let full = '';
    let previous: TextRun | undefined;

    for (const item of content.items) {
      if (!('str' in item)) continue; // marcas de contenido, sin texto

      // Si dos fragmentos están en la misma línea con un hueco, se inserta un espacio virtual.
      const height = item.height || Math.hypot(item.transform[2] ?? 0, item.transform[3] ?? 0);
      if (previous && full.length > 0 && !/\s$/.test(full) && !/^\s/.test(item.str)) {
        const gap = (item.transform[4] ?? 0) - ((previous.transform[4] ?? 0) + previous.width);
        const sameLine =
          Math.abs((item.transform[5] ?? 0) - (previous.transform[5] ?? 0)) < height * 0.5;
        if (sameLine && gap > height * 0.15) full += ' ';
      }

      const run: TextRun = {
        start: full.length,
        end: full.length + item.str.length,
        str: item.str,
        transform: item.transform,
        width: item.width,
        height,
      };
      runs.push(run);
      full += item.str;
      if (item.hasEOL) full += '\n';
      previous = run;
    }
    page.cleanup();

    const result = { full, runs };
    this.textCache.set(pageNumber, result);
    return result;
  }

  async search(query: string, options: SearchOptions = {}): Promise<SearchHit[]> {
    const maxHits = options.maxHits ?? 5000;
    const hits: SearchHit[] = [];
    if (query.trim().length === 0) return hits;

    for (let pageNumber = 1; pageNumber <= this.numPages; pageNumber++) {
      if (options.signal?.aborted) throw abortError();

      const text = await this.getPageText(pageNumber);
      const matches = findMatches(text.full, query);

      if (matches.length > 0) {
        const page = await this.proxy.getPage(pageNumber);
        const viewport = page.getViewport({ scale: 1 });
        for (const match of matches) {
          if (hits.length >= maxHits) break;
          hits.push({
            pageNumber,
            ...buildContext(text.full, match),
            rects: this.rectsForMatch(text, match.start, match.end, viewport),
          });
        }
        page.cleanup();
      }

      options.onProgress?.(pageNumber / this.numPages);
      if (hits.length >= maxHits) break;
      // Ceder el hilo de vez en cuando para que la interfaz siga respondiendo.
      if (pageNumber % 10 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
    }
    return hits;
  }

  /** Rectángulos (en coordenadas de página a escala 1) que cubren el rango [start, end) del texto. */
  private rectsForMatch(
    text: PageText,
    start: number,
    end: number,
    viewport: PdfJs.PageViewport,
  ): Rect[] {
    const rects: Rect[] = [];
    for (const run of text.runs) {
      if (run.end <= start || run.start >= end || run.str.length === 0) continue;

      // Parte del fragmento que cae dentro de la coincidencia (proporcional a los caracteres).
      const from = (Math.max(start, run.start) - run.start) / run.str.length;
      const to = (Math.min(end, run.end) - run.start) / run.str.length;

      const [a = 1, b = 0, , , e = 0, f = 0] = run.transform;
      const norm = Math.hypot(a, b) || 1;
      const dirX = a / norm;
      const dirY = b / norm;
      const h = run.height || 10;

      // Dos esquinas opuestas del rectángulo en espacio PDF (y hacia arriba): base - 20 % y base + 80 %.
      const x1 = e + dirX * run.width * from + dirY * h * 0.2;
      const y1 = f + dirY * run.width * from - dirX * h * 0.2;
      const x2 = e + dirX * run.width * to - dirY * h * 0.8;
      const y2 = f + dirY * run.width * to + dirX * h * 0.8;

      const [vx1 = 0, vy1 = 0] = viewport.convertToViewportPoint(x1, y1) as number[];
      const [vx2 = 0, vy2 = 0] = viewport.convertToViewportPoint(x2, y2) as number[];
      rects.push({
        x: Math.min(vx1, vx2),
        y: Math.min(vy1, vy2),
        width: Math.abs(vx2 - vx1),
        height: Math.abs(vy2 - vy1),
      });
    }
    return rects;
  }

  async getWords(pageNumber: number): Promise<PageWord[]> {
    const text = await this.getPageText(pageNumber);
    const page = await this.proxy.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 1 });
    const words: PageWord[] = [];
    for (const match of text.full.matchAll(/\S+/g)) {
      const rects = this.rectsForMatch(text, match.index, match.index + match[0].length, viewport);
      if (rects.length === 0) continue;
      const x1 = Math.min(...rects.map((r) => r.x));
      const y1 = Math.min(...rects.map((r) => r.y));
      const x2 = Math.max(...rects.map((r) => r.x + r.width));
      const y2 = Math.max(...rects.map((r) => r.y + r.height));
      words.push({ text: match[0], x: x1, y: y1, width: x2 - x1, height: y2 - y1 });
    }
    page.cleanup();
    return words;
  }

  async getImageRects(pageNumber: number): Promise<Rect[]> {
    const page = await this.proxy.getPage(pageNumber);
    const { OPS, Util } = this.pdfjs;
    const operators = await page.getOperatorList();
    const viewport = page.getViewport({ scale: 1 });

    type Matrix = [number, number, number, number, number, number];
    let ctm: Matrix = [1, 0, 0, 1, 0, 0];
    const stack: Matrix[] = [];
    const rects: Rect[] = [];

    operators.fnArray.forEach((fn, index) => {
      const args = operators.argsArray[index] as unknown;
      if (fn === OPS.save) {
        stack.push([...ctm] as Matrix);
      } else if (fn === OPS.restore) {
        ctm = stack.pop() ?? [1, 0, 0, 1, 0, 0];
      } else if (fn === OPS.transform) {
        ctm = Util.transform(ctm, args as Matrix) as Matrix;
      } else if (fn === OPS.paintFormXObjectBegin) {
        stack.push([...ctm] as Matrix);
        const matrix = (args as [Matrix | null])[0];
        if (matrix) ctm = Util.transform(ctm, matrix) as Matrix;
      } else if (fn === OPS.paintFormXObjectEnd) {
        ctm = stack.pop() ?? [1, 0, 0, 1, 0, 0];
      } else if (
        fn === OPS.paintImageXObject ||
        fn === OPS.paintInlineImageXObject ||
        fn === OPS.paintImageXObjectRepeat
      ) {
        // La imagen ocupa el cuadrado unidad transformado por la matriz actual.
        const full = Util.transform(viewport.transform, ctm) as Matrix;
        const corners = [
          [0, 0],
          [1, 0],
          [0, 1],
          [1, 1],
        ].map(([px, py]) => ({
          x: full[0] * px! + full[2] * py! + full[4],
          y: full[1] * px! + full[3] * py! + full[5],
        }));
        const xs = corners.map((c) => c.x);
        const ys = corners.map((c) => c.y);
        const x = Math.min(...xs);
        const y = Math.min(...ys);
        const width = Math.max(...xs) - x;
        const height = Math.max(...ys) - y;
        // Se descartan las imágenes diminutas (puntos, filetes, máscaras de tramado).
        if (width >= 8 && height >= 8) rects.push({ x, y, width, height });
      }
    });
    return rects;
  }

  async getOutline(): Promise<OutlineItem[]> {
    const raw = await this.proxy.getOutline();
    if (!raw) return [];
    return Promise.all(raw.map((item) => this.convertOutlineItem(item)));
  }

  private async convertOutlineItem(item: {
    title: string;
    dest: string | unknown[] | null;
    items: unknown[];
  }): Promise<OutlineItem> {
    return {
      title: item.title.replace(/\s+/g, ' ').trim() || '(sin título)',
      pageNumber: await this.resolveDestination(item.dest),
      children: await Promise.all(
        (item.items as (typeof item)[]).map((child) => this.convertOutlineItem(child)),
      ),
    };
  }

  private async resolveDestination(dest: string | unknown[] | null): Promise<number | null> {
    try {
      const explicit = typeof dest === 'string' ? await this.proxy.getDestination(dest) : dest;
      if (!Array.isArray(explicit)) return null;
      const target: unknown = explicit[0];
      if (typeof target === 'number') return target + 1;
      if (target && typeof target === 'object') {
        return (await this.proxy.getPageIndex(target as { num: number; gen: number })) + 1;
      }
    } catch {
      // Destino roto: se muestra el marcador sin enlace.
    }
    return null;
  }

  async getMetadata(): Promise<PdfMetadata> {
    const { info } = await this.proxy.getMetadata();
    const read = (key: string) => {
      const value = (info as Record<string, unknown> | undefined)?.[key];
      return typeof value === 'string' && value.trim() ? value.trim() : undefined;
    };
    return {
      title: read('Title'),
      author: read('Author'),
      subject: read('Subject'),
      producer: read('Producer'),
    };
  }

  async destroy(): Promise<void> {
    this.textCache.clear();
    await this.proxy.loadingTask.destroy();
  }
}
