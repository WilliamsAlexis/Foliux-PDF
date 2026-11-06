import type { Annotation } from './annotations';
import type { PageOp } from './page-ops';
import type { AppSettings, PageWord, PdfFile, RecentFile, SavedFile } from './models';
import type { FormFieldInfo } from './forms';
import type { WorkspaceView } from './workspace';
import type { UpdateInfo, UpdateState } from './updates';
import type { NewDocumentSpec } from './new-document';
import type { ChatMessage, DetectedFields, ExtractedTables, SensitiveItems, SlideDeck } from './ai';
import type { MetadataReport, Protection } from './security';
import type { AuditEntry, AuditInput, NewCertificate, SignatureReport } from './signing';

export type Unsubscribe = () => void;

/** Documento que se envía a la IA. */
export interface AiDocumentRequest {
  requestId: string;
  documentName: string;
  documentText: string;
  totalPages: number;
}

/** PDF abierto: `data` no incluye las anotaciones de Foliux (vienen en `annotations`, ya editables). */
export interface OpenedPdf extends PdfFile {
  annotations: Annotation[];
  /** Firmas digitales que ya tenía el documento. */
  signatures: SignatureReport[];
  /** Protección que tenía el archivo (null si no estaba protegido). */
  protection: Protection | null;
}

/** API que el preload expone en `window.foliux`. Es lo único que el renderer puede pedirle al sistema. */
export interface FoliuxApi {
  readonly platform: string;
  /** Ruta real de un archivo soltado en la ventana (File ya no expone `path` en Electron moderno). */
  getPathForFile(file: File): string;
  openPdfDialog(): Promise<string[]>;
  readPdf(path: string, password?: string): Promise<OpenedPdf>;
  /** Elige una imagen (PNG o JPEG) del disco. Devuelve null si se cancela. */
  /** Elige un certificado (.p12 / .pfx). */
  chooseFolder(): Promise<string | null>;
  updates: {
    status(): Promise<UpdateInfo>;
    check(): Promise<UpdateInfo>;
    download(): Promise<void>;
    /** Cierra la aplicación, instala la versión descargada y la reabre. */
    install(): Promise<void>;
    onChange(callback: (state: UpdateState) => void): Unsubscribe;
  };
  workspaces: {
    list(): Promise<WorkspaceView[]>;
    create(name: string): Promise<WorkspaceView>;
    rename(id: string, name: string): Promise<WorkspaceView>;
    delete(id: string): Promise<void>;
    addDocuments(id: string, paths: string[]): Promise<WorkspaceView>;
    removeDocument(id: string, path: string): Promise<WorkspaceView>;
  };
  ai: {
    status(): Promise<{ configured: boolean; secureStorage: boolean; model: string }>;
    setKey(key: string): Promise<void>;
    clearKey(): Promise<void>;
    cancel(requestId: string): Promise<void>;
    chat(request: {
      requestId: string;
      documentName: string;
      documentText: string;
      totalPages: number;
      history: ChatMessage[];
      question: string;
      workspace?: boolean;
    }): Promise<{
      text: string;
      usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number };
      truncated: boolean;
    }>;
    extractTables(request: AiDocumentRequest): Promise<ExtractedTables>;
    detectFields(request: AiDocumentRequest): Promise<DetectedFields>;
    findSensitive(request: AiDocumentRequest): Promise<SensitiveItems>;
    makeSlides(request: AiDocumentRequest & { slideCount: number }): Promise<SlideDeck>;
    audioSummary(request: AiDocumentRequest & { language: string }): Promise<{ text: string }>;
    exportTables(request: {
      tables: ExtractedTables['tables'];
      suggestedName: string;
    }): Promise<SavedFile | null>;
    exportSlides(request: { deck: SlideDeck; suggestedName: string }): Promise<SavedFile | null>;
    /** Recibe, troceada, la respuesta de una conversación en curso. */
    onChunk(callback: (chunk: { requestId: string; delta: string }) => void): Unsubscribe;
  };
  openCertificateDialog(): Promise<{ name: string; data: Uint8Array } | null>;
  audit: {
    list(): Promise<{ entries: AuditEntry[]; chainOk: boolean }>;
    exportCsv(): Promise<SavedFile | null>;
    record(input: AuditInput): Promise<void>;
  };
  certificate: {
    create(
      request: NewCertificate,
    ): Promise<{ path: string; name: string; fingerprint: string } | null>;
  };
  openImageDialog(): Promise<{ name: string; format: 'png' | 'jpeg'; data: Uint8Array } | null>;
  pdf: {
    /** Crea un PDF en blanco con el tamaño y el número de páginas indicados. */
    create(spec: NewDocumentSpec): Promise<{ data: Uint8Array }>;
    /** Guarda el documento incluyendo las anotaciones. Devuelve null si se canceló el diálogo. */
    save(request: {
      path: string;
      suggestedName: string;
      saveAs: boolean;
      protection: Protection | null;
      data: Uint8Array;
      annotations: Annotation[];
    }): Promise<SavedFile | null>;
    /** Aplica una operación de páginas y devuelve el documento resultante. */
    transform(request: {
      data: Uint8Array;
      annotations: Annotation[];
      op: PageOp;
    }): Promise<{ data: Uint8Array; annotations: Annotation[] }>;
    /** Guarda las páginas indicadas como un PDF nuevo (pide dónde). */
    extract(request: {
      data: Uint8Array;
      annotations: Annotation[];
      pages: number[];
      suggestedName: string;
      protection: Protection | null;
    }): Promise<SavedFile | null>;
    /** Elige varios PDFs y los une en uno nuevo (pide dónde guardarlo). */
    merge(): Promise<SavedFile | null>;
    /** Divide el documento en varios archivos dentro de una carpeta que se elige. */
    split(request: {
      data: Uint8Array;
      annotations: Annotation[];
      mode: 'each' | 'every' | 'ranges';
      every?: number;
      ranges?: string;
      baseName: string;
      protection: Protection | null;
    }): Promise<{ folder: string; count: number } | null>;
    /** Guarda una copia optimizada (sin pérdida) y devuelve los tamaños antes y después. */
    optimize(request: {
      data: Uint8Array;
      annotations: Annotation[];
      suggestedName: string;
      protection: Protection | null;
    }): Promise<{ path: string; name: string; before: number; after: number } | null>;
    /** Sustituye las páginas indicadas por su imagen ya redactada (eliminación permanente). */
    redact(request: {
      data: Uint8Array;
      annotations: Annotation[];
      pages: {
        page: number;
        image: Uint8Array;
        format: 'png' | 'jpeg';
        words: { text: string; x: number; y: number; width: number; height: number }[];
      }[];
    }): Promise<{ data: Uint8Array; annotations: Annotation[] }>;
    /** Texto de las páginas → Word o Excel. */
    toOffice(request: {
      format: 'docx' | 'xlsx';
      pages: { words: PageWord[] }[];
      suggestedName: string;
    }): Promise<SavedFile | null>;
    /** Imágenes de las páginas → PowerPoint. */
    toPresentation(request: {
      pages: { image: Uint8Array; width: number; height: number; notes: string }[];
      suggestedName: string;
    }): Promise<SavedFile | null>;
    /** Imágenes de las páginas → archivos en una carpeta. */
    toImages(request: {
      pages: { page: number; image: Uint8Array }[];
      format: 'png' | 'jpeg';
      baseName: string;
    }): Promise<{ folder: string; count: number } | null>;
    /** Elige imágenes y las junta en un PDF. */
    fromImages(): Promise<SavedFile | null>;
    /** Elige un documento de Office y lo convierte a PDF (necesita LibreOffice). */
    fromOffice(): Promise<SavedFile | null>;
    officeStatus(): Promise<{ libreOffice: boolean }>;
    /** Prepara el documento para archivado (PDF/A, mejor esfuerzo). */
    pdfa(request: { data: Uint8Array; annotations: Annotation[]; suggestedName: string }): Promise<{
      path: string;
      name: string;
      issues: { code: string; message: string; blocking: boolean }[];
      fixed: string[];
    } | null>;
    /** Aplica una acción sin diálogos (lotes). */
    process(request: {
      data: Uint8Array;
      annotations?: Annotation[];
      action: 'optimize' | 'pdfa' | 'clean-metadata' | 'protect' | 'watermark' | 'bake';
      protection?: Protection | null;
      watermarkText?: string;
    }): Promise<{ data: Uint8Array; note: string }>;
    /** Guarda un resultado en una carpeta con un nombre libre. */
    writeCopy(request: { data: Uint8Array; folder: string; name: string }): Promise<SavedFile>;
    /** Campos de formulario del documento. */
    formFields(request: { data: Uint8Array }): Promise<FormFieldInfo[]>;
    /** Comprueba las firmas digitales. */
    verify(request: { data: Uint8Array }): Promise<SignatureReport[]>;
    /** Firma digitalmente y guarda una copia firmada. */
    sign(request: {
      data: Uint8Array;
      annotations: Annotation[];
      certificate: Uint8Array;
      passphrase: string;
      reason: string;
      location: string;
      contact: string;
      suggestedName: string;
    }): Promise<{ path: string; name: string; signatures: SignatureReport[] } | null>;
    /** Qué metadatos y datos ocultos tiene el documento. */
    metadata(request: { data: Uint8Array }): Promise<MetadataReport>;
  };
  recent: {
    list(): Promise<RecentFile[]>;
    remove(path: string): Promise<void>;
    clear(): Promise<void>;
  };
  settings: {
    get(): Promise<AppSettings>;
    update(patch: Partial<AppSettings>): Promise<AppSettings>;
  };
  window: {
    toggleFullscreen(): Promise<boolean>;
    setFullscreen(value: boolean): Promise<boolean>;
  };
  /** Archivos recibidos antes de que la interfaz estuviera lista (asociación de archivos, línea de comandos). */
  getPendingFiles(): Promise<string[]>;
  onOpenFiles(callback: (paths: string[]) => void): Unsubscribe;
  onFullscreenChange(callback: (isFullscreen: boolean) => void): Unsubscribe;
  log(level: 'info' | 'warn' | 'error', message: string): void;
}
