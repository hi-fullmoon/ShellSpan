import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { AppSection, Locale, ShortcutAction, ShortcutBindings, ThemeMode, WorkbenchTab } from '@/types';

export const DEFAULT_SHORTCUTS: ShortcutBindings = {
  openWorkbench: 'mod+1',
  openTerminal: 'mod+2',
  openSftp: 'mod+3',
  openSettings: 'mod+,',
};

interface AppPreferences {
  theme: ThemeMode;
  locale: Locale;
  startupUpdateCheck: boolean;
  terminalFontSize: number;
  terminalCursorBlink: boolean;
  terminalCopyOnSelect: boolean;
  terminalScrollback: number;
  shortcuts: ShortcutBindings;
}

interface AppState extends AppPreferences {
  activeSection: AppSection;
  activeWorkbenchTab: WorkbenchTab;
  setActiveSection: (section: AppSection) => void;
  setActiveWorkbenchTab: (tab: WorkbenchTab) => void;
  setTheme: (theme: ThemeMode) => void;
  setLocale: (locale: Locale) => void;
  setStartupUpdateCheck: (enabled: boolean) => void;
  setTerminalFontSize: (fontSize: number) => void;
  setTerminalCursorBlink: (enabled: boolean) => void;
  setTerminalCopyOnSelect: (enabled: boolean) => void;
  setTerminalScrollback: (lines: number) => void;
  setShortcut: (action: ShortcutAction, shortcut: string) => void;
  resetShortcut: (action: ShortcutAction) => void;
  resetShortcuts: () => void;
}

const STORAGE_KEY = 'termbridge.preferences';

function readInitialPreferences(): AppPreferences {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<AppPreferences>;
      return {
        theme: parsed.theme ?? 'system',
        locale: parsed.locale ?? 'zh-CN',
        startupUpdateCheck: parsed.startupUpdateCheck ?? true,
        terminalFontSize: parsed.terminalFontSize ?? 14,
        terminalCursorBlink: parsed.terminalCursorBlink ?? true,
        terminalCopyOnSelect: parsed.terminalCopyOnSelect ?? true,
        terminalScrollback: parsed.terminalScrollback ?? 10000,
        shortcuts: { ...DEFAULT_SHORTCUTS, ...parsed.shortcuts },
      };
    }
  } catch {
    // ignore
  }
  return {
    theme: 'system',
    locale: 'zh-CN',
    startupUpdateCheck: true,
    terminalFontSize: 14,
    terminalCursorBlink: true,
    terminalCopyOnSelect: true,
    terminalScrollback: 10000,
    shortcuts: DEFAULT_SHORTCUTS,
  };
}

const initial = readInitialPreferences();

export const useAppStore = create<AppState>()(
  persist(
    (set) => ({
      ...initial,
      activeSection: 'workbench',
      activeWorkbenchTab: 'connections',
      setActiveSection: (section) => set({ activeSection: section }),
      setActiveWorkbenchTab: (activeWorkbenchTab) => set({ activeWorkbenchTab }),
      setTheme: (theme) => set({ theme }),
      setLocale: (locale) => set({ locale }),
      setStartupUpdateCheck: (startupUpdateCheck) => set({ startupUpdateCheck }),
      setTerminalFontSize: (terminalFontSize) => set({ terminalFontSize }),
      setTerminalCursorBlink: (terminalCursorBlink) => set({ terminalCursorBlink }),
      setTerminalCopyOnSelect: (terminalCopyOnSelect) => set({ terminalCopyOnSelect }),
      setTerminalScrollback: (terminalScrollback) => set({ terminalScrollback }),
      setShortcut: (action, shortcut) =>
        set((state) => ({ shortcuts: { ...state.shortcuts, [action]: shortcut } })),
      resetShortcut: (action) =>
        set((state) => ({
          shortcuts: { ...state.shortcuts, [action]: DEFAULT_SHORTCUTS[action] },
        })),
      resetShortcuts: () => set({ shortcuts: { ...DEFAULT_SHORTCUTS } }),
    }),
    {
      name: STORAGE_KEY,
      partialize: (state) => ({
        theme: state.theme,
        locale: state.locale,
        startupUpdateCheck: state.startupUpdateCheck,
        terminalFontSize: state.terminalFontSize,
        terminalCursorBlink: state.terminalCursorBlink,
        terminalCopyOnSelect: state.terminalCopyOnSelect,
        terminalScrollback: state.terminalScrollback,
        shortcuts: state.shortcuts,
      }),
    },
  ),
);
