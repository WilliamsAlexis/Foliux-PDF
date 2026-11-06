/** Códigos de error que viajan entre procesos y se muestran al usuario. */
export const ERROR_CODES = [
  'FILE_NOT_FOUND',
  'NOT_A_PDF',
  'FILE_TOO_LARGE',
  'PDF_ENCRYPTED',
  /** El PDF está protegido y hace falta una contraseña para abrirlo. */
  'PASSWORD_REQUIRED',
  /** La contraseña indicada no es correcta. */
  'PASSWORD_INVALID',
  /** No se encuentra qpdf (el programa que cifra y descifra). */
  'QPDF_MISSING',
  /** No hay LibreOffice instalado (hace falta para convertir documentos de Office a PDF). */
  'LIBREOFFICE_MISSING',
  /** No hay clave de la API de Claude configurada. */
  'AI_KEY_MISSING',
  /** La clave de la API no es válida o no tiene permiso. */
  'AI_AUTH',
  /** Límite de uso o saturación de la API: probar más tarde. */
  'AI_RATE_LIMIT',
  /** La IA rechazó responder (política de seguridad). */
  'AI_REFUSED',
  /** Otro fallo de la API de Claude. */
  'AI_ERROR',
  'PDF_CORRUPT',
  'IO_ERROR',
  'INVALID_REQUEST',
  'UNTRUSTED_SENDER',
  'UNKNOWN',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/**
 * Error de la aplicación. El `message` está escrito para el usuario final (en español),
 * así que puede mostrarse tal cual en una notificación.
 */
export class FoliuxError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'FoliuxError';
    this.code = code;
  }
}
