import { createPortal } from 'react-dom';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { PinIcon, StarIcon, PlusIcon } from './Icons';
import { Tooltip } from './Tooltip';
import { ScrollArea } from './ScrollArea';
import { t } from '../lib/i18n';
import type { ConnectionGroup, ConnectionProfile } from '../types';

const HISTORY_ITEM_DOUBLE_CLICK_DELAY_MS = 220;

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
  groups?: ConnectionGroup[];
  onDeleteProfile: (profileId: string) => void;
  onRenameProfile: (profileId: string, name: string) => void;
  onToggleFavoriteProfile: (profileId: string) => void;
  onTogglePinnedProfile: (profileId: string) => void;
  onSetProfileColor: (profileId: string, color?: string) => void;
  onMoveProfileToGroup?: (profileId: string, groupId?: string) => void;
  onAddGroup?: (name: string) => void;
  onDeleteGroup?: (groupId: string) => void;
  onRenameGroup?: (groupId: string, name: string) => void;
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

const PRESET_COLORS = [
  '#ef4444', '#f97316', '#f59e0b', '#84cc16',
  '#10b981', '#06b6d4', '#3b82f6', '#8b5cf6',
  '#d946ef', '#f43f5e',
];

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
      {profile.color ? (
        <span
          className="h-5 w-1 shrink-0 rounded-full"
          style={{ backgroundColor: profile.color }}
        />
      ) : (
        <span className="h-5 w-1 shrink-0 rounded-full" />
      )}
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
  groups = [],
  onDeleteProfile,
  onRenameProfile,
  onToggleFavoriteProfile,
  onTogglePinnedProfile,
  onSetProfileColor,
  onMoveProfileToGroup,
  onAddGroup,
  onDeleteGroup,
  onRenameGroup,
  onReuseProfile,
  onOpenConnect,
}: SidebarProps) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const clickTimerRef = useRef<ReturnType<typeof window.setTimeout> | undefined>(undefined);
  const [historyMenu, setHistoryMenu] = useState<HistoryMenuState>();
  const [renamingProfileId, setRenamingProfileId] = useState<string>();
  const [renameValue, setRenameValue] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [groupMenu, setGroupMenu] = useState<{ group: ConnectionGroup; x: number; y: number } | null>(null);
  const [renamingGroupId, setRenamingGroupId] = useState<string>();
  const [renameGroupValue, setRenameGroupValue] = useState('');
  const [newGroupOpen, setNewGroupOpen] = useState(false);
  const [newGroupValue, setNewGroupValue] = useState('');
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

  const { ungroupedProfiles, groupedProfiles } = useMemo(() => {
    const ungrouped: ConnectionProfile[] = [];
    const grouped = new Map<string, ConnectionProfile[]>();
    for (const profile of filteredProfiles) {
      if (profile.groupId) {
        const list = grouped.get(profile.groupId) ?? [];
        list.push(profile);
        grouped.set(profile.groupId, list);
      } else {
        ungrouped.push(profile);
      }
    }
    return { ungroupedProfiles: ungrouped, groupedProfiles: grouped };
  }, [filteredProfiles]);

  const toggleGroupExpanded = (groupId: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) {
        next.delete(groupId);
      } else {
        next.add(groupId);
      }
      return next;
    });
  };

  const openGroupMenu = (event: ReactMouseEvent<HTMLDivElement>, group: ConnectionGroup) => {
    event.preventDefault();
    event.stopPropagation();
    setGroupMenu({ group, x: event.clientX, y: event.clientY });
  };

  const startRenamingGroup = (group: ConnectionGroup) => {
    setGroupMenu(null);
    setRenamingGroupId(group.id);
    setRenameGroupValue(group.name);
  };

  const closeRenameGroupDialog = () => {
    setRenamingGroupId(undefined);
    setRenameGroupValue('');
  };

  const openNewGroupDialog = () => {
    setNewGroupOpen(true);
    setNewGroupValue('');
  };

  const closeNewGroupDialog = () => {
    setNewGroupOpen(false);
    setNewGroupValue('');
  };

  const commitNewGroup = () => {
    const name = newGroupValue.trim();
    if (name && onAddGroup) {
      onAddGroup(name);
    }
    closeNewGroupDialog();
  };

  const commitRenameGroup = () => {
    if (!renamingGroupId) return;
    const nextName = renameGroupValue.trim();
    if (nextName && onRenameGroup) {
      onRenameGroup(renamingGroupId, nextName);
    }
    closeRenameGroupDialog();
  };

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
            {onAddGroup ? (
              <button
                className="inline-flex h-5 w-5 items-center justify-center rounded-sm text-(--app-text-muted) transition hover:bg-(--app-icon-hover) hover:text-(--app-text-soft)"
                onClick={openNewGroupDialog}
                title={t('sidebar.groups.newGroup')}
                type="button"
              >
                <PlusIcon className="h-3.5 w-3.5" />
              </button>
            ) : null}
            <span className="text-subtle text-xs">
              {searchQuery.trim() ? `${filteredProfiles.length} / ${savedProfiles.length}` : savedProfiles.length}
            </span>
          </div>
        </div>
        <div className="px-1 pb-0.5">
          <input
            className="themed-input w-full px-2 py-1 text-xs outline-none transition focus:ring-1 focus:ring-cyan-400/50"
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
              {/* Ungrouped profiles */}
              {ungroupedProfiles.map((profile) => (
                <ProfileItem
                  key={profile.id}
                  profile={profile}
                  onClick={() => handleReuseClick(profile)}
                  onDoubleClick={() => handleRenameDoubleClick(profile)}
                  onContextMenu={(event) => openHistoryMenu(event, profile)}
                />
              ))}

              {/* Grouped profiles */}
              {groups.map((group) => {
                const groupProfiles = groupedProfiles.get(group.id) ?? [];
                if (!groupProfiles.length) return null;
                const isExpanded = expandedGroups.has(group.id);
                return (
                  <div key={group.id} className="flex flex-col gap-0.5">
                    <div
                      className="flex cursor-pointer select-none items-center gap-1 rounded-sm px-1.5 py-0.5 transition hover:bg-white/5"
                      onClick={() => toggleGroupExpanded(group.id)}
                      onContextMenu={(event) => openGroupMenu(event, group)}
                    >
                      <span className="text-[10px] text-slate-400 transition-transform" style={{ transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)' }}>
                        ▶
                      </span>
                      <span className="truncate text-xs font-medium">{group.name}</span>
                      <span className="text-subtle text-[10px]">({groupProfiles.length})</span>
                    </div>
                    {isExpanded && (
                      <div className="flex flex-col gap-0.5 pl-3">
                        {groupProfiles.map((profile) => (
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
                  </div>
                );
              })}
            </div>
          )}
        </ScrollArea>
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
                className="themed-menu fixed z-50 max-w-24 rounded-lg p-1 backdrop-blur"
                onClick={(event) => event.stopPropagation()}
                onContextMenu={(event) => event.preventDefault()}
                ref={menuRef}
                style={{ left: historyMenu.x, top: historyMenu.y }}
              >
                <button
                  className="themed-menu-item w-full whitespace-nowrap px-2 py-1 text-left text-xs transition"
                  onClick={() => startRenamingProfile(historyMenu.profile)}
                  type="button"
                >
                  {t('sidebar.menu.rename')}
                </button>
                <button
                  className="themed-menu-item w-full whitespace-nowrap px-2 py-1 text-left text-xs transition"
                  onClick={() => {
                    onTogglePinnedProfile(historyMenu.profile.id);
                    setHistoryMenu(undefined);
                  }}
                  type="button"
                >
                  {historyMenu.profile.pinned ? t('sidebar.menu.unpin') : t('sidebar.menu.pin')}
                </button>
                <button
                  className="themed-menu-item w-full whitespace-nowrap px-2 py-1 text-left text-xs transition"
                  onClick={() => {
                    onToggleFavoriteProfile(historyMenu.profile.id);
                    setHistoryMenu(undefined);
                  }}
                  type="button"
                >
                  {historyMenu.profile.favorite ? t('sidebar.menu.unfavorite') : t('sidebar.menu.favorite')}
                </button>
                <button
                  className="themed-menu-item w-full whitespace-nowrap px-2 py-1 text-left text-xs transition"
                  onClick={() => {
                    onDeleteProfile(historyMenu.profile.id);
                    setHistoryMenu(undefined);
                  }}
                  type="button"
                >
                  {t('sidebar.menu.delete')}
                </button>
                {groups.length > 0 && onMoveProfileToGroup ? (
                  <>
                    <div className="themed-menu-divider my-1 h-px" />
                    <div className="flex flex-col">
                      <span className="px-2 py-0.5 text-[10px] text-slate-400">{t('sidebar.groups.moveTo')}</span>
                      {historyMenu.profile.groupId && (
                        <button
                          className="themed-menu-item w-full whitespace-nowrap px-2 py-1 text-left text-xs transition"
                          onClick={() => {
                            onMoveProfileToGroup(historyMenu.profile.id, undefined);
                            setHistoryMenu(undefined);
                          }}
                          type="button"
                        >
                          {t('sidebar.groups.ungrouped')}
                        </button>
                      )}
                      {groups.map((group) => (
                        <button
                          className="themed-menu-item w-full whitespace-nowrap px-2 py-1 text-left text-xs transition"
                          disabled={group.id === historyMenu.profile.groupId}
                          key={group.id}
                          onClick={() => {
                            onMoveProfileToGroup(historyMenu.profile.id, group.id);
                            setHistoryMenu(undefined);
                          }}
                          type="button"
                        >
                          {group.name}
                        </button>
                      ))}
                    </div>
                  </>
                ) : null}
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

                <input
                  autoFocus
                  className="themed-input mt-3 w-full px-3 py-2 text-sm outline-none transition focus:border-cyan-400/60"
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

      {groupMenu
        ? createPortal(
            <>
              <div
                className="fixed inset-0 z-40"
                onClick={() => setGroupMenu(null)}
                onContextMenu={(event) => {
                  event.preventDefault();
                  setGroupMenu(null);
                }}
                role="presentation"
              />
              <div
                className="themed-menu fixed z-50 max-w-24 rounded-lg p-1 backdrop-blur"
                onClick={(event) => event.stopPropagation()}
                onContextMenu={(event) => event.preventDefault()}
                style={{ left: groupMenu.x, top: groupMenu.y }}
              >
                <button
                  className="themed-menu-item w-full whitespace-nowrap px-2 py-1 text-left text-xs transition"
                  onClick={() => startRenamingGroup(groupMenu.group)}
                  type="button"
                >
                  {t('sidebar.menu.rename')}
                </button>
                {onDeleteGroup ? (
                  <button
                    className="themed-menu-item w-full whitespace-nowrap px-2 py-1 text-left text-xs transition text-rose-400 hover:text-rose-300"
                    onClick={() => {
                      onDeleteGroup(groupMenu.group.id);
                      setGroupMenu(null);
                    }}
                    type="button"
                  >
                    {t('common.delete')}
                  </button>
                ) : null}
              </div>
            </>,
            document.body,
          )
        : null}

      {renamingGroupId
        ? createPortal(
            <div className="app-overlay" role="presentation">
              <div
                className="surface rounded-lg w-full max-w-sm p-3"
                onClick={(event) => event.stopPropagation()}
                role="dialog"
                aria-modal="true"
                aria-label={t('sidebar.groups.renameAriaLabel')}
              >
                <div className="flex flex-col gap-1">
                  <p className="label">{t('sidebar.groups.renameKicker')}</p>
                  <h3 className="themed-heading text-sm font-semibold">{t('sidebar.groups.renameTitle')}</h3>
                </div>

                <input
                  autoFocus
                  className="themed-input mt-3 w-full px-3 py-2 text-sm outline-none transition focus:border-cyan-400/60"
                  onChange={(event) => setRenameGroupValue(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      commitRenameGroup();
                    }
                    if (event.key === 'Escape') {
                      event.preventDefault();
                      closeRenameGroupDialog();
                    }
                  }}
                  placeholder={t('sidebar.groups.renamePlaceholder')}
                  value={renameGroupValue}
                />

                <div className="mt-3 flex justify-end gap-1">
                  <button className="btn-cancel" onClick={closeRenameGroupDialog} type="button">
                    {t('sidebar.renameDialog.cancel')}
                  </button>
                  <button className="btn-primary" disabled={!renameGroupValue.trim()} onClick={commitRenameGroup} type="button">
                    {t('sidebar.renameDialog.save')}
                  </button>
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}

      {newGroupOpen
        ? createPortal(
            <div className="app-overlay" role="presentation">
              <div
                className="surface rounded-lg w-full max-w-sm p-3"
                onClick={(event) => event.stopPropagation()}
                role="dialog"
                aria-modal="true"
                aria-label={t('sidebar.groups.newAriaLabel')}
              >
                <div className="flex flex-col gap-1">
                  <p className="label">{t('sidebar.groups.newKicker')}</p>
                  <h3 className="themed-heading text-sm font-semibold">{t('sidebar.groups.newTitle')}</h3>
                </div>

                <input
                  autoFocus
                  className="themed-input mt-3 w-full px-3 py-2 text-sm outline-none transition focus:border-cyan-400/60"
                  onChange={(event) => setNewGroupValue(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      commitNewGroup();
                    }
                    if (event.key === 'Escape') {
                      event.preventDefault();
                      closeNewGroupDialog();
                    }
                  }}
                  placeholder={t('sidebar.groups.newPlaceholder')}
                  value={newGroupValue}
                />

                <div className="mt-3 flex justify-end gap-1">
                  <button className="btn-cancel" onClick={closeNewGroupDialog} type="button">
                    {t('sidebar.renameDialog.cancel')}
                  </button>
                  <button className="btn-primary" disabled={!newGroupValue.trim()} onClick={commitNewGroup} type="button">
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
