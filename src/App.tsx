import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { ConnectionForm } from './components/ConnectionForm';
import { FileManager } from './components/FileManager';
import { CloseIcon } from './components/Icons';
import { Sidebar } from './components/Sidebar';
import { SplitLayout } from './components/SplitLayout';
import { SessionTabs } from './components/SessionTabs';
import { TerminalPane } from './components/TerminalPane';
import { Toast } from './components/Toast';
import { UpdateRestartDialog } from './components/UpdateRestartDialog';
import { createLogger } from './lib/logger';
import { useLocalStorage } from './hooks/useLocalStorage';
import { createEmptyProfile, describeSession, sanitizeProfileForStorage } from './lib/profile';
import { applyStatusToSessions, consumeBufferedSessionStatus, type PendingSessionStatusEvents } from './lib/sessionStatusBuffer';
import { markStartupUpdateCheck, shouldRunStartupUpdateCheck } from './lib/updateStartupPolicy';
import { updateFlowReducer } from './lib/updateFlow';
import { checkForUpdate, downloadAndInstallUpdate } from './lib/updater';
import { isTauriRuntime } from './lib/tauri';
import { shouldWarnOnClosedSession } from './lib/terminalStatus';
import { useFileManagerStore } from './stores/fileManagerStore';
import { cn, sessionStatusTone } from './lib/ui';
import type { ConnectionProfile, SessionState, SessionSummary, SshClosedEvent, SshStatusEvent } from './types';

const appLogger = createLogger('app');

function reorderSessions(sessions: SessionState[], draggedSessionId: string, targetSessionId: string) {
  const draggedIndex = sessions.findIndex((session) => session.sessionId === draggedSessionId);
  const targetIndex = sessions.findIndex((session) => session.sessionId === targetSessionId);
  if (draggedIndex === -1 || targetIndex === -1 || draggedIndex === targetIndex) {
    return sessions;
  }

  const nextSessions = [...sessions];
  const [draggedSession] = nextSessions.splice(draggedIndex, 1);
  nextSessions.splice(targetIndex, 0, draggedSession);
  return nextSessions;
}

function App() {
  const [draftProfile, setDraftProfile] = useState<ConnectionProfile>(createEmptyProfile());
  const [savedProfiles, setSavedProfiles] = useLocalStorage<ConnectionProfile[]>('termbridge.savedProfiles', [], ['windbridge.savedProfiles']);
  const [sessions, setSessions] = useState<SessionState[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string>();
  const [errorMessage, setErrorMessage] = useState<string>();
  const [connectDialogOpen, setConnectDialogOpen] = useState(false);
  const [pendingDeleteProfileId, setPendingDeleteProfileId] = useState<string>();
  const [pendingCloseSessionId, setPendingCloseSessionId] = useState<string>();
  const [exitDialogOpen, setExitDialogOpen] = useState(false);
  const [reorderingSessions, setReorderingSessions] = useState(false);
  const [updateState, dispatchUpdateState] = useReducer(updateFlowReducer, { phase: 'idle' });
  const [updateDownloadProgress, setUpdateDownloadProgress] = useState<number>();
  const [updateToast, setUpdateToast] = useState<{ message: string; tone: 'info' | 'success' | 'error' }>();
  const [restartDialogDismissed, setRestartDialogDismissed] = useState(false);
  const removeFileManagerSessionState = useFileManagerStore((state) => state.removeSessionState);
  const replaceFileManagerSessionStateKey = useFileManagerStore((state) => state.replaceSessionStateKey);
  const pendingStatusEventsRef = useRef<PendingSessionStatusEvents>({});
  const sessionsRef = useRef<SessionState[]>([]);

  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

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
        const currentSession = sessionsRef.current.find((session) => session.sessionId === event.payload.sessionId);
        if (currentSession) {
          if (shouldWarnOnClosedSession(currentSession.status)) {
            appLogger.warn('会话已关闭', event.payload);
          } else {
            appLogger.debug('会话关闭事件（错误态已记录）', event.payload);
          }
        }

        setSessions((current) =>
          current.map((session) => {
            if (session.sessionId !== event.payload.sessionId) {
              return session;
            }

            return {
              ...session,
              status: session.status === 'error' ? 'error' : 'disconnected',
              note: event.payload.reason,
            };
          }),
        );
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
  }, []);

  const activeSession = useMemo(() => sessions.find((item) => item.sessionId === activeSessionId), [activeSessionId, sessions]);
  const connectedSessions = useMemo(() => sessions.filter((item) => item.status === 'connected').length, [sessions]);
  const pendingDeleteProfile = useMemo(
    () => savedProfiles.find((item) => item.id === pendingDeleteProfileId),
    [pendingDeleteProfileId, savedProfiles],
  );
  const pendingCloseSession = useMemo(() => sessions.find((item) => item.sessionId === pendingCloseSessionId), [pendingCloseSessionId, sessions]);
  const runtimeText = isTauriRuntime() ? '桌面端' : '浏览器预览';
  const restartDialogOpen = updateState.phase === 'downloaded' && !restartDialogDismissed;

  const runUpdateCheck = useCallback(
    async (mode: 'startup' | 'manual') => {
      if (!isTauriRuntime()) {
        if (mode === 'manual') {
          setUpdateToast({
            message: '当前只启动了前端调试环境，无法检查更新。',
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
              message: '当前已是最新版本。',
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
        const message = `更新失败：${String(error)}`;
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
    },
    [],
  );

  useEffect(() => {
    if (!isTauriRuntime() || !shouldRunStartupUpdateCheck(Date.now())) {
      return;
    }

    const timer = window.setTimeout(() => {
      void (async () => {
        await runUpdateCheck('startup');
      })();
    }, 8000);

    return () => window.clearTimeout(timer);
  }, [runUpdateCheck]);

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

  const createSessionFromProfile = async (profile: ConnectionProfile) =>
    invoke<SessionSummary>('create_session', {
      request: {
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
      },
    });

  const handleConnect = async (profile: ConnectionProfile, remember: boolean, rememberPassword: boolean) => {
    if (!profile.host.trim() || !profile.username.trim()) {
      appLogger.warn('连接参数校验失败：Host 或 Username 为空');
      setErrorMessage('Host 和 Username 不能为空。');
      return;
    }

    if (!isTauriRuntime()) {
      appLogger.warn('浏览器预览模式下尝试建立连接');
      setErrorMessage('当前只启动了前端调试环境，请使用 `npm run tauri:dev` 运行桌面端。');
      return;
    }

    try {
      appLogger.info('开始创建 SSH 会话', {
        host: profile.host.trim(),
        port: profile.port,
        username: profile.username.trim(),
      });
      if (remember) {
        const nextProfile = sanitizeProfileForStorage({
          ...profile,
          rememberPassword,
        });
        setSavedProfiles((current) => {
          const others = current.filter((item) => item.id !== nextProfile.id);
          return [nextProfile, ...others].slice(0, 8);
        });
      }

      const summary = await createSessionFromProfile(profile);
      setSessions((current) => {
        const bufferedStatus = consumeBufferedSessionStatus(summary.sessionId, pendingStatusEventsRef.current);
        const nextSession: SessionState = {
          ...summary,
          profile,
          status: bufferedStatus?.status ?? 'connecting',
          note: bufferedStatus?.note,
          createdAt: Date.now(),
        };
        return [nextSession, ...current];
      });
      setActiveSessionId(summary.sessionId);
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

  const loadProfile = (profile: ConnectionProfile) => {
    setDraftProfile({
      ...profile,
      password: profile.rememberPassword ? (profile.password ?? '') : '',
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

  const handleReconnectSession = async (sessionId: string) => {
    const target = sessions.find((item) => item.sessionId === sessionId);
    if (!target) {
      return;
    }

    if (!isTauriRuntime()) {
      appLogger.warn('浏览器预览模式下尝试重连会话', { sessionId });
      setErrorMessage('当前只启动了前端调试环境，请使用 `npm run tauri:dev` 运行桌面端。');
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
      setErrorMessage(undefined);
      appLogger.info('会话重连成功', {
        fromSessionId: sessionId,
        toSessionId: summary.sessionId,
      });
    } catch (error) {
      appLogger.error('会话重连失败', {
        sessionId,
        error: String(error),
      });
      setSessions((current) =>
        current.map((item) =>
          item.sessionId === sessionId
            ? {
                ...item,
                status: 'error',
                note: `重连失败: ${String(error)}`,
              }
            : item,
        ),
      );
      setErrorMessage(`重连失败: ${String(error)}`);
    }
  };

  const confirmDeleteSavedProfile = () => {
    if (!pendingDeleteProfileId) {
      return;
    }

    appLogger.info('删除历史连接', { profileId: pendingDeleteProfileId });
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
        message: '无法调用系统重启，1 秒后将尝试刷新窗口。若更新未生效，请手动重启应用。',
        tone: 'info',
      });

      window.setTimeout(() => {
        try {
          window.location.reload();
        } catch (error) {
          const message = `自动重启失败：${String(error)}。请手动关闭并重新打开应用以完成安装。`;
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

  return (
    <main className="h-screen overflow-hidden p-1">
      <div className="flex h-full gap-1">
        <SplitLayout
          className="min-w-0 flex-1"
          defaultPrimarySize={320}
          primary={<FileManager ignoreWindowDragDrop={reorderingSessions} session={activeSession} />}
          primaryClassName="min-h-0"
          primaryMinSize={280}
          secondary={
            <section className="flex h-full w-full min-h-0 min-w-0 flex-col gap-1">
              {errorMessage ? (
                <div className="surface flex items-center justify-between gap-2 px-2 py-1.5 text-xs text-rose-300">
                  <span className="truncate">{errorMessage}</span>
                  {activeSession ? (
                    <span className={cn('rounded-md px-2 py-1 text-[10px]', sessionStatusTone(activeSession.status))}>
                      {activeSession.status === 'connected'
                        ? '已连接'
                        : activeSession.status === 'connecting'
                          ? '连接中'
                          : activeSession.status === 'error'
                            ? '错误'
                            : '已断开'}
                    </span>
                  ) : null}
                </div>
              ) : null}

              <SessionTabs
                sessions={sessions}
                activeSessionId={activeSessionId}
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
                onReorder={(draggedSessionId, targetSessionId) => {
                  setSessions((current) => reorderSessions(current, draggedSessionId, targetSessionId));
                }}
                onSelect={setActiveSessionId}
                onClose={(sessionId) => {
                  setPendingCloseSessionId(sessionId);
                }}
              />

              <section className="surface rounded-lg relative min-h-0 flex-1 overflow-hidden">
                {sessions.length === 0 ? (
                  <div className="flex h-full min-h-[280px] flex-col justify-between gap-1.5 p-2">
                    <div className="flex flex-col gap-1">
                      <span className="label">就绪</span>
                      <h3 className="text-base font-semibold text-slate-100">开始一个新的远程工作区</h3>
                      <p className="text-xs leading-5 text-slate-400">
                        左侧浏览远程文件，右侧查看历史连接，中间专注终端操作。支持路径跳转、右键菜单和拖拽上传。
                      </p>
                    </div>
                  </div>
                ) : (
                  <div className="relative h-full min-h-0">
                    {sessions.map((session) => (
                      <TerminalPane
                        active={session.sessionId === activeSessionId}
                        key={session.sessionId}
                        onReconnect={() => {
                          void handleReconnectSession(session.sessionId);
                        }}
                        session={session}
                      />
                    ))}
                  </div>
                )}
              </section>
            </section>
          }
          secondaryClassName="min-h-0"
          secondaryMinSize={520}
          storageKey="termbridge.layout.main"
        />

        <div className="h-full w-[240px] shrink-0">
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
        </div>
      </div>

      {connectDialogOpen ? (
        <div
          className="fixed inset-0 z-20 grid place-items-center bg-slate-950/70 p-1 backdrop-blur md:p-2"
          onClick={() => setConnectDialogOpen(false)}
          role="presentation"
        >
          <div
            className="surface max-h-[calc(100vh-16px)] w-full max-w-xl overflow-auto p-3"
            onClick={(event) => event.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label="Connect to server"
          >
            <div className="mb-2 flex items-start justify-between gap-2">
              <div>
                <p className="label">连接</p>
                <h3 className="mt-1 text-sm font-semibold text-slate-100">新建 SSH 连接</h3>
              </div>
              <button aria-label="关闭连接弹框" className="icon-btn" onClick={() => setConnectDialogOpen(false)} type="button">
                <CloseIcon />
              </button>
            </div>
            <ConnectionForm
              profile={draftProfile}
              onProfileChange={(profile) => {
                setDraftProfile(profile);
                setErrorMessage(undefined);
              }}
              onConnect={(profile, remember, rememberPassword) => {
                void handleConnect(profile, remember, rememberPassword);
              }}
              compact
            />
          </div>
        </div>
      ) : null}

      {pendingDeleteProfile ? (
        <div
          className="fixed inset-0 z-30 grid place-items-center bg-slate-950/70 p-1 backdrop-blur md:p-2"
          onClick={() => setPendingDeleteProfileId(undefined)}
          role="presentation"
        >
          <div
            className="surface w-full max-w-sm p-3"
            onClick={(event) => event.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label="删除历史连接"
          >
            <div className="flex flex-col gap-1">
              <p className="label">删除确认</p>
              <h3 className="text-sm font-semibold text-slate-100">删除历史连接</h3>
              <p className="text-xs text-slate-400">确认删除“{pendingDeleteProfile.name}”吗？此操作只会移除历史记录，不影响已经打开的会话。</p>
            </div>

            <div className="mt-3 flex justify-end gap-1">
              <button className="icon-btn" onClick={() => setPendingDeleteProfileId(undefined)} type="button">
                取消
              </button>
              <button
                className="inline-flex items-center justify-center rounded-lg bg-rose-400 px-3 py-2 text-xs font-semibold text-white transition hover:bg-rose-300"
                onClick={confirmDeleteSavedProfile}
                type="button"
              >
                删除
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {pendingCloseSession ? (
        <div
          className="fixed inset-0 z-30 grid place-items-center bg-slate-950/70 p-1 backdrop-blur md:p-2"
          onClick={() => setPendingCloseSessionId(undefined)}
          role="presentation"
        >
          <div
            className="surface w-full max-w-sm p-3"
            onClick={(event) => event.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label="关闭会话"
          >
            <div className="flex flex-col gap-1">
              <p className="label">关闭确认</p>
              <h3 className="text-sm font-semibold text-slate-100">关闭当前会话</h3>
              <p className="text-xs text-slate-400">确认关闭“{pendingCloseSession.title}”吗？关闭后当前终端标签会被移除。</p>
            </div>

            <div className="mt-3 flex justify-end gap-1">
              <button className="icon-btn" onClick={() => setPendingCloseSessionId(undefined)} type="button">
                取消
              </button>
              <button
                className="inline-flex items-center justify-center rounded-lg bg-rose-400 px-3 py-2 text-xs font-semibold text-white transition hover:bg-rose-300"
                onClick={confirmCloseSession}
                type="button"
              >
                关闭
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {exitDialogOpen ? (
        <div
          className="fixed inset-0 z-30 grid place-items-center bg-slate-950/70 p-1 backdrop-blur md:p-2"
          onClick={() => setExitDialogOpen(false)}
          role="presentation"
        >
          <div
            className="surface w-full max-w-sm p-3"
            onClick={(event) => event.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label="退出应用"
          >
            <div className="flex flex-col gap-1">
              <p className="label">退出确认</p>
              <h3 className="text-sm font-semibold text-slate-100">退出应用</h3>
              <p className="text-xs text-slate-400">确认退出 TermBridge 吗？退出后当前窗口和托盘都会关闭。</p>
            </div>

            <div className="mt-3 flex justify-end gap-1">
              <button className="icon-btn" onClick={() => setExitDialogOpen(false)} type="button">
                取消
              </button>
              <button
                className="inline-flex items-center justify-center rounded-lg bg-rose-400 px-3 py-2 text-xs font-semibold text-white transition hover:bg-rose-300"
                onClick={confirmAppExit}
                type="button"
              >
                退出应用
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <UpdateRestartDialog
        downloadProgress={updateDownloadProgress}
        hasActiveSessions={connectedSessions > 0}
        onInstallNow={handleInstallUpdateNow}
        onLater={handleInstallUpdateLater}
        open={restartDialogOpen}
        version={updateState.version?.downloadedVersion ?? updateState.version?.latestVersion ?? '最新版本'}
      />

      <Toast
        message={updateToast?.message ?? ''}
        onClose={() => setUpdateToast(undefined)}
        open={Boolean(updateToast)}
        tone={updateToast?.tone ?? 'info'}
      />
    </main>
  );
}

export default App;
