import type { LucideIcon } from 'lucide-react';
import {
  Archive,
  ArrowUpRight,
  BadgeCheck,
  CalendarDays,
  Circle,
  Copy,
  Crop,
  Download,
  Eraser,
  EyeOff,
  FileCode,
  FileInput,
  FilePlus2,
  FileSpreadsheet,
  FileStack,
  FileText,
  FileType,
  Highlighter,
  Image,
  ImagePlus,
  Layers,
  LayoutGrid,
  Link,
  Lock,
  Mail,
  MessageSquare,
  Minus,
  MousePointer2,
  Pencil,
  PenLine,
  PenTool,
  Presentation,
  Printer,
  Redo2,
  RotateCcw,
  RotateCw,
  ScanText,
  Scissors,
  ShieldOff,
  Square,
  Stamp,
  StickyNote,
  Strikethrough,
  TextCursorInput,
  Trash2,
  Type,
  Underline,
  Undo2,
} from 'lucide-react';
import { toast } from 'sonner';
import type { Annotation } from '@foliux-pdf/core';
import i18n from '@/i18n';
import type { DocTab } from '@/store/docs';
import { useUi, type ConvertFormat, type Tool } from '@/store/ui';
import {
  deletePages,
  deleteSelectedAnnotation,
  duplicatePages,
  extractSelectedPages,
  insertBlankPage,
  insertPagesFromFile,
  mergeFiles,
  redo,
  rotatePages,
  undo,
} from '@/lib/edit';
import { importImages, importOffice } from '@/lib/convert';
import { downloadCopy, printDocument, shareByMail } from '@/lib/share';
import { armDate } from '@/lib/stamps';
import { saveActive } from '@/lib/edit';

/**
 * Configuración de la barra de acciones. Para añadir una función nueva basta con añadir una entrada
 * aquí (y sus textos en es.json): la barra la dibuja sola. Ver «Cómo añadir una acción» en el README.
 */

/** Lo que una herramienta necesita saber del documento para decidir si está disponible. */
export interface RibbonContext {
  tab: DocTab;
  /** Anotación seleccionada en el lienzo, si hay. */
  selectedAnnotation: Annotation | undefined;
  /** Páginas elegidas en las miniaturas. */
  selectedPages: number[];
}

/** Qué debe haber seleccionado para que la herramienta se pueda usar. */
export type RibbonSelection = 'anotacion' | 'paginas';

export interface RibbonTool {
  id: string;
  /** Clave de traducción del texto (y del tooltip). */
  etiqueta: string;
  icono: LucideIcon;
  /** Qué hace al pulsarla. */
  accion: (context: RibbonContext) => void | Promise<void>;
  /** Si es una herramienta del lienzo, cuál: se muestra pulsada mientras esté activa. */
  herramienta?: Tool;
  requiereSeleccion?: RibbonSelection;
  /** Atajo de teclado en formato 'mod+shift+k' (solo para mostrarlo en el tooltip). */
  atajo?: string;
  /** Condición extra para deshabilitarla (además de la selección). */
  deshabilitada?: (context: RibbonContext) => boolean;
  /** Función aún sin implementar: se muestra deshabilitada y avisa al pulsarla. */
  pendiente?: boolean;
  /** Línea separadora delante de la herramienta. */
  separadorAntes?: boolean;
}

export interface RibbonAction {
  id: string;
  etiqueta: string;
  icono: LucideIcon;
  herramientas: RibbonTool[];
  /** Muestra a la derecha el color, el grosor y la tipografía (para las herramientas de anotación). */
  mostrarEstilo?: boolean;
}

// ---------------------------------------------------------------------------
// Ayudas para definir herramientas
// ---------------------------------------------------------------------------

const ui = () => useUi.getState();

/** Activa una herramienta del lienzo y, si hace falta, explica cómo usarla. */
function activateTool(tool: Tool, hint?: string): () => void {
  return () => {
    ui().setTool(tool);
    if (hint) toast(i18n.t(hint), { id: hint });
  };
}

function openDialog(dialog: NonNullable<ReturnType<typeof ui>['toolDialog']>): () => void {
  return () => ui().setToolDialog(dialog);
}

function convertTo(format: ConvertFormat): () => void {
  return () => {
    ui().setConvertFormat(format);
    ui().setToolDialog('convertOptions');
  };
}

const canvasTool = (
  id: string,
  icono: LucideIcon,
  herramienta: Tool,
  atajo?: string,
  hint?: string,
): RibbonTool => ({
  id,
  etiqueta: `ribbon.tools.${id}`,
  icono,
  herramienta,
  atajo,
  accion: activateTool(herramienta, hint),
});

const undoRedo: RibbonTool[] = [
  {
    id: 'undo',
    etiqueta: 'ribbon.tools.undo',
    icono: Undo2,
    atajo: 'mod+z',
    separadorAntes: true,
    deshabilitada: ({ tab }) => tab.history.length === 0,
    accion: () => void undo(),
  },
  {
    id: 'redo',
    etiqueta: 'ribbon.tools.redo',
    icono: Redo2,
    atajo: 'mod+shift+z',
    deshabilitada: ({ tab }) => tab.future.length === 0,
    accion: () => void redo(),
  },
];

// ---------------------------------------------------------------------------
// Las acciones principales y sus herramientas
// ---------------------------------------------------------------------------

export const RIBBON: RibbonAction[] = [
  {
    id: 'editar',
    etiqueta: 'ribbon.actions.editar',
    icono: Pencil,
    mostrarEstilo: true,
    herramientas: [
      canvasTool('select', MousePointer2, 'select', 'v'),
      canvasTool('edittext', PenLine, 'edittext', 'e', 'annotations.editTextHint'),
      canvasTool('text', TextCursorInput, 'text', 'x'),
      canvasTool('image', ImagePlus, 'image', 'i', 'annotations.imageHint'),
      canvasTool('link', Link, 'link', undefined, 'link.hint'),
      canvasTool('crop', Crop, 'crop', undefined, 'crop.hint'),
      {
        id: 'rotate',
        etiqueta: 'ribbon.tools.rotate',
        icono: RotateCw,
        atajo: 'mod+]',
        accion: () => void rotatePages(90),
      },
      { ...canvasTool('highlight', Highlighter, 'highlight', 'h'), separadorAntes: true },
      canvasTool('underline', Underline, 'underline', 'u'),
      canvasTool('strikeout', Strikethrough, 'strikeout', 's'),
      { ...canvasTool('ink', Pencil, 'ink', 'd'), separadorAntes: true },
      canvasTool('rect', Square, 'rect', 'r'),
      canvasTool('ellipse', Circle, 'ellipse', 'o'),
      canvasTool('line', Minus, 'line', 'l'),
      canvasTool('arrow', ArrowUpRight, 'arrow', 'a'),
      {
        id: 'delete',
        etiqueta: 'ribbon.tools.delete',
        icono: Trash2,
        atajo: 'delete',
        requiereSeleccion: 'anotacion',
        separadorAntes: true,
        accion: () => deleteSelectedAnnotation(),
      },
      ...undoRedo,
    ],
  },
  {
    id: 'firmar',
    etiqueta: 'ribbon.actions.firmar',
    icono: PenTool,
    herramientas: [
      {
        id: 'createSignature',
        etiqueta: 'ribbon.tools.createSignature',
        icono: PenTool,
        accion: openDialog('signature'),
      },
      {
        id: 'savedSignatures',
        etiqueta: 'ribbon.tools.savedSignatures',
        icono: Layers,
        accion: openDialog('signature'),
      },
      {
        id: 'placeSignature',
        etiqueta: 'ribbon.tools.placeSignature',
        icono: PenLine,
        herramienta: 'signature',
        atajo: 'm',
        accion: () => {
          // La firma se elige primero (dibujar, escribir o imagen) y luego se coloca con un clic.
          if (!ui().pendingSignature) ui().setToolDialog('signature');
          else {
            ui().setTool('signature');
            toast(i18n.t('signing.placeHint'), { id: 'signature-hint' });
          }
        },
      },
      {
        ...canvasTool('moveSignature', MousePointer2, 'select', 'v', 'ribbon.moveSignatureHint'),
        separadorAntes: true,
      },
      { id: 'date', etiqueta: 'ribbon.tools.date', icono: CalendarDays, accion: () => armDate() },
      {
        id: 'initials',
        etiqueta: 'ribbon.tools.initials',
        icono: Type,
        accion: openDialog('initials'),
      },
      {
        id: 'digitalSignature',
        etiqueta: 'ribbon.tools.digitalSignature',
        icono: BadgeCheck,
        separadorAntes: true,
        accion: openDialog('sign'),
      },
      {
        id: 'signaturesPanel',
        etiqueta: 'ribbon.tools.signaturesPanel',
        icono: FileText,
        accion: () => ui().setSidebarTab('signatures'),
      },
      ...undoRedo,
    ],
  },
  {
    id: 'comentar',
    etiqueta: 'ribbon.actions.comentar',
    icono: MessageSquare,
    mostrarEstilo: true,
    herramientas: [
      canvasTool('select', MousePointer2, 'select', 'v'),
      canvasTool('note', StickyNote, 'note', 'n'),
      canvasTool('freetext', MessageSquare, 'freetext', 't'),
      { ...canvasTool('highlight', Highlighter, 'highlight', 'h'), separadorAntes: true },
      canvasTool('underline', Underline, 'underline', 'u'),
      canvasTool('strikeout', Strikethrough, 'strikeout', 's'),
      {
        id: 'stamp',
        etiqueta: 'ribbon.tools.stamp',
        icono: Stamp,
        separadorAntes: true,
        accion: openDialog('stamp'),
      },
      {
        id: 'delete',
        etiqueta: 'ribbon.tools.delete',
        icono: Trash2,
        atajo: 'delete',
        requiereSeleccion: 'anotacion',
        separadorAntes: true,
        accion: () => deleteSelectedAnnotation(),
      },
      ...undoRedo,
    ],
  },
  {
    id: 'convertir',
    etiqueta: 'ribbon.actions.convertir',
    icono: FileType,
    herramientas: [
      { id: 'toWord', etiqueta: 'ribbon.tools.toWord', icono: FileText, accion: convertTo('docx') },
      {
        id: 'toExcel',
        etiqueta: 'ribbon.tools.toExcel',
        icono: FileSpreadsheet,
        accion: convertTo('xlsx'),
      },
      {
        id: 'toPowerPoint',
        etiqueta: 'ribbon.tools.toPowerPoint',
        icono: Presentation,
        accion: convertTo('pptx'),
      },
      {
        id: 'toImages',
        etiqueta: 'ribbon.tools.toImages',
        icono: Image,
        accion: convertTo('images'),
      },
      { id: 'toText', etiqueta: 'ribbon.tools.toText', icono: FileType, accion: convertTo('txt') },
      { id: 'toHtml', etiqueta: 'ribbon.tools.toHtml', icono: FileCode, accion: convertTo('html') },
      {
        id: 'fromImages',
        etiqueta: 'ribbon.tools.fromImages',
        icono: FileInput,
        separadorAntes: true,
        accion: () => void importImages(),
      },
      {
        id: 'fromOffice',
        etiqueta: 'ribbon.tools.fromOffice',
        icono: FileInput,
        accion: () => void importOffice(),
      },
      {
        id: 'ocr',
        etiqueta: 'ribbon.tools.ocr',
        icono: ScanText,
        separadorAntes: true,
        accion: openDialog('ocr'),
      },
      { id: 'pdfa', etiqueta: 'ribbon.tools.pdfa', icono: Archive, accion: openDialog('pdfa') },
      { id: 'batch', etiqueta: 'ribbon.tools.batch', icono: Layers, accion: openDialog('batch') },
    ],
  },
  {
    id: 'organizar',
    etiqueta: 'ribbon.actions.organizar',
    icono: LayoutGrid,
    herramientas: [
      {
        id: 'thumbnails',
        etiqueta: 'ribbon.tools.thumbnails',
        icono: LayoutGrid,
        accion: () => {
          ui().setSidebarTab('thumbnails');
          toast(i18n.t('ribbon.thumbnailsHint'), { id: 'thumbs-hint' });
        },
      },
      {
        id: 'rotateLeft',
        etiqueta: 'ribbon.tools.rotateLeft',
        icono: RotateCcw,
        atajo: 'mod+[',
        separadorAntes: true,
        accion: () => void rotatePages(-90),
      },
      {
        id: 'rotateRight',
        etiqueta: 'ribbon.tools.rotateRight',
        icono: RotateCw,
        atajo: 'mod+]',
        accion: () => void rotatePages(90),
      },
      {
        id: 'deletePages',
        etiqueta: 'ribbon.tools.deletePages',
        icono: Trash2,
        requiereSeleccion: 'paginas',
        accion: () => void deletePages(),
      },
      {
        id: 'extractPages',
        etiqueta: 'ribbon.tools.extractPages',
        icono: FileInput,
        requiereSeleccion: 'paginas',
        accion: () => void extractSelectedPages(),
      },
      {
        id: 'duplicatePages',
        etiqueta: 'ribbon.tools.duplicatePages',
        icono: Copy,
        accion: () => void duplicatePages(),
      },
      {
        id: 'insertBlank',
        etiqueta: 'ribbon.tools.insertBlank',
        icono: FilePlus2,
        separadorAntes: true,
        accion: () => void insertBlankPage(),
      },
      {
        id: 'insertFile',
        etiqueta: 'ribbon.tools.insertFile',
        icono: FilePlus2,
        accion: () => void insertPagesFromFile(),
      },
      {
        id: 'split',
        etiqueta: 'ribbon.tools.split',
        icono: Scissors,
        separadorAntes: true,
        accion: openDialog('split'),
      },
      {
        id: 'merge',
        etiqueta: 'ribbon.tools.merge',
        icono: FileStack,
        accion: () => void mergeFiles(),
      },
      ...undoRedo,
    ],
  },
  {
    id: 'proteger',
    etiqueta: 'ribbon.actions.proteger',
    icono: Lock,
    mostrarEstilo: false,
    herramientas: [
      {
        id: 'password',
        etiqueta: 'ribbon.tools.password',
        icono: Lock,
        accion: openDialog('security'),
      },
      {
        id: 'watermark',
        etiqueta: 'ribbon.tools.watermark',
        icono: Stamp,
        accion: openDialog('watermark'),
      },
      {
        id: 'markRedact',
        etiqueta: 'ribbon.tools.markRedact',
        icono: EyeOff,
        herramienta: 'redact',
        atajo: 'k',
        separadorAntes: true,
        accion: activateTool('redact', 'annotations.redactHint'),
      },
      {
        id: 'applyRedact',
        etiqueta: 'ribbon.tools.applyRedact',
        icono: Eraser,
        accion: openDialog('redact'),
      },
      {
        id: 'metadata',
        etiqueta: 'ribbon.tools.metadata',
        icono: ShieldOff,
        separadorAntes: true,
        accion: openDialog('metadata'),
      },
      ...undoRedo,
    ],
  },
  {
    id: 'compartir',
    etiqueta: 'ribbon.actions.compartir',
    icono: Download,
    herramientas: [
      {
        id: 'save',
        etiqueta: 'ribbon.tools.save',
        icono: Download,
        atajo: 'mod+s',
        accion: () => void saveActive(),
      },
      {
        id: 'download',
        etiqueta: 'ribbon.tools.download',
        icono: Download,
        atajo: 'mod+shift+s',
        accion: () => void downloadCopy(),
      },
      {
        id: 'print',
        etiqueta: 'ribbon.tools.print',
        icono: Printer,
        atajo: 'mod+p',
        accion: () => void printDocument(),
      },
      { id: 'mail', etiqueta: 'ribbon.tools.mail', icono: Mail, accion: () => void shareByMail() },
    ],
  },
];
