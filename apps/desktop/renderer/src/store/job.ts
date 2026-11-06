import { create } from 'zustand';

/**
 * Trabajo largo en curso que se puede cancelar (rasterizar páginas para redactar, comparar documentos...).
 * La capa de «ocupado» muestra el botón «Cancelar» mientras haya uno.
 */
interface JobState {
  cancel: (() => void) | null;
  setCancel: (cancel: (() => void) | null) => void;
}

export const useJob = create<JobState>((set) => ({
  cancel: null,
  setCancel: (cancel) => set({ cancel }),
}));
