import {
  PDFArray,
  PDFDict,
  PDFName,
  PDFRef,
  PDFStream,
  type PDFDocument,
  type PDFObject,
} from 'pdf-lib';

const TYPE = PDFName.of('Type');
const KIDS = PDFName.of('Kids');

const refKey = (ref: PDFRef) => `${ref.objectNumber} ${ref.generationNumber}`;

/** Referencias de las páginas que de verdad están en el árbol de páginas (recorriéndolo, sin cachés). */
function livePageRefs(doc: PDFDocument): Set<string> {
  const live = new Set<string>();
  const visit = (node: PDFObject | undefined, depth: number) => {
    if (depth > 64 || !node) return;
    const dict = node instanceof PDFRef ? doc.context.lookup(node) : node;
    if (!(dict instanceof PDFDict)) return;
    const kids = dict.lookupMaybe(KIDS, PDFArray);
    if (kids) {
      for (const kid of kids.asArray()) visit(kid, depth + 1);
    } else if (node instanceof PDFRef) {
      live.add(refKey(node));
    }
  };
  visit(doc.catalog.get(PDFName.of('Pages')), 0);
  return live;
}

/**
 * Borra del documento los objetos a los que ya no llega nada.
 *
 * pdf-lib guarda TODOS los objetos que ha leído o creado, aunque ya no se usen: una página eliminada,
 * una imagen sustituida o un metadato borrado seguirían dentro del archivo (invisibles, pero
 * recuperables con cualquier herramienta). Antes de guardar se recorre el documento desde su raíz y se
 * descarta todo lo que no se alcanza.
 *
 * Una página que ya no está en el árbol de páginas tampoco cuenta como alcanzable aunque algo la
 * mencione (un marcador, un enlace, un destino con nombre): esas menciones quedan sin destino, que es
 * lo que corresponde, en lugar de mantener dentro del archivo el contenido de la página eliminada.
 *
 * @returns cuántos objetos se descartaron.
 */
export function pruneUnreachable(doc: PDFDocument): number {
  const context = doc.context;
  const live = livePageRefs(doc);
  const reachable = new Set<string>();
  const pending: PDFObject[] = [];

  const enqueue = (object: PDFObject | undefined) => {
    if (object) pending.push(object);
  };

  const trailer = context.trailerInfo;
  enqueue(trailer.Root);
  enqueue(trailer.Info);
  enqueue(trailer.Encrypt);
  enqueue(trailer.ID);

  while (pending.length > 0) {
    const object = pending.pop();
    if (object instanceof PDFRef) {
      const id = refKey(object);
      if (reachable.has(id)) continue;
      const target = context.lookup(object);
      // Una página fuera del árbol no se mantiene por el mero hecho de que algo la mencione.
      if (
        target instanceof PDFDict &&
        target.lookup(TYPE)?.toString() === '/Page' &&
        !live.has(id)
      ) {
        continue;
      }
      reachable.add(id);
      enqueue(target);
    } else if (object instanceof PDFDict) {
      for (const [, value] of object.entries()) enqueue(value);
    } else if (object instanceof PDFArray) {
      for (const value of object.asArray()) enqueue(value);
    } else if (object instanceof PDFStream) {
      enqueue(object.dict);
    }
  }

  let removed = 0;
  for (const [ref] of context.enumerateIndirectObjects()) {
    if (!reachable.has(refKey(ref))) {
      context.delete(ref);
      removed += 1;
    }
  }
  return removed;
}
