import React, {
  useEffect,
  useMemo,
  useState,
} from 'react';
import {
  PinIcon,
  SearchIcon,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group';
import { Kbd } from '@/components/ui/kbd';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { useI18n } from '@/hooks/useI18n';
import { usePlatform } from '@/hooks/usePlatform';
import { getShortcutKeys } from '@/lib/shortcuts';
import { cn } from '@/lib/utils';
import { DEFAULT_SHORTCUTS, useAppStore } from '@/stores/appStore';
import type { TerminalSession } from '@/stores/terminalStore';
import type { SessionStatus } from '@/types';

export interface TerminalTabSwitcherProps {
  sessions: TerminalSession[];
  activeSessionId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (sessionId: string) => void;
}

const statusDotClass = (status: SessionStatus): string => {
  switch (status) {
    case 'connected':
      return 'bg-app-success';
    case 'connecting':
      return 'bg-app-warning';
    case 'error':
      return 'bg-app-error';
    case 'disconnected':
    default:
      return 'bg-app-text-soft';
  }
};

function matchesSession(session: TerminalSession, query: string): boolean {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const haystack = [
    session.title,
    session.host,
    session.username,
    String(session.port),
    session.status,
  ].join(' ').toLocaleLowerCase();
  return terms.every((term) => haystack.includes(term));
}

export const TerminalTabSwitcher: React.FC<TerminalTabSwitcherProps> = ({
  sessions,
  activeSessionId,
  open,
  onOpenChange,
  onSelect,
}) => {
  const { t } = useI18n();
  const platform = usePlatform();
  const shortcut = useAppStore((state) => (
    state.shortcuts.switchTerminalTab ?? DEFAULT_SHORTCUTS.switchTerminalTab
  ));
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const filteredSessions = useMemo(
    () => sessions.filter((session) => matchesSession(session, query)),
    [query, sessions],
  );
  const shortcutLabel = getShortcutKeys(shortcut, platform).join(' ');
  const selectedSession = filteredSessions[activeIndex];

  useEffect(() => {
    if (!open) return;
    const currentIndex = filteredSessions.findIndex(
      (session) => session.sessionId === activeSessionId,
    );
    setActiveIndex(currentIndex >= 0 ? currentIndex : 0);
  }, [activeSessionId, filteredSessions, open, query]);

  const moveSelection = (direction: 1 | -1): void => {
    if (filteredSessions.length === 0) return;
    setActiveIndex((index) => (
      (index + direction + filteredSessions.length) % filteredSessions.length
    ));
  };

  const selectSession = (session: TerminalSession | undefined): void => {
    if (!session) return;
    onOpenChange(false);
    onSelect(session.sessionId);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        onOpenChange(nextOpen);
        if (!nextOpen) setQuery('');
      }}
    >
      <DialogContent
        data-testid="terminal-tab-switcher"
        className="top-[12vh] flex max-h-[76vh] w-[calc(100%-2rem)] max-w-xl translate-y-0 flex-col gap-0 overflow-hidden p-0"
      >
        <DialogHeader className="px-4 pb-2 pt-4 pr-11">
          <DialogTitle>{t('terminal.tabSwitcher.title')}</DialogTitle>
          <DialogDescription>{t('terminal.tabSwitcher.description')}</DialogDescription>
        </DialogHeader>

        <div className="px-4 pb-3">
          <InputGroup className="h-9 has-[[data-slot=input-group-control]:focus-visible]:ring-1">
            <InputGroupInput
              autoFocus
              type="search"
              aria-label={t('terminal.tabSwitcher.searchPlaceholder')}
              placeholder={t('terminal.tabSwitcher.searchPlaceholder')}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                const key = event.key.toLocaleLowerCase();
                const isNext = event.key === 'ArrowDown'
                  || (event.key === 'Tab' && !event.shiftKey)
                  || (event.ctrlKey && key === 'n');
                const isPrevious = event.key === 'ArrowUp'
                  || (event.key === 'Tab' && event.shiftKey)
                  || (event.ctrlKey && key === 'p');

                if (isNext) {
                  event.preventDefault();
                  moveSelection(1);
                } else if (isPrevious) {
                  event.preventDefault();
                  moveSelection(-1);
                } else if (event.key === 'Home') {
                  event.preventDefault();
                  setActiveIndex(0);
                } else if (event.key === 'End') {
                  event.preventDefault();
                  setActiveIndex(Math.max(0, filteredSessions.length - 1));
                } else if (event.key === 'Enter') {
                  event.preventDefault();
                  selectSession(selectedSession);
                }
              }}
            />
            <InputGroupAddon align="inline-start"><SearchIcon /></InputGroupAddon>
            <InputGroupAddon align="inline-end">
              <Kbd aria-label={t('terminal.tabSwitcher.shortcut')}>{shortcutLabel}</Kbd>
            </InputGroupAddon>
          </InputGroup>
        </div>

        <Separator />

        <ScrollArea
          aria-label={t('terminal.tabSwitcher.sessions')}
          className="min-h-32 flex-1"
        >
          {filteredSessions.length === 0 ? (
            <div className="flex min-h-32 flex-col items-center justify-center gap-1 p-6 text-center">
              <p className="text-sm font-medium">{t('terminal.tabSwitcher.noResults')}</p>
              <p className="text-xs text-muted-foreground">
                {t('terminal.tabSwitcher.noResultsHint')}
              </p>
            </div>
          ) : (
            <div role="listbox" className="flex flex-col gap-1 px-4 py-3">
              {filteredSessions.map((session, index) => {
                const selected = index === activeIndex;
                const current = session.sessionId === activeSessionId;
                return (
                  <Button
                    key={session.sessionId}
                    role="option"
                    aria-selected={selected}
                    variant={selected ? 'secondary' : 'ghost'}
                    className="h-auto w-full justify-start gap-2.5 rounded-lg px-3 py-2.5 text-left"
                    onMouseEnter={() => setActiveIndex(index)}
                    onFocus={() => setActiveIndex(index)}
                    onClick={() => selectSession(session)}
                  >
                    <span
                      aria-hidden="true"
                      className={cn('size-2 shrink-0 rounded-full', statusDotClass(session.status))}
                    />
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="flex min-w-0 items-center gap-1.5">
                        <span className="truncate text-sm font-medium">{session.title}</span>
                        {current && (
                          <Badge variant="outline" size="sm">
                            {t('terminal.tabSwitcher.current')}
                          </Badge>
                        )}
                        {session.pinned && !current && (
                          <PinIcon className="size-3 shrink-0 text-muted-foreground" aria-label={t('terminal.tab.pin')} />
                        )}
                      </span>
                      <span className="truncate text-xs font-normal text-muted-foreground">
                        {session.username}@{session.host}:{session.port}
                      </span>
                    </span>
                    {selected && <Kbd aria-hidden="true">↵</Kbd>}
                  </Button>
                );
              })}
            </div>
          )}
        </ScrollArea>

        <Separator />

        <DialogFooter className="flex-row flex-wrap items-center justify-between gap-2 px-4 py-2.5 pt-2.5">
          <span className="text-xs text-muted-foreground">
            {t('terminal.tabSwitcher.count', { count: filteredSessions.length })}
          </span>
          <div className="hidden items-center gap-2 text-xs text-muted-foreground sm:flex">
            <span className="flex items-center gap-1">
              <Kbd>↑</Kbd><Kbd>↓</Kbd>
              {t('terminal.tabSwitcher.navigate')}
            </span>
            <span className="flex items-center gap-1">
              <Kbd>↵</Kbd>
              {t('terminal.tabSwitcher.switch')}
            </span>
            <span className="flex items-center gap-1">
              <Kbd>Esc</Kbd>
              {t('terminal.tabSwitcher.close')}
            </span>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
