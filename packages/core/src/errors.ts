/** Códigos de error que viajan entre procesos y se muestran al usuario. */
export const ERROR_CODES = [
  'FILE_NOT_FOUND',
  'NOT_A_PDF',
  'FILE_TOO_LARGE',
  'PDF_ENCRYPTED',
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
