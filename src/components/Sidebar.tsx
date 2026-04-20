import { createPortal } from 'react-dom';
import { useLayoutEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { PinIcon, StarIcon } from './Icons';
import { t } from '../lib/i18n';
import type { ConnectionProfile } from '../types';

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
  connectedCount: number;
  runtimeLabel: string;
  savedProfiles: ConnectionProfile[];
  onDeleteProfile: (profileId: string) => void;
  onRenameProfile: (profileId: string, name: string) => void;
  onToggleFavoriteProfile: (profileId: string) => void;
  onTogglePinnedProfile: (profileId: string) => void;
  onReuseProfile: (profile: ConnectionProfile) => void;
  onOpenConnect: () => void;
}

export function sortSavedProfiles(profiles: ConnectionProfile[]) {
  return [...profiles].sort(
    (left, right) => Number(Boolean(right.pinned)) - Number(Boolean(left.pinned)) || Number(Boolean(right.favorite)) - Number(Boolean(left.favorite)),
  );
}

export function countFavoriteProfiles(profiles: ConnectionProfile[]) {
  return profiles.filter((profile) => profile.favorite).length;
}

export function Sidebar({
  connectedCount,
  runtimeLabel,
  savedProfiles,
  onDeleteProfile,
  onRenameProfile,
  onToggleFavoriteProfile,
  onTogglePinnedProfile,
  onReuseProfile,
  onOpenConnect,
}: SidebarProps) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [historyMenu, setHistoryMenu] = useState<HistoryMenuState>();
  const [renamingProfileId, setRenamingProfileId] = useState<string>();
  const [renameValue, setRenameValue] = useState('');
  const sortedProfiles = useMemo(() => sortSavedProfiles(savedProfiles), [savedProfiles]);
  const favoriteCount = useMemo(() => countFavoriteProfiles(savedProfiles), [savedProfiles]);

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

  const startRenamingProfile = (profile: ConnectionProfile) => {
    setHistoryMenu(undefined);
    setRenamingProfileId(profile.id);
    setRenameValue(profile.name);
  };

  const closeRenameDialog = () => {
    setRenamingProfileId(undefined);
    setRenameValue('');
  };

  const commitRename = () => {
    if (!renamingProfileId) {
      return;
    }

    const nextName = renameValue.trim();
    if (nextName) {
      onRenameProfile(renamingProfileId, nextName);
    }
    closeRenameDialog();
  };

  return (
    <aside className="grid h-full min-h-0 gap-1 xl:grid-rows-[auto_minmax(0,1fr)]">
      <div className="surface rounded-lg h-full flex flex-col gap-1.5 p-1.5">
        <div className="flex items-start justify-between gap-1.5">
          <div className="flex min-w-0 items-center gap-1.5">
            <div className="brand-badge">TB</div>
            <div className="min-w-0">
              <p className="label">{t('sidebar.console')}</p>
              <h1 className="truncate text-sm font-semibold">TermBridge</h1>
              <p className="text-subtle truncate text-xs">{runtimeLabel}</p>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-1">
          <div className="surface-muted p-1.5">
            <p className="stats-label">{t('sidebar.history')}</p>
            <strong className="mt-0.5 block text-sm">{savedProfiles.length}</strong>
          </div>
          <div className="surface-muted p-1.5">
            <p className="stats-label">{t('sidebar.online')}</p>
            <strong className="mt-0.5 block text-sm">{connectedCount}</strong>
          </div>
          <div className="surface-muted p-1.5">
            <p className="stats-label">{t('sidebar.favorite')}</p>
            <strong className="mt-0.5 block text-sm">{favoriteCount}</strong>
          </div>
        </div>

        <button className="primary-btn w-full" onClick={onOpenConnect} type="button">
          {t('sidebar.newConnection')}
        </button>
      </div>

      <section className="surface rounded-lg flex min-h-0 flex-col overflow-hidden">
        <div className="surface-header">
          <div>
            <p className="label">{t('sidebar.history')}</p>
            <h2 className="text-sm font-semibold">{t('sidebar.historyTitle')}</h2>
          </div>
          <span className="text-subtle text-xs">{savedProfiles.length}</span>
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-1">
          {sortedProfiles.length === 0 ? (
            <div className="surface-muted text-subtle p-1.5 text-xs">{t('sidebar.emptyHistory')}</div>
          ) : (
            <div className="flex flex-col gap-1">
              {sortedProfiles.map((profile) => (
                <button
                  className="history-item surface-muted rounded-[6px] flex select-none items-center gap-1.5 px-2 py-1 text-left transition"
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
                    <div className="flex items-center gap-1">
                      <strong className="block truncate text-xs">{profile.name}</strong>
                      {profile.pinned ? (
                        <span className="inline-flex h-4 w-4 items-center justify-center rounded-sm text-cyan-300" title={t('sidebar.badge.pinned')}>
                          <PinIcon />
                        </span>
                      ) : null}
                      {profile.favorite ? (
                        <span
                          className="inline-flex h-4 w-4 items-center justify-center rounded-sm text-amber-300"
                          title={t('sidebar.badge.favorite')}
                        >
                          <StarIcon />
                        </span>
                      ) : null}
                    </div>
                    <span className="text-subtle block truncate mt-[4px] text-[11px]">
                      {profile.username}@{profile.host}:{profile.port}
                    </span>
                  </div>
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
                className="themed-menu fixed z-50 max-w-[96px] rounded-lg p-1 backdrop-blur"
                onClick={(event) => event.stopPropagation()}
                onContextMenu={(event) => event.preventDefault()}
                ref={menuRef}
                style={{ left: historyMenu.x, top: historyMenu.y }}
              >
                <button
                  className="themed-menu-item w-full whitespace-nowrap rounded-md px-2 py-1 text-left text-xs transition"
                  onClick={() => startRenamingProfile(historyMenu.profile)}
                  type="button"
                >
                  {t('sidebar.menu.rename')}
                </button>
                <button
                  className="themed-menu-item w-full whitespace-nowrap rounded-md px-2 py-1 text-left text-xs transition"
                  onClick={() => {
                    onTogglePinnedProfile(historyMenu.profile.id);
                    setHistoryMenu(undefined);
                  }}
                  type="button"
                >
                  {historyMenu.profile.pinned ? t('sidebar.menu.unpin') : t('sidebar.menu.pin')}
                </button>
                <button
                  className="themed-menu-item w-full whitespace-nowrap rounded-md px-2 py-1 text-left text-xs transition"
                  onClick={() => {
                    onToggleFavoriteProfile(historyMenu.profile.id);
                    setHistoryMenu(undefined);
                  }}
                  type="button"
                >
                  {historyMenu.profile.favorite ? t('sidebar.menu.unfavorite') : t('sidebar.menu.favorite')}
                </button>
                <button
                  className="themed-menu-item w-full whitespace-nowrap rounded-md px-2 py-1 text-left text-xs transition"
                  onClick={() => {
                    onDeleteProfile(historyMenu.profile.id);
                    setHistoryMenu(undefined);
                  }}
                  type="button"
                >
                  {t('sidebar.menu.delete')}
                </button>
              </div>
            </>,
            document.body,
          )
        : null}

      {renamingProfileId
        ? createPortal(
            <div className="app-overlay" onClick={closeRenameDialog} role="presentation">
              <div
                className="surface w-full max-w-sm p-3"
                onClick={(event) => event.stopPropagation()}
                role="dialog"
                aria-modal="true"
                aria-label={t('sidebar.renameDialog.ariaLabel')}
              >
                <div className="flex flex-col gap-1">
                  <p className="label">{t('sidebar.renameDialog.kicker')}</p>
                  <h3 className="themed-heading text-sm font-semibold">{t('sidebar.renameDialog.title')}</h3>
                </div>

                <input
                  autoFocus
                  className="themed-input mt-3 w-full rounded-lg px-3 py-2 text-sm outline-none transition focus:border-cyan-400/60"
                  onChange={(event) => setRenameValue(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      commitRename();
                    }
                    if (event.key === 'Escape') {
                      event.preventDefault();
                      closeRenameDialog();
                    }
                  }}
                  placeholder={t('sidebar.renameDialog.placeholder')}
                  value={renameValue}
                />

                <div className="mt-3 flex justify-end gap-1">
                  <button className="icon-btn" onClick={closeRenameDialog} type="button">
                    {t('sidebar.renameDialog.cancel')}
                  </button>
                  <button className="primary-btn px-3 py-2 text-xs" disabled={!renameValue.trim()} onClick={commitRename} type="button">
                    {t('sidebar.renameDialog.save')}
                  </button>
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}
    </aside>
  );
}
