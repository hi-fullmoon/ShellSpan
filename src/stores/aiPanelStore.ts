import { create } from 'zustand';

export type AiPanelSection = 'workbench' | 'terminal';

interface AiPanelState {
  panelOpenBySection: Record<AiPanelSection, boolean>;
  setOpen: (open: boolean, section?: AiPanelSection) => void;
  toggleOpen: (section?: AiPanelSection) => void;
}

export const useAiPanelStore = create<AiPanelState>()((set) => ({
  panelOpenBySection: {
    workbench: false,
    terminal: false,
  },
  setOpen: (open, section) => set((state) => ({
    panelOpenBySection: section
      ? { ...state.panelOpenBySection, [section]: open }
      : { workbench: open, terminal: open },
  })),
  toggleOpen: (section) => set((state) => {
    if (!section) {
      const open = !Object.values(state.panelOpenBySection).some(Boolean);
      return { panelOpenBySection: { workbench: open, terminal: open } };
    }
    return {
      panelOpenBySection: {
        ...state.panelOpenBySection,
        [section]: !state.panelOpenBySection[section],
      },
    };
  }),
}));
