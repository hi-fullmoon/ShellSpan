import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  LayoutGridIcon,
  PlusIcon,
  SearchIcon,
  ServerIcon,
  SquareTerminalIcon,
} from 'lucide-react';
import { useI18n } from '@/hooks/useI18n';
import { usePlatform } from '@/hooks/usePlatform';
import { useAppStore } from '@/stores/appStore';
import { useProfileStore } from '@/stores/profileStore';
import { useRecentProfilesStore } from '@/stores/recentProfilesStore';
import { Button } from '@/components/ui/button';
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
import type { ConnectionProfile, LocalTerminalProfile } from '@/types';

interface NewSessionDialogProps {
  open: boolean;
  onClose: () => void;
  onConnect: (profile: ConnectionProfile) => Promise<void>;
  onOpenLocal?: (localProfile?: LocalTerminalProfile) => Promise<void>;
  supportsShellSpanBash?: boolean;
}

type SessionCommand =
  | { kind: 'local'; localProfile?: LocalTerminalProfile; label: string; hint: string }
  | { kind: 'profile'; profile: ConnectionProfile; isRecent: boolean };

interface IndexedSessionCommand {
  command: SessionCommand;
  index: number;
}

export const NewSessionDialog: React.FC<NewSessionDialogProps> = ({
  open,
  onClose,
  onConnect,
  onOpenLocal,
  supportsShellSpanBash = false,
}) => {
  const { t } = useI18n();
  const platform = usePlatform();
  const profiles = useProfileStore((state) => state.profiles);
  const recentIds = useRecentProfilesStore((state) => state.recentIds);
  const setActiveSection = useAppStore((state) => state.setActiveSection);
  const setActiveWorkbenchTab = useAppStore((state) => state.setActiveWorkbenchTab);
  const requestNewConnection = useAppStore((state) => state.requestNewConnection);

  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const commandListRef = useRef<HTMLDivElement>(null);
  const activatingRef = useRef(false);

  const profileCommands = useMemo<SessionCommand[]>(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    const matches = (profile: ConnectionProfile): boolean => {
      if (!normalizedQuery) return true;
      return [
        profile.name,
        profile.host,
        profile.username,
        profile.group,
        ...(profile.tags ?? []),
      ]
        .filter(Boolean)
        .some((value) => value?.toLocaleLowerCase().includes(normalizedQuery));
    };
    const recentOrder = new Map(recentIds.map((id, index) => [id, index]));

    return profiles
      .filter(matches)
      .sort((left, right) => {
        const leftRecentIndex = recentOrder.get(left.id);
        const rightRecentIndex = recentOrder.get(right.id);
        if (leftRecentIndex !== undefined || rightRecentIndex !== undefined) {
          return (leftRecentIndex ?? Number.MAX_SAFE_INTEGER)
            - (rightRecentIndex ?? Number.MAX_SAFE_INTEGER);
        }
        return left.name.localeCompare(right.name);
      })
      .map((profile) => ({
        kind: 'profile' as const,
        profile,
        isRecent: recentOrder.has(profile.id),
      }));
  }, [profiles, query, recentIds]);

  const normalizedQuery = query.trim().toLocaleLowerCase();
  const commands = useMemo<SessionCommand[]>(() => {
    if (!onOpenLocal) return profileCommands;
    const localCommands: Extract<SessionCommand, { kind: 'local' }>[] = [{
      kind: 'local',
      label: t('terminal.newSession.localTerminal'),
      hint: t('terminal.newSession.localTerminalHint'),
    }];
    if (supportsShellSpanBash) {
      localCommands.push({
        kind: 'local',
        localProfile: 'shellSpanBash',
        label: t('terminal.newSession.shellSpanBash'),
        hint: t('terminal.newSession.shellSpanBashHint'),
      });
    }
    return [...localCommands.filter(({ label }) => label.toLocaleLowerCase().includes(normalizedQuery)), ...profileCommands];
  }, [normalizedQuery, onOpenLocal, profileCommands, supportsShellSpanBash, t]);
  const indexedCommands = useMemo<IndexedSessionCommand[]>(
    () => commands.map((command, index) => ({ command, index })),
    [commands],
  );
  const recentCommands = indexedCommands.filter(
    (entry) => entry.command.kind === 'profile' && entry.command.isRecent,
  );
  const savedCommands = indexedCommands.filter(
    (entry) => entry.command.kind === 'profile' && !entry.command.isRecent,
  );

  const activateOnce = useCallback((action: () => void): void => {
    if (activatingRef.current) return;
    activatingRef.current = true;
    action();
    onClose();
  }, [onClose]);

  const activateCommand = useCallback((command: SessionCommand): void => {
    activateOnce(() => {
      if (command.kind === 'local') {
        if (command.localProfile) void onOpenLocal?.(command.localProfile);
        else void onOpenLocal?.();
      } else {
        void onConnect(command.profile);
      }
    });
  }, [activateOnce, onConnect, onOpenLocal]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query, supportsShellSpanBash]);

  useEffect(() => {
    const selectedCommand = commandListRef.current?.querySelector<HTMLElement>(
      `[data-command-index="${selectedIndex}"]`,
    );
    selectedCommand?.scrollIntoView?.({ block: 'nearest' });
  }, [selectedIndex]);

  useEffect(() => {
    if (!open) return;
    activatingRef.current = false;
    setQuery('');
    setSelectedIndex(0);
  }, [open]);

  const handleSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (!open || commands.length === 0 || event.nativeEvent.isComposing) return;
    const isNext = event.key === 'ArrowDown'
      || (event.ctrlKey && event.key.toLocaleLowerCase() === 'n');
    const isPrevious = event.key === 'ArrowUp'
      || (event.ctrlKey && event.key.toLocaleLowerCase() === 'p');

    if (isNext) {
      event.preventDefault();
      setSelectedIndex((current) => (current + 1) % commands.length);
    } else if (isPrevious) {
      event.preventDefault();
      setSelectedIndex((current) => (current - 1 + commands.length) % commands.length);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const selectedCommand = commands[selectedIndex];
      if (selectedCommand) activateCommand(selectedCommand);
    }
  };

  const handleCreateConnection = (): void => {
    onClose();
    requestNewConnection();
  };

  const handleManageConnections = (): void => {
    onClose();
    setActiveWorkbenchTab('connections');
    setActiveSection('workbench');
  };

  const renderProfileCommand = ({ command, index }: IndexedSessionCommand): React.ReactNode => {
    if (command.kind !== 'profile') return null;
    const isSelected = index === selectedIndex;
    return (
      <li key={command.profile.id}>
        <Button
          id={`new-session-command-${index}`}
          type="button"
          aria-label={command.profile.name}
          variant={isSelected ? 'secondary' : 'ghost'}
          onClick={() => activateCommand(command)}
          onMouseEnter={() => setSelectedIndex(index)}
          data-command-index={index}
          className="h-auto w-full justify-start gap-1 rounded-lg p-3 text-left"
        >
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <ServerIcon data-icon="inline-start" />
          </span>
          <span className="flex min-w-0 flex-1 flex-col items-start gap-0.5">
            <span className="w-full truncate text-sm font-medium">{command.profile.name}</span>
            <span className="w-full truncate text-xs text-muted-foreground">
              {command.profile.username}@{command.profile.host}:{command.profile.port}
            </span>
          </span>
          {isSelected && <Kbd aria-hidden="true">↵</Kbd>}
        </Button>
      </li>
    );
  };

  const renderProfileGroup = (
    label: string,
    entries: IndexedSessionCommand[],
  ): React.ReactNode => {
    if (entries.length === 0) return null;
    return (
      <section className="flex flex-col gap-1" aria-label={label}>
        <h3 className="px-3 py-1.5 text-xs font-medium text-muted-foreground">{label}</h3>
        <ul className="flex flex-col gap-1">{entries.map(renderProfileCommand)}</ul>
      </section>
    );
  };

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => { if (!nextOpen) onClose(); }}>
      <DialogContent className="top-[12vh] flex h-[76vh] max-h-[76vh] w-[calc(100%-2rem)] max-w-2xl translate-y-0 flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="shrink-0 px-4 pb-3 pt-4 pr-12">
          <DialogTitle>{t('terminal.newSession.title')}</DialogTitle>
          <DialogDescription>{t('terminal.newSession.description')}</DialogDescription>
        </DialogHeader>

        <div className="shrink-0 px-4 pb-4">
          <InputGroup className="h-10 has-[[data-slot=input-group-control]:focus-visible]:ring-1">
            <InputGroupInput
              type="search"
              aria-label={t('terminal.newSession.searchPlaceholder')}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={handleSearchKeyDown}
              placeholder={t('terminal.newSession.searchPlaceholder')}
              autoFocus
            />
            <InputGroupAddon align="inline-start"><SearchIcon /></InputGroupAddon>
            <InputGroupAddon align="inline-end">
              <Kbd>{platform === 'macos' ? '⌘ K' : 'Ctrl K'}</Kbd>
            </InputGroupAddon>
          </InputGroup>
        </div>

        <Separator />
        <ScrollArea className="min-h-0 flex-1">
          <div id="new-session-command-list" ref={commandListRef} className="flex flex-col gap-2 px-4 py-3">
            {indexedCommands.map(({ command, index }) => command.kind === 'local' && (
              <Button
                key={command.localProfile ?? 'default'}
                id={`new-session-command-${index}`}
                type="button"
                aria-label={command.label}
                variant={selectedIndex === index ? 'secondary' : 'ghost'}
                onClick={() => activateCommand(command)}
                onMouseEnter={() => setSelectedIndex(index)}
                data-command-index={index}
                className="h-auto w-full justify-start gap-1 rounded-lg p-3 text-left"
              >
                <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <SquareTerminalIcon data-icon="inline-start" />
                </span>
                <span className="flex min-w-0 flex-1 flex-col items-start gap-0.5">
                  <span className="text-sm font-medium">{command.label}</span>
                  <span className="text-xs text-muted-foreground">
                    {command.hint}
                  </span>
                </span>
                {selectedIndex === index && <Kbd aria-hidden="true">↵</Kbd>}
              </Button>
            ))}

            {normalizedQuery
              ? renderProfileGroup(t('terminal.newSession.searchResults'), savedCommands.concat(recentCommands).sort((left, right) => left.index - right.index))
              : (
                <>
                  {renderProfileGroup(t('terminal.newSession.recentConnections'), recentCommands)}
                  {renderProfileGroup(t('terminal.newSession.savedConnections'), savedCommands)}
                </>
              )}

            {commands.length === 0 && (
              <div className="flex min-h-32 flex-col items-center justify-center gap-1 p-6 text-center">
                <p className="text-sm font-medium">{t('terminal.newSession.noSearchResults')}</p>
                <p className="text-xs text-muted-foreground">
                  {t('terminal.newSession.noSearchResultsHint')}
                </p>
              </div>
            )}
          </div>
        </ScrollArea>
        <Separator />

        <DialogFooter className="shrink-0 flex-row flex-wrap items-center justify-between gap-2 px-4 py-3 pt-3">
          <div className="flex items-center gap-1">
            <Button type="button" size="sm" onClick={handleCreateConnection}>
              <PlusIcon data-icon="inline-start" />
              {t('terminal.newSession.createConnection')}
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={handleManageConnections}>
              <LayoutGridIcon data-icon="inline-start" />
              {t('terminal.newSession.manageConnections')}
            </Button>
          </div>
          <div className="hidden items-center gap-2 text-xs text-muted-foreground sm:flex">
            <span className="flex items-center gap-1"><Kbd>↑</Kbd><Kbd>↓</Kbd>{t('terminal.newSession.navigate')}</span>
            <span className="flex items-center gap-1"><Kbd>↵</Kbd>{t('terminal.newSession.connect')}</span>
            <span className="flex items-center gap-1"><Kbd>Esc</Kbd>{t('terminal.newSession.close')}</span>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
