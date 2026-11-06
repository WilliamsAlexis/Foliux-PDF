import {
  PDFButton,
  PDFCheckBox,
  PDFDict,
  PDFDropdown,
  PDFOptionList,
  PDFRadioGroup,
  PDFSignature,
  PDFTextField,
  StandardFonts,
  rgb,
  type PDFDocument,
  type PDFField,
} from 'pdf-lib';
import {
  FoliuxError,
  validateFieldName,
  type FormFieldInfo,
  type FormFieldType,
  type FormValue,
  type FormValues,
  type NewFormField,
} from '@foliux-pdf/core';
import { toWinAnsi } from './annotation-codec';
import { invertMatrix, transformRect } from './geometry';
import { pageGeometry } from './annotation-codec';

/** Lectura, relleno y creación de campos de formulario (AcroForm). */

function typeOf(field: PDFField): FormFieldType {
  if (field instanceof PDFTextField) return 'text';
  if (field instanceof PDFCheckBox) return 'checkbox';
  if (field instanceof PDFRadioGroup) return 'radio';
  if (field instanceof PDFDropdown) return 'dropdown';
  if (field instanceof PDFOptionList) return 'list';
  if (field instanceof PDFSignature) return 'signature';
  if (field instanceof PDFButton) return 'button';
  return 'button';
}

function valueOf(field: PDFField): FormValue {
  if (field instanceof PDFTextField) return field.getText() ?? '';
  if (field instanceof PDFCheckBox) return field.isChecked();
  if (field instanceof PDFRadioGroup) return field.getSelected() ?? '';
  if (field instanceof PDFDropdown || field instanceof PDFOptionList) return field.getSelected();
  return '';
}

function optionsOf(field: PDFField): string[] {
  if (
    field instanceof PDFRadioGroup ||
    field instanceof PDFDropdown ||
    field instanceof PDFOptionList
  ) {
    return field.getOptions();
  }
  return [];
}

/** Campos del formulario con el rectángulo de cada aparición en unidades de la vista. */
export function listFormFields(doc: PDFDocument): FormFieldInfo[] {
  let fields: PDFField[];
  try {
    fields = doc.getForm().getFields();
  } catch {
    return []; // formulario dañado o no compatible (p. ej. XFA)
  }

  // Qué anotación (widget) está en qué página.
  const pages = doc.getPages();
  const widgetPage = new Map<PDFDict, number>();
  pages.forEach((page, index) => {
    const annots = page.node.Annots();
    if (!annots) return;
    for (let i = 0; i < annots.size(); i++) {
      const dict = annots.lookupMaybe(i, PDFDict);
      if (dict) widgetPage.set(dict, index);
    }
  });

  const result: FormFieldInfo[] = [];
  for (const field of fields) {
    try {
      const widgets: FormFieldInfo['widgets'] = [];
      const labels = optionsOf(field);
      for (const [widgetIndex, widget] of field.acroField.getWidgets().entries()) {
        const pageIndex = widgetPage.get(widget.dict);
        const page = pageIndex === undefined ? undefined : pages[pageIndex];
        if (!page || pageIndex === undefined) continue;
        const user = widget.getRectangle();
        // Del espacio del PDF a la vista (con la rotación de la página).
        const view = transformRect(invertMatrix(pageGeometry(page).matrix), user);
        // El estado «activado» de un botón puede ser un índice («0», «1»...) que apunta a la etiqueta de /Opt.
        const onValue =
          field instanceof PDFRadioGroup ? widget.getOnValue()?.decodeText() : undefined;
        const option =
          onValue === undefined
            ? undefined
            : labels.includes(onValue)
              ? onValue
              : (labels[widgetIndex] ?? onValue);
        widgets.push({
          page: pageIndex + 1,
          rect: view,
          ...(option !== undefined ? { option } : {}),
        });
      }
      result.push({
        name: field.getName(),
        type: typeOf(field),
        value: valueOf(field),
        options: optionsOf(field),
        multiline: field instanceof PDFTextField ? field.isMultiline() : false,
        readOnly: field.isReadOnly(),
        required: field.isRequired(),
        widgets,
      });
    } catch {
      // Un campo que no se puede interpretar se omite; el resto sigue funcionando.
    }
  }
  return result;
}

/** Escribe los valores en los campos (los desconocidos se ignoran). Devuelve cuántos se aplicaron. */
export async function fillForm(doc: PDFDocument, values: FormValues): Promise<number> {
  const form = doc.getForm();
  let applied = 0;
  for (const [name, value] of Object.entries(values)) {
    const field = form.getFieldMaybe(name);
    if (!field) continue;
    try {
      if (field instanceof PDFTextField && typeof value === 'string') {
        field.setText(value === '' ? undefined : toWinAnsi(value));
      } else if (field instanceof PDFCheckBox && typeof value === 'boolean') {
        if (value) field.check();
        else field.uncheck();
      } else if (field instanceof PDFRadioGroup && typeof value === 'string') {
        if (value === '') field.clear();
        else field.select(value);
      } else if (field instanceof PDFDropdown || field instanceof PDFOptionList) {
        const chosen = Array.isArray(value)
          ? value
          : typeof value === 'string' && value !== ''
            ? [value]
            : [];
        if (chosen.length === 0) field.clear();
        else field.select(chosen);
      } else {
        continue;
      }
      applied += 1;
    } catch (error) {
      throw new FoliuxError(
        'INVALID_REQUEST',
        `No se pudo escribir el valor del campo «${name}»: ${(error as Error).message}`,
        { cause: error },
      );
    }
  }
  const font = await doc.embedFont(StandardFonts.Helvetica);
  form.updateFieldAppearances(font);
  return applied;
}

const BORDER = rgb(0.35, 0.35, 0.4);
const BACKGROUND = rgb(0.94, 0.96, 1);

/** Crea un campo de formulario nuevo en la posición indicada. */
export async function addFormField(doc: PDFDocument, spec: NewFormField): Promise<void> {
  const problem = validateFieldName(spec.name);
  if (problem) throw new FoliuxError('INVALID_REQUEST', problem);
  const name = spec.name.trim();

  const form = doc.getForm();
  if (form.getFieldMaybe(name)) {
    throw new FoliuxError('INVALID_REQUEST', `Ya hay un campo llamado «${name}».`);
  }
  const page = doc.getPages()[spec.page - 1];
  if (!page) throw new FoliuxError('INVALID_REQUEST', `La página ${spec.page} no existe.`);
  const geometry = pageGeometry(page);
  if (geometry.rotation !== 0) {
    throw new FoliuxError(
      'INVALID_REQUEST',
      'Todavía no se pueden crear campos en páginas giradas. Gira la página a su posición original primero.',
    );
  }
  const box = transformRect(geometry.matrix, spec.rect);
  const common = {
    x: box.x,
    y: box.y,
    width: Math.max(box.width, 8),
    height: Math.max(box.height, 8),
  };
  const style = { ...common, borderWidth: 1, borderColor: BORDER, backgroundColor: BACKGROUND };
  const options = (spec.options ?? []).map((option) => toWinAnsi(option));

  switch (spec.type) {
    case 'text': {
      const field = form.createTextField(name);
      if (spec.multiline) field.enableMultiline();
      if (typeof spec.value === 'string' && spec.value !== '') field.setText(toWinAnsi(spec.value));
      field.addToPage(page, style);
      if (spec.required) field.enableRequired();
      break;
    }
    case 'checkbox': {
      const field = form.createCheckBox(name);
      const side = Math.min(common.width, common.height);
      field.addToPage(page, { ...style, width: side, height: side });
      if (spec.value === true) field.check();
      if (spec.required) field.enableRequired();
      break;
    }
    case 'dropdown':
    case 'list': {
      if (options.length === 0) {
        throw new FoliuxError('INVALID_REQUEST', 'Escribe al menos una opción para la lista.');
      }
      const field =
        spec.type === 'dropdown' ? form.createDropdown(name) : form.createOptionList(name);
      field.addOptions(options);
      field.addToPage(page, style);
      if (typeof spec.value === 'string' && options.includes(spec.value)) field.select(spec.value);
      if (spec.required) field.enableRequired();
      break;
    }
    case 'radio': {
      if (options.length < 2) {
        throw new FoliuxError(
          'INVALID_REQUEST',
          'Un grupo de botones de opción necesita al menos dos opciones.',
        );
      }
      const field = form.createRadioGroup(name);
      // Un botón por opción, apilados dentro del rectángulo dibujado.
      const row = common.height / options.length;
      const side = Math.min(row, common.width, 20);
      options.forEach((option, index) => {
        field.addOptionToPage(option, page, {
          x: common.x,
          y: common.y + common.height - row * (index + 1) + (row - side) / 2,
          width: side,
          height: side,
          borderWidth: 1,
          borderColor: BORDER,
          backgroundColor: BACKGROUND,
        });
      });
      if (typeof spec.value === 'string' && options.includes(spec.value)) field.select(spec.value);
      if (spec.required) field.enableRequired();
      break;
    }
  }
  form.updateFieldAppearances(await doc.embedFont(StandardFonts.Helvetica));
}

export function deleteFormField(doc: PDFDocument, name: string): void {
  const form = doc.getForm();
  const field = form.getFieldMaybe(name);
  if (!field) throw new FoliuxError('INVALID_REQUEST', `No existe el campo «${name}».`);
  form.removeField(field);
}

/** Convierte los campos en contenido fijo de la página. */
export async function flattenForm(doc: PDFDocument): Promise<void> {
  const form = doc.getForm();
  form.updateFieldAppearances(await doc.embedFont(StandardFonts.Helvetica));
  form.flatten();
}

/** ¿Tiene el documento campos de formulario? (comprobación rápida sin abrirlo del todo) */
export function mayContainForm(data: Uint8Array): boolean {
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength).includes('/AcroForm');
}
