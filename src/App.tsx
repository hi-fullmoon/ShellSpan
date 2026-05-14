import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { CloseSessionDialog } from './components/CloseSessionDialog';
import { ConnectDialog } from './components/ConnectDialog';
import { DeleteProfileDialog } from './components/DeleteProfileDialog';
import { ExitAppDialog } from './components/ExitAppDialog';
import { FileManager } from './components/FileManager';
import { HostKeyDialog } from './components/HostKeyDialog';
import { TitleBar } from './components/TitleBar';
import { SettingsDialog } from './components/SettingsDialog';
import { Sidebar } from './components/Sidebar';
import { SplitLayout } from './components/SplitLayout';
import { SessionTabs } from './components/SessionTabs';
import { TerminalPane } from './components/TerminalPane';
import { SnippetsPanel } from './components/SnippetsPanel';
import { Toast } from './components/Toast';
import { TooltipProvider } from './components/Tooltip';
import { UpdateRestartDialog } from './components/UpdateRestartDialog';
import { initI18n, syncI18nLocale, t } from './lib/i18n';
import { createLogger } from './lib/logger';
import { useLocalStorage } from './hooks/useLocalStorage';
import { createEmptyProfile, describeSession, sanitizeProfileForStorage } from './lib/profile';
import { applyStatusToSessions, consumeBufferedSessionStatus, type PendingSessionStatusEvents } from './lib/session';
import { insertSessionAfterActive } from './lib/session';
import { markStartupUpdateCheck, shouldRunStartupUpdateCheck } from './lib/update';
import { updateFlowReducer } from './lib/update';
import { checkForUpdate, downloadAndInstallUpdate } from './lib/update';
import { isTauriRuntime } from './lib/tauri';
import { shouldWarnOnClosedSession } from './lib/terminal';
import { useFileManagerStore } from './stores/fileManagerStore';
import { cn, sessionStatusTone } from './lib/ui';
import { DEFAULT_SHORTCUTS, matchesBinding } from './lib/keyboard';
import type { ShortcutAction } from './lib/keyboard';
import type { TerminalPaneRef } from './components/TerminalPane';
import type { AppPreferences, ConnectionGroup, ConnectionProfile, HostKeyCheckResponse, SessionState, SessionSummary, SshClosedEvent, SshStatusEvent } from './types';

const appLogger = createLogger('app');
const SYSTEM_OPEN_SETTINGS_EVENT = 'system-open-settings';
const SETTINGS_CHANGED_EVENT = 'settings-changed';
const defaultPreferences: AppPreferences = {
  theme: 'dark',
  locale: 'zh-CN',
  terminalFontSize: 14,
  terminalLineHeight: 1.2,
  terminalTheme: 'default',
  cursorStyle: 'block',
  cursorBlink: true,
  copyOnSelect: false,
  showFileManager: true,
  showSidebar: true,
  autoReconnect: true,
  startupUpdateCheck: true,
  historyLimit: 8,
  keyboardShortcuts: {},
};

function getSystemThemeMode() {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return 'dark' as const;
  }

  return window.matchMedia('(prefers-color-scheme: dark)').matches ? ('dark' as const) : ('light' as const);
}

const validTerminalThemes: Array<AppPreferences['terminalTheme']> = [
  'default',
  'dracula',
  'solarized-dark',
  'solarized-light',
  'one-dark',
  'monokai',
];
const validCursorStyles: Array<AppPreferences['cursorStyle']> = ['block', 'line', 'bar'];

function normalizePreferences(value: Partial<AppPreferences> | null | undefined): AppPreferences {
  return {
    theme: value?.theme === 'light' || value?.theme === 'system' ? value.theme : 'dark',
    locale: value?.locale === 'en-US' ? 'en-US' : 'zh-CN',
    terminalFontSize:
      typeof value?.terminalFontSize === 'number' && value.terminalFontSize >= 10 && value.terminalFontSize <= 20 ? value.terminalFontSize : 14,
    terminalLineHeight:
      typeof value?.terminalLineHeight === 'number' && value.terminalLineHeight >= 1 && value.terminalLineHeight <= 2
        ? value.terminalLineHeight
        : 1.2,
    terminalTheme: validTerminalThemes.includes(value?.terminalTheme as AppPreferences['terminalTheme'])
      ? (value!.terminalTheme as AppPreferences['terminalTheme'])
      : 'default',
    cursorStyle: validCursorStyles.includes(value?.cursorStyle as AppPreferences['cursorStyle'])
      ? (value!.cursorStyle as AppPreferences['cursorStyle'])
      : 'block',
    cursorBlink: value?.cursorBlink !== false,
    copyOnSelect: value?.copyOnSelect === true,
    showFileManager: value?.showFileManager !== false,
    showSidebar: value?.showSidebar !== false,
    autoReconnect: value?.autoReconnect !== false,
    startupUpdateCheck: value?.startupUpdateCheck !== false,
    historyLimit: typeof value?.historyLimit === 'number' && value.historyLimit >= 3 && value.historyLimit <= 20 ? value.historyLimit : 8,
    keyboardShortcuts: (value?.keyboardShortcuts ?? {}) as AppPreferences['keyboardShortcuts'],
  };
}

function reorderSessions(sessions: SessionState[], draggedSessionId: string, insertIndex: number) {
  const draggedIndex = sessions.findIndex((session) => session.sessionId === draggedSessionId);
  if (draggedIndex === -1) {
    return sessions;
  }

  const nextSessions = [...sessions];
  const [draggedSession] = nextSessions.splice(draggedIndex, 1);
  const adjustedIndex = insertIndex > draggedIndex ? insertIndex - 1 : insertIndex;
  nextSessions.splice(adjustedIndex, 0, draggedSession);
  return nextSessions;
}

function buildSettingsWindowUrl(preferences?: AppPreferences) {
  if (!preferences) {
    return '/index.html#settings';
  }

  const params = new URLSearchParams({
    locale: preferences.locale,
    theme: preferences.theme,
  });

  return `/index.html?${params.toString()}#settings`;
}

async function openSettingsWindow(preferences?: AppPreferences): Promise<void> {
  appLogger.info('openSettingsWindow called');
  if (!isTauriRuntime()) {
    appLogger.info('Not in tauri runtime, dispatching fallback');
    window.dispatchEvent(new CustomEvent('open-settings-fallback'));
    return;
  }
  try {
    appLogger.info('Checking for existing settings window');
    const existing = await WebviewWindow.getByLabel('settings');
    if (existing) {
      appLogger.info('Existing settings window found, focusing');
      await existing.unminimize();
      await existing.show();
      await existing.setFocus();
      return;
    }
    appLogger.info('Creating new settings window');
    const IS_MAC_OS = /mac/i.test(navigator.platform);
    const settingsWindow = new WebviewWindow('settings', {
      url: buildSettingsWindowUrl(preferences),
      title: IS_MAC_OS ? '' : 'Settings',
      width: 640,
      height: 560,
      resizable: false,
      center: true,
      transparent: IS_MAC_OS,
      titleBarStyle: IS_MAC_OS ? 'overlay' : undefined,
      decorations: IS_MAC_OS,
      alwaysOnTop: false,
    });
    settingsWindow.once('tauri://created', () => {
      appLogger.info('Settings window created successfully');
    });
    settingsWindow.once('tauri://error', (e) => {
      appLogger.error('Failed to create settings window', { error: String(e.payload) });
    });
  } catch (error) {
    appLogger.error('Exception in openSettingsWindow', { error: String(error) });
    window.dispatchEvent(new CustomEvent('open-settings-fallback'));
  }
}

function App() {
  const [draftProfile, setDraftProfile] = useState<ConnectionProfile>(createEmptyProfile());
  const [savedProfiles, setSavedProfiles] = useLocalStorage<ConnectionProfile[]>('termbridge.savedProfiles', [], ['windbridge.savedProfiles']);
  const [savedGroups, setSavedGroups] = useLocalStorage<ConnectionGroup[]>('termbridge.groups', []);
  const [storedPreferences, setStoredPreferences] = useLocalStorage<Partial<AppPreferences>>('termbridge.preferences', defaultPreferences);
  const [sessions, setSessions] = useState<SessionState[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string>();
  const [errorMessage, setErrorMessage] = useState<string>();
  const [connectDialogOpen, setConnectDialogOpen] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [settingsDialogOpen, setSettingsDialogOpen] = useState(false);
  const [pendingDeleteProfileId, setPendingDeleteProfileId] = useState<string>();
  const [pendingCloseSessionId, setPendingCloseSessionId] = useState<string>();
  const [exitDialogOpen, setExitDialogOpen] = useState(false);
  const [reorderingSessions, setReorderingSessions] = useState(false);

  // Listen for fallback event when settings window cannot be opened
  useEffect(() => {
    const handler = () => setSettingsDialogOpen(true);
    window.addEventListener('open-settings-fallback', handler);
    return () => window.removeEventListener('open-settings-fallback', handler);
  }, []);
  const [updateState, dispatchUpdateState] = useReducer(updateFlowReducer, { phase: 'idle' });
  const [updateDownloadProgress, setUpdateDownloadProgress] = useState<number>();
  const [updateToast, setUpdateToast] = useState<{ message: string; tone: 'info' | 'success' | 'error' }>();
  const [restartDialogDismissed, setRestartDialogDismissed] = useState(false);
  const [, setIntlVersion] = useState(0);
  const [systemThemeMode, setSystemThemeMode] = useState<'dark' | 'light'>(() => getSystemThemeMode());
  const [hostKeyDialog, setHostKeyDialog] = useState<{
    open: boolean;
    profile?: ConnectionProfile;
    fingerprint?: string;
    remember?: boolean;
    rememberPassword?: boolean;
  }>({ open: false });
  const preferences = useMemo(() => normalizePreferences(storedPreferences), [storedPreferences]);
  const appliedTheme = preferences.theme === 'system' ? systemThemeMode : preferences.theme;
  const removeFileManagerSessionState = useFileManagerStore((state) => state.removeSessionState);
  const replaceFileManagerSessionStateKey = useFileManagerStore((state) => state.replaceSessionStateKey);
  const pendingStatusEventsRef = useRef<PendingSessionStatusEvents>({});
  const sessionsRef = useRef<SessionState[]>([]);
  const preferencesRef = useRef(preferences);
  const terminalPaneRefs = useRef<Record<string, TerminalPaneRef>>({});
  const autoReconnectAttemptedRef = useRef<Record<string, true>>({});
  const dialogStateRef = useRef({
    hostKeyOpen: false,
    connectOpen: false,
    settingsOpen: false,
    pendingDelete: false,
    pendingClose: false,
    exitOpen: false,
  });

  useEffect(() => {
    dialogStateRef.current = {
      hostKeyOpen: hostKeyDialog.open,
      connectOpen: connectDialogOpen,
      settingsOpen: settingsDialogOpen,
      pendingDelete: !!pendingDeleteProfileId,
      pendingClose: !!pendingCloseSessionId,
      exitOpen: exitDialogOpen,
    };
  }, [hostKeyDialog.open, connectDialogOpen, settingsDialogOpen, pendingDeleteProfileId, pendingCloseSessionId, exitDialogOpen]);

  // Global keyboard shortcuts
  useEffect(() => {
    const merged = { ...DEFAULT_SHORTCUTS, ...preferences.keyboardShortcuts };

    const onKeyDown = (event: KeyboardEvent) => {
      // Check if an input element is focused (allow xterm's hidden textarea)
      const activeEl = document.activeElement;
      const tag = activeEl?.tagName.toLowerCase();
      const isXterm = activeEl && (activeEl as HTMLElement).classList.contains('xterm-helper-textarea');
      const isInput = !isXterm && (tag === 'input' || tag === 'textarea' || tag === 'select');

      const dlg = dialogStateRef.current;
      const anyDialogOpen = dlg.hostKeyOpen || dlg.connectOpen || dlg.settingsOpen || dlg.pendingDelete || dlg.pendingClose || dlg.exitOpen;

      // Escape always closes the active dialog, even if input is focused
      if (matchesBinding(merged.closeDialog, event)) {
        if (dlg.hostKeyOpen) {
          setHostKeyDialog({ open: false });
          event.preventDefault();
          return;
        }
        if (dlg.connectOpen) {
          setConnectDialogOpen(false);
          event.preventDefault();
          return;
        }
        if (dlg.settingsOpen) {
          setSettingsDialogOpen(false);
          event.preventDefault();
          return;
        }
        if (dlg.pendingDelete) {
          setPendingDeleteProfileId(undefined);
          event.preventDefault();
          return;
        }
        if (dlg.pendingClose) {
          setPendingCloseSessionId(undefined);
          event.preventDefault();
          return;
        }
        if (dlg.exitOpen) {
          setExitDialogOpen(false);
          event.preventDefault();
          return;
        }
        return;
      }

      // Skip other shortcuts when a dialog or input is active
      if (anyDialogOpen || isInput) return;

      if (matchesBinding(merged.newConnection, event)) {
        event.preventDefault();
        setDraftProfile(createEmptyProfile());
        setErrorMessage(undefined);
        setConnectDialogOpen(true);
        return;
      }

      if (matchesBinding(merged.openSettings, event)) {
        event.preventDefault();
        if (isTauriRuntime()) {
          void openSettingsWindow(preferences);
        } else {
          setSettingsDialogOpen(true);
        }
        return;
      }

      if (matchesBinding(merged.closeSession, event)) {
        event.preventDefault();
        const currentSessions = sessionsRef.current;
        if (currentSessions.length > 0) {
          setPendingCloseSessionId(activeSessionId ?? currentSessions[currentSessions.length - 1].sessionId);
        }
        return;
      }

      if (matchesBinding(merged.nextTab, event)) {
        event.preventDefault();
        const currentSessions = sessionsRef.current;
        if (currentSessions.length > 1) {
          const idx = currentSessions.findIndex((s) => s.sessionId === activeSessionId);
          const next = idx === -1 ? currentSessions[0] : currentSessions[(idx + 1) % currentSessions.length];
          setActiveSessionId(next.sessionId);
        }
        return;
      }

      if (matchesBinding(merged.prevTab, event)) {
        event.preventDefault();
        const currentSessions = sessionsRef.current;
        if (currentSessions.length > 1) {
          const idx = currentSessions.findIndex((s) => s.sessionId === activeSessionId);
          const prev =
            idx === -1 ? currentSessions[currentSessions.length - 1] : currentSessions[(idx - 1 + currentSessions.length) % currentSessions.length];
          setActiveSessionId(prev.sessionId);
        }
        return;
      }

      if (matchesBinding(merged.togglePrimarySidebar, event)) {
        event.preventDefault();
        setStoredPreferences((prev) => ({ ...prev, showFileManager: !normalizePreferences(prev).showFileManager }));
        return;
      }

      if (matchesBinding(merged.toggleSecondarySidebar, event)) {
        event.preventDefault();
        setStoredPreferences((prev) => ({ ...prev, showSidebar: !normalizePreferences(prev).showSidebar }));
        return;
      }

      if (matchesBinding(merged.exportTerminal, event)) {
        event.preventDefault();
        const pane = activeSessionId ? terminalPaneRefs.current[activeSessionId] : undefined;
        if (pane) {
          const content = pane.exportBuffer();
          const blob = new Blob([content], { type: 'text/plain' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `terminal-${activeSessionId}.txt`;
          a.click();
          URL.revokeObjectURL(url);
        }
        return;
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [preferences.keyboardShortcuts, preferences.showFileManager, preferences.showSidebar, activeSessionId]);

  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

  useEffect(() => {
    preferencesRef.current = preferences;
  }, [preferences]);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return;
    }

    const darkMediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const applySystemTheme = () => {
      setSystemThemeMode(darkMediaQuery.matches ? 'dark' : 'light');
    };

    applySystemTheme();
    if (typeof darkMediaQuery.addEventListener === 'function') {
      darkMediaQuery.addEventListener('change', applySystemTheme);
      return () => {
        darkMediaQuery.removeEventListener('change', applySystemTheme);
      };
    }

    darkMediaQuery.addListener(applySystemTheme);
    return () => {
      darkMediaQuery.removeListener(applySystemTheme);
    };
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = appliedTheme;
  }, [appliedTheme]);

  useEffect(() => {
    if (!isTauriRuntime()) {
      return;
    }

    try {
      void getCurrentWindow()
        .setTheme(preferences.theme === 'system' ? null : preferences.theme)
        .catch((error) => {
          appLogger.warn('同步原生窗口主题失败', { error: String(error), theme: preferences.theme });
        });
    } catch (error) {
      appLogger.warn('获取原生窗口实例失败，跳过窗口主题同步', { error: String(error), theme: preferences.theme });
    }
  }, [preferences.theme]);

  useEffect(() => {
    if (!isTauriRuntime()) {
      appLogger.warn('当前运行在浏览器预览模式，SSH 功能不可用');
      return;
    }

    let stopStatus: UnlistenFn | undefined;
    let stopClosed: UnlistenFn | undefined;
    let cancelled = false;

    const attach = async () => {
      const nextStopStatus = await listen<SshStatusEvent>('ssh-status', (event) => {
        appLogger.debug('收到会话状态事件', event.payload);
        setSessions((current) => applyStatusToSessions(current, event.payload, pendingStatusEventsRef.current));
      });

      if (cancelled) {
        nextStopStatus();
        return;
      }
      stopStatus = nextStopStatus;

      const nextStopClosed = await listen<SshClosedEvent>('ssh-closed', (event) => {
        // Stop port forwards when session closes
        if (isTauriRuntime()) {
          const forwardOpId = `pf-${event.payload.sessionId}`;
          void invoke('stop_port_forwards', { operationId: forwardOpId }).catch(() => {
            /* port forwards may not have been started */
          });
        }

        const currentSession = sessionsRef.current.find((session) => session.sessionId === event.payload.sessionId);
        const shouldAutoReconnect =
          !!currentSession &&
          preferences.autoReconnect &&
          event.payload.reasonKind === 'transport_disconnect' &&
          event.payload.retryable &&
          !autoReconnectAttemptedRef.current[event.payload.sessionId];

        if (currentSession) {
          if (shouldWarnOnClosedSession(currentSession.status)) {
            appLogger.warn('会话已关闭', event.payload);
          } else {
            appLogger.debug('会话关闭事件（错误态已记录）', event.payload);
          }
        }

        if (shouldAutoReconnect) {
          autoReconnectAttemptedRef.current[event.payload.sessionId] = true;
        }

        setSessions((current) =>
          current.map((session) => {
            if (session.sessionId !== event.payload.sessionId) {
              return session;
            }

            return {
              ...session,
              status: shouldAutoReconnect ? 'connecting' : session.status === 'error' ? 'error' : 'disconnected',
              note: shouldAutoReconnect ? t('app.note.autoReconnecting') : event.payload.reason,
            };
          }),
        );

        if (shouldAutoReconnect) {
          void handleReconnectSession(event.payload.sessionId, { automatic: true });
        }
      });

      if (cancelled) {
        nextStopClosed();
        return;
      }
      stopClosed = nextStopClosed;
    };

    void attach();

    return () => {
      cancelled = true;
      stopStatus?.();
      stopClosed?.();
    };
  }, [preferences.autoReconnect]);

  const activeSession = useMemo(() => sessions.find((item) => item.sessionId === activeSessionId), [activeSessionId, sessions]);
  const connectedSessions = useMemo(() => sessions.filter((item) => item.status === 'connected').length, [sessions]);
  syncI18nLocale(preferences.locale);
  const pendingDeleteProfile = useMemo(
    () => savedProfiles.find((item) => item.id === pendingDeleteProfileId),
    [pendingDeleteProfileId, savedProfiles],
  );
  const pendingCloseSession = useMemo(() => sessions.find((item) => item.sessionId === pendingCloseSessionId), [pendingCloseSessionId, sessions]);
  const runtimeText = isTauriRuntime() ? t('runtime.desktop') : t('runtime.browser');
  const restartDialogOpen = updateState.phase === 'downloaded' && !restartDialogDismissed;

  useEffect(() => {
    let cancelled = false;

    void initI18n(preferences.locale)
      .then(() => {
        if (!cancelled) {
          setIntlVersion((current) => current + 1);
        }
      })
      .catch((error) => {
        appLogger.error('初始化国际化失败', { error: String(error), locale: preferences.locale });
      });

    return () => {
      cancelled = true;
    };
  }, [preferences.locale]);

  // Migrate passwords from localStorage to OS keychain (one-time)
  useEffect(() => {
    if (!isTauriRuntime() || !savedProfiles.length) {
      return;
    }

    const migrated = localStorage.getItem('termbridge.passwordsMigrated');
    if (migrated === '1') {
      return;
    }

    const passwordsToMigrate: Array<[string, string]> = [];
    for (const profile of savedProfiles) {
      if (profile.rememberPassword && profile.password) {
        passwordsToMigrate.push([profile.id, profile.password]);
      }
    }

    if (passwordsToMigrate.length === 0) {
      localStorage.setItem('termbridge.passwordsMigrated', '1');
      return;
    }

    appLogger.info('Migrating passwords to keychain', { count: passwordsToMigrate.length });

    invoke<Array<[string, boolean]>>('migrate_passwords', {
      profiles: passwordsToMigrate,
    })
      .then((results) => {
        const allSucceeded = results.every(([, ok]) => ok);
        if (allSucceeded) {
          localStorage.setItem('termbridge.passwordsMigrated', '1');
          // Clear passwords from localStorage profiles
          setSavedProfiles((current) =>
            current.map((p) => ({
              ...p,
              password: '',
            })),
          );
          appLogger.info('Passwords migrated to keychain successfully');
        } else {
          appLogger.warn('Some passwords failed to migrate', { results });
        }
      })
      .catch((error) => {
        appLogger.error('Password migration failed', { error: String(error) });
      });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const runUpdateCheck = useCallback(async (mode: 'startup' | 'manual') => {
    if (!isTauriRuntime()) {
      if (mode === 'manual') {
        setUpdateToast({
          message: t('app.update.manualUnavailable'),
          tone: 'error',
        });
      }
      return;
    }

    dispatchUpdateState({ type: 'checkStarted' });
    setUpdateDownloadProgress(undefined);

    try {
      const available = await checkForUpdate();
      if (mode === 'startup') {
        markStartupUpdateCheck(Date.now());
      }
      if (!available) {
        dispatchUpdateState({ type: 'noUpdateFound' });
        if (mode === 'manual') {
          setUpdateToast({
            message: t('app.update.latest'),
            tone: 'info',
          });
        }
        return;
      }

      dispatchUpdateState({
        type: 'updateFound',
        payload: {
          latestVersion: available.version,
        },
      });
      dispatchUpdateState({ type: 'downloadStarted' });
      setUpdateDownloadProgress(0);

      await downloadAndInstallUpdate(available, (percent) => {
        setUpdateDownloadProgress(percent);
      });

      setUpdateDownloadProgress(100);
      dispatchUpdateState({
        type: 'downloadCompleted',
        payload: {
          downloadedVersion: available.version,
        },
      });
      setRestartDialogDismissed(false);
    } catch (error) {
      const message = t('app.update.failed', { error: String(error) });
      appLogger.error('检查或下载更新失败', { mode, error: String(error) });
      dispatchUpdateState({
        type: 'downloadFailed',
        payload: {
          message,
        },
      });
      if (mode === 'manual') {
        setUpdateToast({
          message,
          tone: 'error',
        });
      }
    }
  }, []);

  useEffect(() => {
    if (!isTauriRuntime() || !preferences.startupUpdateCheck || !shouldRunStartupUpdateCheck(Date.now())) {
      return;
    }

    const timer = window.setTimeout(() => {
      void (async () => {
        await runUpdateCheck('startup');
      })();
    }, 8000);

    return () => window.clearTimeout(timer);
  }, [runUpdateCheck, preferences.startupUpdateCheck]);

  useEffect(() => {
    if (!isTauriRuntime()) {
      return;
    }

    let stopSystemCheckUpdate: UnlistenFn | undefined;
    let cancelled = false;

    const attach = async () => {
      try {
        const nextStopSystemCheckUpdate = await listen('system-check-update', () => {
          void runUpdateCheck('manual');
        });

        if (cancelled) {
          nextStopSystemCheckUpdate();
          return;
        }

        stopSystemCheckUpdate = nextStopSystemCheckUpdate;
      } catch (error) {
        appLogger.error('监听系统更新检查事件失败', { error: String(error) });
      }
    };

    void attach();

    return () => {
      cancelled = true;
      stopSystemCheckUpdate?.();
    };
  }, [runUpdateCheck]);

  useEffect(() => {
    if (!isTauriRuntime()) {
      return;
    }

    let stopSystemOpenSettings: UnlistenFn | undefined;
    let stopSettingsChanged: UnlistenFn | undefined;
    let cancelled = false;

    const attach = async () => {
      try {
        const nextStopSystemOpenSettings = await listen(SYSTEM_OPEN_SETTINGS_EVENT, () => {
          void openSettingsWindow(preferencesRef.current);
        });

        if (cancelled) {
          nextStopSystemOpenSettings();
          return;
        }

        stopSystemOpenSettings = nextStopSystemOpenSettings;

        const nextStopSettingsChanged = await listen(SETTINGS_CHANGED_EVENT, () => {
          // Re-read localStorage to sync with settings window changes
          try {
            const rawPrefs = window.localStorage.getItem('termbridge.preferences');
            if (rawPrefs) {
              setStoredPreferences(JSON.parse(rawPrefs));
            }
          } catch {
            // ignore parse errors
          }
        });

        if (cancelled) {
          nextStopSettingsChanged();
          return;
        }

        stopSettingsChanged = nextStopSettingsChanged;
      } catch (error) {
        appLogger.error('监听系统设置事件失败', { error: String(error) });
      }
    };

    void attach();

    return () => {
      cancelled = true;
      stopSystemOpenSettings?.();
      stopSettingsChanged?.();
    };
  }, []);

  useEffect(() => {
    if (!isTauriRuntime()) {
      return;
    }

    let stopAppExitRequest: UnlistenFn | undefined;
    let cancelled = false;

    const attach = async () => {
      try {
        const nextStopAppExitRequest = await listen('system-request-app-exit', () => {
          setExitDialogOpen(true);
        });

        if (cancelled) {
          nextStopAppExitRequest();
          return;
        }

        stopAppExitRequest = nextStopAppExitRequest;
      } catch (error) {
        appLogger.error('监听系统退出请求事件失败', { error: String(error) });
      }
    };

    void attach();

    return () => {
      cancelled = true;
      stopAppExitRequest?.();
    };
  }, []);

  const createSessionFromProfile = async (profile: ConnectionProfile) => {
    const request: Record<string, unknown> = {
      name: describeSession(profile),
      host: profile.host.trim(),
      port: profile.port,
      username: profile.username.trim(),
      authMethod: profile.authMethod,
      password: profile.password || undefined,
      privateKeyPath: profile.privateKeyPath?.trim() || undefined,
      passphrase: profile.passphrase || undefined,
      terminalCols: 120,
      terminalRows: 32,
    };
    if (profile.jumpHost) {
      request.jumpHost = {
        host: profile.jumpHost.host.trim(),
        port: profile.jumpHost.port,
        username: profile.jumpHost.username.trim(),
        authMethod: profile.jumpHost.authMethod,
        password: profile.jumpHost.password || undefined,
        privateKeyPath: profile.jumpHost.privateKeyPath?.trim() || undefined,
        passphrase: profile.jumpHost.passphrase || undefined,
      };
    }
    return invoke<SessionSummary>('create_session', { request });
  };

  const proceedWithConnection = async (profile: ConnectionProfile, remember: boolean, rememberPassword: boolean) => {
    try {
      if (remember) {
        // Store password in OS keychain before saving profile
        if (rememberPassword && profile.password && isTauriRuntime()) {
          try {
            await invoke('store_password', {
              profileId: profile.id,
              password: profile.password,
            });
          } catch (error) {
            appLogger.warn('Failed to store password in keychain', { error: String(error) });
          }
        }
        const nextProfile = sanitizeProfileForStorage({
          ...profile,
          rememberPassword,
        });
        setSavedProfiles((current) => {
          const others = current.filter((item) => item.id !== nextProfile.id);
          return [nextProfile, ...others].slice(0, preferences.historyLimit);
        });
      }

      const summary = await createSessionFromProfile(profile);
      const bufferedStatus = consumeBufferedSessionStatus(summary.sessionId, pendingStatusEventsRef.current);
      const nextSession: SessionState = {
        ...summary,
        profile,
        status: bufferedStatus?.status ?? 'connecting',
        note: bufferedStatus?.note,
        createdAt: Date.now(),
      };
      const insertAfterSessionId = activeSessionId;
      sessionsRef.current = insertSessionAfterActive(sessionsRef.current, nextSession, insertAfterSessionId);
      setSessions((current) => insertSessionAfterActive(current, nextSession, insertAfterSessionId));
      setActiveSessionId(summary.sessionId);

      // Start port forwards if configured
      if ((profile.portForwards?.length ?? 0) > 0 && isTauriRuntime()) {
        const forwardOpId = `pf-${summary.sessionId}`;
        void invoke('start_port_forwards', {
          operationId: forwardOpId,
          host: profile.host.trim(),
          port: profile.port,
          username: profile.username.trim(),
          authMethod: profile.authMethod,
          password: profile.password || undefined,
          privateKeyPath: profile.privateKeyPath?.trim() || undefined,
          passphrase: profile.passphrase || undefined,
          jumpHost: profile.jumpHost
            ? {
                host: profile.jumpHost.host.trim(),
                port: profile.jumpHost.port,
                username: profile.jumpHost.username.trim(),
                authMethod: profile.jumpHost.authMethod,
                password: profile.jumpHost.password || undefined,
                privateKeyPath: profile.jumpHost.privateKeyPath?.trim() || undefined,
                passphrase: profile.jumpHost.passphrase || undefined,
              }
            : undefined,
          forwards: profile.portForwards,
        }).catch((error) => {
          appLogger.warn('Failed to start port forwards', { error: String(error) });
        });
      }

      setDraftProfile({
        ...createEmptyProfile(),
        username: profile.username,
        port: profile.port,
        authMethod: profile.authMethod,
        rememberPassword: false,
        privateKeyPath: profile.privateKeyPath ?? '',
      });
      setErrorMessage(undefined);
      setConnectDialogOpen(false);
      appLogger.info('SSH 会话创建成功', {
        sessionId: summary.sessionId,
        title: summary.title,
      });
    } catch (error) {
      appLogger.error('SSH 会话创建失败', error);
      setErrorMessage(String(error));
    }
  };

  const handleConnect = async (profile: ConnectionProfile, remember: boolean, rememberPassword: boolean) => {
    if (isConnecting) return;

    if (!profile.host.trim() || !profile.username.trim()) {
      appLogger.warn('连接参数校验失败：Host 或 Username 为空');
      setErrorMessage(t('app.error.hostUsernameRequired'));
      return;
    }

    if (!isTauriRuntime()) {
      appLogger.warn('浏览器预览模式下尝试建立连接');
      setErrorMessage(t('app.error.desktopOnly'));
      return;
    }

    setIsConnecting(true);
    try {
      appLogger.info('开始检查主机密钥', {
        host: profile.host.trim(),
        port: profile.port,
      });

      const checkResult = await invoke<HostKeyCheckResponse>('check_host_key', {
        request: {
          host: profile.host.trim(),
          port: profile.port,
        },
      });

      if (checkResult.status === 'mismatch') {
        appLogger.warn('主机密钥不匹配，可能存在中间人攻击', {
          host: profile.host.trim(),
          port: profile.port,
        });
        setErrorMessage(t('app.error.hostKeyMismatch'));
        return;
      }

      if (checkResult.status === 'failure') {
        appLogger.warn('主机密钥检查失败', {
          host: profile.host.trim(),
          port: profile.port,
        });
        setErrorMessage(checkResult.message || t('app.error.hostKeyCheckFailed'));
        return;
      }

      if (checkResult.status === 'notFound') {
        appLogger.info('首次连接到该主机，等待用户确认指纹', {
          host: profile.host.trim(),
          fingerprint: checkResult.fingerprint,
        });
        setHostKeyDialog({
          open: true,
          profile,
          fingerprint: checkResult.fingerprint,
          remember,
          rememberPassword,
        });
        return;
      }

      await proceedWithConnection(profile, remember, rememberPassword);
    } catch (error) {
      appLogger.error('主机密钥检查或连接失败', error);
      setErrorMessage(String(error));
    } finally {
      setIsConnecting(false);
    }
  };

  const handleTrustAndConnect = async () => {
    if (!hostKeyDialog.profile) return;

    const { profile, remember, rememberPassword } = hostKeyDialog;
    try {
      await invoke('trust_host', {
        request: {
          host: profile.host.trim(),
          port: profile.port,
        },
      });
      setHostKeyDialog({ open: false });
      await proceedWithConnection(profile, remember ?? false, rememberPassword ?? false);
    } catch (error) {
      appLogger.error('信任主机失败', error);
      setErrorMessage(String(error));
    }
  };

  const loadProfile = async (profile: ConnectionProfile) => {
    let password = '';
    if (profile.rememberPassword && isTauriRuntime()) {
      try {
        const stored = await invoke<string | null>('retrieve_password', {
          profileId: profile.id,
        });
        if (stored) {
          password = stored;
        }
      } catch (error) {
        appLogger.warn('Failed to retrieve password from keychain', { error: String(error) });
      }
    }
    setDraftProfile({
      ...profile,
      password,
      passphrase: '',
    });
    setErrorMessage(undefined);
    setConnectDialogOpen(true);
  };

  const handleCloseSession = async (sessionId: string) => {
    delete pendingStatusEventsRef.current[sessionId];

    if (!isTauriRuntime()) {
      appLogger.warn('浏览器预览模式下关闭会话', { sessionId });
      setSessions((current) => current.filter((session) => session.sessionId !== sessionId));
      removeFileManagerSessionState(sessionId);
      return;
    }

    try {
      appLogger.info('请求关闭会话', { sessionId });
      await invoke('close_session', { sessionId });
    } finally {
      // Stop port forwards if running
      if (isTauriRuntime()) {
        const forwardOpId = `pf-${sessionId}`;
        void invoke('stop_port_forwards', { operationId: forwardOpId }).catch((error) => {
          appLogger.warn('Failed to stop port forwards', { error: String(error) });
        });
      }
      let nextActiveSessionId: string | undefined;
      setSessions((current) => {
        const remaining = current.filter((session) => session.sessionId !== sessionId);
        nextActiveSessionId = remaining[0]?.sessionId;
        return remaining;
      });
      setActiveSessionId((current) => (current === sessionId ? nextActiveSessionId : current));
      removeFileManagerSessionState(sessionId);
      appLogger.info('会话已从前端状态移除', { sessionId });
    }
  };

  const handleDeleteSavedProfile = (profileId: string) => {
    const target = savedProfiles.find((item) => item.id === profileId);
    if (!target) {
      return;
    }

    setPendingDeleteProfileId(profileId);
  };

  const handleToggleSavedProfilePinned = (profileId: string) => {
    setSavedProfiles((current) =>
      current.map((profile) =>
        profile.id === profileId
          ? {
              ...profile,
              pinned: !profile.pinned,
            }
          : profile,
      ),
    );
  };

  const handleToggleSavedProfileFavorite = (profileId: string) => {
    setSavedProfiles((current) =>
      current.map((profile) =>
        profile.id === profileId
          ? {
              ...profile,
              favorite: !profile.favorite,
            }
          : profile,
      ),
    );
  };

  const handleRenameSavedProfile = (profileId: string, name: string) => {
    setSavedProfiles((current) =>
      current.map((profile) =>
        profile.id === profileId
          ? {
              ...profile,
              name,
            }
          : profile,
      ),
    );
  };

  const handleSetSavedProfileColor = (profileId: string, color?: string) => {
    setSavedProfiles((current) =>
      current.map((profile) =>
        profile.id === profileId
          ? {
              ...profile,
              color,
            }
          : profile,
      ),
    );
  };

  const handleMoveProfileToGroup = (profileId: string, groupId?: string) => {
    setSavedProfiles((current) =>
      current.map((profile) =>
        profile.id === profileId
          ? { ...profile, groupId }
          : profile,
      ),
    );
  };

  const handleAddGroup = (name: string) => {
    const id = crypto.randomUUID();
    setSavedGroups((current) => [...current, { id, name }]);
  };

  const handleDeleteGroup = (groupId: string) => {
    setSavedGroups((current) => current.filter((g) => g.id !== groupId));
    setSavedProfiles((current) =>
      current.map((profile) =>
        profile.groupId === groupId ? { ...profile, groupId: undefined } : profile,
      ),
    );
  };

  const handleRenameGroup = (groupId: string, name: string) => {
    setSavedGroups((current) =>
      current.map((g) => (g.id === groupId ? { ...g, name } : g)),
    );
  };

  const handleReconnectSession = async (sessionId: string, options?: { automatic?: boolean }) => {
    const automatic = options?.automatic ?? false;
    const target = sessionsRef.current.find((item) => item.sessionId === sessionId);
    if (!target) {
      return;
    }

    if (!isTauriRuntime()) {
      appLogger.warn('浏览器预览模式下尝试重连会话', { sessionId });
      setErrorMessage(t('app.error.desktopOnly'));
      return;
    }

    try {
      appLogger.info('开始重连会话', { sessionId });
      const summary = await createSessionFromProfile(target.profile);
      setSessions((current) => {
        const bufferedStatus = consumeBufferedSessionStatus(summary.sessionId, pendingStatusEventsRef.current);
        const nextSession: SessionState = {
          ...summary,
          title: target.title,
          profile: target.profile,
          status: bufferedStatus?.status ?? 'connecting',
          note: bufferedStatus?.note,
          createdAt: Date.now(),
        };
        return current.map((item) => (item.sessionId === sessionId ? nextSession : item));
      });
      setActiveSessionId((current) => (current === sessionId ? summary.sessionId : current));
      replaceFileManagerSessionStateKey(sessionId, summary.sessionId);
      delete autoReconnectAttemptedRef.current[sessionId];
      delete autoReconnectAttemptedRef.current[summary.sessionId];
      setErrorMessage(undefined);
      appLogger.info('会话重连成功', {
        fromSessionId: sessionId,
        toSessionId: summary.sessionId,
        automatic,
      });
    } catch (error) {
      appLogger.error('会话重连失败', {
        sessionId,
        automatic,
        error: String(error),
      });
      setSessions((current) =>
        current.map((item) =>
          item.sessionId === sessionId
            ? {
                ...item,
                status: 'error',
                note: automatic
                  ? t('app.error.autoReconnectFailed', { error: String(error) })
                  : t('app.error.reconnectFailed', { error: String(error) }),
              }
            : item,
        ),
      );
      setErrorMessage(
        automatic ? t('app.error.autoReconnectFailed', { error: String(error) }) : t('app.error.reconnectFailed', { error: String(error) }),
      );
    }
  };

  const confirmDeleteSavedProfile = () => {
    if (!pendingDeleteProfileId) {
      return;
    }

    appLogger.info('删除历史连接', { profileId: pendingDeleteProfileId });
    if (isTauriRuntime()) {
      void invoke('remove_password', { profileId: pendingDeleteProfileId }).catch((error) => {
        appLogger.warn('Failed to remove password from keychain', { error: String(error) });
      });
    }
    setSavedProfiles((current) => current.filter((item) => item.id !== pendingDeleteProfileId));
    setPendingDeleteProfileId(undefined);
  };

  const confirmCloseSession = () => {
    if (!pendingCloseSessionId) {
      return;
    }

    void handleCloseSession(pendingCloseSessionId);
    setPendingCloseSessionId(undefined);
  };

  const confirmAppExit = () => {
    appLogger.info('用户确认退出应用');
    setExitDialogOpen(false);
    void invoke('request_app_exit');
  };

  const handleInstallUpdateNow = () => {
    appLogger.info('用户确认立即重启安装更新');
    void (async () => {
      try {
        await invoke('request_app_restart');
        return;
      } catch (error) {
        appLogger.error('调用原生重启失败，回退到窗口刷新', { error: String(error) });
      }

      setUpdateToast({
        message: t('app.update.restartFallback'),
        tone: 'info',
      });

      window.setTimeout(() => {
        try {
          window.location.reload();
        } catch (error) {
          const message = t('app.update.reloadFailed', { error: String(error) });
          appLogger.error('回退刷新失败', { error: String(error) });
          setUpdateToast({
            message,
            tone: 'error',
          });
        }
      }, 1000);
    })();
  };

  const handleInstallUpdateLater = () => {
    appLogger.info('用户选择稍后安装更新');
    setRestartDialogDismissed(true);
  };

  const workspaceContent = (
    <section className="flex h-full w-full min-h-0 min-w-0 flex-col">
      {errorMessage ? (
        <div className="surface flex items-center justify-between gap-2 px-2 py-1.5 text-xs text-rose-300">
          <span className="truncate">{errorMessage}</span>
          {activeSession ? (
            <span className={cn('px-2 py-1 text-[10px]', sessionStatusTone(activeSession.status))}>
              {activeSession.status === 'connected'
                ? t('app.status.connected')
                : activeSession.status === 'connecting'
                  ? t('app.status.connecting')
                  : activeSession.status === 'error'
                    ? t('app.status.error')
                    : t('app.status.disconnected')}
            </span>
          ) : null}
        </div>
      ) : null}

      <SessionTabs
        sessions={sessions}
        activeSessionId={activeSessionId}
        onClose={(sessionId) => {
          setPendingCloseSessionId(sessionId);
        }}
        onCloseAll={() => {
          for (const session of sessions) {
            void handleCloseSession(session.sessionId);
          }
        }}
        onCloseOthers={(sessionId) => {
          for (const session of sessions) {
            if (session.sessionId !== sessionId) {
              void handleCloseSession(session.sessionId);
            }
          }
        }}
        onCloseToLeft={(sessionId) => {
          const index = sessions.findIndex((s) => s.sessionId === sessionId);
          if (index <= 0) return;
          for (let i = 0; i < index; i++) {
            void handleCloseSession(sessions[i].sessionId);
          }
        }}
        onCloseToRight={(sessionId) => {
          const index = sessions.findIndex((s) => s.sessionId === sessionId);
          if (index < 0 || index >= sessions.length - 1) return;
          for (let i = index + 1; i < sessions.length; i++) {
            void handleCloseSession(sessions[i].sessionId);
          }
        }}
        onDragStateChange={setReorderingSessions}
        onRename={(sessionId, title) => {
          setSessions((current) =>
            current.map((session) =>
              session.sessionId === sessionId
                ? {
                    ...session,
                    title,
                  }
                : session,
            ),
          );
        }}
        onReorder={(draggedSessionId, insertIndex) => {
          setSessions((current) => reorderSessions(current, draggedSessionId, insertIndex));
        }}
        onSelect={setActiveSessionId}
      />

      <section className="surface relative min-h-0 flex-1 overflow-hidden">
        {sessions.length === 0 ? (
          <div className="flex h-full min-h-70 flex-col justify-between gap-1 p-1.5">
            <div className="flex flex-col gap-1">
              <span className="label">{t('app.ready')}</span>
              <h3 className="themed-heading text-base font-semibold">{t('app.emptyState.title')}</h3>
              <p className="text-xs leading-5 text-slate-400">{t('app.emptyState.description')}</p>
            </div>
          </div>
        ) : (
          <div className="relative h-full min-h-0">
            {sessions.map((session) => (
              <TerminalPane
                active={session.sessionId === activeSessionId}
                copyOnSelect={preferences.copyOnSelect}
                cursorBlink={preferences.cursorBlink}
                cursorStyle={preferences.cursorStyle}
                fontSize={preferences.terminalFontSize}
                key={session.sessionId}
                lineHeight={preferences.terminalLineHeight}
                onReconnect={() => {
                  void handleReconnectSession(session.sessionId);
                }}
                ref={(el) => {
                  if (el) {
                    terminalPaneRefs.current[session.sessionId] = el;
                  } else {
                    delete terminalPaneRefs.current[session.sessionId];
                  }
                }}
                session={session}
                terminalTheme={preferences.terminalTheme}
              />
            ))}
          </div>
        )}
      </section>
    </section>
  );

  const handleTogglePrimarySide = useCallback(() => {
    setStoredPreferences((prev) => ({ ...prev, showFileManager: !normalizePreferences(prev).showFileManager }));
  }, [setStoredPreferences]);

  const handleToggleSecondarySide = useCallback(() => {
    setStoredPreferences((prev) => ({ ...prev, showSidebar: !normalizePreferences(prev).showSidebar }));
  }, [setStoredPreferences]);

  return (
    <TooltipProvider>
      <main className="h-screen overflow-hidden flex flex-col">
      <TitleBar
        onTogglePrimarySide={handleTogglePrimarySide}
        onToggleSecondarySide={handleToggleSecondarySide}
        primarySideVisible={preferences.showFileManager}
        secondarySideVisible={preferences.showSidebar}
      />
      <div className="flex flex-1 gap-0 p-0 min-h-0">
        <SplitLayout className="min-w-0 flex-1" storageKey="termbridge.layout.main">
          <SplitLayout.Slot className="min-h-0" collapsed={!preferences.showFileManager} defaultSize={320} minSize={280} name="fileManager">
            {() => {
              const activeProfileId = activeSession?.profile.id;
              const activeBookmarks = activeProfileId
                ? (savedProfiles.find((p) => p.id === activeProfileId)?.bookmarks ?? [])
                : [];
              return (
                <FileManager
                  bookmarks={activeBookmarks}
                  ignoreWindowDragDrop={reorderingSessions}
                  session={activeSession}
                  onAddBookmark={(path) => {
                    if (!activeProfileId) return;
                    setSavedProfiles((prev) =>
                      prev.map((p) =>
                        p.id === activeProfileId
                          ? { ...p, bookmarks: [...new Set([...(p.bookmarks ?? []), path])] }
                          : p,
                      ),
                    );
                  }}
                  onRemoveBookmark={(path) => {
                    if (!activeProfileId) return;
                    setSavedProfiles((prev) =>
                      prev.map((p) =>
                        p.id === activeProfileId
                          ? { ...p, bookmarks: (p.bookmarks ?? []).filter((b) => b !== path) }
                          : p,
                      ),
                    );
                  }}
                />
              );
            }}
          </SplitLayout.Slot>

          <SplitLayout.Slot className="min-h-0" minSize={520} name="workspace">
            {() => (
              <SplitLayout className="w-full" storageKey="termbridge.layout.sidebar">
                <SplitLayout.Slot className="min-h-0" defaultSize={520} minSize={320} name="tabs">
                  {() => workspaceContent}
                </SplitLayout.Slot>

                <SplitLayout.Slot className="min-h-0" collapsed={!preferences.showSidebar} defaultSize={280} fixed minSize={240} name="sidebar">
                  {() => (
                    <div className="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)]">
                      <Sidebar
                        connectedCount={connectedSessions}
                        groups={savedGroups}
                        runtimeLabel={runtimeText}
                        savedProfiles={savedProfiles}
                        onAddGroup={handleAddGroup}
                        onDeleteGroup={handleDeleteGroup}
                        onDeleteProfile={handleDeleteSavedProfile}
                        onMoveProfileToGroup={handleMoveProfileToGroup}
                        onRenameGroup={handleRenameGroup}
                        onRenameProfile={handleRenameSavedProfile}
                        onToggleFavoriteProfile={handleToggleSavedProfileFavorite}
                        onTogglePinnedProfile={handleToggleSavedProfilePinned}
                        onSetProfileColor={handleSetSavedProfileColor}
                        onReuseProfile={loadProfile}
                        onOpenConnect={() => {
                          setDraftProfile(createEmptyProfile());
                          setErrorMessage(undefined);
                          setConnectDialogOpen(true);
                        }}
                      />
                      <SnippetsPanel
                        onSendCommand={(command) => {
                          const pane = activeSessionId ? terminalPaneRefs.current[activeSessionId] : undefined;
                          if (pane) {
                            pane.sendData(command + '\r');
                          }
                        }}
                      />
                    </div>
                  )}
                </SplitLayout.Slot>
              </SplitLayout>
            )}
          </SplitLayout.Slot>
        </SplitLayout>
      </div>

      <SettingsDialog
        onChange={setStoredPreferences}
        onClose={() => setSettingsDialogOpen(false)}
        open={settingsDialogOpen}
        preferences={preferences}
      />

      <ConnectDialog
        draftProfile={draftProfile}
        groups={savedGroups}
        isConnecting={isConnecting}
        onClose={() => setConnectDialogOpen(false)}
        onConnect={(profile, remember, rememberPassword) => {
          void handleConnect(profile, remember, rememberPassword);
        }}
        onProfileChange={(profile) => {
          setDraftProfile(profile);
          setErrorMessage(undefined);
        }}
        open={connectDialogOpen}
      />

      <DeleteProfileDialog
        onClose={() => setPendingDeleteProfileId(undefined)}
        onConfirm={confirmDeleteSavedProfile}
        open={!!pendingDeleteProfileId}
        profile={pendingDeleteProfile}
      />

      <CloseSessionDialog
        onClose={() => setPendingCloseSessionId(undefined)}
        onConfirm={confirmCloseSession}
        open={!!pendingCloseSessionId}
        session={pendingCloseSession}
      />

      <ExitAppDialog
        onClose={() => setExitDialogOpen(false)}
        onConfirm={confirmAppExit}
        open={exitDialogOpen}
      />

      <HostKeyDialog
        fingerprint={hostKeyDialog.fingerprint}
        onClose={() => setHostKeyDialog({ open: false })}
        onTrustAndConnect={() => void handleTrustAndConnect()}
        open={hostKeyDialog.open && !!hostKeyDialog.profile}
        profile={hostKeyDialog.profile}
      />

      <UpdateRestartDialog
        downloadProgress={updateDownloadProgress}
        hasActiveSessions={connectedSessions > 0}
        onInstallNow={handleInstallUpdateNow}
        onLater={handleInstallUpdateLater}
        open={restartDialogOpen}
        version={updateState.version?.downloadedVersion ?? updateState.version?.latestVersion ?? t('app.update.latestVersion')}
      />

      <Toast
        message={updateToast?.message ?? ''}
        onClose={() => setUpdateToast(undefined)}
        open={Boolean(updateToast)}
        tone={updateToast?.tone ?? 'info'}
      />
    </main>
    </TooltipProvider>
  );
}

export default App;
