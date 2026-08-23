import React from 'react';
import {
  FolderSyncIcon,
  LogsIcon,
  MonitorIcon,
  SearchIcon,
  ServerIcon,
  SettingsIcon,
  SquareTerminalIcon,
  WrenchIcon,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group';
import { useI18n } from '@/hooks/useI18n';
import type { LocaleKey } from '@/locales';
import { cn } from '@/lib/utils';
import { useAppStore } from '@/stores/appStore';
import { useProfileStore } from '@/stores/profileStore';
import { useTerminalStore } from '@/stores/terminalStore';
import type { TerminalSession } from '@/stores/terminalStore';
import type { AppSection, ConnectionProfile, WorkbenchTab } from '@/types';

type PaletteGroup = 'navigation' | 'connection' | 'session';

export interface CommandPaletteItem {
  id: string;
  group: PaletteGroup;
  label: string;
  detail?: string;
  keywords: string;
  icon: React.ReactNode;
  run: () => void;
}

interface BuildCommandPaletteItemsOptions {
  profiles: ConnectionProfile[];
  sessions: TerminalSession[];
  label: (key: LocaleKey) => string;
  navigate: (section: AppSection, tab?: WorkbenchTab) => void;
  connect: (profileId: string, target: 'terminal' | 'sftp') => void;
  switchTerminal: (sessionId: string) => void;
}

export function buildCommandPaletteItems({
  profiles,
  sessions,
  label,
  navigate,
  connect,
  switchTerminal,
}: BuildCommandPaletteItemsOptions): CommandPaletteItem[] {
  const navigation: CommandPaletteItem[] = [
    ['workbench', 'workbench', undefined, WrenchIcon],
    ['terminal', 'terminal', undefined, SquareTerminalIcon],
    ['sftp', 'sftp', undefined, FolderSyncIcon],
    ['settings', 'workbench', 'settings', SettingsIcon],
    ['logs', 'workbench', 'logs', LogsIcon],
    ['monitor', 'workbench', 'monitor', MonitorIcon],
  ].map(([id, section, tab, Icon]) => ({
    id: `navigation-${String(id)}`,
    group: 'navigation' as const,
    label: label(`commandPalette.action.${String(id)}` as LocaleKey),
    keywords: `${String(id)} ${String(section)} ${String(tab ?? '')}`,
    icon: React.createElement(Icon as React.ComponentType<{ className?: string }>, { className: 'size-4' }),
    run: () => navigate(section as AppSection, tab as WorkbenchTab | undefined),
  }));

  const connections = profiles.flatMap((profile): CommandPaletteItem[] => [
    {
      id: `profile-terminal-${profile.id}`,
      group: 'connection',
      label: `${label('commandPalette.action.connectTerminal')}: ${profile.name}`,
      detail: `${profile.username}@${profile.host}:${profile.port}`,
      keywords: `${profile.name} ${profile.host} ${profile.username} ssh terminal`,
      icon: <SquareTerminalIcon className="size-4" />,
      run: () => connect(profile.id, 'terminal'),
    },
    {
      id: `profile-sftp-${profile.id}`,
      group: 'connection',
      label: `${label('commandPalette.action.connectSftp')}: ${profile.name}`,
      detail: `${profile.username}@${profile.host}:${profile.port}`,
      keywords: `${profile.name} ${profile.host} ${profile.username} sftp files`,
      icon: <ServerIcon className="size-4" />,
      run: () => connect(profile.id, 'sftp'),
    },
  ]);

  const openSessions = sessions.map((session): CommandPaletteItem => ({
    id: `session-${session.sessionId}`,
    group: 'session',
    label: `${label('commandPalette.action.switchTerminal')}: ${session.title}`,
    detail: `${session.username}@${session.host}${session.port ? `:${session.port}` : ''}`,
    keywords: `${session.title} ${session.host} ${session.username} terminal session`,
    icon: <SquareTerminalIcon className="size-4" />,
    run: () => switchTerminal(session.sessionId),
  }));

  return [...navigation, ...connections, ...openSessions];
}

function matchesQuery(item: CommandPaletteItem, query: string): boolean {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const haystack = `${item.label} ${item.detail ?? ''} ${item.keywords}`.toLocaleLowerCase();
  return terms.every((term) => haystack.includes(term));
}

export const CommandPalette: React.FC = () => {
  const { t } = useI18n();
  const profiles = useProfileStore((state) => state.profiles);
  const sessions = useTerminalStore((state) => state.sessions);
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const [activeIndex, setActiveIndex] = React.useState(0);

  React.useEffect(() => {
    const handleOpen = (): void => setOpen(true);
    document.addEventListener('termbridge:open-command-palette', handleOpen);
    return () => document.removeEventListener('termbridge:open-command-palette', handleOpen);
  }, []);

  const items = React.useMemo(
    () => buildCommandPaletteItems({
      profiles,
      sessions,
      label: t,
      navigate: (section, tab) => {
        const app = useAppStore.getState();
        app.setActiveSection(section);
        if (tab) app.setActiveWorkbenchTab(tab);
      },
      connect: (profileId, target) => {
        document.dispatchEvent(new CustomEvent('termbridge:connect-profile', {
          detail: { profileId, target },
        }));
      },
      switchTerminal: (sessionId) => {
        useTerminalStore.getState().setActiveSession(sessionId);
        useAppStore.getState().setActiveSection('terminal');
      },
    }),
    [profiles, sessions, t],
  );
  const filteredItems = React.useMemo(
    () => items.filter((item) => matchesQuery(item, query)),
    [items, query],
  );

  React.useEffect(() => setActiveIndex(0), [query, open]);

  const runItem = React.useCallback((item: CommandPaletteItem | undefined): void => {
    if (!item) return;
    item.run();
    setOpen(false);
    setQuery('');
  }, []);

  const groups: PaletteGroup[] = ['navigation', 'connection', 'session'];

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => {
      setOpen(nextOpen);
      if (!nextOpen) setQuery('');
    }}>
      <DialogContent className="top-[18%] max-w-xl translate-y-0 gap-3 p-3" showCloseButton={false}>
        <DialogHeader className="sr-only">
          <DialogTitle>{t('commandPalette.title')}</DialogTitle>
          <DialogDescription>{t('commandPalette.description')}</DialogDescription>
        </DialogHeader>
        <InputGroup>
          <InputGroupAddon><SearchIcon /></InputGroupAddon>
          <InputGroupInput
            autoFocus
            aria-label={t('commandPalette.title')}
            placeholder={t('commandPalette.placeholder')}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault();
                setActiveIndex((index) => filteredItems.length === 0 ? 0 : (index + 1) % filteredItems.length);
              } else if (event.key === 'ArrowUp') {
                event.preventDefault();
                setActiveIndex((index) => filteredItems.length === 0 ? 0 : (index - 1 + filteredItems.length) % filteredItems.length);
              } else if (event.key === 'Enter') {
                event.preventDefault();
                runItem(filteredItems[activeIndex]);
              }
            }}
          />
        </InputGroup>

        <div className="max-h-[min(28rem,60vh)] overflow-y-auto">
          {filteredItems.length === 0 ? (
            <EmptyState className="min-h-36" title={t('commandPalette.noResults')} icon={<SearchIcon className="size-5" />} />
          ) : groups.map((group) => {
            const groupItems = filteredItems.filter((item) => item.group === group);
            if (groupItems.length === 0) return null;
            return (
              <section key={group} aria-label={t(`commandPalette.group.${group}`)} className="mb-2 last:mb-0">
                <div className="px-2 py-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  {t(`commandPalette.group.${group}`)}
                </div>
                {groupItems.map((item) => {
                  const itemIndex = filteredItems.indexOf(item);
                  return (
                    <Button
                      key={item.id}
                      variant="ghost"
                      className={cn(
                        'h-auto w-full justify-start gap-3 px-2 py-2 text-left',
                        itemIndex === activeIndex && 'bg-accent text-accent-foreground',
                      )}
                      onMouseMove={() => setActiveIndex(itemIndex)}
                      onClick={() => runItem(item)}
                    >
                      {item.icon}
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm">{item.label}</span>
                        {item.detail && <span className="block truncate text-xs text-muted-foreground">{item.detail}</span>}
                      </span>
                    </Button>
                  );
                })}
              </section>
            );
          })}
        </div>
      </DialogContent>
    </Dialog>
  );
};
