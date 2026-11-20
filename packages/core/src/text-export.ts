import { buildParagraphs, groupLines } from './layout';
import type { PageWord } from './models';

/** Exportar el texto de un PDF a texto plano (.txt) o a una página HTML (.html). */

export interface PageText {
  /** Número de página (base 1) tal como está en el documento. */
  page: number;
  words: readonly PageWord[];
}

/** Texto plano: un párrafo por bloque y una línea de separación entre páginas. */
export function buildPlainText(pages: readonly PageText[]): string {
  const blocks = pages.map(({ page, words }) => {
    const body = buildParagraphs(groupLines(words))
      .map((p) => p.text)
      .join('\n\n');
    return `--- Página ${page} ---\n\n${body}`.trimEnd();
  });
  return `${blocks.join('\n\n\n')}\n`;
}

/** Escapa lo necesario para meter texto en HTML (contenido y atributos). */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Página HTML autónoma (sin scripts): una sección por página, los títulos como encabezados. */
export function buildHtmlDocument(title: string, pages: readonly PageText[]): string {
  const sections = pages.map(({ page, words }) => {
    const paragraphs = buildParagraphs(groupLines(words))
      .map((p) =>
        p.heading ? `    <h3>${escapeHtml(p.text)}</h3>` : `    <p>${escapeHtml(p.text)}</p>`,
      )
      .join('\n');
    return `  <section id="pagina-${page}">\n    <h2>Página ${page}</h2>\n${paragraphs}\n  </section>`;
  });
  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 48rem; margin: 2rem auto; padding: 0 1rem; line-height: 1.6; color: #1f2937; }
    h2 { margin-top: 2.5rem; padding-top: 1rem; border-top: 1px solid #d1d5db; font-size: 0.9rem; color: #6b7280; text-transform: uppercase; letter-spacing: 0.05em; }
  </style>
</head>
<body>
  <h1>${escapeHtml(title)}</h1>
${sections.join('\n')}
</body>
</html>
`;
}
