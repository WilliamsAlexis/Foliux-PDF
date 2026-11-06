import { Loader2, Minus, Pencil, Plus, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { useDocs } from '@/store/docs';
import { useCompare, type DiffKind } from '@/store/compare';
import { cancelCompare, closeCompare, goToChange, startCompare, stepChange } from '@/lib/compare';
import { cn } from '@/lib/utils';

const KIND_STYLE: Record<DiffKind, { icon: React.ReactNode; className: string }> = {
  removed: {
    icon: <Minus />,
    className: 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300',
  },
  added: {
    icon: <Plus />,
    className: 'bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300',
  },
  changed: {
    icon: <Pencil />,
    className: 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300',
  },
};

const clip = (text: string, max = 90) => (text.length > max ? `${text.slice(0, max)}…` : text);

/** Comparación de dos versiones de un documento: resumen y lista navegable de cambios. */
export function ComparePanel() {
  const { t } = useTranslation();
  const compare = useCompare();
  const tabs = useDocs((s) => s.tabs);
  const nameOf = (id: string | null) => tabs.find((tab) => tab.id === id)?.name ?? '—';

  if (compare.status === 'idle') {
    return (
      <div className="flex flex-col gap-3 p-4 text-sm">
        <p className="text-muted-foreground">{t('compare.intro')}</p>
        <Button onClick={() => void startCompare()}>{t('compare.choose')}</Button>
        <p className="text-xs text-muted-foreground">{t('compare.limits')}</p>
      </div>
    );
  }

  if (compare.status === 'running') {
    return (
      <div className="flex flex-col gap-3 p-4 text-sm" role="status" aria-live="polite">
        <p className="flex items-center gap-2">
          <Loader2 className="size-4 animate-spin" aria-hidden />
          {t('compare.running', { percent: Math.round(compare.progress * 100) })}
        </p>
        <div className="h-1.5 overflow-hidden rounded bg-muted">
          <div className="h-full bg-primary" style={{ width: `${compare.progress * 100}%` }} />
        </div>
        <Button variant="outline" onClick={cancelCompare}>
          {t('dialogs.cancel')}
        </Button>
      </div>
    );
  }

  if (compare.status === 'error') {
    return (
      <div className="flex flex-col gap-3 p-4 text-sm">
        <p role="alert" className="text-destructive">
          {compare.error}
        </p>
        <Button variant="outline" onClick={closeCompare}>
          {t('compare.close')}
        </Button>
      </div>
    );
  }

  const counts = { removed: 0, added: 0, changed: 0 };
  for (const change of compare.changes) counts[change.kind] += 1;

  return (
    <div className="flex flex-col">
      <div className="flex flex-col gap-2 border-b border-border p-3 text-sm">
        <p className="text-xs text-muted-foreground">
          {t('compare.versions', { a: nameOf(compare.tabA), b: nameOf(compare.tabB) })}
        </p>
        {compare.changes.length === 0 ? (
          <p className="font-medium">{t('compare.identical')}</p>
        ) : (
          <p className="font-medium" aria-live="polite">
            {t('compare.summary', {
              total: compare.changes.length,
              removed: counts.removed,
              added: counts.added,
              changed: counts.changed,
            })}
          </p>
        )}
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={compare.changes.length === 0}
            onClick={() => stepChange(-1)}
          >
            {t('compare.previous')}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={compare.changes.length === 0}
            onClick={() => stepChange(1)}
          >
            {t('compare.next')}
          </Button>
          <Button size="sm" variant="ghost" onClick={closeCompare} className="ml-auto">
            <X /> {t('compare.close')}
          </Button>
        </div>
      </div>
      <ul className="flex flex-col p-1.5">
        {compare.changes.map((change, index) => {
          const style = KIND_STYLE[change.kind];
          const page = (change.kind === 'added' ? change.b : change.a)[0]?.page;
          return (
            <li key={index}>
              <button
                type="button"
                onClick={() => goToChange(index)}
                aria-current={compare.current === index ? 'true' : undefined}
                className={cn(
                  'flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent/60',
                  compare.current === index && 'bg-accent',
                )}
              >
                <span
                  aria-hidden
                  className={cn(
                    'mt-0.5 flex size-5 shrink-0 items-center justify-center rounded [&_svg]:size-3.5',
                    style.className,
                  )}
                >
                  {style.icon}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-xs text-muted-foreground tabular-nums">
                    {t(`compare.kinds.${change.kind}`)} · {t('annotations.onPage', { page })}
                  </span>
                  {change.textA ? (
                    <span className="block break-words text-red-700 line-through dark:text-red-300">
                      {clip(change.textA)}
                    </span>
                  ) : null}
                  {change.textB ? (
                    <span className="block break-words text-green-700 dark:text-green-300">
                      {clip(change.textB)}
                    </span>
                  ) : null}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
