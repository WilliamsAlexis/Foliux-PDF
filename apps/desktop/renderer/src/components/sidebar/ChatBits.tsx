import { useTranslation } from 'react-i18next';

/**
 * Citas que escribe la IA: «[p. 3]» en un documento y «[nombre.pdf, p. 3]» en un espacio de trabajo.
 * Captura: (1) nombre del documento, si lo hay; (2) las páginas.
 */
const CITATION = /^\[(?:([^\][]{1,200}?),\s*)?p\.?\s?([\d,\s–-]+)\]$/;
const SPLITTER = /(\*\*[^*]+\*\*|\[(?:[^\][]{1,200}?,\s*)?p\.?\s?[\d,\s–-]+\])/g;

/** Convierte «**negrita**» y las citas de una respuesta en elementos; el resto, texto tal cual. */
export function RichText({
  text,
  onCite,
}: {
  text: string;
  /** Se llama al pulsar una cita; `doc` es null si la cita no nombra documento. */
  onCite: (page: number, doc: string | null) => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      {text.split(SPLITTER).map((part, index) => {
        if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
          return <strong key={index}>{part.slice(2, -2)}</strong>;
        }
        const citation = CITATION.exec(part);
        if (citation) {
          const doc = citation[1]?.trim() || null;
          const pages = [...new Set(citation[2]?.match(/\d+/g) ?? [])].slice(0, 6);
          return (
            <span key={index} className="mx-0.5 inline-flex gap-0.5 align-baseline">
              {pages.map((page) => (
                <button
                  key={page}
                  type="button"
                  title={t('ai.goToPage', { page })}
                  onClick={() => onCite(Number(page), doc)}
                  className="rounded bg-accent px-1 text-[11px] font-medium text-accent-foreground hover:underline"
                >
                  {doc ? `${doc}, p. ${page}` : `p. ${page}`}
                </button>
              ))}
            </span>
          );
        }
        return <span key={index}>{part}</span>;
      })}
    </>
  );
}

export function Bubble({
  role,
  children,
}: {
  role: 'user' | 'assistant';
  children: React.ReactNode;
}) {
  return (
    <div
      className={
        role === 'user'
          ? 'ml-6 self-end rounded-lg bg-primary px-2.5 py-1.5 text-sm whitespace-pre-wrap text-primary-foreground'
          : 'mr-2 self-start rounded-lg bg-muted px-2.5 py-1.5 text-sm whitespace-pre-wrap'
      }
    >
      {children}
    </div>
  );
}
