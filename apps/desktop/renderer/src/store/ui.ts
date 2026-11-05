import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { RecentFile, ThemePreference, ViewMode } from '@foliux-pdf/core';

export type SidebarTab = 'thumbnails' | 'outline' | 'results';

interface UiState {
  sidebarOpen: boolean;
  sidebarTab: SidebarTab;
  viewMode: ViewMode;
  fullscreen: boolean;
  searchOpen: boolean;
  paletteOpen: boolean;
  /** Se está arrastrando un archivo sobre la ventana. */
  dragging: boolean;
  theme: ThemePreference;
  recent: RecentFile[];

  setSidebarOpen: (open: boolean) => void;
  toggleSidebar: () => void;
  setSidebarTab: (tab: SidebarTab) => void;
  setViewMode: (mode: ViewMode) => void;
  setFullscreen: (value: boolean) => void;
  setSearchOpen: (open: boolean) => void;
  setPaletteOpen: (open: boolean) => void;
  setDragging: (value: boolean) => void;
  setTheme: (theme: ThemePreference) => void;
  setRecent: (items: RecentFile[]) => void;
}

/** Estado de la interfaz. Solo el modo de lectura y la barra lateral se recuerdan entre sesiones. */
export const useUi = create<UiState>()(
  persist(
    (set) => ({
      sidebarOpen: true,
      sidebarTab: 'thumbnails',
      viewMode: 'continuous',
      fullscreen: false,
      searchOpen: false,
      paletteOpen: false,
      dragging: false,
      theme: 'system',
      recent: [],

      setSidebarOpen: (sidebarOpen) => set({ sidebarOpen }),
      toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
      setSidebarTab: (sidebarTab) => set({ sidebarTab, sidebarOpen: true }),
      setViewMode: (viewMode) => set({ viewMode }),
      setFullscreen: (fullscreen) => set({ fullscreen }),
      setSearchOpen: (searchOpen) => set({ searchOpen }),
      setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
      setDragging: (dragging) => set({ dragging }),
      setTheme: (theme) => set({ theme }),
      setRecent: (recent) => set({ recent }),
    }),
    {
      name: 'foliux-ui',
      partialize: (s) => ({
        sidebarOpen: s.sidebarOpen,
        sidebarTab: s.sidebarTab,
        viewMode: s.viewMode,
      }),
    },
  ),
);
