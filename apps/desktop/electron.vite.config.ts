import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import type { Plugin } from 'vite';

/**
 * Content Security Policy del renderer (estricta).
 * - Solo se ejecuta JavaScript propio ('self'); nada de eval ni scripts inline.
 * - 'wasm-unsafe-eval': PDF.js usa WebAssembly para decodificar imágenes JPEG2000/JBIG2.
 * - style-src 'unsafe-inline': necesario para estilos dinámicos de librerías de UI (no permite ejecutar código).
 * - Sin acceso a la red: connect-src solo 'self'.
 */
const PROD_CSP = [
  "default-src 'none'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-src 'none'",
].join('; ');

/** En desarrollo, Vite necesita scripts inline (React Fast Refresh) y WebSocket (HMR). */
const DEV_CSP = PROD_CSP.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'").replace(
  "connect-src 'self'",
  "connect-src 'self' ws://localhost:* http://localhost:*",
);

function cspPlugin(): Plugin {
  return {
    name: 'foliux-csp',
    transformIndexHtml: {
      order: 'pre',
      handler(html, ctx) {
        const csp = ctx.server ? DEV_CSP : PROD_CSP;
        return html.replace('__CSP__', csp);
      },
    },
  };
}

export default defineConfig({
  main: {
    build: {
      outDir: 'out/main',
      lib: { entry: resolve(__dirname, 'main/index.ts') },
    },
  },
  preload: {
    build: {
      outDir: 'out/preload',
      lib: { entry: resolve(__dirname, 'preload/index.ts') },
      // Con sandbox el preload no puede cargar módulos de node_modules: se empaqueta todo dentro.
      externalizeDeps: false,
      isolatedEntries: true,
    },
  },
  renderer: {
    root: resolve(__dirname, 'renderer'),
    build: {
      outDir: resolve(__dirname, 'out/renderer'),
      emptyOutDir: true,
      rollupOptions: { input: resolve(__dirname, 'renderer/index.html') },
    },
    resolve: { alias: { '@': resolve(__dirname, 'renderer/src') } },
    plugins: [react(), tailwindcss(), cspPlugin()],
  },
});
