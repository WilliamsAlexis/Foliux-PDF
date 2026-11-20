import { toast } from 'sonner';
import i18n from '@/i18n';
import { getActiveTab, isDirty } from '@/store/docs';
import { pdfEngine } from './engine';
import { notifyError } from './notify';
import { saveTab, saveActive } from './edit';
import { withJob } from './convert';
import { renderPageCanvas } from './raster';

/** Compartir: guardar una copia, imprimir y preparar un correo. */

/** Descargar = guardar una copia con otro nombre o en otro sitio. */
export function downloadCopy(): Promise<boolean> {
  return saveActive(true);
}

/**
 * Enviar por correo. Una aplicación de escritorio no puede adjuntar archivos al programa de correo por sí
 * sola, así que se guarda el documento, se abre un mensaje nuevo y se indica dónde está el archivo.
 */
export async function shareByMail(): Promise<void> {
  const tab = getActiveTab();
  if (!tab || tab.busy) return;
  // Sin archivo en disco o con cambios, primero se guarda: así lo que se envía es lo que se ve.
  if (tab.path === '' || isDirty(tab)) {
    if (!(await saveTab(tab.id))) return;
  }
  const saved = getActiveTab();
  if (!saved) return;
  try {
    await window.foliux.pdf.openMail({
      subject: saved.name,
      body: i18n.t('share.mailBody', { name: saved.name }),
    });
    toast.info(i18n.t('share.mailOpened'), { description: saved.path, duration: 15_000 });
  } catch (error) {
    notifyError(i18n.t('share.mailFailed'), error);
  }
}

// ---------------------------------------------------------------------------
// Imprimir
// ---------------------------------------------------------------------------

const MAX_PRINT_PAGES = 300;
const PRINT_ROOT = 'foliux-print-root';

/**
 * Imprime el documento tal como se ve (con anotaciones y texto pendiente). Dibuja cada página como imagen
 * en un contenedor que solo se muestra al imprimir (ver styles.css) y abre el diálogo de impresión del sistema.
 */
export async function printDocument(): Promise<void> {
  const tab = getActiveTab();
  if (!tab || tab.busy) return;
  if (tab.numPages > MAX_PRINT_PAGES) {
    toast.error(i18n.t('share.printTooLong', { max: MAX_PRINT_PAGES }));
    return;
  }

  const images = await withJob(
    tab.id,
    (done, total) => i18n.t('share.printing', { done, total }),
    async (signal, progress) => {
      // Se imprime el documento con lo editado incorporado, no solo el archivo original.
      const baked = await window.foliux.pdf.bake({ data: tab.data, annotations: tab.annotations });
      const doc = await pdfEngine.load(baked.data);
      try {
        const sizes = await doc.getPageSizes();
        const urls: string[] = [];
        for (let page = 1; page <= doc.numPages; page++) {
          if (signal.aborted) throw new DOMException('Cancelado', 'AbortError');
          const size = sizes[page - 1];
          if (!size) continue;
          const { canvas } = await renderPageCanvas(doc, page, size, 150, signal);
          urls.push(canvas.toDataURL('image/jpeg', 0.9));
          progress(page, doc.numPages);
        }
        return urls;
      } finally {
        void doc.destroy().catch(() => undefined);
      }
    },
  );
  if (!images || images.length === 0) return;

  document.getElementById(PRINT_ROOT)?.remove();
  const root = document.createElement('div');
  root.id = PRINT_ROOT;
  for (const src of images) {
    const page = document.createElement('div');
    page.className = 'foliux-print-page';
    const img = document.createElement('img');
    img.alt = '';
    img.src = src;
    page.append(img);
    root.append(page);
  }
  document.body.append(root);

  const cleanup = () => {
    root.remove();
    window.removeEventListener('afterprint', cleanup);
  };
  window.addEventListener('afterprint', cleanup);
  // Se espera a que todas las imágenes estén listas antes de abrir el diálogo.
  await Promise.all(
    [...root.querySelectorAll('img')].map((img) => img.decode().catch(() => undefined)),
  );
  window.print();
}
