import { create } from 'zustand';

export type AiPanelSection = 'workbench' | 'terminal';
export type AiActiveSessionScope = 'workbench' | 'terminal' | 'focus';

interface AiPanelState {
  panelOpenBySection: Record<AiPanelSection, boolean>;
  activeSessionByScope: Record<AiActiveSessionScope, string | null>;
  pendingOpenSessionId: string | null;
  setOpen: (open: boolean, section?: AiPanelSection) => void;
  toggleOpen: (section?: AiPanelSection) => void;
  setActiveSession: (scope: AiActiveSessionScope, sessionId: string | null) => void;
  requestOpenSession: (sessionId: string) => void;
  consumePendingOpenSession: (sessionId: string) => void;
}

export const useAiPanelStore = create<AiPanelState>()((set) => ({
  panelOpenBySection: {
    workbench: false,
    terminal: false,
  },
  activeSessionByScope: {
    workbench: null,
    terminal: null,
    focus: null,
  },
  pendingOpenSessionId: null,
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
  setActiveSession: (scope, sessionId) => set((state) => (
    state.activeSessionByScope[scope] === sessionId
      ? state
      : {
          activeSessionByScope: {
            ...state.activeSessionByScope,
            [scope]: sessionId,
          },
        }
  )),
  requestOpenSession: (sessionId) => set({ pendingOpenSessionId: sessionId }),
  consumePendingOpenSession: (sessionId) => set((state) => (
    state.pendingOpenSessionId === sessionId ? { pendingOpenSessionId: null } : state
  )),
}));
