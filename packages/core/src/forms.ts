import { z } from 'zod';

/**
 * Formularios (AcroForm). Los campos se leen del PDF, se rellenan encima de la página con la interfaz de
 * Foliux y los valores se escriben en el PDF al guardar o al aplicar otra operación. No se admiten
 * formularios XFA (los de Adobe LiveCycle).
 */

export const FORM_FIELD_TYPES = [
  'text',
  'checkbox',
  'radio',
  'dropdown',
  'list',
  'button',
  'signature',
] as const;
export type FormFieldType = (typeof FORM_FIELD_TYPES)[number];

/** Tipos de campo que se pueden crear desde Foliux. */
export const CREATABLE_FIELD_TYPES = ['text', 'checkbox', 'radio', 'dropdown', 'list'] as const;
export type CreatableFieldType = (typeof CREATABLE_FIELD_TYPES)[number];

/** Valor de un campo: texto, marcado/desmarcado, o la(s) opción(es) elegida(s). */
export const FormValueSchema = z.union([
  z.string().max(100000),
  z.boolean(),
  z.array(z.string().max(1000)).max(1000),
]);
export type FormValue = z.infer<typeof FormValueSchema>;

export const FormValuesSchema = z.record(z.string().min(1).max(300), FormValueSchema);
export type FormValues = z.infer<typeof FormValuesSchema>;

const RectSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().finite().min(0),
  height: z.number().finite().min(0),
});

export const FormFieldInfoSchema = z.object({
  name: z.string(),
  type: z.enum(FORM_FIELD_TYPES),
  value: FormValueSchema,
  /** Opciones de una lista, un desplegable o un grupo de botones de opción. */
  options: z.array(z.string()),
  multiline: z.boolean(),
  readOnly: z.boolean(),
  required: z.boolean(),
  /** Dónde se dibuja el campo (uno por cada aparición; un grupo de opciones tiene varias). */
  widgets: z.array(
    z.object({
      page: z.number().int().min(1),
      /** Rectángulo en unidades de la vista (origen arriba-izquierda). */
      rect: RectSchema,
      /** Opción que representa este botón (solo botones de opción). */
      option: z.string().optional(),
    }),
  ),
});
export type FormFieldInfo = z.infer<typeof FormFieldInfoSchema>;

/** Especificación de un campo nuevo. */
export const NewFormFieldSchema = z.object({
  type: z.enum(CREATABLE_FIELD_TYPES),
  name: z.string().min(1).max(100),
  page: z.number().int().min(1),
  /** Rectángulo en unidades de la vista. */
  rect: RectSchema,
  /** Opciones (desplegable, lista y botones de opción). */
  options: z.array(z.string().min(1).max(200)).max(200).default([]),
  multiline: z.boolean().default(false),
  required: z.boolean().default(false),
  /** Valor inicial. */
  value: FormValueSchema.optional(),
});
export type NewFormField = z.input<typeof NewFormFieldSchema>;

/** Nombre válido para un campo (el punto separa niveles de jerarquía en PDF). */
export function validateFieldName(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed === '') return 'Escribe un nombre para el campo.';
  if (trimmed.includes('.')) return 'El nombre del campo no puede contener puntos.';
  if (trimmed.length > 100) return 'El nombre del campo es demasiado largo.';
  return null;
}
