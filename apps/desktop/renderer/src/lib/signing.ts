import { toast } from 'sonner';
import type { Rect } from '@foliux-pdf/core';
import i18n from '@/i18n';
import { getActiveTab } from '@/store/docs';
import { useUi } from '@/store/ui';
import { notifyError } from './notify';
import { openPdfPath, refreshRecent } from './actions';
import { addAnnotations, createAnnotation, flushForm, patchTab, tabOf } from './edit';

/** Firmas: visual (imagen colocada en la página) y digital (certificado), verificación y registro. */

// ---------------------------------------------------------------------------
// Firmas visuales guardadas (solo en este equipo)
// ---------------------------------------------------------------------------

export interface SavedSignature {
  id: string;
  name: string;
  src: string;
  format: 'png' | 'jpeg';
  /** Ancho / alto de la imagen. */
  ratio: number;
}

const STORAGE_KEY = 'foliux-signatures';
const MAX_SAVED = 10;

export function loadSavedSignatures(): SavedSignature[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]') as SavedSignature[];
    return Array.isArray(parsed) ? parsed.filter((s) => typeof s.src === 'string') : [];
  } catch {
    return [];
  }
}

export function saveSignature(signature: SavedSignature): void {
  try {
    const next = [signature, ...loadSavedSignatures().filter((s) => s.id !== signature.id)].slice(
      0,
      MAX_SAVED,
    );
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Sin almacenamiento (modo privado, cuota): la firma sigue sirviendo en esta sesión.
  }
}

export function deleteSavedSignature(id: string): void {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(loadSavedSignatures().filter((s) => s.id !== id)),
    );
  } catch {
    // ver arriba
  }
}

/** Deja elegida una firma: se colocará con un clic en la página. */
export function chooseSignature(signature: SavedSignature): void {
  useUi.getState().setPendingSignature({
    src: signature.src,
    format: signature.format,
    ratio: signature.ratio,
    name: signature.name,
  });
  useUi.getState().setTool('signature');
  toast(i18n.t('signing.placeHint'), { id: 'signature-hint' });
}

/** Coloca la firma elegida en el punto indicado (como una imagen en la página). */
export function placeSignature(tabId: string, page: number, point: { x: number; y: number }): void {
  const pending = useUi.getState().pendingSignature;
  const tab = tabOf(tabId);
  if (!pending || !tab) return;
  const size = tab.sizes[page - 1];
  const width = Math.min(150, (size?.width ?? 200) * 0.4);
  const rect: Rect = {
    x: Math.max(0, Math.min(point.x - width / 2, (size?.width ?? 0) - width)),
    y: Math.max(0, point.y - width / pending.ratio / 2),
    width,
    height: width / pending.ratio,
  };
  const item = createAnnotation('image', page, { rect, src: pending.src, format: pending.format });
  addAnnotations(tabId, [item]);
  useUi.getState().setTool('select');
  useUi.getState().setPendingSignature(null);
  void window.foliux.audit
    .record({
      action: 'visual-signature',
      file: tab.name,
      fileHash: '',
      signer: pending.name,
      detail: `Firma visual colocada en la página ${page}`,
    })
    .catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Firma digital
// ---------------------------------------------------------------------------

export interface SignRequest {
  certificate: Uint8Array;
  passphrase: string;
  reason: string;
  location: string;
  contact: string;
}

/** Firma digitalmente y guarda una copia firmada. El documento abierto no cambia. */
export async function signDocument(request: SignRequest): Promise<boolean> {
  const tab = getActiveTab();
  if (!tab || tab.busy) return false;
  if (tab.protection) {
    toast.error(i18n.t('signing.protectedBlocked'));
    return false;
  }
  if (!(await flushForm(tab.id))) return false;
  const current = tabOf(tab.id);
  if (!current) return false;

  patchTab(current.id, () => ({ busy: i18n.t('busy.signing') }));
  try {
    const result = await window.foliux.pdf.sign({
      data: current.data,
      annotations: current.annotations,
      suggestedName: `${current.name.replace(/\.pdf$/i, '')} (firmado).pdf`,
      ...request,
    });
    patchTab(current.id, () => ({ busy: null }));
    if (!result) return false;
    const signature = result.signatures[result.signatures.length - 1];
    toast.success(i18n.t('signing.done', { name: result.name }), {
      description: signature
        ? i18n.t('signing.doneDetail', { signer: signature.signer })
        : undefined,
      action: { label: i18n.t('save.open'), onClick: () => void openPdfPath(result.path) },
    });
    await refreshRecent();
    return true;
  } catch (error) {
    patchTab(current.id, () => ({ busy: null }));
    notifyError(i18n.t('errors.signFailed'), error);
    return false;
  }
}

export interface CertificateRequest {
  commonName: string;
  organization: string;
  email: string;
  days: number;
  passphrase: string;
}

export async function createCertificate(request: CertificateRequest): Promise<boolean> {
  try {
    const result = await window.foliux.certificate.create(request);
    if (!result) return false;
    toast.success(i18n.t('signing.certCreated', { name: result.name }), {
      description: i18n.t('signing.certFingerprint', {
        fingerprint: result.fingerprint.slice(0, 16),
      }),
    });
    return true;
  } catch (error) {
    notifyError(i18n.t('errors.signFailed'), error);
    return false;
  }
}

/** Vuelve a leer el archivo de disco y comprueba sus firmas. */
export async function recheckSignatures(tabId: string): Promise<void> {
  const tab = tabOf(tabId);
  if (!tab) return;
  try {
    const file = await window.foliux.readPdf(tab.path);
    patchTab(tabId, () => ({ signatures: file.signatures }));
    toast.info(
      file.signatures.length === 0 ? i18n.t('signatures.none') : i18n.t('signatures.rechecked'),
    );
  } catch (error) {
    notifyError(i18n.t('errors.signFailed'), error);
  }
}
