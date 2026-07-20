import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { changeLocale } from '@/locales';
import type { AppSection, Locale, SftpConflictPolicy, ShortcutAction, ShortcutBindings, TerminalBellStyle, TerminalColorScheme, TerminalCursorStyle, TerminalFontFamily, TerminalRightClickBehavior, ThemeMode, WorkbenchTab } from '@/types';

export const DEFAULT_SHORTCUTS: ShortcutBindings = {
  openWorkbench: 'mod+1',
  openTerminal: 'mod+2',
  openSftp: 'mod+3',
  openSettings: 'mod+,',
  newTerminalTab: 'mod+t',
  closeTerminalTab: 'mod+w',
  nextTerminalTab: 'mod+shift+]',
  previousTerminalTab: 'mod+shift+[',
  findTerminal: 'mod+f',
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
  terminalLineHeight: number;
  terminalLetterSpacing: number;
  terminalUrlDetection: boolean;
  terminalTrimTrailingWhitespace: boolean;
  terminalRightClickBehavior: TerminalRightClickBehavior;
  terminalBellStyle: TerminalBellStyle;
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
  setTerminalLineHeight: (lineHeight: number) => void;
  setTerminalLetterSpacing: (letterSpacing: number) => void;
  setTerminalUrlDetection: (enabled: boolean) => void;
  setTerminalTrimTrailingWhitespace: (enabled: boolean) => void;
  setTerminalRightClickBehavior: (behavior: TerminalRightClickBehavior) => void;
  setTerminalBellStyle: (style: TerminalBellStyle) => void;
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

export function mergeShortcutBindings(value: unknown): ShortcutBindings {
  const stored = value && typeof value === 'object'
    ? value as Partial<Record<ShortcutAction, unknown>>
    : {};
  return Object.fromEntries(
    (Object.entries(DEFAULT_SHORTCUTS) as Array<[ShortcutAction, string]>).map(
      ([action, fallback]) => [
        action,
        typeof stored[action] === 'string' && stored[action].length > 0
          ? stored[action]
          : fallback,
      ],
    ),
  ) as ShortcutBindings;
}

function readInitialPreferences(): AppPreferences {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const stored = JSON.parse(raw) as Partial<AppPreferences> & {
        state?: Partial<AppPreferences>;
      };
      const parsed = stored.state ?? stored;
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
        terminalLineHeight: parsed.terminalLineHeight ?? 1,
        terminalLetterSpacing: parsed.terminalLetterSpacing ?? 0,
        terminalUrlDetection: parsed.terminalUrlDetection ?? true,
        terminalTrimTrailingWhitespace: parsed.terminalTrimTrailingWhitespace ?? true,
        terminalRightClickBehavior: parsed.terminalRightClickBehavior ?? 'paste',
        terminalBellStyle: parsed.terminalBellStyle ?? 'none',
        confirmBeforeExit: parsed.confirmBeforeExit ?? true,
        restoreWorkspace: parsed.restoreWorkspace ?? true,
        sftpShowHiddenFiles: parsed.sftpShowHiddenFiles ?? true,
        sftpConflictPolicy: parsed.sftpConflictPolicy ?? 'ask',
        sftpRetryCount: parsed.sftpRetryCount ?? 1,
        sftpDownloadDirectory: parsed.sftpDownloadDirectory ?? '',
        sftpCompletionNotification: parsed.sftpCompletionNotification ?? true,
        shortcuts: mergeShortcutBindings(parsed.shortcuts),
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
    terminalLineHeight: 1,
    terminalLetterSpacing: 0,
    terminalUrlDetection: true,
    terminalTrimTrailingWhitespace: true,
    terminalRightClickBehavior: 'paste',
    terminalBellStyle: 'none',
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
      setTerminalLineHeight: (terminalLineHeight) => set({ terminalLineHeight }),
      setTerminalLetterSpacing: (terminalLetterSpacing) => set({ terminalLetterSpacing }),
      setTerminalUrlDetection: (terminalUrlDetection) => set({ terminalUrlDetection }),
      setTerminalTrimTrailingWhitespace: (terminalTrimTrailingWhitespace) => set({ terminalTrimTrailingWhitespace }),
      setTerminalRightClickBehavior: (terminalRightClickBehavior) => set({ terminalRightClickBehavior }),
      setTerminalBellStyle: (terminalBellStyle) => set({ terminalBellStyle }),
      setConfirmBeforeExit: (confirmBeforeExit) => set({ confirmBeforeExit }),
      setRestoreWorkspace: (restoreWorkspace) => set({ restoreWorkspace }),
      setSftpShowHiddenFiles: (sftpShowHiddenFiles) => set({ sftpShowHiddenFiles }),
      setSftpConflictPolicy: (sftpConflictPolicy) => set({ sftpConflictPolicy }),
      setSftpRetryCount: (sftpRetryCount) => set({ sftpRetryCount }),
      setSftpDownloadDirectory: (sftpDownloadDirectory) => set({ sftpDownloadDirectory }),
      setSftpCompletionNotification: (sftpCompletionNotification) => set({ sftpCompletionNotification }),
      setShortcut: (action, shortcut) =>
        set((state) => ({
          shortcuts: { ...DEFAULT_SHORTCUTS, ...state.shortcuts, [action]: shortcut },
        })),
      resetShortcut: (action) =>
        set((state) => ({
          shortcuts: { ...DEFAULT_SHORTCUTS, ...state.shortcuts, [action]: DEFAULT_SHORTCUTS[action] },
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
        terminalLineHeight: state.terminalLineHeight,
        terminalLetterSpacing: state.terminalLetterSpacing,
        terminalUrlDetection: state.terminalUrlDetection,
        terminalTrimTrailingWhitespace: state.terminalTrimTrailingWhitespace,
        terminalRightClickBehavior: state.terminalRightClickBehavior,
        terminalBellStyle: state.terminalBellStyle,
        confirmBeforeExit: state.confirmBeforeExit,
        restoreWorkspace: state.restoreWorkspace,
        sftpShowHiddenFiles: state.sftpShowHiddenFiles,
        sftpConflictPolicy: state.sftpConflictPolicy,
        sftpRetryCount: state.sftpRetryCount,
        sftpDownloadDirectory: state.sftpDownloadDirectory,
        sftpCompletionNotification: state.sftpCompletionNotification,
        shortcuts: state.shortcuts,
      }),
      merge: (persistedState, currentState) => {
        const persisted = persistedState && typeof persistedState === 'object'
          ? persistedState as Partial<AppState>
          : {};
        return {
          ...currentState,
          ...persisted,
          shortcuts: mergeShortcutBindings(persisted.shortcuts),
        };
      },
      onRehydrateStorage: () => (state) => {
        if (state) state.setActiveSection(state.startupSection);
      },
    },
  ),
);
