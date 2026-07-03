import { create } from 'zustand';
import type { AppSection, MyMenuKey } from '../types';

interface AppStoreState {
  activeSection: AppSection;
  myActiveMenu: MyMenuKey;
  sftpSessionIds: string[];
  activeSftpSessionId: string | undefined;
  setActiveSection: (section: AppSection) => void;
  setMyActiveMenu: (menu: MyMenuKey) => void;
  openSftpSession: (sessionId: string) => void;
  closeSftpSession: (sessionId: string) => void;
  setActiveSftpSessionId: (sessionId: string | undefined) => void;
}

const STORAGE_KEY = 'termbridge.appState';

interface PersistedAppState {
  activeSection: AppSection;
  myActiveMenu: MyMenuKey;
}

const DEFAULT_STATE: PersistedAppState = {
  activeSection: 'my',
  myActiveMenu: 'savedConnections',
};

function readPersistedState(): PersistedAppState {
  if (typeof window === 'undefined') return DEFAULT_STATE;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_STATE;
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object') {
      const record = parsed as Record<string, unknown>;
      const activeSection = record.activeSection === 'my' || record.activeSection === 'sftp' || record.activeSection === 'terminal'
        ? record.activeSection
        : DEFAULT_STATE.activeSection;
      const validMenus: MyMenuKey[] = [
        'savedConnections',
        'keychain',
        'portForwards',
        'snippets',
        'knownHosts',
        'logs',
      ];
      const myActiveMenu = validMenus.includes(record.myActiveMenu as MyMenuKey)
        ? (record.myActiveMenu as MyMenuKey)
        : DEFAULT_STATE.myActiveMenu;
      return { activeSection, myActiveMenu };
    }
  } catch {
    // ignore
  }
  return DEFAULT_STATE;
}

function writePersistedState(state: PersistedAppState) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // ignore
  }
}

const persisted = readPersistedState();

export const useAppStore = create<AppStoreState>((set) => ({
  activeSection: persisted.activeSection,
  myActiveMenu: persisted.myActiveMenu,
  sftpSessionIds: [],
  activeSftpSessionId: undefined,
  setActiveSection: (section) =>
    set((state) => {
      const next = { ...state, activeSection: section };
      writePersistedState({ activeSection: section, myActiveMenu: state.myActiveMenu });
      return next;
    }),
  setMyActiveMenu: (menu) =>
    set((state) => {
      const next = { ...state, myActiveMenu: menu };
      writePersistedState({ activeSection: state.activeSection, myActiveMenu: menu });
      return next;
    }),
  openSftpSession: (sessionId) =>
    set((state) => {
      if (state.sftpSessionIds.includes(sessionId)) {
        return { activeSftpSessionId: sessionId };
      }
      const sftpSessionIds = [...state.sftpSessionIds, sessionId];
      return { sftpSessionIds, activeSftpSessionId: sessionId };
    }),
  closeSftpSession: (sessionId) =>
    set((state) => {
      const sftpSessionIds = state.sftpSessionIds.filter((id) => id !== sessionId);
      const activeSftpSessionId =
        state.activeSftpSessionId === sessionId
          ? sftpSessionIds[sftpSessionIds.length - 1]
          : state.activeSftpSessionId;
      return { sftpSessionIds, activeSftpSessionId };
    }),
  setActiveSftpSessionId: (sessionId) => set({ activeSftpSessionId: sessionId }),
}));
