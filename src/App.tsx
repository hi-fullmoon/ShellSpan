import { invoke } from '@tauri-apps/api/core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AboutDialog } from './components/AboutDialog';
import { CloseSessionDialog } from './components/CloseSessionDialog';
import { ConnectDialog } from './components/ConnectDialog';
import { DeleteProfileDialog } from './components/DeleteProfileDialog';
import { ExitAppDialog } from './components/ExitAppDialog';
import { HostKeyDialog } from './components/HostKeyDialog';
import { MySection } from './components/MySection';
import { SftpSection } from './components/SftpSection';
import { StatusBar } from './components/StatusBar';
import { TerminalSection } from './components/TerminalSection';
import { TitleBar } from './components/TitleBar';
import { UpdateRestartDialog } from './components/UpdateRestartDialog';
import { Toast, toaster } from './components/ui';
import { Toast as ChakraToast, Toaster } from '@chakra-ui/react';
import { initI18n, syncI18nLocale, t } from './lib/i18n';
import { createLogger } from './lib/logger';
import { createEmptyProfile } from './lib/profile';
import { reorderSessions } from './lib/appHelpers';
import { useFileManagerStore } from './stores/fileManagerStore';
import { useAppStore } from './stores/appStore';
import { useRecentConnectionsStore } from './stores/recentConnectionsStore';
import { usePreferences } from './hooks/usePreferences';
import { useSavedProfiles } from './hooks/useSavedProfiles';
import { useSessions } from './hooks/useSessions';
import { useConnectionFlow } from './hooks/useConnectionFlow';
import { useUpdateFlow } from './hooks/useUpdateFlow';
import { useTauriSystemEvents, readPreferencesFromLocalStorage } from './hooks/useTauriSystemEvents';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import { type TerminalPaneRef } from './components/TerminalPane';
import { listenSettingsChanged, openSettingsWindow } from './lib/settingsWindow';
import type { AppPreferences, ConnectionProfile } from './types';

const appLogger = createLogger('app');

function App() {
  const { setStoredPreferences, preferences } = usePreferences();
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

  const activeSection = useAppStore((state) => state.activeSection);
  const setActiveSection = useAppStore((state) => state.setActiveSection);
  const addRecentConnection = useRecentConnectionsStore((state) => state.add);

  const [errorMessage, setErrorMessage] = useState<string>();
  const removeFileManagerSessionState = useFileManagerStore((state) => state.removeSessionState);
  const replaceFileManagerSessionStateKey = useFileManagerStore((state) => state.replaceSessionStateKey);
  const terminalPaneRefs = useRef<Record<string, TerminalPaneRef>>({});
  const connectFromSftpRef = useRef(false);

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

  function handleSuccessfulConnection(profile: ConnectionProfile, sessionId: string) {
    addRecentConnection({
      host: profile.host,
      port: profile.port,
      username: profile.username,
      name: profile.name,
      authMethod: profile.authMethod,
      privateKeyPath: profile.privateKeyPath,
    });
    if (connectFromSftpRef.current) {
      setActiveSection('sftp');
      useAppStore.getState().openSftpSession(sessionId);
      connectFromSftpRef.current = false;
    } else {
      setActiveSection('terminal');
    }
  }

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
    onSuccess: handleSuccessfulConnection,
  });

  const [exitDialogOpen, setExitDialogOpen] = useState(false);
  const [aboutDialogOpen, setAboutDialogOpen] = useState(false);
  const [pendingCloseSessionId, setPendingCloseSessionId] = useState<string>();
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
    onOpenSettings: useCallback(() => {
      void openSettingsWindow(preferences);
    }, [preferences]),
    onRequestAppExit: useCallback(() => setExitDialogOpen(true), []),
    onAbout: useCallback(() => setAboutDialogOpen(true), []),
    onSettingsChangedExternal: useCallback(() => {
      const external = readPreferencesFromLocalStorage();
      if (external) {
        setStoredPreferences(() => external);
      }
    }, [setStoredPreferences]),
  });

  useEffect(() => {
    const stopListen = listenSettingsChanged((nextPreferences) => {
      setStoredPreferences(() => nextPreferences);
    });

    return () => {
      stopListen();
    };
  }, [setStoredPreferences]);

  const activeSession = useMemo(() => sessions.find((item) => item.sessionId === activeSessionId), [activeSessionId, sessions]);
  const connectedSessions = useMemo(() => sessions.filter((item) => item.status === 'connected').length, [sessions]);
  const pendingDeleteProfile = useMemo(
    () => savedProfiles.find((item) => item.id === pendingDeleteProfileId),
    [pendingDeleteProfileId, savedProfiles],
  );
  const pendingCloseSession = useMemo(() => sessions.find((item) => item.sessionId === pendingCloseSessionId), [pendingCloseSessionId, sessions]);

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

  const openConnectDialog = useCallback(() => {
    connectFromSftpRef.current = false;
    setDraftProfile(createEmptyProfile());
    setErrorMessage(undefined);
    setConnectDialogOpen(true);
  }, [setDraftProfile, setConnectDialogOpen]);

  const openConnectDialogFromSftp = useCallback(() => {
    connectFromSftpRef.current = true;
    setDraftProfile(createEmptyProfile());
    setErrorMessage(undefined);
    setConnectDialogOpen(true);
  }, [setDraftProfile, setConnectDialogOpen]);

  const handleOpenSettings = useCallback(() => {
    void openSettingsWindow(preferences);
  }, [preferences]);

  const handleConnectProfile = useCallback(
    async (profile: ConnectionProfile, remember = false, rememberPassword = false) => {
      await handleConnect(profile, remember, rememberPassword);
    },
    [handleConnect],
  );

  useKeyboardShortcuts({
    keyboardShortcuts: preferences.keyboardShortcuts,
    activeSessionId,
    dialogState: {
      hostKeyOpen: hostKeyDialog.open,
      connectOpen: connectDialogOpen,
      pendingDelete: !!pendingDeleteProfileId,
      pendingClose: !!pendingCloseSessionId,
      exitOpen: exitDialogOpen,
    },
    handlers: {
      closeHostKeyDialog: () => setHostKeyDialog({ open: false }),
      closeConnectDialog: () => setConnectDialogOpen(false),
      cancelPendingDelete: () => setPendingDeleteProfileId(undefined),
      cancelPendingClose: () => setPendingCloseSessionId(undefined),
      closeExitDialog: () => setExitDialogOpen(false),
      openNewConnection: openConnectDialog,
      openSettings: handleOpenSettings,
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
            idx === -1
              ? currentSessions[currentSessions.length - 1]
              : currentSessions[(idx - 1 + currentSessions.length) % currentSessions.length];
          setActiveSessionId(prev.sessionId);
        }
      },
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

  const bookmarksByProfileId = useMemo(() => {
    const map: Record<string, string[]> = {};
    for (const profile of savedProfiles) {
      if (profile.bookmarks?.length) {
        map[profile.id] = profile.bookmarks;
      }
    }
    return map;
  }, [savedProfiles]);

  const handleAddBookmark = useCallback(
    (profileId: string, path: string) => {
      setSavedProfiles((prev) =>
        prev.map((p) =>
          p.id === profileId ? { ...p, bookmarks: [...new Set([...(p.bookmarks ?? []), path])] } : p,
        ),
      );
    },
    [setSavedProfiles],
  );

  const handleRemoveBookmark = useCallback(
    (profileId: string, path: string) => {
      setSavedProfiles((prev) =>
        prev.map((p) =>
          p.id === profileId ? { ...p, bookmarks: (p.bookmarks ?? []).filter((b) => b !== path) } : p,
        ),
      );
    },
    [setSavedProfiles],
  );

  const renderSection = () => {
    switch (activeSection) {
      case 'my':
        return (
          <MySection
            savedProfiles={savedProfiles}
            onConnectProfile={(profile) => {
              void handleConnectProfile(profile, false, false);
            }}
            onEditProfile={(profile) => {
              void loadProfile(profile);
            }}
            onDeleteProfile={handleDeleteSavedProfile}
            onTogglePinProfile={handleToggleSavedProfilePinned}
            onToggleFavoriteProfile={handleToggleSavedProfileFavorite}
            onRenameProfile={handleRenameSavedProfile}
            onOpenConnectDialog={openConnectDialog}
            onSendSnippetCommand={(command) => {
              const pane = activeSessionId ? terminalPaneRefs.current[activeSessionId] : undefined;
              if (pane) {
                pane.sendData(`${command}\r`);
              }
            }}
          />
        );
      case 'sftp':
        return (
          <SftpSection
            bookmarksByProfileId={bookmarksByProfileId}
            onNewConnection={openConnectDialogFromSftp}
            sessions={sessions}
            onAddBookmark={handleAddBookmark}
            onRemoveBookmark={handleRemoveBookmark}
          />
        );
      case 'terminal':
        return (
          <TerminalSection
            activeSessionId={activeSessionId}
            errorMessage={errorMessage}
            preferences={{
              terminalFontSize: preferences.terminalFontSize,
              terminalLineHeight: preferences.terminalLineHeight,
              terminalTheme: preferences.terminalTheme,
              cursorStyle: preferences.cursorStyle,
              cursorBlink: preferences.cursorBlink,
              copyOnSelect: preferences.copyOnSelect,
            }}
            sessions={sessions}
            onCloseAllSessions={() => {
              for (const session of sessions) {
                if (!session.pinned) {
                  void handleCloseSession(session.sessionId);
                }
              }
            }}
            onCloseOtherSessions={(sessionId) => {
              for (const session of sessions) {
                if (session.sessionId !== sessionId && !session.pinned) {
                  void handleCloseSession(session.sessionId);
                }
              }
            }}
            onCloseSession={(sessionId) => setPendingCloseSessionId(sessionId)}
            onCloseSessionsToLeft={(sessionId) => {
              const index = sessions.findIndex((s) => s.sessionId === sessionId);
              if (index <= 0) return;
              for (let i = 0; i < index; i++) {
                if (!sessions[i].pinned) {
                  void handleCloseSession(sessions[i].sessionId);
                }
              }
            }}
            onCloseSessionsToRight={(sessionId) => {
              const index = sessions.findIndex((s) => s.sessionId === sessionId);
              if (index < 0 || index >= sessions.length - 1) return;
              for (let i = index + 1; i < sessions.length; i++) {
                if (!sessions[i].pinned) {
                  void handleCloseSession(sessions[i].sessionId);
                }
              }
            }}
            onNewConnection={openConnectDialog}
            onReconnectSession={(sessionId) => {
              void handleReconnectSession(sessionId);
            }}
            onRenameSession={(sessionId, title) => {
              setSessions((current) =>
                current.map((session) =>
                  session.sessionId === sessionId ? { ...session, title } : session,
                ),
              );
            }}
            onReorderSessions={(draggedSessionId, insertIndex) => {
              setSessions((current) => reorderSessions(current, draggedSessionId, insertIndex));
            }}
            onSelectSession={setActiveSessionId}
            onSetSessionColor={(sessionId, color) => {
              setSessions((current) =>
                current.map((session) =>
                  session.sessionId === sessionId
                    ? { ...session, profile: { ...session.profile, color } }
                    : session,
                ),
              );
            }}
            onToggleSessionPin={(sessionId) => {
              setSessions((current) => {
                const next = current.map((session) =>
                  session.sessionId === sessionId ? { ...session, pinned: !session.pinned } : session,
                );
                return next.sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)));
              });
            }}
          />
        );
      default:
        return null;
    }
  };

  return (
    <main className="h-screen overflow-hidden flex flex-col">
      <TitleBar
        activeSection={activeSection}
        onSectionChange={setActiveSection}
      />

      <div className="relative min-h-0 flex-1">{renderSection()}</div>

      <StatusBar
        sessions={sessions}
        activeSession={activeSession}
        updateState={updateState}
        updateDownloadProgress={updateDownloadProgress}
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

      <AboutDialog onClose={() => setAboutDialogOpen(false)} open={aboutDialogOpen} />

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
        {(toastItem) => (
          <ChakraToast.Root key={toastItem.id} maxW="420px">
            <ChakraToast.Indicator />
            <ChakraToast.Title>{toastItem.title}</ChakraToast.Title>
            {toastItem.description && <ChakraToast.Description>{toastItem.description}</ChakraToast.Description>}
            {toastItem.action && (
              <ChakraToast.ActionTrigger onClick={toastItem.action.onClick}>
                {toastItem.action.label}
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
