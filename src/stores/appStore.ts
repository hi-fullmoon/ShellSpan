import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { changeLocale } from '@/locales';
import type { AppSection, Locale, ShortcutAction, ShortcutBindings, TerminalCursorStyle, TerminalFontFamily, ThemeMode, WorkbenchTab } from '@/types';

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
  startupSection: AppSection;
  terminalFontSize: number;
  terminalFontFamily: TerminalFontFamily;
  terminalCursorBlink: boolean;
  terminalCursorStyle: TerminalCursorStyle;
  terminalCopyOnSelect: boolean;
  terminalScrollback: number;
  sftpShowHiddenFiles: boolean;
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
  setStartupSection: (section: AppSection) => void;
  setTerminalFontSize: (fontSize: number) => void;
  setTerminalFontFamily: (fontFamily: TerminalFontFamily) => void;
  setTerminalCursorBlink: (enabled: boolean) => void;
  setTerminalCursorStyle: (cursorStyle: TerminalCursorStyle) => void;
  setTerminalCopyOnSelect: (enabled: boolean) => void;
  setTerminalScrollback: (lines: number) => void;
  setSftpShowHiddenFiles: (enabled: boolean) => void;
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
        startupSection: parsed.startupSection ?? 'workbench',
        terminalFontSize: parsed.terminalFontSize ?? 14,
        terminalFontFamily: parsed.terminalFontFamily ?? 'system',
        terminalCursorBlink: parsed.terminalCursorBlink ?? true,
        terminalCursorStyle: parsed.terminalCursorStyle ?? 'block',
        terminalCopyOnSelect: parsed.terminalCopyOnSelect ?? true,
        terminalScrollback: parsed.terminalScrollback ?? 10000,
        sftpShowHiddenFiles: parsed.sftpShowHiddenFiles ?? true,
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
    startupSection: 'workbench',
    terminalFontSize: 14,
    terminalFontFamily: 'system',
    terminalCursorBlink: true,
    terminalCursorStyle: 'block',
    terminalCopyOnSelect: true,
    terminalScrollback: 10000,
    sftpShowHiddenFiles: true,
    shortcuts: DEFAULT_SHORTCUTS,
  };
}

const initial = readInitialPreferences();

export const useAppStore = create<AppState>()(
  persist(
    (set) => ({
      ...initial,
      activeSection: initial.startupSection,
      activeWorkbenchTab: 'connections',
      setActiveSection: (section) => set({ activeSection: section }),
      setActiveWorkbenchTab: (activeWorkbenchTab) => set({ activeWorkbenchTab }),
      setTheme: (theme) => set({ theme }),
      setLocale: (locale) => {
        void changeLocale(locale);
        set({ locale });
      },
      setStartupUpdateCheck: (startupUpdateCheck) => set({ startupUpdateCheck }),
      setStartupSection: (startupSection) => set({ startupSection }),
      setTerminalFontSize: (terminalFontSize) => set({ terminalFontSize }),
      setTerminalFontFamily: (terminalFontFamily) => set({ terminalFontFamily }),
      setTerminalCursorBlink: (terminalCursorBlink) => set({ terminalCursorBlink }),
      setTerminalCursorStyle: (terminalCursorStyle) => set({ terminalCursorStyle }),
      setTerminalCopyOnSelect: (terminalCopyOnSelect) => set({ terminalCopyOnSelect }),
      setTerminalScrollback: (terminalScrollback) => set({ terminalScrollback }),
      setSftpShowHiddenFiles: (sftpShowHiddenFiles) => set({ sftpShowHiddenFiles }),
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
        startupSection: state.startupSection,
        terminalFontSize: state.terminalFontSize,
        terminalFontFamily: state.terminalFontFamily,
        terminalCursorBlink: state.terminalCursorBlink,
        terminalCursorStyle: state.terminalCursorStyle,
        terminalCopyOnSelect: state.terminalCopyOnSelect,
        terminalScrollback: state.terminalScrollback,
        sftpShowHiddenFiles: state.sftpShowHiddenFiles,
        shortcuts: state.shortcuts,
      }),
      onRehydrateStorage: () => (state) => {
        if (state) state.setActiveSection(state.startupSection);
      },
    },
  ),
);
