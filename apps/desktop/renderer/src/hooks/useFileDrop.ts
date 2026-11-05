import { useEffect } from 'react';
import { toast } from 'sonner';
import i18n from '@/i18n';
import { openPdfPaths } from '@/lib/actions';
import { useUi } from '@/store/ui';

function hasFiles(event: DragEvent): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes('Files');
}

/** Arrastrar y soltar PDFs sobre la ventana para abrirlos. */
export function useFileDrop(): void {
  useEffect(() => {
    const setDragging = useUi.getState().setDragging;
    let depth = 0; // dragenter/dragleave se disparan también al cruzar elementos hijos

    const onEnter = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      depth++;
      setDragging(true);
    };
    const onOver = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault(); // necesario para permitir soltar
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    };
    const onLeave = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    };
    const onDrop = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault(); // evita que Chromium navegue al archivo
      depth = 0;
      setDragging(false);

      const paths = Array.from(event.dataTransfer?.files ?? [])
        .map((file) => window.foliux.getPathForFile(file))
        .filter((path) => path.length > 0);
      const pdfs = paths.filter((path) => path.toLowerCase().endsWith('.pdf'));
      if (pdfs.length < paths.length) {
        toast.warning(i18n.t('errors.notPdf'));
      }
      void openPdfPaths(pdfs);
    };

    window.addEventListener('dragenter', onEnter);
    window.addEventListener('dragover', onOver);
    window.addEventListener('dragleave', onLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onEnter);
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('dragleave', onLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, []);
}
