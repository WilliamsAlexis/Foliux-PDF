import { create } from 'zustand';
import type { UpdateState } from '@foliux-pdf/core';

interface UpdateStore {
  current: string;
  state: UpdateState;
  autoCheck: boolean;
  dialogOpen: boolean;
  set: (patch: Partial<Pick<UpdateStore, 'current' | 'state' | 'autoCheck'>>) => void;
  setDialogOpen: (open: boolean) => void;
}

export const useUpdate = create<UpdateStore>()((set) => ({
  current: '',
  state: { state: 'idle' },
  autoCheck: true,
  dialogOpen: false,
  set: (patch) => set(patch),
  setDialogOpen: (dialogOpen) => set({ dialogOpen }),
}));
