import { createPortal } from 'react-dom';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { PinIcon, StarIcon } from './Icons';
import { Tooltip } from './Tooltip';
import { ScrollArea } from './ScrollArea';
import { Input } from '@chakra-ui/react';
import { t } from '../lib/i18n';
import { useContextMenu } from '../hooks/useContextMenu';
import type { ConnectionProfile } from '../types';

const HISTORY_ITEM_DOUBLE_CLICK_DELAY_MS = 220;

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

interface ProfileItemProps {
  profile: ConnectionProfile;
  onClick: () => void;
  onDoubleClick: () => void;
  onContextMenu: (event: ReactMouseEvent<HTMLButtonElement>) => void;
}

function ProfileItem({ profile, onClick, onDoubleClick, onContextMenu }: ProfileItemProps) {
  return (
    <button
      className="history-item surface-muted rounded-sm flex select-none items-center gap-1.5 px-1.5 py-0.5 text-left transition"
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onDragStart={(event) => event.preventDefault()}
      onMouseDown={(event) => {
        if (event.button === 2) {
          event.preventDefault();
        }
      }}
      onContextMenu={onContextMenu}
      type="button"
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1">
          <strong className="block truncate text-xs">{profile.name}</strong>
          {profile.pinned ? (
            <Tooltip content={t('sidebar.badge.pinned')}>
              <span className="inline-flex h-4 w-4 items-center justify-center text-cyan-300">
                <PinIcon />
              </span>
            </Tooltip>
          ) : null}
          {profile.favorite ? (
            <Tooltip content={t('sidebar.badge.favorite')}>
              <span className="inline-flex h-4 w-4 items-center justify-center text-amber-300">
                <StarIcon />
              </span>
            </Tooltip>
          ) : null}
        </div>
        <span className="text-subtle block truncate mt-1 text-[11px]">
          {profile.username}@{profile.host}:{profile.port}
        </span>
      </div>
    </button>
  );
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
  const clickTimerRef = useRef<ReturnType<typeof window.setTimeout> | undefined>(undefined);
  const [menuProfile, setMenuProfile] = useState<ConnectionProfile | null>(null);
  const { isOpen: menuOpen, position: menuPosition, open: openMenu, close: closeMenu, menuRef } = useContextMenu('sidebar-history');
  const [renamingProfileId, setRenamingProfileId] = useState<string>();
  const [renameValue, setRenameValue] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const sortedProfiles = useMemo(() => sortSavedProfiles(savedProfiles), [savedProfiles]);
  const favoriteCount = useMemo(() => countFavoriteProfiles(savedProfiles), [savedProfiles]);
  const filteredProfiles = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return sortedProfiles;
    return sortedProfiles.filter((p) =>
      p.name.toLowerCase().includes(query) ||
      p.host.toLowerCase().includes(query) ||
      p.username.toLowerCase().includes(query),
    );
  }, [sortedProfiles, searchQuery]);

  const openHistoryMenu = (event: ReactMouseEvent<HTMLButtonElement>, profile: ConnectionProfile) => {
    event.preventDefault();
    event.stopPropagation();

    setMenuProfile(profile);
    openMenu(event.clientX, event.clientY);
  };

  const startRenamingProfile = (profile: ConnectionProfile) => {
    closeMenu();
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

  const clearPendingReuse = () => {
    if (clickTimerRef.current) {
      window.clearTimeout(clickTimerRef.current);
      clickTimerRef.current = undefined;
    }
  };

  useEffect(() => clearPendingReuse, []);

  const handleReuseClick = (profile: ConnectionProfile) => {
    clearPendingReuse();
    clickTimerRef.current = window.setTimeout(() => {
      clickTimerRef.current = undefined;
      onReuseProfile(profile);
    }, HISTORY_ITEM_DOUBLE_CLICK_DELAY_MS);
  };

  const handleRenameDoubleClick = (profile: ConnectionProfile) => {
    clearPendingReuse();
    startRenamingProfile(profile);
  };

  return (
    <aside className="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)]">
      <div className="surface flex flex-col gap-1 p-1">
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
          <div className="surface-muted min-w-0 p-1 rounded-sm">
            <p className="stats-label truncate">{t('sidebar.online')}</p>
            <strong className="mt-0.5 block text-sm">{connectedCount}</strong>
          </div>
          <div className="surface-muted min-w-0 p-1 rounded-sm">
            <p className="stats-label truncate">{t('sidebar.history')}</p>
            <strong className="mt-0.5 block text-sm">{savedProfiles.length}</strong>
          </div>
          <div className="surface-muted min-w-0 p-1 rounded-sm">
            <p className="stats-label truncate">{t('sidebar.favorite')}</p>
            <strong className="mt-0.5 block text-sm">{favoriteCount}</strong>
          </div>
        </div>

        <button className="btn-primary w-full whitespace-nowrap" onClick={onOpenConnect} type="button">
          {t('sidebar.newConnection')}
        </button>
      </div>

      <section className="surface flex min-h-0 flex-col overflow-hidden">
        <div className="surface-header">
          <div>
            <p className="label">{t('sidebar.history')}</p>
            <h2 className="text-sm font-semibold">{t('sidebar.historyTitle')}</h2>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-subtle text-xs">
              {searchQuery.trim() ? `${filteredProfiles.length} / ${savedProfiles.length}` : savedProfiles.length}
            </span>
          </div>
        </div>
        <div className="px-1 pb-0.5">
          <Input
            size="sm"
            className="themed-input w-full text-xs outline-none transition focus:ring-1 focus:ring-cyan-400/50"
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder={t('sidebar.searchPlaceholder')}
            value={searchQuery}
          />
        </div>
        <ScrollArea className="flex-1 p-1">
          {sortedProfiles.length === 0 ? (
            <div className="text-subtle px-1 py-2 text-xs leading-relaxed">{t('sidebar.emptyHistory')}</div>
          ) : filteredProfiles.length === 0 ? (
            <div className="text-subtle px-1 py-2 text-xs leading-relaxed">{t('sidebar.emptyHistory')}</div>
          ) : (
            <div className="flex flex-col gap-1">
              {filteredProfiles.map((profile) => (
                <ProfileItem
                  key={profile.id}
                  profile={profile}
                  onClick={() => handleReuseClick(profile)}
                  onDoubleClick={() => handleRenameDoubleClick(profile)}
                  onContextMenu={(event) => openHistoryMenu(event, profile)}
                />
              ))}
            </div>
          )}
        </ScrollArea>
      </section>

      {menuOpen && menuProfile && menuPosition
        ? createPortal(
            <>
              <div
                className="fixed inset-0 z-40"
                onClick={closeMenu}
                onContextMenu={(event) => {
                  event.preventDefault();
                  closeMenu();
                }}
                role="presentation"
              />
              <div
                className="themed-menu fixed z-50 max-w-24 rounded-lg p-1 backdrop-blur"
                onClick={(event) => event.stopPropagation()}
                onContextMenu={(event) => event.preventDefault()}
                ref={menuRef}
                style={{ left: menuPosition.x, top: menuPosition.y }}
              >
                <button
                  className="themed-menu-item w-full whitespace-nowrap px-2 py-1 text-left text-xs transition"
                  onClick={() => startRenamingProfile(menuProfile)}
                  type="button"
                >
                  {t('sidebar.menu.rename')}
                </button>
                <button
                  className="themed-menu-item w-full whitespace-nowrap px-2 py-1 text-left text-xs transition"
                  onClick={() => {
                    onTogglePinnedProfile(menuProfile.id);
                    closeMenu();
                  }}
                  type="button"
                >
                  {menuProfile.pinned ? t('sidebar.menu.unpin') : t('sidebar.menu.pin')}
                </button>
                <button
                  className="themed-menu-item w-full whitespace-nowrap px-2 py-1 text-left text-xs transition"
                  onClick={() => {
                    onToggleFavoriteProfile(menuProfile.id);
                    closeMenu();
                  }}
                  type="button"
                >
                  {menuProfile.favorite ? t('sidebar.menu.unfavorite') : t('sidebar.menu.favorite')}
                </button>
                <button
                  className="themed-menu-item w-full whitespace-nowrap px-2 py-1 text-left text-xs transition"
                  onClick={() => {
                    onDeleteProfile(menuProfile.id);
                    closeMenu();
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
            <div className="app-overlay" role="presentation">
              <div
                className="surface rounded-lg w-full max-w-sm p-3"
                onClick={(event) => event.stopPropagation()}
                role="dialog"
                aria-modal="true"
                aria-label={t('sidebar.renameDialog.ariaLabel')}
              >
                <div className="flex flex-col gap-1">
                  <p className="label">{t('sidebar.renameDialog.kicker')}</p>
                  <h3 className="themed-heading text-sm font-semibold">{t('sidebar.renameDialog.title')}</h3>
                </div>

                <Input
                  autoFocus
                  className="themed-input mt-3 w-full text-sm outline-none transition focus:border-cyan-400/60"
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
                  <button className="btn-cancel" onClick={closeRenameDialog} type="button">
                    {t('sidebar.renameDialog.cancel')}
                  </button>
                  <button className="btn-primary" disabled={!renameValue.trim()} onClick={commitRename} type="button">
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
