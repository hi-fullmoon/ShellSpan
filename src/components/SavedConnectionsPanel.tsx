import { useMemo, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { Input } from '@chakra-ui/react';
import { t } from '../lib/i18n';
import { cn } from '../lib/ui';
import {
  ScrollArea,
  ServerIcon,
  SearchIcon,
  LayoutGridIcon,
  LayoutListIcon,
  PlusIcon,
  DotsIcon,
  PinIcon,
  StarIcon,
  Tooltip,
} from './ui';
import type { ConnectionProfile } from '../types';

interface SavedConnectionsPanelProps {
  profiles: ConnectionProfile[];
  onConnect: (profile: ConnectionProfile) => void;
  onEdit: (profile: ConnectionProfile) => void;
  onDelete: (profileId: string) => void;
  onNewHost: () => void;
  onTogglePin: (profileId: string) => void;
  onToggleFavorite: (profileId: string) => void;
  onRename: (profileId: string, name: string) => void;
}

function sortSavedProfiles(profiles: ConnectionProfile[]) {
  return [...profiles].sort(
    (left, right) =>
      Number(Boolean(right.pinned)) - Number(Boolean(left.pinned)) ||
      Number(Boolean(right.favorite)) - Number(Boolean(left.favorite)),
  );
}

function HostIcon({ color }: { color?: string }) {
  return (
    <div
      className="grid h-10 w-10 shrink-0 place-items-center rounded-xl text-white"
      style={{ backgroundColor: color || 'var(--app-primary-bg)' }}
    >
      <ServerIcon className="h-5 w-5" />
    </div>
  );
}

interface ProfileCardProps {
  profile: ConnectionProfile;
  onConnect: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onTogglePin: () => void;
  onToggleFavorite: () => void;
}

function ProfileCard({ profile, onConnect, onEdit, onDelete, onTogglePin, onToggleFavorite }: ProfileCardProps) {
  const [menuOpen, setMenuOpen] = useState(false);

  const handleContextMenu = (event: ReactMouseEvent) => {
    event.preventDefault();
    setMenuOpen(true);
  };

  return (
    <div
      className="group relative flex items-center gap-3 rounded-xl border border-[var(--app-border)] bg-[var(--app-surface)] p-3 transition hover:border-[var(--app-border-strong)] hover:bg-[var(--app-surface-hover)]"
      onContextMenu={handleContextMenu}
    >
      <HostIcon color={profile.color} />

      <button
        className="min-w-0 flex-1 text-left"
        onClick={onConnect}
        type="button"
      >
        <div className="flex items-center gap-1">
          <strong className="truncate text-sm font-medium text-[var(--app-text)]">{profile.name}</strong>
          {profile.pinned ? (
            <Tooltip content={t('sidebar.badge.pinned')}>
              <span className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center text-cyan-300">
                <PinIcon />
              </span>
            </Tooltip>
          ) : null}
          {profile.favorite ? (
            <Tooltip content={t('sidebar.badge.favorite')}>
              <span className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center text-amber-300">
                <StarIcon />
              </span>
            </Tooltip>
          ) : null}
        </div>
        <span className="block truncate text-xs text-[var(--app-text-muted)]">
          ssh, {profile.username}
        </span>
      </button>

      <div className="relative">
        <button
          className={cn(
            'icon-btn h-7 w-7 shrink-0 opacity-0 transition group-hover:opacity-100',
            menuOpen && 'opacity-100',
          )}
          onClick={() => setMenuOpen((open) => !open)}
          type="button"
        >
          <DotsIcon className="h-4 w-4" />
        </button>

        {menuOpen ? (
          <div className="themed-menu absolute right-0 top-full z-10 mt-1 min-w-[120px] rounded-md p-1 shadow-lg">
            <button
              className="themed-menu-item w-full px-2 py-1.5 text-left text-xs font-medium transition"
              onClick={() => {
                onConnect();
                setMenuOpen(false);
              }}
              type="button"
            >
              {t('savedConnections.connect')}
            </button>
            <button
              className="themed-menu-item w-full px-2 py-1.5 text-left text-xs font-medium transition"
              onClick={() => {
                onEdit();
                setMenuOpen(false);
              }}
              type="button"
            >
              {t('savedConnections.edit')}
            </button>
            <button
              className="themed-menu-item w-full px-2 py-1.5 text-left text-xs font-medium transition"
              onClick={() => {
                onTogglePin();
                setMenuOpen(false);
              }}
              type="button"
            >
              {profile.pinned ? t('sidebar.menu.unpin') : t('sidebar.menu.pin')}
            </button>
            <button
              className="themed-menu-item w-full px-2 py-1.5 text-left text-xs font-medium transition"
              onClick={() => {
                onToggleFavorite();
                setMenuOpen(false);
              }}
              type="button"
            >
              {profile.favorite ? t('sidebar.menu.unfavorite') : t('sidebar.menu.favorite')}
            </button>
            <button
              className="themed-menu-item w-full px-2 py-1.5 text-left text-xs font-medium text-rose-400 transition"
              onClick={() => {
                onDelete();
                setMenuOpen(false);
              }}
              type="button"
            >
              {t('savedConnections.delete')}
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function SavedConnectionsPanel({
  profiles,
  onConnect,
  onEdit,
  onDelete,
  onNewHost,
  onTogglePin,
  onToggleFavorite,
}: SavedConnectionsPanelProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
  const sortedProfiles = useMemo(() => sortSavedProfiles(profiles), [profiles]);
  const filteredProfiles = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return sortedProfiles;
    return sortedProfiles.filter(
      (profile) =>
        profile.name.toLowerCase().includes(query) ||
        profile.host.toLowerCase().includes(query) ||
        profile.username.toLowerCase().includes(query),
    );
  }, [sortedProfiles, searchQuery]);

  return (
    <section className="flex h-full min-h-0 flex-col overflow-hidden bg-[var(--app-bg)]">
      <div className="flex items-center gap-2 border-b border-[var(--app-border)] px-4 py-2">
        <div className="flex flex-1 items-center gap-2 rounded-md border border-[var(--app-border)] bg-[var(--app-surface-muted)] px-2 py-1.5">
          <SearchIcon className="h-4 w-4 text-[var(--app-text-muted)]" />
          <Input
            className="h-5 flex-1 border-0 bg-transparent p-0 text-xs text-[var(--app-text)] placeholder:text-[var(--app-text-muted)] focus-visible:ring-0"
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder={t('savedConnections.searchPlaceholder')}
            value={searchQuery}
          />
        </div>
        <button className="btn-primary h-7 px-3 text-xs" type="button">
          {t('savedConnections.connect')}
        </button>
      </div>

      <div className="flex items-center justify-between gap-3 border-b border-[var(--app-border)] px-4 py-2">
        <div className="flex items-center gap-2">
          <button className="btn-secondary" onClick={onNewHost} type="button">
            <PlusIcon className="h-4 w-4" />
            {t('savedConnections.newHost')}
          </button>
          <div className="h-4 w-px bg-[var(--app-border)]" />
          <button className="btn-ghost text-[var(--app-text-soft)]" type="button">
            {t('savedConnections.terminal')}
          </button>
          <button className="btn-ghost text-[var(--app-text-soft)]" type="button">
            {t('savedConnections.serial')}
          </button>
        </div>

        <div className="flex items-center gap-1">
          <button
            className={cn('icon-btn h-7 w-7', viewMode === 'grid' && 'bg-[var(--app-surface-active)]')}
            onClick={() => setViewMode('grid')}
            type="button"
          >
            <LayoutGridIcon className="h-4 w-4" />
          </button>
          <button
            className={cn('icon-btn h-7 w-7', viewMode === 'list' && 'bg-[var(--app-surface-active)]')}
            onClick={() => setViewMode('list')}
            type="button"
          >
            <LayoutListIcon className="h-4 w-4" />
          </button>
        </div>
      </div>

      <ScrollArea className="flex-1 p-4">
        <h2 className="mb-3 text-sm font-semibold text-[var(--app-text)]">{t('savedConnections.title')}</h2>

        {profiles.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center pb-12 text-center">
            <div className="mb-4 grid h-16 w-16 place-items-center rounded-2xl bg-[var(--app-surface-muted)] text-[var(--app-text-muted)]">
              <ServerIcon className="h-7 w-7" />
            </div>
            <h3 className="text-base font-semibold text-[var(--app-text)]">{t('savedConnections.empty.title')}</h3>
            <p className="mt-1 max-w-sm text-sm text-[var(--app-text-soft)]">{t('savedConnections.empty.description')}</p>
          </div>
        ) : filteredProfiles.length === 0 ? (
          <div className="text-subtle px-1 py-4 text-center text-xs leading-relaxed">{t('savedConnections.empty.noMatch')}</div>
        ) : (
          <div
            className={cn(
              'gap-3',
              viewMode === 'grid'
                ? 'grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4'
                : 'flex flex-col',
            )}
          >
            {filteredProfiles.map((profile) => (
              <ProfileCard
                key={profile.id}
                profile={profile}
                onConnect={() => onConnect(profile)}
                onDelete={() => onDelete(profile.id)}
                onEdit={() => onEdit(profile)}
                onToggleFavorite={() => onToggleFavorite(profile.id)}
                onTogglePin={() => onTogglePin(profile.id)}
              />
            ))}
          </div>
        )}
      </ScrollArea>
    </section>
  );
}
