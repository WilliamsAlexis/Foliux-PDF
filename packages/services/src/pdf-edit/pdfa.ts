import {
  PDFArray,
  PDFDict,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFString,
  type PDFDocument,
} from 'pdf-lib';
import { randomBytes } from 'node:crypto';
import { loadPdf } from './page-ops';
import { cleanMetadata, inspectDocument } from './metadata';
import { pruneUnreachable } from './prune';

/**
 * Preparación para archivado (PDF/A-2b), de MEJOR ESFUERZO.
 *
 * Se hace lo que se puede hacer de forma fiable con pdf-lib: metadatos XMP con la marca PDF/A, perfil de
 * color de salida (si hay un perfil sRGB disponible), identificador del documento, y se quita lo que PDF/A
 * prohíbe (JavaScript, adjuntos). Lo que no se puede arreglar sin un conversor completo (sobre todo las
 * fuentes no incrustadas) se informa como problema. El resultado NO está validado con veraPDF: no debe
 * presentarse como PDF/A certificado.
 */

export interface PdfAIssue {
  code: string;
  message: string;
  /** Impide que el documento sea PDF/A aunque se hayan aplicado las demás correcciones. */
  blocking: boolean;
}

export interface PdfAResult {
  data: Uint8Array;
  issues: PdfAIssue[];
  /** Lo que se corrigió. */
  fixed: string[];
}

const name = PDFName.of;

const escapeXml = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function xmpPacket(title: string, created: Date, modified: Date): string {
  const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
  return [
    '<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>',
    '<x:xmpmeta xmlns:x="adobe:ns:meta/">',
    '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">',
    '<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/"',
    ' xmlns:pdf="http://ns.adobe.com/pdf/1.3/" xmlns:xmp="http://ns.adobe.com/xap/1.0/"',
    ' xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/">',
    `<dc:title><rdf:Alt><rdf:li xml:lang="x-default">${escapeXml(title)}</rdf:li></rdf:Alt></dc:title>`,
    '<pdf:Producer>Foliux PDF</pdf:Producer>',
    `<xmp:CreateDate>${iso(created)}</xmp:CreateDate>`,
    `<xmp:ModifyDate>${iso(modified)}</xmp:ModifyDate>`,
    `<xmp:MetadataDate>${iso(modified)}</xmp:MetadataDate>`,
    '<xmp:CreatorTool>Foliux PDF</xmp:CreatorTool>',
    '<pdfaid:part>2</pdfaid:part>',
    '<pdfaid:conformance>B</pdfaid:conformance>',
    '</rdf:Description>',
    '</rdf:RDF>',
    '</x:xmpmeta>',
    '<?xpacket end="w"?>',
  ].join('\n');
}

/** Cuántas fuentes (distintas) del documento no están incrustadas. */
function countUnembeddedFonts(doc: PDFDocument): number {
  const hasFile = (descriptor: PDFDict | undefined) =>
    !!descriptor &&
    (descriptor.has(name('FontFile')) ||
      descriptor.has(name('FontFile2')) ||
      descriptor.has(name('FontFile3')));
  let missing = 0;
  for (const [, object] of doc.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFDict) || object.lookup(name('Type'))?.toString() !== '/Font')
      continue;
    const subtype = object.lookup(name('Subtype'))?.toString();
    if (subtype === '/Type3') continue; // sus glifos van dentro de la propia fuente
    if (subtype === '/Type0') {
      const descendants = object.lookupMaybe(name('DescendantFonts'), PDFArray);
      const descendant = descendants?.lookupMaybe(0, PDFDict);
      if (!hasFile(descendant?.lookupMaybe(name('FontDescriptor'), PDFDict))) missing += 1;
    } else if (!hasFile(object.lookupMaybe(name('FontDescriptor'), PDFDict))) {
      missing += 1;
    }
  }
  return missing;
}

export async function convertToPdfA(
  data: Uint8Array,
  options: { iccProfile?: Uint8Array; title?: string } = {},
): Promise<PdfAResult> {
  const doc = await loadPdf(data);
  const context = doc.context;
  const issues: PdfAIssue[] = [];
  const fixed: string[] = [];

  // 1) Lo que PDF/A prohíbe y se puede quitar sin riesgo
  const before = inspectDocument(doc);
  cleanMetadata(doc, {
    type: 'cleanMetadata',
    info: false,
    xmp: false,
    thumbnails: false,
    attachments: true,
    javascript: true,
  });
  if (before.hasJavaScript) fixed.push('Se quitó el JavaScript.');
  if (before.attachments.length > 0)
    fixed.push(`Se quitaron ${before.attachments.length} archivo(s) adjunto(s).`);

  // 2) Anotaciones: deben imprimirse y no pueden estar ocultas
  let noAppearance = 0;
  for (const page of doc.getPages()) {
    const annots = page.node.Annots();
    if (!annots) continue;
    for (let i = 0; i < annots.size(); i++) {
      const annotation = annots.lookupMaybe(i, PDFDict);
      if (!annotation) continue;
      const subtype = annotation.lookup(name('Subtype'))?.toString();
      if (subtype !== '/Link' && subtype !== '/Popup' && !annotation.has(name('AP')))
        noAppearance += 1;
      const current = (annotation.lookup(name('F')) as PDFNumber | undefined)?.asNumber() ?? 0;
      const flags = (current | 4) & ~(2 | 32); // imprimible; ni oculta ni «no ver»
      if (flags !== current) annotation.set(name('F'), PDFNumber.of(flags));
    }
  }
  if (noAppearance > 0) {
    issues.push({
      code: 'ANNOTATION_NO_APPEARANCE',
      message: `${noAppearance} anotación(es) sin apariencia propia: PDF/A exige que todas la tengan.`,
      blocking: true,
    });
  }

  // 3) Metadatos coherentes: Info, XMP y marca PDF/A
  const now = new Date();
  const created = doc.getCreationDate() ?? now;
  const title = options.title ?? doc.getTitle() ?? 'Documento';
  doc.setTitle(title);
  doc.setProducer('Foliux PDF');
  doc.setCreator('Foliux PDF');
  doc.setCreationDate(created);
  doc.setModificationDate(now);
  const xmp = context.stream(xmpPacket(title, created, now), { Type: 'Metadata', Subtype: 'XML' });
  doc.catalog.set(name('Metadata'), context.register(xmp));
  fixed.push('Se añadieron los metadatos XMP con la marca PDF/A-2b.');

  // 4) Identificador del documento (obligatorio)
  const id = randomBytes(16).toString('hex');
  context.trailerInfo.ID = context.obj([PDFHexString.of(id), PDFHexString.of(id)]);

  // 5) Perfil de color de salida
  if (options.iccProfile && options.iccProfile.length > 128) {
    const profile = context.register(
      context.flateStream(options.iccProfile, { N: 3, Alternate: 'DeviceRGB' }),
    );
    const intent = context.obj({
      Type: 'OutputIntent',
      S: 'GTS_PDFA1',
      OutputConditionIdentifier: PDFString.of('sRGB IEC61966-2.1'),
      Info: PDFString.of('sRGB IEC61966-2.1'),
      DestOutputProfile: profile,
    });
    doc.catalog.set(name('OutputIntents'), context.obj([context.register(intent)]));
    fixed.push('Se añadió el perfil de color sRGB como intención de salida.');
  } else {
    issues.push({
      code: 'NO_OUTPUT_INTENT',
      message: 'No se encontró un perfil de color sRGB para añadir la intención de salida.',
      blocking: true,
    });
  }

  // 6) Fuentes: deben estar todas incrustadas (se cuenta tras descartar lo que ya no se usa)
  pruneUnreachable(doc);
  const unembedded = countUnembeddedFonts(doc);
  if (unembedded > 0) {
    issues.push({
      code: 'FONTS_NOT_EMBEDDED',
      message: `${unembedded} fuente(s) no incrustada(s) (p. ej. las estándar de PDF): PDF/A exige incrustarlas todas y Foliux aún no puede hacerlo.`,
      blocking: true,
    });
  }

  return { data: await doc.save({ useObjectStreams: false }), issues, fixed };
}
