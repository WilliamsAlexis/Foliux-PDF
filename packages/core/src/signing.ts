import { z } from 'zod';

/** Firmas digitales: informe de verificación y registro de auditoría. */

export const SignatureReportSchema = z.object({
  /** Número de orden de la firma en el documento (1, 2...). */
  index: z.number().int(),
  /** Nombre común del firmante (CN del certificado). */
  signer: z.string(),
  issuer: z.string(),
  /** Fecha de la firma (ISO 8601) o cadena vacía si no consta. */
  signedAt: z.string(),
  reason: z.string(),
  location: z.string(),
  /**
   * valid: el contenido firmado no cambió y la firma es correcta.
   * modified: el documento cambió dentro de lo firmado.
   * invalid: la firma no se corresponde con el certificado.
   * unreadable: no se pudo interpretar.
   */
  integrity: z.enum(['valid', 'modified', 'invalid', 'unreadable']),
  /** ¿La firma cubre el documento completo, o se añadió contenido después de firmar? */
  coversWholeDocument: z.boolean(),
  selfSigned: z.boolean(),
  /** El certificado estaba caducado en el momento de firmar. */
  expiredWhenSigned: z.boolean(),
  /** Huella SHA-256 del certificado (hexadecimal). */
  fingerprint: z.string(),
  /** Avisos legibles (certificado autofirmado, no verificado ante una autoridad...). */
  notes: z.array(z.string()),
});
export type SignatureReport = z.infer<typeof SignatureReportSchema>;

export const AUDIT_ACTIONS = [
  'visual-signature',
  'digital-signature',
  'signature-check',
  'certificate-created',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export const AuditEntrySchema = z.object({
  /** Número correlativo (1, 2...). */
  id: z.number().int(),
  /** Momento (ISO 8601). */
  time: z.string(),
  action: z.enum(AUDIT_ACTIONS),
  /** Nombre del archivo afectado. */
  file: z.string(),
  /** SHA-256 del archivo resultante (hexadecimal) o cadena vacía. */
  fileHash: z.string(),
  signer: z.string(),
  detail: z.string(),
  /** Hash de la entrada anterior: encadena el registro para detectar manipulaciones. */
  prevHash: z.string(),
  hash: z.string(),
});
export type AuditEntry = z.infer<typeof AuditEntrySchema>;

/** Lo que el llamador aporta al registrar un evento (el resto lo rellena el registro). */
export type AuditInput = Pick<AuditEntry, 'action' | 'file' | 'fileHash' | 'signer' | 'detail'>;

export const AuditInputSchema = AuditEntrySchema.pick({
  action: true,
  file: true,
  fileHash: true,
  signer: true,
  detail: true,
}).extend({
  file: z.string().max(500),
  fileHash: z.string().max(128),
  signer: z.string().max(300),
  detail: z.string().max(2000),
});

/** Datos para crear un certificado autofirmado. */
export const NewCertificateSchema = z.object({
  commonName: z.string().min(1).max(100),
  organization: z.string().max(100),
  email: z.string().max(100),
  days: z.number().int().min(1).max(3650),
  passphrase: z.string().min(1).max(127),
});
export type NewCertificate = z.infer<typeof NewCertificateSchema>;
