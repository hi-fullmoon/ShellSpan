import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useI18n } from '@/hooks/useI18n';
import { useProfileStore } from '@/stores/profileStore';
import { useAppStore } from '@/stores/appStore';
import { useRecentProfilesStore } from '@/stores/recentProfilesStore';
import { useConnectSession } from '@/hooks/useConnectSession';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { ServerIcon, LayoutGridIcon } from 'lucide-react';
import type { ConnectionProfile } from '@/types';

const ANIMATION_DURATION = 150;

// Icons replaced with lucide-react imports

interface NewTabMenuProps {
  open: boolean;
  onClose: () => void;
}

interface ProfileListItem {
  profile: ConnectionProfile;
  isRecent: boolean;
}

export const NewTabMenu: React.FC<NewTabMenuProps> = ({ open, onClose }) => {
  const { t } = useI18n();
  const profiles = useProfileStore((state) => state.profiles);
  const recentIds = useRecentProfilesStore((state) => state.recentIds);
  const { connect } = useConnectSession();
  const setActiveSection = useAppStore((state) => state.setActiveSection);

  const [query, setQuery] = useState('');
  const [mounted, setMounted] = useState(open);
  const [closing, setClosing] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);

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

  const hasResults = filteredItems.length > 0;

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

      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setSelectedIndex((prev) => (prev + 1) % filteredItems.length);
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        setSelectedIndex(
          (prev) => (prev - 1 + filteredItems.length) % filteredItems.length,
        );
      } else if (event.key === 'Enter') {
        event.preventDefault();
        const selected = filteredItems[selectedIndex];
        if (selected) {
          void connect(selected.profile);
          onClose();
        }
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [mounted, onClose, filteredItems, hasResults, selectedIndex, connect]);

  const handleOpenWorkbench = (): void => {
    setActiveSection('workbench');
    onClose();
  };

  const handleConnect = (profile: ConnectionProfile): void => {
    void connect(profile);
    onClose();
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
        aria-label={t('terminal.newTabMenu.title')}
      >
        <div className="relative border-b border-app-border p-4">
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('terminal.newTabMenu.searchPlaceholder')}
            className="h-11 rounded-xl pr-20 text-sm"
            autoFocus
          />
          <span className="pointer-events-none absolute right-7 top-1/2 -translate-y-1/2 rounded-md border border-app-border bg-app-surface-muted px-1.5 py-0.5 text-xs text-app-text-soft">
            ⌘K
          </span>
        </div>

        <div className="max-h-[60vh] min-h-0 overflow-y-auto p-2">
          {hasResults ? (
            <>
              <h3 className="px-3 py-2 text-xs font-semibold uppercase tracking-wider text-app-text-soft">
                {renderSectionLabel()}
              </h3>
              <ul ref={listRef} className="flex flex-col gap-1">
                {filteredItems.map(({ profile }, index) => {
                  const isSelected = index === selectedIndex;
                  return (
                    <li key={profile.id}>
                      <button
                        type="button"
                        aria-label={profile.name}
                        onClick={() => handleConnect(profile)}
                        onMouseEnter={() => setSelectedIndex(index)}
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
                          <ServerIcon />
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
            </>
          ) : (
            <div className="flex flex-col items-center justify-center gap-2 p-8 text-center">
              <p className="text-sm text-app-text-soft">
                {query
                  ? t('terminal.newTabMenu.noSearchResults')
                  : t('terminal.tab.noProfiles')}
              </p>
              <p className="text-xs text-app-text-soft">
                {t('terminal.newTabMenu.openWorkbenchHint')}
              </p>
            </div>
          )}
        </div>

        <div className="flex items-center justify-between border-t border-app-border px-4 py-3">
          <button
            type="button"
            onClick={handleOpenWorkbench}
            className="flex items-center gap-2 rounded-lg px-2 py-1 text-xs text-app-text-soft transition-colors hover:bg-app-surface-muted hover:text-app-text"
          >
            <LayoutGridIcon />
            {t('terminal.newTabMenu.openWorkbench')}
          </button>
          <div className="flex items-center gap-3 text-xs text-app-text-soft">
            <span>↑↓ {t('terminal.newTabMenu.navigate')}</span>
            <span>↵ {t('terminal.newTabMenu.connect')}</span>
            <span>Esc {t('terminal.newTabMenu.close')}</span>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
};
