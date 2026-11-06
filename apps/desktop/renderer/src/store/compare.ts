import { create } from 'zustand';
import type { Change, Rect } from '@foliux-pdf/core';

export type DiffKind = 'removed' | 'added' | 'changed';

/** Zona resaltada en una página por la comparación. */
export interface DiffMark {
  rect: Rect;
  kind: DiffKind;
  /** Índice del cambio al que pertenece. */
  change: number;
}

interface CompareState {
  status: 'idle' | 'running' | 'done' | 'error';
  progress: number;
  error: string | null;
  /** Pestañas comparadas: A (versión anterior) y B (versión nueva). */
  tabA: string | null;
  tabB: string | null;
  changes: Change[];
  /** Cambio seleccionado en la lista (-1 = ninguno). */
  current: number;
  set: (patch: Partial<Omit<CompareState, 'set' | 'reset'>>) => void;
  reset: () => void;
}

const EMPTY = {
  status: 'idle' as const,
  progress: 0,
  error: null,
  tabA: null,
  tabB: null,
  changes: [] as Change[],
  current: -1,
};

export const useCompare = create<CompareState>((set) => ({
  ...EMPTY,
  set: (patch) => set(patch),
  reset: () => set(EMPTY),
}));

/** Marcas de la comparación en las páginas de una pestaña (A muestra lo eliminado; B, lo añadido). */
export function buildDiffMarks(
  state: Pick<CompareState, 'changes' | 'tabA' | 'tabB'>,
  tabId: string,
): Map<number, DiffMark[]> {
  const byPage = new Map<number, DiffMark[]>();
  const isA = state.tabA === tabId;
  const isB = state.tabB === tabId;
  if (!isA && !isB) return byPage;

  state.changes.forEach((change, index) => {
    const pieces = isA ? change.a : change.b;
    // En A, un cambio «añadido» no tiene nada que marcar; en B, uno «eliminado» tampoco.
    const kind: DiffKind = change.kind;
    for (const piece of pieces) {
      const list = byPage.get(piece.page) ?? [];
      for (const rect of piece.rects) list.push({ rect, kind, change: index });
      byPage.set(piece.page, list);
    }
  });
  return byPage;
}
