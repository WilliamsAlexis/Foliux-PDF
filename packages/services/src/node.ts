// Punto de entrada para el proceso principal (usa el sistema de archivos de Node).
export { JsonFileStore } from './node/json-file-store';
export { RecentFilesService } from './node/recent-files-service';
export { SettingsService } from './node/settings-service';
export { readPdfFile, MAX_PDF_BYTES } from './node/pdf-file-reader';
export { writePdfFile } from './node/pdf-file-writer';
export * from './pdf-edit';
export { QpdfService, parsePermissions } from './node/qpdf';
export {
  signPdf,
  verifySignatures,
  mayContainSignatures,
  createSelfSignedCertificate,
} from './node/signing';
export { AuditLogService, auditToCsv, verifyChain, hashEntry, sha256 } from './node/audit-log';
export {
  buildDocx,
  buildXlsx,
  buildPptx,
  buildTablesXlsx,
  buildDeckPptx,
  imagesToPdf,
} from './node/convert';
export { EncryptedKeyStore, type KeyCipher } from './node/key-store';
export { convertOfficeToPdf, findLibreOffice, OFFICE_EXTENSIONS } from './node/office';
export { AiService, mapAiError, type AiClientLike, type AiUsage } from './node/ai';
export { WorkspaceService } from './node/workspace-service';
export { UpdateManager, describeUpdateError, type UpdaterLike } from './node/update-manager';
