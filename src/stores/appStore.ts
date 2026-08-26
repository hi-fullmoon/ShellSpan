import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import { shallow } from 'zustand/shallow';
import { changeLocale } from '@/locales';
import type { AppSection, Locale, SettingsSection, SftpConflictPolicy, ShortcutAction, ShortcutBindings, TerminalBellStyle, TerminalColorScheme, TerminalCursorStyle, TerminalFontFamily, TerminalRightClickBehavior, ThemeMode, WorkbenchTab } from '@/types';
import {
  invokeLoadPreferences,
  invokeSavePreferences,
} from '@/lib/tauri';
import { createLogger } from '@/lib/logger';

const logger = createLogger('appStore');

export const DEFAULT_SHORTCUTS: ShortcutBindings = {
  openWorkbench: 'mod+1',
  openTerminal: 'mod+2',
  openSftp: 'mod+3',
  openSettings: 'mod+,',
  openCommandPalette: 'mod+shift+p',
  toggleAiPanel: 'mod+shift+a',
  newTerminalTab: 'mod+k',
  closeTerminalTab: 'mod+w',
  switchTerminalTab: 'mod+shift+o',
  nextTerminalTab: 'mod+shift+]',
  previousTerminalTab: 'mod+shift+[',
  findTerminal: 'mod+f',
  newSftpConnection: 'mod+k',
  terminalLeader: 'ctrl+b',
  terminalFocusLeft: 'h',
  terminalFocusDown: 'j',
  terminalFocusUp: 'k',
  terminalFocusRight: 'l',
  terminalSplitRight: 'v',
  terminalSplitDown: 's',
  terminalClosePane: 'x',
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
  terminalHideSingleTabBar: boolean;
  sftpHideSingleTabBar: boolean;
  shortcuts: ShortcutBindings;
}

interface AppState extends AppPreferences {
  initialized: boolean;
  activeSection: AppSection;
  activeWorkbenchTab: WorkbenchTab;
  activeSettingsSection: SettingsSection;
  pendingWorkbenchAction: 'newConnection' | null;
  hydrateFromDb: () => Promise<void>;
  setActiveSection: (section: AppSection) => void;
  setActiveWorkbenchTab: (tab: WorkbenchTab) => void;
  setActiveSettingsSection: (section: SettingsSection) => void;
  requestNewConnection: () => void;
  consumeWorkbenchAction: (action: 'newConnection') => void;
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
  setTerminalHideSingleTabBar: (enabled: boolean) => void;
  setSftpHideSingleTabBar: (enabled: boolean) => void;
  setShortcut: (action: ShortcutAction, shortcut: string) => void;
  resetShortcut: (action: ShortcutAction) => void;
  resetShortcuts: () => void;
}

const PREFERENCE_KEYS: readonly (keyof AppPreferences)[] = [
  'theme', 'locale', 'startupUpdateCheck', 'startupSection',
  'terminalFontSize', 'terminalFontFamily', 'terminalCursorBlink',
  'terminalCursorStyle', 'terminalCopyOnSelect', 'terminalScrollback',
  'terminalColorScheme', 'terminalMultiLinePasteWarning',
  'terminalLargePasteWarning', 'terminalAutoReconnect',
  'terminalLineHeight', 'terminalLetterSpacing', 'terminalUrlDetection',
  'terminalTrimTrailingWhitespace', 'terminalRightClickBehavior',
  'terminalBellStyle', 'confirmBeforeExit', 'restoreWorkspace',
  'sftpShowHiddenFiles', 'sftpConflictPolicy', 'sftpRetryCount',
  'sftpDownloadDirectory', 'sftpCompletionNotification',
  'terminalHideSingleTabBar', 'sftpHideSingleTabBar', 'shortcuts',
];

function getDefaultPreferences(): AppPreferences {
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
    terminalHideSingleTabBar: false,
    sftpHideSingleTabBar: false,
    shortcuts: DEFAULT_SHORTCUTS,
  };
}

const defaults = getDefaultPreferences();

// Bindings whose default changed across versions. A stored value equal to the
// old default is treated as uncustomized and upgraded to the new default.
const LEGACY_DEFAULT_SHORTCUTS: Partial<Record<ShortcutAction, string>> = {
  newTerminalTab: 'mod+t',
};

export function mergeShortcutBindings(value: unknown): ShortcutBindings {
  const stored = value && typeof value === 'object'
    ? value as Partial<Record<ShortcutAction, unknown>>
    : {};
  return Object.fromEntries(
    (Object.entries(DEFAULT_SHORTCUTS) as Array<[ShortcutAction, string]>).map(
      ([action, fallback]) => {
        const candidate = stored[action];
        const usable = typeof candidate === 'string'
          && candidate.length > 0
          && candidate !== LEGACY_DEFAULT_SHORTCUTS[action];
        return [action, usable ? candidate : fallback];
      },
    ),
  ) as ShortcutBindings;
}

function entriesToPreferences(entries: [string, string][]): Partial<AppPreferences> {
  const prefs: Record<string, unknown> = {};
  for (const [key, value] of entries) {
    try { prefs[key] = JSON.parse(value); } catch { prefs[key] = value; }
  }

  return {
    theme: (prefs.theme as ThemeMode) ?? defaults.theme,
    locale: (prefs.locale as Locale) ?? defaults.locale,
    startupUpdateCheck: (prefs.startupUpdateCheck as boolean) ?? defaults.startupUpdateCheck,
    startupSection: (prefs.startupSection as AppSection) ?? defaults.startupSection,
    terminalFontSize: (prefs.terminalFontSize as number) ?? defaults.terminalFontSize,
    terminalFontFamily: (prefs.terminalFontFamily as TerminalFontFamily) ?? defaults.terminalFontFamily,
    terminalCursorBlink: (prefs.terminalCursorBlink as boolean) ?? defaults.terminalCursorBlink,
    terminalCursorStyle: (prefs.terminalCursorStyle as TerminalCursorStyle) ?? defaults.terminalCursorStyle,
    terminalCopyOnSelect: (prefs.terminalCopyOnSelect as boolean) ?? defaults.terminalCopyOnSelect,
    terminalScrollback: (prefs.terminalScrollback as number) ?? defaults.terminalScrollback,
    terminalColorScheme: (prefs.terminalColorScheme as TerminalColorScheme) ?? defaults.terminalColorScheme,
    terminalMultiLinePasteWarning: (prefs.terminalMultiLinePasteWarning as boolean) ?? defaults.terminalMultiLinePasteWarning,
    terminalLargePasteWarning: (prefs.terminalLargePasteWarning as boolean) ?? defaults.terminalLargePasteWarning,
    terminalAutoReconnect: (prefs.terminalAutoReconnect as boolean) ?? defaults.terminalAutoReconnect,
    terminalLineHeight: (prefs.terminalLineHeight as number) ?? defaults.terminalLineHeight,
    terminalLetterSpacing: (prefs.terminalLetterSpacing as number) ?? defaults.terminalLetterSpacing,
    terminalUrlDetection: (prefs.terminalUrlDetection as boolean) ?? defaults.terminalUrlDetection,
    terminalTrimTrailingWhitespace: (prefs.terminalTrimTrailingWhitespace as boolean) ?? defaults.terminalTrimTrailingWhitespace,
    terminalRightClickBehavior: (prefs.terminalRightClickBehavior as TerminalRightClickBehavior) ?? defaults.terminalRightClickBehavior,
    terminalBellStyle: (prefs.terminalBellStyle as TerminalBellStyle) ?? defaults.terminalBellStyle,
    confirmBeforeExit: (prefs.confirmBeforeExit as boolean) ?? defaults.confirmBeforeExit,
    restoreWorkspace: (prefs.restoreWorkspace as boolean) ?? defaults.restoreWorkspace,
    sftpShowHiddenFiles: (prefs.sftpShowHiddenFiles as boolean) ?? defaults.sftpShowHiddenFiles,
    sftpConflictPolicy: (prefs.sftpConflictPolicy as SftpConflictPolicy) ?? defaults.sftpConflictPolicy,
    sftpRetryCount: (prefs.sftpRetryCount as number) ?? defaults.sftpRetryCount,
    sftpDownloadDirectory: (prefs.sftpDownloadDirectory as string) ?? defaults.sftpDownloadDirectory,
    sftpCompletionNotification: (prefs.sftpCompletionNotification as boolean) ?? defaults.sftpCompletionNotification,
    terminalHideSingleTabBar: (prefs.terminalHideSingleTabBar as boolean) ?? defaults.terminalHideSingleTabBar,
    sftpHideSingleTabBar: (prefs.sftpHideSingleTabBar as boolean) ?? defaults.sftpHideSingleTabBar,
    shortcuts: mergeShortcutBindings(prefs.shortcuts),
  };
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;

function debouncedSaveToDb(state: AppPreferences) {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const entries: [string, string][] = PREFERENCE_KEYS.map((key) => [
      key as string,
      JSON.stringify(state[key]),
    ]);
    invokeSavePreferences(entries).catch((error) => {
      logger.error('failed to save preferences to database', error);
    });
  }, 500);
}

export const useAppStore = create<AppState>()(
  subscribeWithSelector((set, _get) => ({
    ...defaults,
    initialized: false,
    activeSection: defaults.startupSection,
    activeWorkbenchTab: 'connections' as WorkbenchTab,
    activeSettingsSection: 'general' as SettingsSection,
    pendingWorkbenchAction: null,

    hydrateFromDb: async () => {
      try {
        const entries = await invokeLoadPreferences();
        if (entries.length > 0) {
          const prefs = entriesToPreferences(entries);
          set({ ...prefs, initialized: true, activeSection: prefs.startupSection ?? defaults.startupSection });
          if (prefs.locale) {
            void changeLocale(prefs.locale);
          }
          logger.info('preferences loaded from database');
        } else {
          set({ initialized: true });
        }
      } catch (error) {
        logger.error('failed to hydrate preferences from database', error);
        set({ initialized: true });
      }
    },

    setActiveSection: (activeSection) => set({ activeSection }),
    setActiveWorkbenchTab: (activeWorkbenchTab) => set({ activeWorkbenchTab }),
    setActiveSettingsSection: (activeSettingsSection) => set({ activeSettingsSection }),
    requestNewConnection: () => set({
      activeSection: 'workbench',
      activeWorkbenchTab: 'connections',
      pendingWorkbenchAction: 'newConnection',
    }),
    consumeWorkbenchAction: (action) => set((state) => (
      state.pendingWorkbenchAction === action
        ? { pendingWorkbenchAction: null }
        : {}
    )),
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
    setTerminalHideSingleTabBar: (terminalHideSingleTabBar) => set({ terminalHideSingleTabBar }),
    setSftpHideSingleTabBar: (sftpHideSingleTabBar) => set({ sftpHideSingleTabBar }),
    setShortcut: (action, shortcut) =>
      set((state) => ({
        shortcuts: { ...DEFAULT_SHORTCUTS, ...state.shortcuts, [action]: shortcut },
      })),
    resetShortcut: (action) =>
      set((state) => ({
        shortcuts: { ...DEFAULT_SHORTCUTS, ...state.shortcuts, [action]: DEFAULT_SHORTCUTS[action] },
      })),
    resetShortcuts: () => set({ shortcuts: { ...DEFAULT_SHORTCUTS } }),
  })),
);

// Subscribe to preference changes and persist to database. The selector plus
// shallow equality ensure the comparison/save only runs when a persisted
// preference key actually changes (not on activeSection/activeWorkbenchTab).
useAppStore.subscribe(
  (state): AppPreferences => ({
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
    terminalHideSingleTabBar: state.terminalHideSingleTabBar,
    sftpHideSingleTabBar: state.sftpHideSingleTabBar,
    shortcuts: state.shortcuts,
  }),
  (currentPrefs) => {
    // Only save after initialization is complete
    if (!useAppStore.getState().initialized) return;
    debouncedSaveToDb(currentPrefs);
  },
  { equalityFn: shallow },
);
