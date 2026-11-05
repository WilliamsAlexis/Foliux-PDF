import { useTranslation } from 'react-i18next';
import type { DocTab } from '@/store/docs';
import { selectHit } from '@/lib/actions';
import { cn } from '@/lib/utils';

/** Lista de coincidencias de la búsqueda; pulsar una lleva a su lugar en el documento. */
export function ResultsList({ tab }: { tab: DocTab }) {
  const { t } = useTranslation();
  const { hits, current, status, query } = tab.search;

  if (status === 'idle' && hits.length === 0) {
    return <p className="p-4 text-sm text-muted-foreground">{t('sidebar.noResults')}</p>;
  }
  if (status === 'done' && hits.length === 0) {
    return <p className="p-4 text-sm text-muted-foreground">{t('search.none')}</p>;
  }

  return (
    <ul aria-label={t('sidebar.results')} aria-live="polite" className="p-1.5">
      {hits.map((hit, index) => (
        <li key={index}>
          <button
            type="button"
            aria-current={index === current ? 'true' : undefined}
            onClick={() => selectHit(tab.id, index)}
            className={cn(
              'w-full rounded-md px-2 py-1.5 text-left hover:bg-accent',
              index === current && 'bg-accent',
            )}
          >
            <span className="text-xs font-semibold text-primary">
              {t('sidebar.pageLabel', { page: hit.pageNumber })}
            </span>
            <span className="mt-0.5 block text-[13px] leading-snug text-muted-foreground">
              {hit.before}
              <mark className="rounded-sm bg-yellow-300/70 px-0.5 text-foreground dark:bg-yellow-400/40">
                {hit.match}
              </mark>
              {hit.after}
            </span>
          </button>
        </li>
      ))}
      {hits.length >= 5000 && (
        <li className="p-2 text-xs text-muted-foreground">{t('search.limit', { count: 5000 })}</li>
      )}
      <li className="sr-only">{query}</li>
    </ul>
  );
}
