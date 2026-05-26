import { create } from 'zustand';

interface ContextMenuStore {
  activeMenuId: string | null;
  openMenu: (id: string) => void;
  closeMenu: () => void;
}

export const useContextMenuStore = create<ContextMenuStore>((set) => ({
  activeMenuId: null,
  openMenu: (id) => set({ activeMenuId: id }),
  closeMenu: () => set({ activeMenuId: null }),
}));
