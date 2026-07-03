import { invoke } from '@tauri-apps/api/core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AboutDialog } from './components/AboutDialog';
import { CloseSessionDialog } from './components/CloseSessionDialog';
import { ConnectDialog } from './components/ConnectDialog';
import { DeleteProfileDialog } from './components/DeleteProfileDialog';
import { ExitAppDialog } from './components/ExitAppDialog';
import { FileManager } from './components/FileManager';
import { HostKeyDialog } from './components/HostKeyDialog';
import { StatusBar } from './components/StatusBar';
import { TitleBar } from './components/TitleBar';
import { SettingsDialog } from './components/SettingsDialog';
import { Sidebar } from './components/Sidebar';
import { SplitLayout } from './components/SplitLayout';
import { SessionTabs } from './components/SessionTabs';
import { TerminalPane, type TerminalPaneRef } from './components/TerminalPane';
import { SnippetsPanel } from './components/SnippetsPanel';
import { Toast, toaster } from './components/ui';
import { Toast as ChakraToast, Toaster } from '@chakra-ui/react';
import { UpdateRestartDialog } from './components/UpdateRestartDialog';
import { initI18n, syncI18nLocale, t } from './lib/i18n';
import { createLogger } from './lib/logger';
import { createEmptyProfile } from './lib/profile';
import { normalizePreferences, reorderSessions } from './lib/appHelpers';
import { isTauriRuntime } from './lib/tauri';
import { useFileManagerStore } from './stores/fileManagerStore';
import { cn, sessionStatusTone } from './lib/ui';
import { usePreferences } from './hooks/usePreferences';
import { useSavedProfiles } from './hooks/useSavedProfiles';
import { useSessions } from './hooks/useSessions';
import { useConnectionFlow } from './hooks/useConnectionFlow';
import { useUpdateFlow } from './hooks/useUpdateFlow';
import { useTauriSystemEvents, readPreferencesFromLocalStorage } from './hooks/useTauriSystemEvents';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import type { AppPreferences } from './types';

const appLogger = createLogger('app');

function App() {
  const { storedPreferences, setStoredPreferences, preferences, appliedTheme } = usePreferences();
  const {
    savedProfiles,
    setSavedProfiles,
    pendingDeleteProfileId,
    setPendingDeleteProfileId,
    handleDeleteSavedProfile,
    handleToggleSavedProfilePinned,
    handleToggleSavedProfileFavorite,
    handleRenameSavedProfile,
    confirmDeleteSavedProfile,
  } = useSavedProfiles();

  const [errorMessage, setErrorMessage] = useState<string>();
  const removeFileManagerSessionState = useFileManagerStore((state) => state.removeSessionState);
  const replaceFileManagerSessionStateKey = useFileManagerStore((state) => state.replaceSessionStateKey);
  const terminalPaneRefs = useRef<Record<string, TerminalPaneRef>>({});

  const {
    sessions,
    setSessions,
    activeSessionId,
    setActiveSessionId,
    sessionsRef,
    pendingStatusEventsRef,
    handleCloseSession,
    handleReconnectSession,
  } = useSessions({
    autoReconnect: preferences.autoReconnect,
    setErrorMessage,
    removeFileManagerSessionState,
    replaceFileManagerSessionStateKey,
  });

  const {
    draftProfile,
    setDraftProfile,
    connectDialogOpen,
    setConnectDialogOpen,
    isConnecting,
    hostKeyDialog,
    setHostKeyDialog,
    handleConnect,
    handleTrustAndConnect,
    loadProfile,
  } = useConnectionFlow({
    historyLimit: preferences.historyLimit,
    setSavedProfiles,
    setSessions,
    sessionsRef,
    activeSessionId,
    setActiveSessionId,
    pendingStatusEventsRef,
    setErrorMessage,
  });

  const [settingsDialogOpen, setSettingsDialogOpen] = useState(false);
  const [exitDialogOpen, setExitDialogOpen] = useState(false);
  const [aboutDialogOpen, setAboutDialogOpen] = useState(false);
  const [pendingCloseSessionId, setPendingCloseSessionId] = useState<string>();
  const [reorderingSessions, setReorderingSessions] = useState(false);
  const [, setIntlVersion] = useState(0);

  const {
    updateState,
    updateDownloadProgress,
    updateToast,
    restartDialogOpen,
    handleInstallUpdateNow,
    handleInstallUpdateLater,
    setUpdateToast,
  } = useUpdateFlow({ startupUpdateCheck: preferences.startupUpdateCheck });

  useTauriSystemEvents({
    onOpenSettings: useCallback(() => setSettingsDialogOpen(true), []),
    onRequestAppExit: useCallback(() => setExitDialogOpen(true), []),
    onAbout: useCallback(() => setAboutDialogOpen(true), []),
    onSettingsChangedExternal: useCallback(() => {
      const external = readPreferencesFromLocalStorage();
      if (external) {
        setStoredPreferences(() => external);
      }
    }, [setStoredPreferences]),
  });

  const activeSession = useMemo(() => sessions.find((item) => item.sessionId === activeSessionId), [activeSessionId, sessions]);
  const connectedSessions = useMemo(() => sessions.filter((item) => item.status === 'connected').length, [sessions]);
  const pendingDeleteProfile = useMemo(
    () => savedProfiles.find((item) => item.id === pendingDeleteProfileId),
    [pendingDeleteProfileId, savedProfiles],
  );
  const pendingCloseSession = useMemo(() => sessions.find((item) => item.sessionId === pendingCloseSessionId), [pendingCloseSessionId, sessions]);
  const runtimeText = isTauriRuntime() ? t('runtime.desktop') : t('runtime.browser');

  syncI18nLocale(preferences.locale);

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

  useKeyboardShortcuts({
    keyboardShortcuts: preferences.keyboardShortcuts,
    showFileManager: preferences.showFileManager,
    showSidebar: preferences.showSidebar,
    activeSessionId,
    dialogState: {
      hostKeyOpen: hostKeyDialog.open,
      connectOpen: connectDialogOpen,
      settingsOpen: settingsDialogOpen,
      pendingDelete: !!pendingDeleteProfileId,
      pendingClose: !!pendingCloseSessionId,
      exitOpen: exitDialogOpen,
    },
    handlers: {
      closeHostKeyDialog: () => setHostKeyDialog({ open: false }),
      closeConnectDialog: () => setConnectDialogOpen(false),
      closeSettingsDialog: () => setSettingsDialogOpen(false),
      cancelPendingDelete: () => setPendingDeleteProfileId(undefined),
      cancelPendingClose: () => setPendingCloseSessionId(undefined),
      closeExitDialog: () => setExitDialogOpen(false),
      openNewConnection: () => {
        setDraftProfile(createEmptyProfile());
        setErrorMessage(undefined);
        setConnectDialogOpen(true);
      },
      openSettings: () => setSettingsDialogOpen(true),
      requestCloseActiveSession: () => {
        const currentSessions = sessionsRef.current;
        if (currentSessions.length > 0) {
          setPendingCloseSessionId(activeSessionId ?? currentSessions[currentSessions.length - 1].sessionId);
        }
      },
      selectNextTab: () => {
        const currentSessions = sessionsRef.current;
        if (currentSessions.length > 1) {
          const idx = currentSessions.findIndex((s) => s.sessionId === activeSessionId);
          const next = idx === -1 ? currentSessions[0] : currentSessions[(idx + 1) % currentSessions.length];
          setActiveSessionId(next.sessionId);
        }
      },
      selectPrevTab: () => {
        const currentSessions = sessionsRef.current;
        if (currentSessions.length > 1) {
          const idx = currentSessions.findIndex((s) => s.sessionId === activeSessionId);
          const prev =
            idx === -1 ? currentSessions[currentSessions.length - 1] : currentSessions[(idx - 1 + currentSessions.length) % currentSessions.length];
          setActiveSessionId(prev.sessionId);
        }
      },
      togglePrimarySidebar: () =>
        setStoredPreferences((prev) => ({ ...prev, showFileManager: !normalizePreferences(prev).showFileManager })),
      toggleSecondarySidebar: () =>
        setStoredPreferences((prev) => ({ ...prev, showSidebar: !normalizePreferences(prev).showSidebar })),
      exportActiveTerminal: () => {
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
      },
    },
  });

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

  const handleTogglePrimarySide = useCallback(() => {
    setStoredPreferences((prev) => ({ ...prev, showFileManager: !normalizePreferences(prev).showFileManager }));
  }, [setStoredPreferences]);

  const handleToggleSecondarySide = useCallback(() => {
    setStoredPreferences((prev) => ({ ...prev, showSidebar: !normalizePreferences(prev).showSidebar }));
  }, [setStoredPreferences]);

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
            if (!session.pinned) {
              void handleCloseSession(session.sessionId);
            }
          }
        }}
        onCloseOthers={(sessionId) => {
          for (const session of sessions) {
            if (session.sessionId !== sessionId && !session.pinned) {
              void handleCloseSession(session.sessionId);
            }
          }
        }}
        onCloseToLeft={(sessionId) => {
          const index = sessions.findIndex((s) => s.sessionId === sessionId);
          if (index <= 0) return;
          for (let i = 0; i < index; i++) {
            if (!sessions[i].pinned) {
              void handleCloseSession(sessions[i].sessionId);
            }
          }
        }}
        onCloseToRight={(sessionId) => {
          const index = sessions.findIndex((s) => s.sessionId === sessionId);
          if (index < 0 || index >= sessions.length - 1) return;
          for (let i = index + 1; i < sessions.length; i++) {
            if (!sessions[i].pinned) {
              void handleCloseSession(sessions[i].sessionId);
            }
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
        onSetColor={(sessionId, color) => {
          setSessions((current) =>
            current.map((session) =>
              session.sessionId === sessionId
                ? {
                    ...session,
                    profile: {
                      ...session.profile,
                      color,
                    },
                  }
                : session,
            ),
          );
        }}
        onTogglePin={(sessionId) => {
          setSessions((current) => {
            const next = current.map((session) =>
              session.sessionId === sessionId
                ? { ...session, pinned: !session.pinned }
                : session,
            );
            return next.sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)));
          });
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

  return (
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
                        runtimeLabel={runtimeText}
                        savedProfiles={savedProfiles}
                        onDeleteProfile={handleDeleteSavedProfile}
                        onRenameProfile={handleRenameSavedProfile}
                        onToggleFavoriteProfile={handleToggleSavedProfileFavorite}
                        onTogglePinnedProfile={handleToggleSavedProfilePinned}
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

      <StatusBar
        sessions={sessions}
        activeSession={activeSession}
        updateState={updateState}
        updateDownloadProgress={updateDownloadProgress}
      />

      <SettingsDialog
        onChange={setStoredPreferences}
        onClose={() => setSettingsDialogOpen(false)}
        open={settingsDialogOpen}
        preferences={preferences}
      />

      <ConnectDialog
        draftProfile={draftProfile}
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

      <AboutDialog
        onClose={() => setAboutDialogOpen(false)}
        open={aboutDialogOpen}
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
      <Toaster toaster={toaster}>
        {(t) => (
          <ChakraToast.Root key={t.id} maxW="420px">
            <ChakraToast.Indicator />
            <ChakraToast.Title>{t.title}</ChakraToast.Title>
            {t.description && <ChakraToast.Description>{t.description}</ChakraToast.Description>}
            {t.action && (
              <ChakraToast.ActionTrigger onClick={t.action.onClick}>
                {t.action.label}
              </ChakraToast.ActionTrigger>
            )}
            <ChakraToast.CloseTrigger />
          </ChakraToast.Root>
        )}
      </Toaster>
    </main>
  );
}

export default App;

// Re-export for compatibility with any external consumers expecting these helpers.
export { normalizePreferences } from './lib/appHelpers';
export type { AppPreferences };
