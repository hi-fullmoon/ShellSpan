import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ServerIcon, LayoutGridIcon, SearchIcon, FolderIcon } from 'lucide-react';
import { usePlatform } from '@/hooks/usePlatform';
import { useI18n } from '@/hooks/useI18n';
import { useProfileStore } from '@/stores/profileStore';
import { useAppStore } from '@/stores/appStore';
import { useRecentProfilesStore } from '@/stores/recentProfilesStore';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { ConnectionProfile } from '@/types';

const ANIMATION_DURATION = 150;

interface SftpNewConnectionMenuProps {
  open: boolean;
  onClose: () => void;
  onConnect: (profile: ConnectionProfile) => Promise<void>;
  onOpenLocal?: () => void;
}

interface ProfileListItem {
  profile: ConnectionProfile;
  isRecent: boolean;
}

export const SftpNewConnectionMenu: React.FC<SftpNewConnectionMenuProps> = ({
  open,
  onClose,
  onConnect,
  onOpenLocal,
}) => {
  const { t } = useI18n();
  const platform = usePlatform();
  const profiles = useProfileStore((state) => state.profiles);
  const recentIds = useRecentProfilesStore((state) => state.recentIds);
  const setActiveSection = useAppStore((state) => state.setActiveSection);

  const [query, setQuery] = useState('');
  const [mounted, setMounted] = useState(open);
  const [closing, setClosing] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);
  const activatingRef = useRef(false);

  const activateOnce = useCallback((action: () => void): void => {
    if (activatingRef.current) return;
    activatingRef.current = true;
    action();
    onClose();
  }, [onClose]);

  const filteredItems = useMemo<ProfileListItem[]>(() => {
    const q = query.trim().toLowerCase();
    const matches = (profile: ConnectionProfile): boolean => {
      if (!q) return true;
      return (
        profile.name.toLowerCase().includes(q) ||
        profile.host.toLowerCase().includes(q) ||
        profile.username.toLowerCase().includes(q)
      );
    };

    const recentProfiles: ConnectionProfile[] = [];
    const otherProfiles: ConnectionProfile[] = [];

    profiles.forEach((profile) => {
      if (!matches(profile)) return;
      if (recentIds.includes(profile.id)) {
        recentProfiles.push(profile);
      } else {
        otherProfiles.push(profile);
      }
    });

    const recentOrder = new Map(recentIds.map((id, index) => [id, index]));
    recentProfiles.sort(
      (a, b) => (recentOrder.get(a.id) ?? Infinity) - (recentOrder.get(b.id) ?? Infinity),
    );
    otherProfiles.sort((a, b) => a.name.localeCompare(b.name));

    return [
      ...recentProfiles.map((profile) => ({ profile, isRecent: true })),
      ...otherProfiles.map((profile) => ({ profile, isRecent: false })),
    ];
  }, [profiles, recentIds, query]);

  const showLocal = Boolean(onOpenLocal) && (!query.trim() || t('sftp.newConnectionMenu.openLocal').toLowerCase().includes(query.trim().toLowerCase()));
  const itemCount = filteredItems.length + (showLocal ? 1 : 0);
  const hasResults = itemCount > 0;

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  useEffect(() => {
    if (selectedIndex < 0 || !listRef.current) return;
    const selectedItem = listRef.current.children[selectedIndex] as HTMLElement | undefined;
    if (typeof selectedItem?.scrollIntoView === 'function') {
      selectedItem.scrollIntoView({ block: 'nearest' });
    }
  }, [selectedIndex]);

  useEffect(() => {
    let timer: number | null = null;
    if (open) {
      activatingRef.current = false;
      setMounted(true);
      setClosing(false);
      setQuery('');
      setSelectedIndex(0);
    } else if (mounted) {
      setClosing(true);
      timer = window.setTimeout(() => {
        setMounted(false);
      }, ANIMATION_DURATION);
    }
    return () => {
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [open, mounted]);

  useEffect(() => {
    if (!mounted) {
      setQuery('');
      return;
    }
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (!hasResults) return;

      const isNext = event.key === 'ArrowDown' || (event.ctrlKey && event.key.toLowerCase() === 'n');
      const isPrevious = event.key === 'ArrowUp' || (event.ctrlKey && event.key.toLowerCase() === 'p');
      if (isNext) {
        event.preventDefault();
        setSelectedIndex((prev) => (prev + 1) % itemCount);
      } else if (isPrevious) {
        event.preventDefault();
        setSelectedIndex((prev) => (prev - 1 + itemCount) % itemCount);
      } else if (event.key === 'Enter') {
        event.preventDefault();
        if (showLocal && selectedIndex === 0) {
          activateOnce(() => onOpenLocal?.());
          return;
        }
        const selected = filteredItems[selectedIndex - (showLocal ? 1 : 0)];
        if (selected) {
          activateOnce(() => {
            void onConnect(selected.profile);
          });
        }
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [mounted, onClose, filteredItems, hasResults, itemCount, selectedIndex, onConnect, onOpenLocal, showLocal, activateOnce]);

  const handleOpenWorkbench = (): void => {
    setActiveSection('workbench');
    onClose();
  };

  const handleConnect = (profile: ConnectionProfile): void => {
    activateOnce(() => {
      void onConnect(profile);
    });
  };

  const renderSectionLabel = (): string | null => {
    if (!hasResults) return null;
    if (query.trim()) return t('terminal.newTabMenu.searchResults');
    if (filteredItems.some((item) => item.isRecent)) {
      return t('terminal.newTabMenu.recentConnections');
    }
    return t('terminal.newTabMenu.savedConnections');
  };

  if (!mounted) return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center p-4 pt-[10vh]">
      <div
        className={cn(
          'absolute inset-0 bg-black/40 backdrop-blur-sm transition-opacity',
          closing ? 'opacity-0' : 'opacity-100',
        )}
        role="presentation"
        onClick={onClose}
      />
      <div
        className={cn(
          'relative z-10 flex w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-app-border bg-app-surface shadow-[var(--shadow-dialog)] transition-all',
          closing
            ? 'translate-y-2 scale-95 opacity-0'
            : 'translate-y-0 scale-100 opacity-100',
        )}
        role="dialog"
        aria-label={t('sftp.newConnectionMenu.title')}
      >
        <div className="border-b border-app-border/50 p-4"><div className="relative">
          <SearchIcon className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-app-text-soft" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('sftp.newConnectionMenu.searchPlaceholder')}
            className="h-11 rounded-xl pl-10 pr-24 text-sm"
            autoFocus
          />
          <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 rounded-md border border-app-border bg-app-surface-muted px-2 py-0.5 font-mono text-xs text-app-text-soft">
            {platform === 'macos' ? '⌘ K' : 'Ctrl K'}
          </span>
        </div></div>

        <div className="max-h-[60vh] min-h-0 overflow-y-auto p-2">
          {hasResults ? (
            <>
              {showLocal && <Button type="button" variant="secondary" data-command-index={0} onClick={() => activateOnce(() => onOpenLocal?.())} onMouseEnter={() => setSelectedIndex(0)} className={cn('mb-2 h-auto w-full justify-start gap-3 rounded-xl p-3 text-left', selectedIndex === 0 && 'ring-1 ring-app-primary')}><span className="flex size-9 items-center justify-center rounded-lg bg-app-primary text-app-primary-text"><FolderIcon /></span><span className="flex min-w-0 flex-1 flex-col items-start"><span className="text-sm font-medium">{t('sftp.newConnectionMenu.openLocal')}</span><span className="text-xs text-app-text-soft">{t('sftp.newConnectionMenu.openLocalHint')}</span></span>{selectedIndex === 0 && <span className="text-xs text-app-text-soft">↵</span>}</Button>}
              {filteredItems.length > 0 && <>
              <h3 className="px-3 py-2 text-xs font-semibold uppercase tracking-wider text-app-text-soft">
                {renderSectionLabel()}
              </h3>
              <ul ref={listRef} className="flex flex-col gap-1">
                {filteredItems.map(({ profile }, index) => {
                  const commandIndex = index + (showLocal ? 1 : 0);
                  const isSelected = commandIndex === selectedIndex;
                  return (
                    <li key={profile.id}>
                      <button
                        type="button"
                        aria-label={profile.name}
                        onClick={() => handleConnect(profile)}
                        onMouseEnter={() => setSelectedIndex(commandIndex)}
                        data-command-index={commandIndex}
                        className={cn(
                          'flex w-full items-center gap-3 rounded-xl p-3 text-left transition-colors',
                          isSelected
                            ? 'bg-app-primary/10 text-app-text'
                            : 'hover:bg-app-surface-muted',
                        )}
                      >
                        <div
                          className={cn(
                            'flex h-9 w-9 shrink-0 items-center justify-center rounded-xl',
                            isSelected
                              ? 'bg-app-primary text-app-primary-text'
                              : 'bg-app-primary/10 text-app-primary',
                          )}
                        >
                          <ServerIcon className="h-4 w-4" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium text-app-text">
                            {profile.name}
                          </p>
                          <p className="truncate text-xs text-app-text-soft">
                            {profile.username}@{profile.host}:{profile.port}
                          </p>
                        </div>
                        {isSelected && (
                          <span className="text-xs text-app-text-soft">↵</span>
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
              </>}
            </>
          ) : (
            <div className="flex flex-col items-center justify-center gap-2 p-8 text-center">
              <p className="text-sm text-app-text-soft">
                {query
                  ? t('terminal.newTabMenu.noSearchResults')
                  : t('sftp.newConnectionMenu.noProfiles')}
              </p>
              <p className="text-xs text-app-text-soft">
                {t('sftp.newConnectionMenu.openWorkbenchHint')}
              </p>
            </div>
          )}
        </div>

        <div className="flex items-center justify-between border-t border-app-border/50 px-4 py-3">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={handleOpenWorkbench}
            className="gap-2 px-2 text-muted-foreground hover:text-app-text"
          >
            <LayoutGridIcon className="h-4 w-4" />
            {t('terminal.newTabMenu.openWorkbench')}
          </Button>
          <div className="flex items-center gap-3 text-xs text-app-text-soft">
            <span>↑↓ / Ctrl N P {t('terminal.newTabMenu.navigate')}</span>
            <span>↵ {t('sftp.newConnectionMenu.connect')}</span>
            <span>Esc {t('terminal.newTabMenu.close')}</span>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
};
