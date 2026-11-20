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
  type DocxPage,
  buildXlsx,
  buildPptx,
  buildTablesXlsx,
  buildDeckPptx,
  imagesToPdf,
} from './node/convert';
export {
  ANTHROPIC_KEY_FORMAT,
  EncryptedKeyStore,
  GEMINI_KEY_FORMAT,
  type KeyCipher,
  type KeyFormat,
} from './node/key-store';
export { convertOfficeToPdf, findLibreOffice, OFFICE_EXTENSIONS } from './node/office';
export {
  AiService,
  mapAiError,
  type AiAssistant,
  type AiClientLike,
  type AiUsage,
} from './node/ai';
export { AiRouter } from './node/ai-router';
export {
  GeminiClient,
  buildGeminiRequest,
  mapGeminiHttpError,
  toGeminiSchema,
} from './node/gemini-client';
export { WorkspaceService } from './node/workspace-service';
export { UpdateManager, describeUpdateError, type UpdaterLike } from './node/update-manager';
