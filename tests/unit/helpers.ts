import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Crea una carpeta temporal y devuelve su ruta junto con una función para borrarla. */
export async function makeTempDir(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'foliux-test-'));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

export const TEST_PAGE_WIDTH = 200;
export const TEST_PAGE_HEIGHT = 300;

/** Genera los bytes de un PDF mínimo válido con una página (200×300 pt) por cada texto. */
export function buildPdf(pageTexts: string[]): Uint8Array {
  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  const addObject = (content: string) => {
    offsets.push(body.length);
    body += `${offsets.length} 0 obj\n${content}\nendobj\n`;
  };

  const count = pageTexts.length;
  const kids = pageTexts.map((_, i) => `${4 + 2 * i} 0 R`).join(' ');

  addObject('<< /Type /Catalog /Pages 2 0 R /Outlines 99 0 R >>'); // 1 (los marcadores se añaden abajo)
  addObject(`<< /Type /Pages /Kids [${kids}] /Count ${count} >>`); // 2
  addObject('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'); // 3

  pageTexts.forEach((text, i) => {
    addObject(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${TEST_PAGE_WIDTH} ${TEST_PAGE_HEIGHT}] ` +
        `/Contents ${5 + 2 * i} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`,
    );
    const stream = `BT /F1 24 Tf 20 150 Td (${text}) Tj ET`;
    addObject(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  });

  // Marcadores: uno por página, enlazados al objeto de cada página.
  const firstOutlineObj = offsets.length + 2; // objeto raíz de marcadores = offsets.length + 1
  const rootObj = offsets.length + 1;
  addObject(
    `<< /Type /Outlines /First ${firstOutlineObj} 0 R /Last ${firstOutlineObj + count - 1} 0 R /Count ${count} >>`,
  );
  pageTexts.forEach((text, i) => {
    const prev = i > 0 ? `/Prev ${firstOutlineObj + i - 1} 0 R ` : '';
    const next = i < count - 1 ? `/Next ${firstOutlineObj + i + 1} 0 R ` : '';
    addObject(
      `<< /Title (Capitulo ${i + 1}) /Parent ${rootObj} 0 R ${prev}${next}/Dest [${4 + 2 * i} 0 R /Fit] >>`,
    );
  });

  // El catálogo apunta a 99 0 R como marcadores; se reescribe con el número real.
  body = body.replace('/Outlines 99 0 R', `/Outlines ${rootObj} 0 R`);
  // Al cambiar el texto del catálogo cambia su longitud, así que se recalculan los desplazamientos.
  return finishPdf(body);
}

/** Recalcula la tabla xref a partir del contenido (así no importa si se editó algún objeto). */
function finishPdf(body: string): Uint8Array {
  const offsets: number[] = [];
  const regex = /^(\d+) 0 obj$/gm;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(body)) !== null) offsets[Number(match[1]) - 1] = match.index;

  let out = body;
  const xrefPosition = out.length;
  out += `xref\n0 ${offsets.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${String(offset).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${offsets.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPosition}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(out, 'latin1'));
}

export async function writeTestPdf(
  dir: string,
  name: string,
  pageTexts: string[],
): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, buildPdf(pageTexts));
  return path;
}

/**
 * Todo el texto del PDF que un buscador de bytes podría encontrar: el archivo tal cual, los flujos
 * descomprimidos y las cadenas en hexadecimal (pdf-lib escribe así el texto y los metadatos), tanto
 * en Latin-1 como en UTF-16. Sirve para comprobar que algo «no está» sin que la prueba pase en vacío.
 */
export async function everything(data: Uint8Array): Promise<string> {
  const { inflateSync } = await import('node:zlib');
  const raw = Buffer.from(data);
  const latin = raw.toString('latin1');
  const NL = String.fromCharCode(10);
  let text = latin;
  // Tras la palabra «stream» va un salto de línea (CR LF o LF): se construye sin escapes de control.
  const streams = new RegExp(`stream${String.fromCharCode(13)}?${NL}`, 'g');
  let match: RegExpExecArray | null;
  while ((match = streams.exec(latin))) {
    const start = match.index + match[0].length;
    const end = raw.indexOf('endstream', start);
    if (end < 0) break;
    try {
      text += NL + inflateSync(raw.subarray(start, end)).toString('latin1');
    } catch {
      // no era un flujo comprimido con Flate
    }
  }
  const decoded: string[] = [];
  for (const hex of text.matchAll(/<([0-9A-Fa-f]{8,})>/g)) {
    const bytes = Buffer.from(hex[1]!, 'hex');
    decoded.push(bytes.toString('latin1'));
    if (bytes[0] === 0xfe && bytes[1] === 0xff) {
      decoded.push(new TextDecoder('utf-16be').decode(bytes.subarray(2)));
    }
  }
  return text + NL + decoded.join(NL);
}
