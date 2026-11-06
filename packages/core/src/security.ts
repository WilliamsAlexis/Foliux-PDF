import { z } from 'zod';

/**
 * Protección de un documento: contraseñas y permisos (cifrado AES-256 hecho por qpdf).
 * Los permisos son una petición al lector: los programas que respetan el estándar los cumplen,
 * pero nada obliga a un lector ajeno a hacerlo (no son una barrera de seguridad real).
 */
export const PRINT_LEVELS = ['none', 'low', 'full'] as const;
export type PrintLevel = (typeof PRINT_LEVELS)[number];

export const PermissionsSchema = z.object({
  /** Imprimir: nada, baja resolución o completa. */
  print: z.enum(PRINT_LEVELS),
  /** Copiar o extraer texto e imágenes. */
  copy: z.boolean(),
  /** Modificar el documento (editar, anotar, rellenar formularios, reordenar páginas). */
  modify: z.boolean(),
});
export type Permissions = z.infer<typeof PermissionsSchema>;

export const ProtectionSchema = z.object({
  /** Contraseña para abrir el documento (vacía = se abre sin contraseña, solo con permisos). */
  userPassword: z.string().max(127),
  /** Contraseña de propietario: permite saltarse los permisos. */
  ownerPassword: z.string().max(127),
  permissions: PermissionsSchema,
});
export type Protection = z.infer<typeof ProtectionSchema>;

export const FULL_PERMISSIONS: Permissions = { print: 'full', copy: true, modify: true };

export function isRestricted(permissions: Permissions): boolean {
  return permissions.print !== 'full' || !permissions.copy || !permissions.modify;
}

/**
 * Comprueba que una protección se puede aplicar. Devuelve el motivo (en español, para mostrarlo al
 * usuario) o null si es válida.
 */
export function validateProtection(protection: Protection): string | null {
  for (const [label, value] of [
    ['La contraseña de apertura', protection.userPassword],
    ['La contraseña de propietario', protection.ownerPassword],
  ] as const) {
    if (/[\r\n]/.test(value)) return `${label} no puede contener saltos de línea.`;
    // qpdf interpretaría un valor que empieza por «-» como una opción.
    if (value.startsWith('-')) return `${label} no puede empezar por «-».`;
  }
  const restricted = isRestricted(protection.permissions);
  if (protection.userPassword === '' && !restricted) {
    return 'Escribe una contraseña de apertura o restringe algún permiso; así no habría ninguna protección.';
  }
  if (restricted && protection.ownerPassword === '') {
    return 'Para restringir permisos hace falta una contraseña de propietario.';
  }
  return null;
}

/** Lo que un PDF guarda «por debajo» y puede delatar información. */
export const MetadataReportSchema = z.object({
  title: z.string(),
  author: z.string(),
  subject: z.string(),
  keywords: z.string(),
  creator: z.string(),
  producer: z.string(),
  /** Fechas en ISO 8601 o cadena vacía. */
  created: z.string(),
  modified: z.string(),
  /** Metadatos XMP (un bloque XML que repite y amplía los anteriores). */
  hasXmp: z.boolean(),
  /** Páginas con miniatura incrustada. */
  thumbnails: z.number().int(),
  /** Nombres de los archivos adjuntos. */
  attachments: z.array(z.string()),
  hasJavaScript: z.boolean(),
});
export type MetadataReport = z.infer<typeof MetadataReportSchema>;
