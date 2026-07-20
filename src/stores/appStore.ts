import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { changeLocale } from '@/locales';
import type { AppSection, Locale, SftpConflictPolicy, ShortcutAction, ShortcutBindings, TerminalColorScheme, TerminalCursorStyle, TerminalFontFamily, ThemeMode, WorkbenchTab } from '@/types';

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
  terminalColorScheme: TerminalColorScheme;
  terminalMultiLinePasteWarning: boolean;
  terminalLargePasteWarning: boolean;
  terminalAutoReconnect: boolean;
  confirmBeforeExit: boolean;
  restoreWorkspace: boolean;
  sftpShowHiddenFiles: boolean;
  sftpConflictPolicy: SftpConflictPolicy;
  sftpRetryCount: number;
  sftpDownloadDirectory: string;
  sftpCompletionNotification: boolean;
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
  setTerminalColorScheme: (scheme: TerminalColorScheme) => void;
  setTerminalMultiLinePasteWarning: (enabled: boolean) => void;
  setTerminalLargePasteWarning: (enabled: boolean) => void;
  setTerminalAutoReconnect: (enabled: boolean) => void;
  setConfirmBeforeExit: (enabled: boolean) => void;
  setRestoreWorkspace: (enabled: boolean) => void;
  setSftpShowHiddenFiles: (enabled: boolean) => void;
  setSftpConflictPolicy: (policy: SftpConflictPolicy) => void;
  setSftpRetryCount: (count: number) => void;
  setSftpDownloadDirectory: (path: string) => void;
  setSftpCompletionNotification: (enabled: boolean) => void;
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
        terminalColorScheme: parsed.terminalColorScheme ?? 'app',
        terminalMultiLinePasteWarning: parsed.terminalMultiLinePasteWarning ?? true,
        terminalLargePasteWarning: parsed.terminalLargePasteWarning ?? true,
        terminalAutoReconnect: parsed.terminalAutoReconnect ?? false,
        confirmBeforeExit: parsed.confirmBeforeExit ?? true,
        restoreWorkspace: parsed.restoreWorkspace ?? true,
        sftpShowHiddenFiles: parsed.sftpShowHiddenFiles ?? true,
        sftpConflictPolicy: parsed.sftpConflictPolicy ?? 'ask',
        sftpRetryCount: parsed.sftpRetryCount ?? 1,
        sftpDownloadDirectory: parsed.sftpDownloadDirectory ?? '',
        sftpCompletionNotification: parsed.sftpCompletionNotification ?? true,
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
    terminalColorScheme: 'app',
    terminalMultiLinePasteWarning: true,
    terminalLargePasteWarning: true,
    terminalAutoReconnect: false,
    confirmBeforeExit: true,
    restoreWorkspace: true,
    sftpShowHiddenFiles: true,
    sftpConflictPolicy: 'ask',
    sftpRetryCount: 1,
    sftpDownloadDirectory: '',
    sftpCompletionNotification: true,
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
      setTerminalColorScheme: (terminalColorScheme) => set({ terminalColorScheme }),
      setTerminalMultiLinePasteWarning: (terminalMultiLinePasteWarning) => set({ terminalMultiLinePasteWarning }),
      setTerminalLargePasteWarning: (terminalLargePasteWarning) => set({ terminalLargePasteWarning }),
      setTerminalAutoReconnect: (terminalAutoReconnect) => set({ terminalAutoReconnect }),
      setConfirmBeforeExit: (confirmBeforeExit) => set({ confirmBeforeExit }),
      setRestoreWorkspace: (restoreWorkspace) => set({ restoreWorkspace }),
      setSftpShowHiddenFiles: (sftpShowHiddenFiles) => set({ sftpShowHiddenFiles }),
      setSftpConflictPolicy: (sftpConflictPolicy) => set({ sftpConflictPolicy }),
      setSftpRetryCount: (sftpRetryCount) => set({ sftpRetryCount }),
      setSftpDownloadDirectory: (sftpDownloadDirectory) => set({ sftpDownloadDirectory }),
      setSftpCompletionNotification: (sftpCompletionNotification) => set({ sftpCompletionNotification }),
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
        terminalColorScheme: state.terminalColorScheme,
        terminalMultiLinePasteWarning: state.terminalMultiLinePasteWarning,
        terminalLargePasteWarning: state.terminalLargePasteWarning,
        terminalAutoReconnect: state.terminalAutoReconnect,
        confirmBeforeExit: state.confirmBeforeExit,
        restoreWorkspace: state.restoreWorkspace,
        sftpShowHiddenFiles: state.sftpShowHiddenFiles,
        sftpConflictPolicy: state.sftpConflictPolicy,
        sftpRetryCount: state.sftpRetryCount,
        sftpDownloadDirectory: state.sftpDownloadDirectory,
        sftpCompletionNotification: state.sftpCompletionNotification,
        shortcuts: state.shortcuts,
      }),
      onRehydrateStorage: () => (state) => {
        if (state) state.setActiveSection(state.startupSection);
      },
    },
  ),
);
