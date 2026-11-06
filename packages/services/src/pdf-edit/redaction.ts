import { PDFName, StandardFonts, type PDFDocument } from 'pdf-lib';
import {
  FoliuxError,
  annotationBounds,
  isPermanent,
  type Annotation,
  type PageWord,
} from '@foliux-pdf/core';
import { num, pageGeometry, pdfStringLiteral, toWinAnsi } from './annotation-codec';
import { viewSize } from './geometry';

/**
 * Redacción permanente.
 *
 * Un PDF no guarda «frases» sino letras sueltas colocadas en la página con fuentes que a menudo solo
 * contienen los caracteres usados: no se puede borrar de forma fiable «el texto que hay bajo un
 * rectángulo» editando el contenido. Lo que sí garantiza que desaparece es **sustituir la página** por
 * una imagen en la que las zonas redactadas ya están en negro. Las palabras que no se redactan se
 * vuelven a escribir como texto invisible para que la página siga siendo buscable y copiable.
 *
 * El contenido antiguo (texto, imágenes, anotaciones, enlaces, miniatura, metadatos de la página) se
 * descarta del archivo al guardar (ver pruneUnreachable): no se oculta, desaparece.
 */
export interface RedactedPageInput {
  /** Página (base 1). */
  page: number;
  /** Imagen de la página completa, a tamaño de vista, con las zonas redactadas ya pintadas en negro. */
  image: Uint8Array;
  format: 'png' | 'jpeg';
  /** Palabras que se conservan como texto invisible (las redactadas no se incluyen). */
  words: PageWord[];
}

/** Entradas de la página que dejan de tener sentido (o que podrían contener lo redactado). */
const PAGE_KEYS_TO_DROP = ['Annots', 'Thumb', 'Metadata', 'PieceInfo', 'AA', 'B', 'StructParents'];

/**
 * Contenido PDF que escribe las palabras como texto invisible (modo de dibujo 3), cada una con el ancho
 * de la original. Las coordenadas son las de la vista (y hacia abajo): va dentro de «q <matriz> cm … Q».
 */
export function buildInvisibleText(
  words: readonly PageWord[],
  fontName: string,
  font: { widthOfTextAtSize(text: string, size: number): number },
): string {
  return words
    .map((word) => {
      const safe = toWinAnsi(word.text).replace(/\n/g, ' ');
      if (safe.trim() === '' || word.width <= 0) return '';
      const size = Math.max(1, word.height * 0.85);
      const natural = font.widthOfTextAtSize(safe, size);
      const scale = natural > 0 ? (word.width / natural) * 100 : 100;
      const baseline = word.y + word.height * 0.8;
      return `BT 3 Tr /${fontName} ${num(size)} Tf ${num(scale)} Tz 1 0 0 -1 ${num(word.x)} ${num(baseline)} Tm ${pdfStringLiteral(safe)} Tj ET`;
    })
    .filter((part) => part !== '')
    .join(' ');
}

/** Sustituye la página por su imagen y su texto invisible. */
async function replacePage(
  doc: PDFDocument,
  input: RedactedPageInput,
  fontRef: Awaited<ReturnType<PDFDocument['embedFont']>>,
): Promise<void> {
  const page = doc.getPages()[input.page - 1];
  if (!page) throw new FoliuxError('INVALID_REQUEST', `La página ${input.page} no existe.`);
  const geometry = pageGeometry(page);
  const view = viewSize(geometry.rotation, geometry.box);

  const image =
    input.format === 'png' ? await doc.embedPng(input.image) : await doc.embedJpg(input.image);

  const text = buildInvisibleText(input.words, 'FlRedFont', fontRef);

  const m = geometry.matrix;
  const content =
    `q ${m.map(num).join(' ')} cm ` +
    `q ${num(view.width)} 0 0 ${num(-view.height)} 0 ${num(view.height)} cm /FlRedImage Do Q ${text} Q`;

  const context = doc.context;
  page.node.set(PDFName.of('Contents'), context.register(context.stream(content)));
  page.node.set(
    PDFName.of('Resources'),
    context.obj({ XObject: { FlRedImage: image.ref }, Font: { FlRedFont: fontRef.ref } }),
  );
  for (const key of PAGE_KEYS_TO_DROP) page.node.delete(PDFName.of(key));
}

/**
 * Aplica la redacción: sustituye las páginas indicadas y devuelve las anotaciones que sobreviven
 * (se eliminan las marcas de redacción y cualquier anotación que tape o roce una zona redactada).
 */
export async function redactPages(
  doc: PDFDocument,
  inputs: readonly RedactedPageInput[],
  annotations: readonly Annotation[],
): Promise<Annotation[]> {
  const redacted = new Set(inputs.map((input) => input.page));
  const font = await doc.embedFont(StandardFonts.Helvetica);

  const marksByPage = new Map<number, Annotation[]>();
  for (const annotation of annotations) {
    if (annotation.kind !== 'redact') continue;
    const list = marksByPage.get(annotation.page);
    if (list) list.push(annotation);
    else marksByPage.set(annotation.page, [annotation]);
  }

  const touches = (annotation: Annotation): boolean => {
    const marks = marksByPage.get(annotation.page);
    if (!marks) return false;
    const a = annotationBounds(annotation);
    return marks.some((mark) => {
      const b = annotationBounds(mark);
      return (
        a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
      );
    });
  };

  for (const input of inputs) await replacePage(doc, input, font);

  return annotations.filter(
    (annotation) =>
      annotation.kind !== 'redact' &&
      !isPermanent(annotation) &&
      // Una anotación (nota, resaltado con comentario...) que toca una zona redactada podría contener lo
      // redactado: se elimina junto con ella.
      !(redacted.has(annotation.page) && touches(annotation)),
  );
}
