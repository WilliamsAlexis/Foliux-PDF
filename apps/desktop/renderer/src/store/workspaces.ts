import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { WorkspaceView } from '@foliux-pdf/core';

interface WorkspaceState {
  workspaces: WorkspaceView[];
  /** Espacio que se está viendo (se recuerda entre sesiones). */
  activeId: string | null;
  loaded: boolean;
  setWorkspaces: (workspaces: WorkspaceView[]) => void;
  upsert: (workspace: WorkspaceView) => void;
  setActiveId: (id: string | null) => void;
}

/** Espacios de trabajo: la lista vive en el proceso principal; aquí solo su copia para pintarla. */
export const useWorkspaces = create<WorkspaceState>()(
  persist(
    (set) => ({
      workspaces: [],
      activeId: null,
      loaded: false,
      setWorkspaces: (workspaces) =>
        set((s) => ({
          workspaces,
          loaded: true,
          activeId: workspaces.some((w) => w.id === s.activeId)
            ? s.activeId
            : (workspaces[0]?.id ?? null),
        })),
      upsert: (workspace) =>
        set((s) => ({
          workspaces: s.workspaces.some((w) => w.id === workspace.id)
            ? s.workspaces.map((w) => (w.id === workspace.id ? workspace : w))
            : [...s.workspaces, workspace],
        })),
      setActiveId: (activeId) => set({ activeId }),
    }),
    { name: 'foliux-workspaces', partialize: (s) => ({ activeId: s.activeId }) },
  ),
);

export const getActiveWorkspace = (): WorkspaceView | undefined => {
  const { workspaces, activeId } = useWorkspaces.getState();
  return workspaces.find((w) => w.id === activeId);
};
