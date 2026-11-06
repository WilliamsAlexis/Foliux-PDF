import { z } from 'zod';
import { ERROR_CODES } from './errors';
import { THEME_PREFERENCES } from './models';
import { AnnotationListSchema } from './annotations';
import { PageOpSchema } from './page-ops';
import { MetadataReportSchema, ProtectionSchema } from './security';
import { FormFieldInfoSchema } from './forms';
import { WorkspaceViewSchema } from './workspace';
import { UpdateInfoSchema } from './updates';
import { NewDocumentSchema } from './new-document';
import {
  ChatMessageSchema,
  DetectedFieldsSchema,
  ExtractedTablesSchema,
  SensitiveItemsSchema,
  SlideDeckSchema,
} from './ai';
import {
  AuditEntrySchema,
  AuditInputSchema,
  NewCertificateSchema,
  SignatureReportSchema,
} from './signing';

/**
 * Contrato IPC entre el renderer y el proceso principal.
 * Cada canal define el esquema Zod de su petición y de su respuesta; el proceso principal
 * valida SIEMPRE la petición antes de actuar (el renderer no es de confianza).
 */

const AppSettingsSchema = z.object({
  theme: z.enum(THEME_PREFERENCES),
  language: z.string().min(2).max(10),
  aiModel: z.enum(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']),
  autoCheckUpdates: z.boolean(),
});

const RecentFileSchema = z.object({
  path: z.string(),
  name: z.string(),
  openedAt: z.number(),
});

const BytesSchema = z.custom<Uint8Array>((value) => value instanceof Uint8Array);
const SavedFileSchema = z.object({ path: z.string(), name: z.string() });
/** Protección con la que se escribe el archivo (null o ausente = sin proteger). */
const ProtectionField = ProtectionSchema.nullish();

/** Documento que se envía a la IA (siempre lo decide el usuario al pulsar). */
const AiDocumentSchema = z.object({
  /** Identifica la petición para poder cancelarla y recibir su streaming. */
  requestId: z.string().min(1).max(64),
  documentName: z.string().max(300),
  documentText: z.string().max(2_000_000),
  totalPages: z.number().int().min(1),
});
const AiUsageSchema = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number(),
});

export const ipcContract = {
  'dialog:open-pdf': {
    request: z.void(),
    response: z.array(z.string()),
  },
  'file:read': {
    request: z.object({
      path: z.string().min(1).max(4096),
      /** Contraseña para abrir un PDF protegido. */
      password: z.string().max(127).optional(),
    }),
    response: z.object({
      path: z.string(),
      name: z.string(),
      /** Firmas digitales que ya tenía el documento (vacío si no estaba firmado). */
      signatures: z.array(SignatureReportSchema),
      /** Si el PDF estaba protegido: la protección que tenía (se conserva al guardar). */
      protection: ProtectionSchema.nullable(),
      /** Contenido del PDF SIN las anotaciones de Foliux (que viajan aparte, ya editables). */
      data: BytesSchema,
      annotations: AnnotationListSchema,
    }),
  },
  'pdf:save': {
    request: z.object({
      /** Ruta actual del documento (se sobrescribe salvo que `saveAs` sea true). */
      path: z.string().max(4096),
      suggestedName: z.string().max(255),
      saveAs: z.boolean(),
      protection: ProtectionField,
      data: BytesSchema,
      annotations: AnnotationListSchema,
    }),
    /** null si el usuario canceló el diálogo. */
    response: SavedFileSchema.nullable(),
  },
  /** Crea un PDF en blanco (sin guardarlo: queda como documento nuevo en la interfaz). */
  'pdf:create': { request: NewDocumentSchema, response: z.object({ data: BytesSchema }) },
  'pdf:transform': {
    request: z.object({ data: BytesSchema, annotations: AnnotationListSchema, op: PageOpSchema }),
    response: z.object({ data: BytesSchema, annotations: AnnotationListSchema }),
  },
  'pdf:extract': {
    request: z.object({
      data: BytesSchema,
      annotations: AnnotationListSchema,
      pages: z.array(z.number().int().min(1)).min(1).max(100000),
      suggestedName: z.string().max(255),
      protection: ProtectionField,
    }),
    response: SavedFileSchema.nullable(),
  },
  'pdf:merge': { request: z.void(), response: SavedFileSchema.nullable() },
  'pdf:split': {
    request: z.object({
      data: BytesSchema,
      annotations: AnnotationListSchema,
      mode: z.enum(['each', 'every', 'ranges']),
      every: z.number().int().min(1).max(100000).optional(),
      ranges: z.string().max(2000).optional(),
      /** Nombre base de los archivos resultantes (sin extensión). */
      baseName: z.string().min(1).max(200),
      protection: ProtectionField,
    }),
    /** null si se canceló la elección de carpeta. */
    response: z.object({ folder: z.string(), count: z.number().int() }).nullable(),
  },
  'pdf:optimize': {
    request: z.object({
      data: BytesSchema,
      annotations: AnnotationListSchema,
      suggestedName: z.string().max(255),
      protection: ProtectionField,
    }),
    response: z
      .object({
        path: z.string(),
        name: z.string(),
        before: z.number().int(),
        after: z.number().int(),
      })
      .nullable(),
  },
  /** Redacta de forma permanente: sustituye las páginas indicadas por su imagen ya tapada. */
  'pdf:redact': {
    request: z.object({
      data: BytesSchema,
      annotations: AnnotationListSchema,
      pages: z
        .array(
          z.object({
            page: z.number().int().min(1),
            /** Página ya dibujada con las zonas redactadas en negro. */
            image: BytesSchema,
            format: z.enum(['png', 'jpeg']),
            /** Palabras que NO se redactan: se conservan como texto invisible para poder buscar y copiar. */
            words: z
              .array(
                z.object({
                  text: z.string().max(300),
                  x: z.number().finite(),
                  y: z.number().finite(),
                  width: z.number().finite().min(0),
                  height: z.number().finite().min(0),
                }),
              )
              .max(100000),
          }),
        )
        .min(1)
        .max(5000),
    }),
    response: z.object({ data: BytesSchema, annotations: AnnotationListSchema }),
  },
  /** Texto de las páginas → documento de Word o libro de Excel (pide dónde guardar). */
  'convert:pdf-to-office': {
    request: z.object({
      format: z.enum(['docx', 'xlsx']),
      pages: z
        .array(
          z.object({
            words: z
              .array(
                z.object({
                  text: z.string().max(300),
                  x: z.number().finite(),
                  y: z.number().finite(),
                  width: z.number().finite().min(0),
                  height: z.number().finite().min(0),
                }),
              )
              .max(200000),
          }),
        )
        .min(1)
        .max(5000),
      suggestedName: z.string().max(255),
    }),
    response: SavedFileSchema.nullable(),
  },
  /** Imágenes de las páginas → presentación de PowerPoint (una diapositiva por página). */
  'convert:pdf-to-pptx': {
    request: z.object({
      pages: z
        .array(
          z.object({
            image: BytesSchema,
            /** Tamaño de la página en puntos. */
            width: z.number().positive(),
            height: z.number().positive(),
            /** Texto de la página, para las notas de la diapositiva. */
            notes: z.string().max(200000),
          }),
        )
        .min(1)
        .max(2000),
      suggestedName: z.string().max(255),
    }),
    response: SavedFileSchema.nullable(),
  },
  /** Imágenes de las páginas → archivos PNG o JPEG en una carpeta que se elige. */
  'convert:pdf-to-images': {
    request: z.object({
      pages: z
        .array(z.object({ page: z.number().int().min(1), image: BytesSchema }))
        .min(1)
        .max(5000),
      format: z.enum(['png', 'jpeg']),
      baseName: z.string().min(1).max(200),
    }),
    response: z.object({ folder: z.string(), count: z.number().int() }).nullable(),
  },
  /** Elige imágenes y las junta en un PDF nuevo (pide dónde guardar). */
  'convert:images-to-pdf': { request: z.void(), response: SavedFileSchema.nullable() },
  /** Elige un documento de Office y lo convierte a PDF con LibreOffice (pide dónde guardar). */
  'convert:office-to-pdf': { request: z.void(), response: SavedFileSchema.nullable() },
  'convert:office-status': {
    request: z.void(),
    response: z.object({ libreOffice: z.boolean() }),
  },
  /** Prepara el documento para archivado (PDF/A, mejor esfuerzo) y guarda una copia. */
  'pdf:pdfa': {
    request: z.object({
      data: BytesSchema,
      annotations: AnnotationListSchema,
      suggestedName: z.string().max(255),
    }),
    response: z
      .object({
        path: z.string(),
        name: z.string(),
        issues: z.array(z.object({ code: z.string(), message: z.string(), blocking: z.boolean() })),
        fixed: z.array(z.string()),
      })
      .nullable(),
  },
  /** Aplica una acción a unos bytes sin diálogos (para el procesamiento por lotes). */
  'pdf:process': {
    request: z.object({
      data: BytesSchema,
      annotations: AnnotationListSchema.optional(),
      action: z.enum(['optimize', 'pdfa', 'clean-metadata', 'protect', 'watermark', 'bake']),
      protection: ProtectionField,
      watermarkText: z.string().max(500).optional(),
    }),
    response: z.object({ data: BytesSchema, note: z.string() }),
  },
  /** Elige una carpeta. */
  'dialog:choose-folder': { request: z.void(), response: z.string().nullable() },
  /** Guarda un resultado en una carpeta con un nombre libre (no sobrescribe). */
  'pdf:write-copy': {
    request: z.object({
      data: BytesSchema,
      folder: z.string().min(1),
      name: z.string().min(1).max(255),
    }),
    response: SavedFileSchema,
  },
  // ---- Actualizaciones de la aplicación ----
  'update:status': { request: z.void(), response: UpdateInfoSchema },
  'update:check': { request: z.void(), response: UpdateInfoSchema },
  'update:download': { request: z.void(), response: z.void() },
  'update:install': { request: z.void(), response: z.void() },

  // ---- Fase 8: espacios de trabajo ----
  'workspace:list': { request: z.void(), response: z.array(WorkspaceViewSchema) },
  'workspace:create': {
    request: z.object({ name: z.string().max(200) }),
    response: WorkspaceViewSchema,
  },
  'workspace:rename': {
    request: z.object({ id: z.string().min(1).max(64), name: z.string().max(200) }),
    response: WorkspaceViewSchema,
  },
  'workspace:delete': { request: z.object({ id: z.string().min(1).max(64) }), response: z.void() },
  'workspace:add': {
    request: z.object({
      id: z.string().min(1).max(64),
      paths: z.array(z.string().min(1).max(1000)).min(1).max(200),
    }),
    response: WorkspaceViewSchema,
  },
  'workspace:remove': {
    request: z.object({ id: z.string().min(1).max(64), path: z.string().min(1).max(1000) }),
    response: WorkspaceViewSchema,
  },

  // ---- Fase 7: asistente de IA ----
  'ai:status': {
    request: z.void(),
    response: z.object({
      configured: z.boolean(),
      /** ¿El sistema ofrece almacenamiento cifrado para la clave? Sin él, no se guarda. */
      secureStorage: z.boolean(),
      model: z.string(),
    }),
  },
  'ai:set-key': { request: z.object({ key: z.string().min(20).max(400) }), response: z.void() },
  'ai:clear-key': { request: z.void(), response: z.void() },
  'ai:cancel': { request: z.object({ requestId: z.string().min(1).max(64) }), response: z.void() },
  /** Conversación con el documento; la respuesta llega además troceada por el evento ai-chunk. */
  'ai:chat': {
    request: AiDocumentSchema.extend({
      history: z.array(ChatMessageSchema).max(200),
      question: z.string().min(1).max(50000),
      /** El texto reúne varios documentos de un espacio de trabajo (cambia cómo se citan). */
      workspace: z.boolean().optional(),
    }),
    response: z.object({ text: z.string(), usage: AiUsageSchema, truncated: z.boolean() }),
  },
  'ai:extract-tables': { request: AiDocumentSchema, response: ExtractedTablesSchema },
  'ai:detect-fields': { request: AiDocumentSchema, response: DetectedFieldsSchema },
  'ai:find-sensitive': { request: AiDocumentSchema, response: SensitiveItemsSchema },
  'ai:make-slides': {
    request: AiDocumentSchema.extend({ slideCount: z.number().int().min(3).max(40) }),
    response: SlideDeckSchema,
  },
  'ai:audio-summary': {
    request: AiDocumentSchema.extend({ language: z.string().min(2).max(40) }),
    response: z.object({ text: z.string() }),
  },
  'ai:export-tables': {
    request: z.object({
      tables: ExtractedTablesSchema.shape.tables,
      suggestedName: z.string().max(255),
    }),
    response: SavedFileSchema.nullable(),
  },
  'ai:export-slides': {
    request: z.object({ deck: SlideDeckSchema, suggestedName: z.string().max(255) }),
    response: SavedFileSchema.nullable(),
  },
  /** Campos de formulario del documento. */
  'pdf:form-fields': {
    request: z.object({ data: BytesSchema }),
    response: z.array(FormFieldInfoSchema),
  },
  /** Comprueba las firmas digitales de un documento. */
  'pdf:verify': {
    request: z.object({ data: BytesSchema }),
    response: z.array(SignatureReportSchema),
  },
  /** Firma digitalmente y guarda una copia firmada (pide dónde). */
  'pdf:sign': {
    request: z.object({
      data: BytesSchema,
      annotations: AnnotationListSchema,
      /** Certificado en formato PKCS#12 (.p12 / .pfx). */
      certificate: BytesSchema,
      passphrase: z.string().max(127),
      reason: z.string().max(300),
      location: z.string().max(300),
      contact: z.string().max(300),
      suggestedName: z.string().max(255),
    }),
    response: z
      .object({ path: z.string(), name: z.string(), signatures: z.array(SignatureReportSchema) })
      .nullable(),
  },
  'dialog:open-certificate': {
    request: z.void(),
    response: z.object({ name: z.string(), data: BytesSchema }).nullable(),
  },
  /** Crea un certificado autofirmado y lo guarda como .p12 (pide dónde). */
  'cert:create': {
    request: NewCertificateSchema,
    response: z.object({ path: z.string(), name: z.string(), fingerprint: z.string() }).nullable(),
  },
  'audit:list': {
    request: z.void(),
    response: z.object({ entries: z.array(AuditEntrySchema), chainOk: z.boolean() }),
  },
  /** Exporta el registro de auditoría a CSV (pide dónde). */
  'audit:export': { request: z.void(), response: SavedFileSchema.nullable() },
  /** Anota un evento (lo usa la interfaz para las firmas visuales). */
  'audit:record': { request: AuditInputSchema, response: z.void() },
  /** Qué metadatos y datos ocultos contiene el documento. */
  'pdf:metadata': { request: z.object({ data: BytesSchema }), response: MetadataReportSchema },
  'dialog:open-image': {
    request: z.void(),
    response: z
      .object({ name: z.string(), format: z.enum(['png', 'jpeg']), data: BytesSchema })
      .nullable(),
  },
  'recent:list': { request: z.void(), response: z.array(RecentFileSchema) },
  'recent:remove': { request: z.object({ path: z.string().min(1) }), response: z.void() },
  'recent:clear': { request: z.void(), response: z.void() },
  'settings:get': { request: z.void(), response: AppSettingsSchema },
  'settings:update': { request: AppSettingsSchema.partial(), response: AppSettingsSchema },
  'window:toggle-fullscreen': { request: z.void(), response: z.boolean() },
  'window:set-fullscreen': { request: z.object({ value: z.boolean() }), response: z.boolean() },
  'app:pending-files': { request: z.void(), response: z.array(z.string()) },
  'log:write': {
    request: z.object({
      level: z.enum(['info', 'warn', 'error']),
      message: z.string().max(5000),
    }),
    response: z.void(),
  },
} as const;

export type IpcChannel = keyof typeof ipcContract;
export type IpcRequest<C extends IpcChannel> = z.input<(typeof ipcContract)[C]['request']>;
export type IpcResponse<C extends IpcChannel> = z.output<(typeof ipcContract)[C]['response']>;

/** Eventos que el proceso principal envía al renderer. */
export const ipcEvents = {
  openFiles: 'event:open-files',
  fullscreenChanged: 'event:fullscreen-changed',
  updateChanged: 'event:update-changed',
  aiChunk: 'event:ai-chunk',
} as const;

/** Resultado envuelto: así los errores llegan al renderer con código y mensaje claros. */
export const IpcErrorSchema = z.object({
  code: z.enum(ERROR_CODES),
  message: z.string(),
});

export type IpcResult<T> =
  { ok: true; value: T } | { ok: false; error: z.infer<typeof IpcErrorSchema> };
