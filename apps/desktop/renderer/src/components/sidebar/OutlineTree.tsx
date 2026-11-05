import { useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { OutlineItem } from '@foliux-pdf/core';
import { useDocs, type DocTab } from '@/store/docs';
import { cn } from '@/lib/utils';

/** Marcadores (índice) del documento, en árbol plegable. */
export function OutlineTree({ tab }: { tab: DocTab }) {
  const { t } = useTranslation();
  const goToPage = useDocs((s) => s.goToPage);

  if (!tab.outline || tab.outline.length === 0) {
    return <p className="p-4 text-sm text-muted-foreground">{t('sidebar.noOutline')}</p>;
  }
  return (
    <ul role="tree" aria-label={t('sidebar.outline')} className="p-2">
      {tab.outline.map((item, index) => (
        <OutlineNode
          key={index}
          item={item}
          depth={0}
          onSelect={(page) => goToPage(tab.id, page)}
        />
      ))}
    </ul>
  );
}

function OutlineNode({
  item,
  depth,
  onSelect,
}: {
  item: OutlineItem;
  depth: number;
  onSelect: (page: number) => void;
}) {
  const [expanded, setExpanded] = useState(depth === 0);
  const hasChildren = item.children.length > 0;

  return (
    <li role="treeitem" aria-expanded={hasChildren ? expanded : undefined} aria-selected={false}>
      <div className="flex items-center" style={{ paddingLeft: depth * 12 }}>
        {hasChildren ? (
          <button
            type="button"
            aria-label={expanded ? 'Contraer' : 'Expandir'}
            onClick={() => setExpanded((value) => !value)}
            className="flex size-6 shrink-0 items-center justify-center rounded hover:bg-accent"
          >
            <ChevronRight
              className={cn('size-3.5 transition-transform', expanded && 'rotate-90')}
              aria-hidden
            />
          </button>
        ) : (
          <span className="size-6 shrink-0" aria-hidden />
        )}
        <button
          type="button"
          disabled={item.pageNumber === null}
          onClick={() => item.pageNumber !== null && onSelect(item.pageNumber)}
          className="min-w-0 flex-1 truncate rounded px-1.5 py-1 text-left text-[13px] hover:bg-accent disabled:cursor-default disabled:opacity-60 disabled:hover:bg-transparent"
          title={item.title}
        >
          {item.title}
        </button>
        {item.pageNumber !== null && (
          <span className="shrink-0 pr-1 text-xs text-muted-foreground tabular-nums">
            {item.pageNumber}
          </span>
        )}
      </div>
      {hasChildren && expanded && (
        <ul role="group">
          {item.children.map((child, index) => (
            <OutlineNode key={index} item={child} depth={depth + 1} onSelect={onSelect} />
          ))}
        </ul>
      )}
    </li>
  );
}
