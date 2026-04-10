import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { useEffect, useMemo, useState } from 'react';
import { ConnectionForm } from './components/ConnectionForm';
import { FileManager } from './components/FileManager';
import { Sidebar } from './components/Sidebar';
import { SplitLayout } from './components/SplitLayout';
import { SessionTabs } from './components/SessionTabs';
import { TerminalPane } from './components/TerminalPane';
import { useLocalStorage } from './hooks/useLocalStorage';
import { createEmptyProfile, describeSession, sanitizeProfileForStorage } from './lib/profile';
import { isTauriRuntime } from './lib/tauri';
import { useFileManagerStore } from './stores/fileManagerStore';
import { cn, sessionStatusTone } from './lib/ui';
import type { ConnectionProfile, SessionState, SessionSummary, SshClosedEvent, SshStatusEvent } from './types';

function App() {
  const [draftProfile, setDraftProfile] = useState<ConnectionProfile>(createEmptyProfile());
  const [savedProfiles, setSavedProfiles] = useLocalStorage<ConnectionProfile[]>('termbridge.savedProfiles', [], ['windbridge.savedProfiles']);
  const [sessions, setSessions] = useState<SessionState[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string>();
  const [errorMessage, setErrorMessage] = useState<string>();
  const [connectDialogOpen, setConnectDialogOpen] = useState(false);
  const [pendingDeleteProfileId, setPendingDeleteProfileId] = useState<string>();
  const [pendingCloseSessionId, setPendingCloseSessionId] = useState<string>();
  const removeFileManagerSessionState = useFileManagerStore((state) => state.removeSessionState);
  const replaceFileManagerSessionStateKey = useFileManagerStore((state) => state.replaceSessionStateKey);

  useEffect(() => {
    if (!isTauriRuntime()) {
      return;
    }

    let stopStatus: UnlistenFn | undefined;
    let stopClosed: UnlistenFn | undefined;
    let cancelled = false;

    const attach = async () => {
      const nextStopStatus = await listen<SshStatusEvent>('ssh-status', (event) => {
        setSessions((current) =>
          current.map((session) =>
            session.sessionId === event.payload.sessionId
              ? {
                  ...session,
                  status: event.payload.status,
                  note: event.payload.message,
                }
              : session,
          ),
        );
      });

      if (cancelled) {
        nextStopStatus();
        return;
      }
      stopStatus = nextStopStatus;

      const nextStopClosed = await listen<SshClosedEvent>('ssh-closed', (event) => {
        setSessions((current) =>
          current.map((session) =>
            session.sessionId === event.payload.sessionId
              ? {
                  ...session,
                  status: session.status === 'error' ? 'error' : 'disconnected',
                  note: event.payload.reason,
                }
              : session,
          ),
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
      setErrorMessage('Host 和 Username 不能为空。');
      return;
    }

    if (!isTauriRuntime()) {
      setErrorMessage('当前只启动了前端调试环境，请使用 `npm run tauri:dev` 运行桌面端。');
      return;
    }

    try {
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

      const nextSession: SessionState = {
        ...summary,
        profile,
        status: 'connecting',
        createdAt: Date.now(),
      };

      setSessions((current) => [nextSession, ...current]);
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
    } catch (error) {
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
    if (!isTauriRuntime()) {
      setSessions((current) => current.filter((session) => session.sessionId !== sessionId));
      removeFileManagerSessionState(sessionId);
      return;
    }

    try {
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
    }
  };

  const handleDeleteSavedProfile = (profileId: string) => {
    const target = savedProfiles.find((item) => item.id === profileId);
    if (!target) {
      return;
    }

    setPendingDeleteProfileId(profileId);
  };

  const handleReconnectSession = async (sessionId: string) => {
    const target = sessions.find((item) => item.sessionId === sessionId);
    if (!target) {
      return;
    }

    if (!isTauriRuntime()) {
      setErrorMessage('当前只启动了前端调试环境，请使用 `npm run tauri:dev` 运行桌面端。');
      return;
    }

    try {
      const summary = await createSessionFromProfile(target.profile);
      const nextSession: SessionState = {
        ...summary,
        profile: target.profile,
        status: 'connecting',
        createdAt: Date.now(),
      };

      setSessions((current) => current.map((item) => (item.sessionId === sessionId ? nextSession : item)));
      setActiveSessionId((current) => (current === sessionId ? summary.sessionId : current));
      replaceFileManagerSessionStateKey(sessionId, summary.sessionId);
      setErrorMessage(undefined);
    } catch (error) {
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

  return (
    <main className="h-screen overflow-hidden p-1">
      <div className="flex h-full gap-1">
        <SplitLayout
          className="min-w-0 flex-1"
          defaultPrimarySize={320}
          primary={<FileManager session={activeSession} />}
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
                onSelect={setActiveSessionId}
                onClose={(sessionId) => {
                  setPendingCloseSessionId(sessionId);
                }}
              />

              <section className="surface relative min-h-0 flex-1 overflow-hidden">
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
            activeSessionId={activeSessionId}
            connectedCount={connectedSessions}
            runtimeLabel={runtimeText}
            sessions={sessions}
            savedProfiles={savedProfiles}
            onDeleteProfile={handleDeleteSavedProfile}
            onSelectSession={setActiveSessionId}
            onReuseProfile={loadProfile}
            onOpenConnect={() => {
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
              <button className="icon-btn" onClick={() => setConnectDialogOpen(false)} type="button">
                ×
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
    </main>
  );
}

export default App;
