import { create } from 'zustand';

/**
 * Estado de la barra de acciones. La «herramienta activa» del lienzo es `tool` de la interfaz (store/ui.ts);
 * aquí solo se guarda qué acción tiene desplegada su barra secundaria (null = ninguna: contraída).
 */
interface RibbonState {
  activeAction: string | null;
  /** Despliega una acción; pulsar la que ya está activa la contrae. */
  toggle: (id: string) => void;
  collapse: () => void;
}

export const useRibbon = create<RibbonState>()((set) => ({
  activeAction: null,
  toggle: (id) => set((s) => ({ activeAction: s.activeAction === id ? null : id })),
  collapse: () => set({ activeAction: null }),
}));
