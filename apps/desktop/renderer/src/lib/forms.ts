import { toast } from 'sonner';
import {
  validateFieldName,
  type FormFieldInfo,
  type FormValue,
  type NewFormField,
  type Rect,
} from '@foliux-pdf/core';
import i18n from '@/i18n';
import { getActiveTab, useDocs, type DocTab } from '@/store/docs';
import { patchTab, runPageOp } from './edit';

/** Formularios: rellenar los campos, crear campos nuevos, borrarlos y aplanarlos. */

/** Valor que se muestra de un campo: lo tecleado (pendiente) o el que ya tiene el PDF. */
export function currentValue(tab: DocTab, field: FormFieldInfo): FormValue {
  const pending = tab.formValues[field.name];
  return pending !== undefined ? pending : field.value;
}

/** Anota el valor de un campo; se escribe en el PDF al guardar o al hacer otra operación. */
export function setFormValue(tabId: string, field: FormFieldInfo, value: FormValue): void {
  patchTab(tabId, (tab) => {
    const next = { ...tab.formValues };
    // Si el usuario vuelve al valor que ya tenía el PDF, deja de haber cambio pendiente.
    if (JSON.stringify(value) === JSON.stringify(field.value)) delete next[field.name];
    else next[field.name] = value;
    return { formValues: next };
  });
}

/** Nombre de campo libre: campo1, campo2... */
export function suggestFieldName(tab: DocTab | undefined, base = 'campo'): string {
  const used = new Set((tab?.form ?? []).map((f) => f.name));
  for (let n = 1; ; n++) if (!used.has(`${base}${n}`)) return `${base}${n}`;
}

export interface FieldSpec {
  type: NewFormField['type'];
  name: string;
  options: string[];
  multiline: boolean;
  required: boolean;
}

/** Crea un campo en la zona dibujada. */
export async function createField(page: number, rect: Rect, spec: FieldSpec): Promise<boolean> {
  const tab = getActiveTab();
  if (!tab) return false;
  const problem = validateFieldName(spec.name);
  if (problem) {
    toast.error(problem);
    return false;
  }
  const ok = await runPageOp({
    type: 'addFormField',
    field: { ...spec, name: spec.name.trim(), page, rect },
  });
  if (ok) toast.success(i18n.t('forms.created', { name: spec.name.trim() }));
  return ok;
}

export function deleteField(name: string): Promise<boolean> {
  return runPageOp({ type: 'deleteFormField', name });
}

export async function flattenFormFields(): Promise<boolean> {
  const ok = await runPageOp({ type: 'flattenForm' });
  if (ok) toast.success(i18n.t('forms.flattened'));
  return ok;
}

/** Se desplaza hasta un campo. */
export function goToField(tabId: string, field: FormFieldInfo): void {
  const widget = field.widgets[0];
  if (!widget) return;
  useDocs.getState().goToPage(tabId, widget.page, widget.rect.y);
}

/** ¿Hay campos que rellenar (o crear)? */
export function formFieldCount(): number {
  return getActiveTab()?.form?.length ?? 0;
}

/** Aviso de que la herramienta «campo» necesita una zona; lo usa la barra al elegirla. */
export function hintField(): void {
  toast(i18n.t('forms.hint'), { id: 'field-hint' });
}
