// Copia el motor de OCR (Tesseract.js, Apache 2.0) y los datos de idioma a la carpeta pública del renderer,
// para que el OCR funcione sin red: la CSP de la aplicación no permite cargar nada de fuera.
//
// Solo se copian las variantes «LSTM» del núcleo (las que usa el reconocimiento actual) y los idiomas
// español e inglés. Para añadir otro idioma: instalar @tesseract.js-data/<código> y añadirlo a LANGUAGES.
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const target = join(root, 'apps', 'desktop', 'renderer', 'public', 'tesseract');

const LANGUAGES = ['spa', 'eng'];
const CORES = [
  'tesseract-core-lstm.wasm.js',
  'tesseract-core-simd-lstm.wasm.js',
  'tesseract-core-relaxedsimd-lstm.wasm.js',
];

rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });

const tesseractDist = join(dirname(require.resolve('tesseract.js/package.json')), 'dist');
cpSync(join(tesseractDist, 'worker.min.js'), join(target, 'worker.min.js'));

const coreDir = dirname(require.resolve('tesseract.js-core/package.json'));
for (const file of CORES) {
  if (!existsSync(join(coreDir, file))) throw new Error(`Falta ${file} en tesseract.js-core`);
  cpSync(join(coreDir, file), join(target, file));
}

for (const language of LANGUAGES) {
  const dataDir = join(dirname(require.resolve(`@tesseract.js-data/${language}/package.json`)), '4.0.0_best_int');
  cpSync(join(dataDir, `${language}.traineddata.gz`), join(target, `${language}.traineddata.gz`));
}
console.log(`[foliux] Recursos de OCR copiados a ${target}`);
