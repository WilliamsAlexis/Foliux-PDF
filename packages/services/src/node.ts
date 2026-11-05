// Punto de entrada para el proceso principal (usa el sistema de archivos de Node).
export { JsonFileStore } from './node/json-file-store';
export { RecentFilesService } from './node/recent-files-service';
export { SettingsService } from './node/settings-service';
export { readPdfFile, MAX_PDF_BYTES } from './node/pdf-file-reader';
