import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ServerIcon, LayoutGridIcon, SearchIcon, FolderIcon } from 'lucide-react';
import { usePlatform } from '@/hooks/usePlatform';
import { useI18n } from '@/hooks/useI18n';
import { useProfileStore } from '@/stores/profileStore';
import { useAppStore } from '@/stores/appStore';
import { useRecentProfilesStore } from '@/stores/recentProfilesStore';
import { Button } from '@/components/ui/button';
import type { ConnectionProfile } from '@/types';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from '@/components/ui/input-group';
import { Kbd } from '@/components/ui/kbd';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';

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
  const [selectedIndex, setSelectedIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
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
    const selectedItem = listRef.current?.querySelector<HTMLElement>(
      `[data-command-index="${selectedIndex}"]`,
    );
    selectedItem?.scrollIntoView?.({ block: 'nearest' });
  }, [selectedIndex]);

  useEffect(() => {
    if (open) {
      activatingRef.current = false;
      setQuery('');
      setSelectedIndex(0);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent): void => {
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
  }, [open, filteredItems, hasResults, itemCount, selectedIndex, onConnect, onOpenLocal, showLocal, activateOnce]);

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

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => { if (!nextOpen) onClose(); }}>
      <DialogContent className="top-[12vh] flex max-h-[76vh] w-[calc(100%-2rem)] max-w-2xl translate-y-0 flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="px-4 pb-3 pt-4 pr-12">
          <DialogTitle>{t('sftp.newConnectionMenu.title')}</DialogTitle>
          <DialogDescription>{t('sftp.newConnectionMenu.description')}</DialogDescription>
        </DialogHeader>

        <div className="px-4 pb-4">
          <InputGroup className="h-10 has-[[data-slot=input-group-control]:focus-visible]:ring-1">
            <InputGroupInput
              type="search"
              aria-label={t('sftp.newConnectionMenu.searchPlaceholder')}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('sftp.newConnectionMenu.searchPlaceholder')}
              autoFocus
            />
            <InputGroupAddon align="inline-start"><SearchIcon /></InputGroupAddon>
            <InputGroupAddon align="inline-end">
              <Kbd>{platform === 'macos' ? '⌘ K' : 'Ctrl K'}</Kbd>
            </InputGroupAddon>
          </InputGroup>
        </div>

        <Separator />
        <ScrollArea className="min-h-32 flex-1">
          <div ref={listRef} className="flex flex-col gap-2 px-4 py-3">
            {hasResults ? (
              <>
                {showLocal && (
                  <Button
                    type="button"
                    variant={selectedIndex === 0 ? 'secondary' : 'ghost'}
                    data-command-index={0}
                    onClick={() => activateOnce(() => onOpenLocal?.())}
                    onMouseEnter={() => setSelectedIndex(0)}
                    className="h-auto w-full justify-start gap-3 rounded-lg p-3 text-left"
                  >
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground">
                      <FolderIcon data-icon="inline-start" />
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col items-start gap-0.5">
                      <span className="text-sm font-medium">
                        {t('sftp.newConnectionMenu.openLocal')}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {t('sftp.newConnectionMenu.openLocalHint')}
                      </span>
                    </span>
                    {selectedIndex === 0 && <Kbd aria-hidden="true">↵</Kbd>}
                  </Button>
                )}
                {filteredItems.length > 0 && (
                  <section
                    className="flex flex-col gap-1"
                    aria-label={renderSectionLabel() ?? undefined}
                  >
                    <h3 className="px-3 py-1.5 text-xs font-medium text-muted-foreground">
                      {renderSectionLabel()}
                    </h3>
                    <ul className="flex flex-col gap-1">
                      {filteredItems.map(({ profile }, index) => {
                        const commandIndex = index + (showLocal ? 1 : 0);
                        const isSelected = commandIndex === selectedIndex;
                        return (
                          <li key={profile.id}>
                            <Button
                              type="button"
                              aria-label={profile.name}
                              variant={isSelected ? 'secondary' : 'ghost'}
                              onClick={() => handleConnect(profile)}
                              onMouseEnter={() => setSelectedIndex(commandIndex)}
                              data-command-index={commandIndex}
                              className="h-auto w-full justify-start gap-3 rounded-lg p-3 text-left"
                            >
                              <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                                <ServerIcon data-icon="inline-start" />
                              </span>
                              <span className="flex min-w-0 flex-1 flex-col items-start gap-0.5">
                                <span className="w-full truncate text-sm font-medium">
                                  {profile.name}
                                </span>
                                <span className="w-full truncate text-xs text-muted-foreground">
                                  {profile.username}@{profile.host}:{profile.port}
                                </span>
                              </span>
                              {isSelected && <Kbd aria-hidden="true">↵</Kbd>}
                            </Button>
                          </li>
                        );
                      })}
                    </ul>
                  </section>
                )}
              </>
            ) : (
              <div className="flex min-h-32 flex-col items-center justify-center gap-1 p-6 text-center">
                <p className="text-sm font-medium">
                  {query
                    ? t('terminal.newTabMenu.noSearchResults')
                    : t('sftp.newConnectionMenu.noProfiles')}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t('sftp.newConnectionMenu.openWorkbenchHint')}
                </p>
              </div>
            )}
          </div>
        </ScrollArea>
        <Separator />

        <DialogFooter className="flex-row flex-wrap items-center justify-between gap-2 px-4 py-3 pt-3">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={handleOpenWorkbench}
          >
            <LayoutGridIcon data-icon="inline-start" />
            {t('terminal.newTabMenu.openWorkbench')}
          </Button>
          <div className="hidden items-center gap-2 text-xs text-muted-foreground sm:flex">
            <span className="flex items-center gap-1">
              <Kbd>↑</Kbd><Kbd>↓</Kbd>{t('terminal.newTabMenu.navigate')}
            </span>
            <span className="flex items-center gap-1">
              <Kbd>↵</Kbd>{t('sftp.newConnectionMenu.connect')}
            </span>
            <span className="flex items-center gap-1">
              <Kbd>Esc</Kbd>{t('terminal.newTabMenu.close')}
            </span>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
