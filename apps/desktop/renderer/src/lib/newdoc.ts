import { toast } from 'sonner';
import type { NewDocumentSpec } from '@foliux-pdf/core';
import i18n from '@/i18n';
import { useDocs } from '@/store/docs';
import { useUi } from '@/store/ui';
import { pdfEngine } from './engine';
import { notifyError } from './notify';
import { patchTab } from './edit';

/** Crear un PDF desde cero: queda como documento sin título (se elige dónde guardarlo al guardar). */

/** «Documento sin título.pdf», «Documento sin título 2.pdf»... sin repetir los nombres abiertos. */
function untitledName(): string {
  const used = new Set(useDocs.getState().tabs.map((t) => t.name.toLowerCase()));
  const base = i18n.t('newDocument.untitled');
  for (let n = 1; ; n++) {
    const name = n === 1 ? `${base}.pdf` : `${base} ${n}.pdf`;
    if (!used.has(name.toLowerCase())) return name;
  }
}

export async function createNewDocument(spec: NewDocumentSpec): Promise<boolean> {
  try {
    const { data } = await window.foliux.pdf.create(spec);
    const doc = await pdfEngine.load(data);
    const id = useDocs.getState().addTab({
      path: '',
      name: untitledName(),
      doc,
      numPages: doc.numPages,
      sizes: await doc.getPageSizes(),
      data,
      annotations: [],
      protection: null,
      signatures: [],
    });
    // Un documento nuevo no existe en disco: cuenta como «con cambios» para que cerrarlo pregunte
    // y Guardar abra el diálogo de «Guardar como».
    patchTab(id, (tab) => ({ saved: { ...tab.saved, data: new Uint8Array(0) } }));
    void doc
      .getOutline()
      .then((outline) => useDocs.getState().update(id, { outline }))
      .catch(() => useDocs.getState().update(id, { outline: [] }));
    toast.info(i18n.t('newDocument.created'), { id: 'new-document-hint', duration: 8000 });
    return true;
  } catch (error) {
    notifyError(i18n.t('newDocument.failed'), error);
    return false;
  }
}

export function openNewDocumentDialog(): void {
  useUi.getState().setToolDialog('newDocument');
}
