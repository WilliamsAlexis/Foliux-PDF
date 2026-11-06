// Descarga qpdf (Apache 2.0) y lo deja en apps/desktop/resources/qpdf para empaquetarlo con la aplicación.
// qpdf es lo que cifra, descifra y aplica permisos a los PDFs (pdf-lib no puede).
//
// La descarga se verifica con la huella SHA-256 publicada por GitHub para ese archivo de la versión
// 12.4.2; si no coincide, se aborta. Solo Windows x64 por ahora (macOS y Linux usarán el qpdf del sistema).
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const VERSION = '12.4.2';
const ARCHIVE = `qpdf-${VERSION}-msvc64.zip`;
const URL = `https://github.com/qpdf/qpdf/releases/download/v${VERSION}/${ARCHIVE}`;
const SHA256 = 'db87077e683630c1217e0e8f9a20a9749d952ab676e881c3689187763a5de25d';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const target = join(root, 'apps', 'desktop', 'resources', 'qpdf');
const marker = join(target, '.version');

if (process.platform !== 'win32') {
  console.log('[foliux] qpdf: se usa el instalado en el sistema (solo se empaqueta para Windows).');
  process.exit(0);
}
if (existsSync(join(target, 'qpdf.exe')) && existsSync(marker) && readFileSync(marker, 'utf8') === VERSION) {
  process.exit(0); // ya está
}

console.log(`[foliux] Descargando qpdf ${VERSION}...`);
const response = await fetch(URL);
if (!response.ok) throw new Error(`No se pudo descargar qpdf (${response.status}).`);
const bytes = Buffer.from(await response.arrayBuffer());

const digest = createHash('sha256').update(bytes).digest('hex');
if (digest !== SHA256) {
  throw new Error(`La huella de qpdf no coincide (esperada ${SHA256}, recibida ${digest}). Descarga cancelada.`);
}

const work = mkdtempSync(join(tmpdir(), 'foliux-qpdf-'));
try {
  const zip = join(work, ARCHIVE);
  writeFileSync(zip, bytes);
  // «tar» de Windows 10+ (bsdtar) sabe abrir .zip
  // Se usa el tar de Windows por ruta completa: otros «tar» en el PATH (p. ej. el de Git Bash) no entienden «C:».
  const windowsTar = join(process.env.SystemRoot ?? 'C:/Windows', 'System32', 'tar.exe');
  const result = spawnSync(windowsTar, ['-xf', zip, '-C', work], { stdio: 'inherit' });
  if (result.status !== 0) throw new Error('No se pudo descomprimir qpdf.');

  const folder = readdirSync(work).find((name) => name.startsWith('qpdf-') && !name.endsWith('.zip'));
  if (!folder) throw new Error('El archivo de qpdf no tiene el contenido esperado.');

  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  cpSync(join(work, folder, 'bin'), target, { recursive: true });
  for (const doc of ['LICENSE.txt', 'NOTICE.md']) {
    if (existsSync(join(work, folder, doc))) cpSync(join(work, folder, doc), join(target, doc));
  }
  writeFileSync(marker, VERSION);
  console.log(`[foliux] qpdf ${VERSION} listo en ${target}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
