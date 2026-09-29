import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import { shallow } from 'zustand/shallow';
import { changeLocale } from '@/locales';
import type { AppSection, Locale, PetdexDiagnostic, SettingsSection, SftpConflictPolicy, ShortcutAction, ShortcutBindings, TerminalBellStyle, TerminalColorScheme, TerminalCursorStyle, TerminalFontFamily, TerminalRightClickBehavior, ThemeMode, WorkbenchTab } from '@/types';
import {
  invokeLoadPreferences,
  invokeSavePreferences,
} from '@/lib/ipc/tauri';
import { createLogger } from '@/lib/logger';
import { configurePetdex } from '@/lib/petdex/petdex';
import { DEFAULT_PETDEX_CATEGORIES, normalizePetdexCategories, resolvePetdexConfiguration } from '@/lib/petdex/preferences';
import type { PetdexConfigurationPatch } from '@/lib/petdex/preferences';
import type { PetdexCategories } from '@/types';

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
  profileName: string;
  profileAvatar: string;
  startupUpdateCheck: boolean;
  petdexEnabled: boolean;
  petdexCategories: PetdexCategories;
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
  petdexBackendEnabled: boolean;
  petdexBackendCategories: PetdexCategories;
  petdexRequestedCategories: PetdexCategories | null;
  petdexRequestedEnabled: boolean | null;
  petdexConfiguring: boolean;
  activeSection: AppSection;
  activeWorkbenchTab: WorkbenchTab;
  activeSettingsSection: SettingsSection;
  settingsDialogOpen: boolean;
  pendingWorkbenchAction: 'newConnection' | null;
  hydrateFromDb: () => Promise<void>;
  setActiveSection: (section: AppSection) => void;
  setActiveWorkbenchTab: (tab: WorkbenchTab) => void;
  setActiveSettingsSection: (section: SettingsSection) => void;
  setSettingsDialogOpen: (open: boolean) => void;
  openSettings: (section?: SettingsSection) => void;
  requestNewConnection: () => void;
  consumeWorkbenchAction: (action: 'newConnection') => void;
  setTheme: (theme: ThemeMode) => void;
  setLocale: (locale: Locale) => void;
  setProfileName: (name: string) => void;
  setProfileAvatar: (avatar: string) => void;
  setStartupUpdateCheck: (enabled: boolean) => void;
  setPetdexEnabled: (enabled: boolean) => Promise<PetdexDiagnostic>;
  setPetdexCategory: (category: keyof PetdexCategories, enabled: boolean) => Promise<PetdexDiagnostic>;
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
  'theme', 'locale', 'profileName', 'profileAvatar', 'startupUpdateCheck', 'petdexEnabled', 'petdexCategories', 'startupSection',
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
    profileName: '',
    profileAvatar: '',
    startupUpdateCheck: true,
    petdexEnabled: false,
    petdexCategories: { ...DEFAULT_PETDEX_CATEGORIES },
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

export function mergeShortcutBindings(value: unknown): ShortcutBindings {
  const stored = value && typeof value === 'object'
    ? value as Partial<Record<ShortcutAction, unknown>>
    : {};
  return Object.fromEntries(
    (Object.entries(DEFAULT_SHORTCUTS) as Array<[ShortcutAction, string]>).map(
      ([action, fallback]) => {
        const candidate = stored[action];
        const usable = typeof candidate === 'string' && candidate.length > 0;
        return [action, usable ? candidate : fallback];
      },
    ),
  ) as ShortcutBindings;
}

export const PROFILE_NAME_MAX_LENGTH = 32;
const PROFILE_AVATAR_MAX_LENGTH = 2_000_000;
const PROFILE_AVATAR_PATTERN = /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/;

export function sanitizeProfileName(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, PROFILE_NAME_MAX_LENGTH);
}

export function sanitizeProfileAvatar(value: unknown): string {
  if (
    typeof value !== 'string'
    || value.length > PROFILE_AVATAR_MAX_LENGTH
    || !PROFILE_AVATAR_PATTERN.test(value)
  ) {
    return '';
  }
  return value;
}

function entriesToPreferences(entries: [string, string][]): Partial<AppPreferences> {
  const prefs: Record<string, unknown> = {};
  for (const [key, value] of entries) {
    try { prefs[key] = JSON.parse(value); } catch { prefs[key] = value; }
  }

  return {
    theme: (prefs.theme as ThemeMode) ?? defaults.theme,
    locale: (prefs.locale as Locale) ?? defaults.locale,
    profileName: sanitizeProfileName(prefs.profileName),
    profileAvatar: sanitizeProfileAvatar(prefs.profileAvatar),
    startupUpdateCheck: (prefs.startupUpdateCheck as boolean) ?? defaults.startupUpdateCheck,
    petdexEnabled: (prefs.petdexEnabled as boolean) ?? defaults.petdexEnabled,
    petdexCategories: normalizePetdexCategories(prefs.petdexCategories),
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
let petdexConfigurationRevision = 0;
let petdexConfigurationQueue: Promise<void> = Promise.resolve();

function enqueuePetdexConfiguration(enabled: boolean, categories = DEFAULT_PETDEX_CATEGORIES): Promise<PetdexDiagnostic> {
  const request = petdexConfigurationQueue.then(() => configurePetdex(enabled, categories));
  petdexConfigurationQueue = request.then(() => undefined, () => undefined);
  return request;
}

async function updatePetdexConfiguration(patch: PetdexConfigurationPatch): Promise<PetdexDiagnostic> {
  const revision = ++petdexConfigurationRevision;
  const current = useAppStore.getState();
  useAppStore.setState({
    petdexRequestedEnabled: patch.enabled ?? current.petdexRequestedEnabled ?? current.petdexEnabled,
    petdexRequestedCategories: { ...(current.petdexRequestedCategories ?? current.petdexCategories), ...patch.categories },
    petdexConfiguring: true,
  });
  // Compose each patch against the last backend acknowledgement, not a stale
  // UI snapshot. Failed changes cannot leak into a subsequent category update.
  const request = petdexConfigurationQueue.then(async () => {
    const confirmed = useAppStore.getState();
    const { enabled, categories } = resolvePetdexConfiguration({
      enabled: confirmed.petdexBackendEnabled,
      categories: confirmed.petdexBackendCategories,
    }, patch);
    const diagnostic = await configurePetdex(enabled, categories);
    useAppStore.setState({ petdexBackendEnabled: enabled, petdexBackendCategories: categories });
    return diagnostic;
  });
  petdexConfigurationQueue = request.then(() => undefined, () => undefined);
  try {
    return await request;
  } catch (error) {
    logger.warn('failed to update Petdex integration state');
    throw error;
  } finally {
    if (revision === petdexConfigurationRevision) {
      const confirmed = useAppStore.getState();
      useAppStore.setState({
        petdexEnabled: confirmed.petdexBackendEnabled,
        petdexCategories: confirmed.petdexBackendCategories,
        petdexRequestedEnabled: null,
        petdexRequestedCategories: null,
        petdexConfiguring: false,
      });
    }
  }
}

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
  subscribeWithSelector((set) => ({
    ...defaults,
    initialized: false,
    petdexBackendEnabled: false,
    petdexBackendCategories: { ...DEFAULT_PETDEX_CATEGORIES },
    petdexRequestedCategories: null,
    petdexRequestedEnabled: null,
    petdexConfiguring: false,
    activeSection: defaults.startupSection,
    activeWorkbenchTab: 'connections' as WorkbenchTab,
    activeSettingsSection: 'general' as SettingsSection,
    settingsDialogOpen: false,
    pendingWorkbenchAction: null,

    hydrateFromDb: async () => {
      try {
        const entries = await invokeLoadPreferences();
        if (entries.length > 0) {
          const prefs = entriesToPreferences(entries);
          const requestedPetdexEnabled = prefs.petdexEnabled ?? false;
          let confirmedPetdexEnabled = requestedPetdexEnabled;
          let confirmedPetdexCategories = { ...DEFAULT_PETDEX_CATEGORIES };
          try {
            await enqueuePetdexConfiguration(requestedPetdexEnabled, prefs.petdexCategories);
            confirmedPetdexCategories = prefs.petdexCategories ?? { ...DEFAULT_PETDEX_CATEGORIES };
          } catch {
            confirmedPetdexEnabled = false;
            logger.warn('failed to synchronize Petdex integration state');
          }
          set({
            ...prefs,
            petdexEnabled: confirmedPetdexEnabled,
            petdexCategories: confirmedPetdexCategories,
            petdexBackendEnabled: confirmedPetdexEnabled,
            petdexBackendCategories: confirmedPetdexCategories,
            petdexRequestedCategories: null,
            petdexRequestedEnabled: null,
            petdexConfiguring: false,
            initialized: true,
            activeSection: prefs.startupSection ?? defaults.startupSection,
          });
          if (prefs.locale) {
            void changeLocale(prefs.locale);
          }
          logger.info('preferences loaded from database');
        } else {
          try {
            await enqueuePetdexConfiguration(false);
          } catch {
            logger.warn('failed to initialize Petdex integration state');
          }
          set({
            petdexEnabled: false,
            petdexBackendEnabled: false,
            petdexRequestedEnabled: null,
            petdexConfiguring: false,
            initialized: true,
          });
        }
      } catch (error) {
        logger.error('failed to hydrate preferences from database', error);
        set({
          petdexEnabled: false,
          petdexBackendEnabled: false,
          petdexRequestedEnabled: null,
          petdexConfiguring: false,
          initialized: true,
        });
      }
    },

    setActiveSection: (activeSection) => set({ activeSection }),
    setActiveWorkbenchTab: (activeWorkbenchTab) => set({ activeWorkbenchTab }),
    setActiveSettingsSection: (activeSettingsSection) => set({ activeSettingsSection }),
    setSettingsDialogOpen: (settingsDialogOpen) => set({ settingsDialogOpen }),
    openSettings: (section) => set((state) => ({
      settingsDialogOpen: true,
      activeSettingsSection: section ?? state.activeSettingsSection,
    })),
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
    setProfileName: (name) => set({ profileName: sanitizeProfileName(name) }),
    setProfileAvatar: (avatar) => set({ profileAvatar: sanitizeProfileAvatar(avatar) }),
    setStartupUpdateCheck: (startupUpdateCheck) => set({ startupUpdateCheck }),
    setPetdexEnabled: (enabled) => updatePetdexConfiguration({ enabled }),
    setPetdexCategory: (category, enabled) => updatePetdexConfiguration({ categories: { [category]: enabled } }),
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
    profileName: state.profileName,
    profileAvatar: state.profileAvatar,
    startupUpdateCheck: state.startupUpdateCheck,
    petdexEnabled: state.petdexEnabled,
    petdexCategories: state.petdexCategories,
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
