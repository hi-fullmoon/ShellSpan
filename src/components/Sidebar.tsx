import { createPortal } from 'react-dom';
import { useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { KeyIcon, LockIcon } from './Icons';
import { cn, sessionStatusTone } from '../lib/ui';
import type { ConnectionProfile, SessionState } from '../types';

interface HistoryMenuState {
  profile: ConnectionProfile;
  x: number;
  y: number;
}

function clampMenuPosition(x: number, y: number, width: number, height: number) {
  const edge = 8;
  return {
    x: Math.max(edge, Math.min(x, window.innerWidth - width - edge)),
    y: Math.max(edge, Math.min(y, window.innerHeight - height - edge)),
  };
}

interface SidebarProps {
  activeSessionId?: string;
  connectedCount: number;
  runtimeLabel: string;
  sessions: SessionState[];
  savedProfiles: ConnectionProfile[];
  onDeleteProfile: (profileId: string) => void;
  onSelectSession: (sessionId: string) => void;
  onReuseProfile: (profile: ConnectionProfile) => void;
  onOpenConnect: () => void;
}

export function Sidebar({
  activeSessionId,
  connectedCount,
  runtimeLabel,
  sessions,
  savedProfiles,
  onDeleteProfile,
  onSelectSession,
  onReuseProfile,
  onOpenConnect,
}: SidebarProps) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [historyMenu, setHistoryMenu] = useState<HistoryMenuState>();

  useLayoutEffect(() => {
    if (!historyMenu || !menuRef.current) {
      return;
    }

    const rect = menuRef.current.getBoundingClientRect();
    const nextPosition = clampMenuPosition(historyMenu.x, historyMenu.y, rect.width, rect.height);

    if (nextPosition.x === historyMenu.x && nextPosition.y === historyMenu.y) {
      return;
    }

    setHistoryMenu((current) =>
      current
        ? {
            ...current,
            x: nextPosition.x,
            y: nextPosition.y,
          }
        : current,
    );
  }, [historyMenu]);

  const openHistoryMenu = (event: ReactMouseEvent<HTMLButtonElement>, profile: ConnectionProfile) => {
    event.preventDefault();
    event.stopPropagation();

    setHistoryMenu({
      profile,
      x: event.clientX,
      y: event.clientY,
    });
  };

  return (
    <aside className="grid h-full min-h-0 gap-1 xl:grid-rows-[auto_minmax(0,1fr)_minmax(0,0.9fr)]">
      <div className="surface h-full flex flex-col gap-1.5 p-1.5">
        <div className="flex items-center gap-1.5">
          <div className="grid h-8 w-8 place-items-center rounded-lg bg-cyan-400 font-mono text-[11px] font-bold text-slate-950">TB</div>
          <div className="min-w-0">
            <p className="label">控制台</p>
            <h1 className="truncate text-sm font-semibold">TermBridge</h1>
            <p className="truncate text-xs text-slate-400">{runtimeLabel}</p>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-1">
          <div className="surface-muted p-1.5">
            <p className="text-[10px] uppercase tracking-[0.16em] text-slate-500">历史</p>
            <strong className="mt-0.5 block text-sm">{savedProfiles.length}</strong>
          </div>
          <div className="surface-muted p-1.5">
            <p className="text-[10px] uppercase tracking-[0.16em] text-slate-500">在线</p>
            <strong className="mt-0.5 block text-sm">{connectedCount}</strong>
          </div>
          <div className="surface-muted p-1.5">
            <p className="text-[10px] uppercase tracking-[0.16em] text-slate-500">标签</p>
            <strong className="mt-0.5 block text-sm">{sessions.length}</strong>
          </div>
        </div>

        <button className="primary-btn w-full flex justify-center items-center" onClick={onOpenConnect} type="button">
          新建连接
        </button>
      </div>

      <section className="surface flex min-h-0 flex-col overflow-hidden">
        <div className="surface-header">
          <div>
            <p className="label">历史</p>
            <h2 className="text-sm font-semibold">历史连接</h2>
          </div>
          <span className="text-xs text-slate-500">{savedProfiles.length}</span>
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-1">
          {savedProfiles.length === 0 ? (
            <div className="surface-muted p-1.5 text-xs text-slate-400">还没有保存的连接配置。</div>
          ) : (
            <div className="flex flex-col gap-1">
              {savedProfiles.map((profile) => (
                <button
                  className="surface-muted flex select-none items-center gap-1.5 px-2 py-1 text-left transition hover:border-slate-700 hover:bg-slate-900"
                  key={profile.id}
                  onClick={() => onReuseProfile(profile)}
                  onDragStart={(event) => event.preventDefault()}
                  onMouseDown={(event) => {
                    if (event.button === 2) {
                      event.preventDefault();
                    }
                  }}
                  onContextMenu={(event) => openHistoryMenu(event, profile)}
                  type="button"
                >
                  <div className="min-w-0 flex-1">
                    <strong className="block truncate text-xs text-slate-100">{profile.name}</strong>
                    <span className="block truncate text-[11px] text-slate-400">
                      {profile.username}@{profile.host}:{profile.port}
                    </span>
                  </div>
                  <span
                    className="inline-flex h-5 w-5 items-center justify-center rounded-md bg-slate-800 text-slate-300"
                    title={profile.authMethod === 'password' ? '密码认证' : '私钥认证'}
                  >
                    {profile.authMethod === 'password' ? <LockIcon /> : <KeyIcon />}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      </section>

      <section className="surface flex min-h-0 flex-col overflow-hidden">
        <div className="surface-header">
          <div>
            <p className="label">会话</p>
            <h2 className="text-sm font-semibold">会话记录</h2>
          </div>
          <span className="text-xs text-slate-500">{sessions.length}</span>
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-1">
          {sessions.length === 0 ? (
            <div className="surface-muted p-1.5 text-xs text-slate-400">当前没有打开的终端会话。</div>
          ) : (
            <div className="flex flex-col gap-1">
              {sessions.map((session) => (
                <button
                  className={cn(
                    'surface-muted flex flex-col gap-0.5 px-2 py-1.5 text-left transition hover:border-slate-700 hover:bg-slate-900',
                    session.sessionId === activeSessionId && 'border-cyan-400/50 bg-slate-900',
                  )}
                  key={session.sessionId}
                  onClick={() => onSelectSession(session.sessionId)}
                  type="button"
                >
                  <div className="flex items-center justify-between gap-2">
                    <strong className="truncate text-xs text-slate-100">{session.title}</strong>
                    <span className={cn('rounded-md px-2 py-1 text-[10px]', sessionStatusTone(session.status))}>{session.status}</span>
                  </div>
                  <span className="truncate text-[11px] text-slate-400">
                    {session.username}@{session.host}:{session.port}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      </section>

      {historyMenu
        ? createPortal(
            <>
              <div
                className="fixed inset-0 z-40"
                onClick={() => setHistoryMenu(undefined)}
                onContextMenu={(event) => {
                  event.preventDefault();
                  setHistoryMenu(undefined);
                }}
                role="presentation"
              />
              <div
                className="fixed z-50 min-w-[132px] rounded-lg border border-slate-800 bg-slate-950/95 p-1 shadow-[0_12px_36px_rgba(2,6,23,0.45)] backdrop-blur"
                onClick={(event) => event.stopPropagation()}
                onContextMenu={(event) => event.preventDefault()}
                ref={menuRef}
                style={{ left: historyMenu.x, top: historyMenu.y }}
              >
                <button
                  className="w-full rounded-md px-2 py-1 text-left text-xs text-slate-200 transition hover:bg-slate-800"
                  onClick={() => {
                    onDeleteProfile(historyMenu.profile.id);
                    setHistoryMenu(undefined);
                  }}
                  type="button"
                >
                  删除
                </button>
              </div>
            </>,
            document.body,
          )
        : null}
    </aside>
  );
}
