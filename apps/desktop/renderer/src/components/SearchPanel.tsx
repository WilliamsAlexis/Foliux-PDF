import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, Loader2, Search, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { DocTab } from '@/store/docs';
import { useUi } from '@/store/ui';
import { cancelSearch, runSearch, stepHit } from '@/lib/actions';
import { IconButton } from '@/components/IconButton';

/** Panel flotante de búsqueda (Ctrl+F). La búsqueda es asíncrona, muestra progreso y se puede cancelar. */
export function SearchPanel({ tab }: { tab: DocTab }) {
  const { t } = useTranslation();
  const setSearchOpen = useUi((s) => s.setSearchOpen);
  const setSidebarTab = useUi((s) => s.setSidebarTab);
  const inputRef = useRef<HTMLInputElement>(null);
  const [text, setText] = useState(tab.search.query);
  const { status, progress, hits, current } = tab.search;

  // Al cambiar de pestaña se muestra la consulta de esa pestaña.
  useEffect(() => setText(tab.search.query), [tab.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Foco al abrir y con Ctrl+F
  useEffect(() => {
    const focus = () => {
      inputRef.current?.focus();
      inputRef.current?.select();
    };
    focus();
    window.addEventListener('foliux:focus-search', focus);
    return () => window.removeEventListener('foliux:focus-search', focus);
  }, []);

  // Búsqueda mientras se escribe (con una pausa de 350 ms para no buscar en cada tecla).
  useEffect(() => {
    if (text === tab.search.query) return;
    const timer = window.setTimeout(() => {
      void runSearch(tab.id, text);
      if (text.trim()) setSidebarTab('results');
    }, 350);
    return () => window.clearTimeout(timer);
  }, [text, tab.id, tab.search.query, setSidebarTab]);

  const close = () => {
    cancelSearch(tab.id);
    void runSearch(tab.id, ''); // limpia los resaltados
    setText('');
    setSearchOpen(false);
  };

  return (
    <div
      role="search"
      className="absolute top-3 right-4 z-10 flex w-[360px] max-w-[calc(100%-2rem)] flex-col overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-lg"
    >
      <div className="flex items-center gap-1 p-1.5">
        <Search className="mx-1.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
        <input
          ref={inputRef}
          value={text}
          aria-label={t('search.label')}
          placeholder={t('search.placeholder')}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              if (text !== tab.search.query) void runSearch(tab.id, text);
              else stepHit(e.shiftKey ? -1 : 1);
            } else if (e.key === 'Escape') {
              e.stopPropagation();
              close();
            }
          }}
          className="h-8 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        />
        <span
          className="shrink-0 px-1 text-xs text-muted-foreground tabular-nums"
          aria-live="polite"
        >
          {status === 'running' ? (
            <Loader2
              className="size-3.5 animate-spin"
              aria-label={t('search.running', { percent: Math.round(progress * 100) })}
            />
          ) : hits.length > 0 ? (
            t('search.count', { current: current + 1, total: hits.length })
          ) : status === 'done' ? (
            t('search.none')
          ) : null}
        </span>
        <IconButton
          label={t('search.previous')}
          shortcut="shift+f3"
          icon={<ChevronUp />}
          disabled={hits.length === 0}
          onClick={() => stepHit(-1)}
          className="size-7"
        />
        <IconButton
          label={t('search.next')}
          shortcut="f3"
          icon={<ChevronDown />}
          disabled={hits.length === 0}
          onClick={() => stepHit(1)}
          className="size-7"
        />
        {status === 'running' ? (
          <IconButton
            label={t('search.cancel')}
            icon={<X />}
            onClick={() => cancelSearch(tab.id)}
            className="size-7"
          />
        ) : (
          <IconButton
            label={t('search.close')}
            shortcut="escape"
            icon={<X />}
            onClick={close}
            className="size-7"
          />
        )}
      </div>
      {status === 'running' && (
        <div
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(progress * 100)}
          className="h-0.5 w-full bg-muted"
        >
          <div
            className="h-full bg-primary transition-[width]"
            style={{ width: `${progress * 100}%` }}
          />
        </div>
      )}
    </div>
  );
}
