// Copia los recursos de PDF.js (CMaps, fuentes estándar, WASM, perfiles ICC) a la carpeta pública
// del renderer, para que PDF.js los cargue desde 'self' (la CSP no permite orígenes externos).
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pdfjsDir = dirname(require.resolve('pdfjs-dist/package.json'));
const target = join(root, 'apps', 'desktop', 'renderer', 'public', 'pdfjs');

rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
for (const folder of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) {
  const source = join(pdfjsDir, folder);
  if (existsSync(source)) cpSync(source, join(target, folder), { recursive: true });
}
console.log(`[foliux] Recursos de PDF.js copiados a ${target}`);
