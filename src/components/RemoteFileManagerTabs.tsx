import { useMemo, useState } from 'react';
import { t } from '../lib/i18n';
import { cn } from '../lib/ui';
import { FileManager } from './FileManager';
import { PlusIcon, ScrollArea, ServerIcon, XIcon } from './ui';
import { useAppStore } from '../stores/appStore';
import type { SessionState } from '../types';

interface RemoteFileManagerTabsProps {
  sessions: SessionState[];
  bookmarksByProfileId?: Record<string, string[]>;
  className?: string;
  onNewConnection: () => void;
  onAddBookmark?: (profileId: string, path: string) => void;
  onRemoveBookmark?: (profileId: string, path: string) => void;
}

export function RemoteFileManagerTabs({
  sessions,
  bookmarksByProfileId,
  className,
  onNewConnection,
  onAddBookmark,
  onRemoveBookmark,
}: RemoteFileManagerTabsProps) {
  const sftpSessionIds = useAppStore((state) => state.sftpSessionIds);
  const activeSftpSessionId = useAppStore((state) => state.activeSftpSessionId);
  const setActiveSftpSessionId = useAppStore((state) => state.setActiveSftpSessionId);
  const openSftpSession = useAppStore((state) => state.openSftpSession);
  const closeSftpSession = useAppStore((state) => state.closeSftpSession);
  const [showSessionPicker, setShowSessionPicker] = useState(false);

  const sftpSessions = useMemo(
    () => sessions.filter((session) => sftpSessionIds.includes(session.sessionId)),
    [sessions, sftpSessionIds],
  );

  const connectedSessions = useMemo(
    () => sessions.filter((session) => session.status === 'connected'),
    [sessions],
  );

  const activeSession = useMemo(
    () => sftpSessions.find((session) => session.sessionId === activeSftpSessionId),
    [sftpSessions, activeSftpSessionId],
  );

  return (
    <div className={cn('flex h-full min-h-0 flex-col overflow-hidden bg-[var(--app-bg)]', className)}>
      <div className="surface-header">
        <div className="min-w-0">
          <p className="label">{t('sftp.remote')}</p>
          <h3 className="themed-heading truncate text-[13px] font-semibold tracking-[0.01em]">
            {activeSession ? activeSession.title : t('sftp.remoteTabs')}
          </h3>
        </div>
        <button
          aria-label={t('sftp.addRemote')}
          className="icon-btn h-6 w-6 px-0"
          onClick={() => setShowSessionPicker(true)}
          type="button"
        >
          <PlusIcon />
        </button>
      </div>

      {sftpSessions.length > 0 ? (
        <div className="flex border-b border-[var(--app-border)]">
          <ScrollArea className="max-w-full" orientation="horizontal" scrollbar="hover" scrollbarSize={3}>
            <div className="flex w-max min-w-full">
              {sftpSessions.map((session) => (
                <button
                  key={session.sessionId}
                  className={cn(
                    'flex h-[30px] shrink-0 items-center gap-1 border-r border-[var(--app-border)] px-2 text-left text-[11px] font-medium transition',
                    session.sessionId === activeSftpSessionId
                      ? 'bg-[var(--app-surface)] text-[var(--app-text)]'
                      : 'text-[var(--app-text-muted)] hover:bg-[var(--app-surface-muted)] hover:text-[var(--app-text-soft)]',
                  )}
                  onClick={() => setActiveSftpSessionId(session.sessionId)}
                  type="button"
                >
                  <span className="max-w-[120px] truncate">{session.title}</span>
                  <span
                    className="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-sm opacity-0 transition hover:bg-black/10 hover:opacity-100 dark:hover:bg-white/10"
                    onClick={(event) => {
                      event.stopPropagation();
                      closeSftpSession(session.sessionId);
                    }}
                    role="button"
                    tabIndex={-1}
                  >
                    <XIcon />
                  </span>
                </button>
              ))}
            </div>
          </ScrollArea>
        </div>
      ) : null}

      <div className="relative min-h-0 flex-1">
        {activeSession ? (
          <FileManager
            bookmarks={activeSession.profile.id ? bookmarksByProfileId?.[activeSession.profile.id] ?? [] : []}
            session={activeSession}
            onAddBookmark={(path) => {
              if (activeSession.profile.id) {
                onAddBookmark?.(activeSession.profile.id, path);
              }
            }}
            onRemoveBookmark={(path) => {
              if (activeSession.profile.id) {
                onRemoveBookmark?.(activeSession.profile.id, path);
              }
            }}
          />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-3 p-4 text-center">
            <div className="grid h-12 w-12 place-items-center rounded-2xl bg-[var(--app-surface-muted)] text-[var(--app-text-muted)]">
              <ServerIcon className="h-6 w-6" />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-[var(--app-text)]">{t('sftp.empty.title')}</h3>
              <p className="mt-1 max-w-xs text-xs text-[var(--app-text-soft)]">{t('sftp.empty.description')}</p>
            </div>
            <button
              className="btn-primary text-xs"
              onClick={onNewConnection}
              type="button"
            >
              {t('sftp.newConnection')}
            </button>
          </div>
        )}
      </div>

      {showSessionPicker ? (
        <div className="absolute inset-0 z-20 flex items-start justify-center p-4" style={{ background: 'var(--app-overlay)' }}>
          <div className="surface w-full max-w-xs rounded-lg p-3">
            <p className="label">{t('sftp.addRemote')}</p>
            <div className="mt-2 flex max-h-60 flex-col gap-1 overflow-auto">
              {connectedSessions.length === 0 ? (
                <span className="text-subtle px-1 py-2 text-xs">{t('sftp.empty')}</span>
              ) : (
                connectedSessions.map((session) => (
                  <button
                    key={session.sessionId}
                    className="themed-menu-item flex items-center justify-between px-2 py-1.5 text-left text-xs transition"
                    onClick={() => {
                      openSftpSession(session.sessionId);
                      setShowSessionPicker(false);
                    }}
                    type="button"
                  >
                    <span className="truncate">{session.title}</span>
                    <span className="text-subtle shrink-0 text-[10px]">{session.host}:{session.port}</span>
                  </button>
                ))
              )}
            </div>
            <div className="mt-2 flex justify-end">
              <button
                className="btn-cancel text-xs"
                onClick={() => setShowSessionPicker(false)}
                type="button"
              >
                {t('fileManager.dialog.cancel')}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
