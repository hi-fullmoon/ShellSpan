import { create } from 'zustand';
import { useTerminalStore } from './terminalStore';
import { useAppStore } from './appStore';

const SPLIT_KEY = 'shellspan.focus.split';
function savedSplit(): number {
  try {
    const value = Number(localStorage.getItem(SPLIT_KEY));
    return Number.isFinite(value) && value >= 0.3 && value <= 0.75 ? value : 0.6;
  } catch { return 0.6; }
}

interface FocusState {
  enabled: boolean;
  hasOpened: boolean;
  terminalOpen: boolean;
  targetSessionId: string | null;
  conversationSessionId: string | null;
  busy: boolean;
  split: number;
  enter: () => void;
  leave: () => void;
  setTerminalOpen: (open: boolean) => void;
  setTarget: (sessionId: string) => boolean;
  setBusy: (busy: boolean) => void;
  setConversation: (sessionId: string | null) => void;
  setSplit: (split: number) => void;
}

/** Viewing another terminal never changes the explicit Agent target. */
export const useFocusStore = create<FocusState>()((set, get) => ({
  enabled: false,
  hasOpened: false,
  terminalOpen: true,
  targetSessionId: null,
  conversationSessionId: null,
  busy: false,
  split: savedSplit(),
  enter: () => {
    const terminal = useTerminalStore.getState();
    const current = terminal.sessions.find(s => s.sessionId === terminal.activeSessionId && s.status === 'connected');
    set(state => ({ enabled: true, hasOpened: true,
      targetSessionId: state.hasOpened ? state.targetSessionId : current?.sessionId ?? null }));
    useAppStore.getState().setActiveSection('terminal');
  },
  leave: () => set({ enabled: false }),
  setTerminalOpen: (terminalOpen) => set({ terminalOpen }),
  setTarget: (sessionId) => {
    const state = get();
    if (!state.enabled || state.busy
      || !useTerminalStore.getState().sessions.some(s => s.sessionId === sessionId && s.status === 'connected')) return false;
    set({ targetSessionId: sessionId, terminalOpen: true });
    useTerminalStore.getState().setActiveSession(sessionId);
    return true;
  },
  setBusy: (busy) => set({ busy }),
  setConversation: (conversationSessionId) => set({ conversationSessionId }),
  setSplit: (value) => {
    if (!Number.isFinite(value)) return;
    const split = Math.max(0.3, Math.min(0.75, value));
    set({ split });
    try { localStorage.setItem(SPLIT_KEY, String(split)); } catch { /* Layout remains usable without storage. */ }
  },
}));
