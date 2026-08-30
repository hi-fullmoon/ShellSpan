import React from 'react';
import {
  BotIcon,
  CableIcon,
  FolderIcon,
  FolderOpenIcon,
  FolderSyncIcon,
  InfoIcon,
  KeyboardIcon,
  LogsIcon,
  MonitorIcon,
  PaletteIcon,
  PanelBottomIcon,
  PanelRightIcon,
  SearchIcon,
  ServerIcon,
  Settings2Icon,
  SettingsIcon,
  SquareTerminalIcon,
  WrenchIcon,
  ZapIcon,
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
import { useToast } from '@/hooks/useToast';
import {
  insertHostCommandSnippet,
  openHostPath,
  runHostConnectionAction,
} from '@/lib/host-quick-actions';
import { invokeListSftpBookmarks } from '@/lib/tauri';
import type { LocaleKey } from '@/locales';
import { cn } from '@/lib/utils';
import { useAppStore } from '@/stores/appStore';
import { isPortForwardActive, usePortForwardStore } from '@/stores/portForwardStore';
import { useProfileStore } from '@/stores/profileStore';
import { useSftpStore, type SftpConnection } from '@/stores/sftpStore';
import { useTerminalStore } from '@/stores/terminalStore';
import type { TerminalSession } from '@/stores/terminalStore';
import type {
  AppSection,
  ConnectionProfile,
  HostQuickAction,
  PortForwardRuntime,
  SettingsSection,
  SftpBookmarkRow,
  WorkbenchTab,
} from '@/types';

type PaletteGroup =
  | 'navigation'
  | 'connection'
  | 'session'
  | 'bookmark'
  | 'quickAction'
  | 'forward'
  | 'settings';

export interface CommandPaletteItem {
  id: string;
  group: PaletteGroup;
  label: string;
  detail?: string;
  keywords: string;
  icon: React.ElementType;
  disabled?: boolean;
  disabledReason?: string;
  run: () => void | Promise<void>;
}

export interface ProfileBookmark {
  profileId: string;
  bookmark: SftpBookmarkRow;
}

interface BuildCommandPaletteItemsOptions {
  profiles: ConnectionProfile[];
  terminalSessions: TerminalSession[];
  activeTerminalSessionId: string | null;
  sftpConnections: SftpConnection[];
  bookmarks: ProfileBookmark[];
  portForwardRuntimes: PortForwardRuntime[];
  label: (key: LocaleKey, values?: Record<string, string | number>) => string;
  navigate: (section: AppSection, tab?: WorkbenchTab) => void;
  openSettings: (section: SettingsSection) => void;
  connect: (profileId: string, target: 'terminal' | 'sftp') => void;
  openHostTool: (profileId: string, tool: 'overview' | 'portForward' | 'quickActions') => void;
  switchTerminal: (sessionId: string) => void;
  switchSftp: (connectionId: string) => void;
  openBookmark: (profile: ConnectionProfile, bookmark: SftpBookmarkRow) => void;
  runQuickAction: (profile: ConnectionProfile, action: HostQuickAction) => void | Promise<void>;
  splitTerminal: (direction: 'right' | 'bottom') => void;
  startForward: (profile: ConnectionProfile, ruleId: string) => void | Promise<void>;
}

const SETTINGS: Array<{ id: SettingsSection; icon: React.ElementType }> = [
  { id: 'general', icon: Settings2Icon },
  { id: 'appearance', icon: PaletteIcon },
  { id: 'terminal', icon: SquareTerminalIcon },
  { id: 'sftp', icon: FolderSyncIcon },
  { id: 'ai', icon: BotIcon },
  { id: 'shortcuts', icon: KeyboardIcon },
];

export async function loadCommandPaletteBookmarks(
  profiles: ConnectionProfile[],
): Promise<ProfileBookmark[]> {
  const endpointProfiles = new Map<string, ConnectionProfile[]>();
  for (const profile of profiles) {
    const endpoint = `${profile.username}\u0000${profile.host}\u0000${profile.port}`;
    endpointProfiles.set(endpoint, [...(endpointProfiles.get(endpoint) ?? []), profile]);
  }
  const rows = await Promise.all([...endpointProfiles.values()].map(async (endpointGroup) => {
    const profile = endpointGroup[0];
    if (!profile) return [];
    try {
      const bookmarks = await invokeListSftpBookmarks(
        profile.host,
        profile.port,
        profile.username,
      );
      return endpointGroup.flatMap((candidate) => (
        bookmarks.map((bookmark) => ({ profileId: candidate.id, bookmark }))
      ));
    } catch {
      return [];
    }
  }));
  return rows.flat();
}

export function buildCommandPaletteItems({
  profiles,
  terminalSessions,
  activeTerminalSessionId,
  sftpConnections,
  bookmarks,
  portForwardRuntimes,
  label,
  navigate,
  openSettings,
  connect,
  openHostTool,
  switchTerminal,
  switchSftp,
  openBookmark,
  runQuickAction,
  splitTerminal,
  startForward,
}: BuildCommandPaletteItemsOptions): CommandPaletteItem[] {
  const navigation: CommandPaletteItem[] = [
    ['workbench', 'workbench', undefined, WrenchIcon],
    ['terminal', 'terminal', undefined, SquareTerminalIcon],
    ['sftp', 'sftp', undefined, FolderSyncIcon],
    ['logs', 'workbench', 'logs', LogsIcon],
    ['monitor', 'workbench', 'monitor', MonitorIcon],
  ].map(([id, section, tab, icon]) => ({
    id: `navigation-${String(id)}`,
    group: 'navigation' as const,
    label: label(`commandPalette.action.${String(id)}` as LocaleKey),
    keywords: `${String(id)} ${String(section)} ${String(tab ?? '')}`,
    icon: icon as React.ElementType,
    run: () => navigate(section as AppSection, tab as WorkbenchTab | undefined),
  }));

  navigation.push({
    id: 'navigation-settings',
    group: 'navigation',
    label: label('commandPalette.action.settings'),
    keywords: 'settings preferences',
    icon: SettingsIcon,
    run: () => openSettings('general'),
  });

  const canSplit = terminalSessions.length >= 2
    && terminalSessions.some((session) => session.sessionId === activeTerminalSessionId);
  navigation.push(
    {
      id: 'terminal-split-right',
      group: 'navigation',
      label: label('commandPalette.action.splitRight'),
      keywords: 'terminal split pane right vertical',
      icon: PanelRightIcon,
      disabled: !canSplit,
      disabledReason: !canSplit ? label('commandPalette.disabled.split') : undefined,
      run: () => splitTerminal('right'),
    },
    {
      id: 'terminal-split-bottom',
      group: 'navigation',
      label: label('commandPalette.action.splitBottom'),
      keywords: 'terminal split pane bottom horizontal down',
      icon: PanelBottomIcon,
      disabled: !canSplit,
      disabledReason: !canSplit ? label('commandPalette.disabled.split') : undefined,
      run: () => splitTerminal('bottom'),
    },
  );

  const connections = profiles.flatMap((profile): CommandPaletteItem[] => [
    {
      id: `profile-terminal-${profile.id}`,
      group: 'connection',
      label: `${label('commandPalette.action.connectTerminal')}: ${profile.name}`,
      detail: `${profile.username}@${profile.host}:${profile.port}`,
      keywords: `${profile.name} ${profile.host} ${profile.username} ssh terminal`,
      icon: SquareTerminalIcon,
      run: () => connect(profile.id, 'terminal'),
    },
    {
      id: `profile-sftp-${profile.id}`,
      group: 'connection',
      label: `${label('commandPalette.action.connectSftp')}: ${profile.name}`,
      detail: `${profile.username}@${profile.host}:${profile.port}`,
      keywords: `${profile.name} ${profile.host} ${profile.username} sftp files`,
      icon: ServerIcon,
      run: () => connect(profile.id, 'sftp'),
    },
    {
      id: `profile-overview-${profile.id}`,
      group: 'connection',
      label: `${label('commandPalette.action.hostOverview')}: ${profile.name}`,
      detail: `${profile.username}@${profile.host}:${profile.port}`,
      keywords: `${profile.name} ${profile.host} overview health diagnostic`,
      icon: InfoIcon,
      run: () => openHostTool(profile.id, 'overview'),
    },
    {
      id: `profile-port-forward-${profile.id}`,
      group: 'connection',
      label: `${label('commandPalette.action.manageForwards')}: ${profile.name}`,
      detail: `${profile.username}@${profile.host}:${profile.port}`,
      keywords: `${profile.name} ${profile.host} port forward tunnel`,
      icon: CableIcon,
      run: () => openHostTool(profile.id, 'portForward'),
    },
    {
      id: `profile-quick-actions-${profile.id}`,
      group: 'connection',
      label: `${label('commandPalette.action.manageQuickActions')}: ${profile.name}`,
      detail: `${profile.username}@${profile.host}:${profile.port}`,
      keywords: `${profile.name} ${profile.host} pinned quick actions shortcuts snippets`,
      icon: ZapIcon,
      run: () => openHostTool(profile.id, 'quickActions'),
    },
  ]);

  const openTerminalSessions = terminalSessions.map((session): CommandPaletteItem => ({
    id: `terminal-session-${session.sessionId}`,
    group: 'session',
    label: `${label('commandPalette.action.switchTerminal')}: ${session.title}`,
    detail: `${session.username}@${session.host}${session.port ? `:${session.port}` : ''}`,
    keywords: `${session.title} ${session.host} ${session.username} terminal session ${session.status}`,
    icon: SquareTerminalIcon,
    run: () => switchTerminal(session.sessionId),
  }));

  const openSftpSessions = sftpConnections.map((connection): CommandPaletteItem => ({
    id: `sftp-session-${connection.id}`,
    group: 'session',
    label: `${label('commandPalette.action.switchSftp')}: ${connection.title}`,
    detail: connection.localOnly
      ? label('commandPalette.detail.localFiles')
      : `${connection.connection.username}@${connection.connection.host}:${connection.connection.port}`,
    keywords: `${connection.title} ${connection.connection.host} ${connection.connection.username} ${connection.leftTitle ?? ''} ${connection.leftConnection?.host ?? ''} ${connection.leftConnection?.username ?? ''} sftp files session`,
    icon: FolderSyncIcon,
    run: () => switchSftp(connection.id),
  }));

  const bookmarkItems = bookmarks.flatMap(({ profileId, bookmark }): CommandPaletteItem[] => {
    const profile = profiles.find((candidate) => candidate.id === profileId);
    if (!profile) return [];
    return [{
      id: `bookmark-${profileId}-${bookmark.id}`,
      group: 'bookmark',
      label: `${label('commandPalette.action.openBookmark')}: ${bookmark.label || bookmark.path}`,
      detail: `${profile.name} · ${bookmark.path}`,
      keywords: `${profile.name} ${profile.host} ${bookmark.path} ${bookmark.label ?? ''} bookmark directory path sftp`,
      icon: FolderOpenIcon,
      run: () => openBookmark(profile, bookmark),
    }];
  });

  const quickActions = profiles.flatMap((profile) => (
    (profile.quickActions ?? []).map((action): CommandPaletteItem => {
      const connectedTarget = terminalSessions.some((session) => (
        session.profileId === profile.id && session.status === 'connected'
      ));
      const commandDisabled = action.kind === 'command' && !connectedTarget;
      const detail = action.kind === 'directory'
        ? `${profile.name} · ${action.path}`
        : action.kind === 'command'
          ? `${profile.name} · ${action.command}`
          : `${profile.name} · ${label(`hostQuickActions.connection.${action.action}`)}`;
      return {
        id: `quick-action-${profile.id}-${action.id}`,
        group: 'quickAction',
        label: action.label,
        detail,
        keywords: `${profile.name} ${profile.host} ${action.kind} ${detail}`,
        icon: action.kind === 'directory'
          ? FolderIcon
          : action.kind === 'command'
            ? SquareTerminalIcon
            : ZapIcon,
        disabled: commandDisabled,
        disabledReason: commandDisabled ? label('hostQuickActions.noTerminal') : undefined,
        run: () => runQuickAction(profile, action),
      };
    })
  ));

  const forwards = profiles.flatMap((profile) => (
    (profile.portForwards ?? []).map((rule): CommandPaletteItem => {
      const active = portForwardRuntimes.some((runtime) => (
        runtime.profileId === profile.id
        && runtime.configId === rule.id
        && isPortForwardActive(runtime)
      ));
      return {
        id: `forward-${profile.id}-${rule.id}`,
        group: 'forward',
        label: `${label('commandPalette.action.startForward')}: ${rule.name}`,
        detail: `${profile.name} · ${rule.kind === 'local' ? rule.localPort : rule.remotePort} → ${rule.remoteHost}:${rule.remotePort}`,
        keywords: `${profile.name} ${profile.host} ${rule.name} ${rule.kind} port forward tunnel`,
        icon: CableIcon,
        disabled: active,
        disabledReason: active ? label('commandPalette.disabled.forwardActive') : undefined,
        run: () => startForward(profile, rule.id),
      };
    })
  ));

  const settings = SETTINGS.map(({ id, icon }): CommandPaletteItem => ({
    id: `settings-${id}`,
    group: 'settings',
    label: label(`settings.${id}.title` as LocaleKey),
    detail: label('commandPalette.detail.settings'),
    keywords: `${id} settings preferences configuration ${label(`settings.${id}.title` as LocaleKey)}`,
    icon,
    run: () => openSettings(id),
  }));

  return [
    ...navigation,
    ...connections,
    ...openTerminalSessions,
    ...openSftpSessions,
    ...bookmarkItems,
    ...quickActions,
    ...forwards,
    ...settings,
  ];
}

function matchesQuery(item: CommandPaletteItem, query: string): boolean {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const haystack = `${item.label} ${item.detail ?? ''} ${item.keywords}`.toLocaleLowerCase();
  return terms.every((term) => haystack.includes(term));
}

export function findEnabledItemIndex(
  items: CommandPaletteItem[],
  currentIndex: number,
  direction: 1 | -1,
): number {
  if (items.length === 0 || items.every((item) => item.disabled)) return 0;
  for (let offset = 1; offset <= items.length; offset += 1) {
    const index = (currentIndex + direction * offset + items.length) % items.length;
    if (!items[index]?.disabled) return index;
  }
  return 0;
}

export const CommandPalette: React.FC = () => {
  const { t } = useI18n();
  const { error: showError, info } = useToast();
  const profiles = useProfileStore((state) => state.profiles);
  const terminalSessions = useTerminalStore((state) => state.sessions);
  const activeTerminalSessionId = useTerminalStore((state) => state.activeSessionId);
  const sftpConnections = useSftpStore((state) => state.connections);
  const portForwardRuntimes = usePortForwardStore((state) => state.runtimes);
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const [activeIndex, setActiveIndex] = React.useState(0);
  const [bookmarks, setBookmarks] = React.useState<ProfileBookmark[]>([]);

  React.useEffect(() => {
    const handleOpen = (): void => setOpen(true);
    document.addEventListener('termbridge:open-command-palette', handleOpen);
    return () => document.removeEventListener('termbridge:open-command-palette', handleOpen);
  }, []);

  React.useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void loadCommandPaletteBookmarks(profiles).then((loaded) => {
      if (!cancelled) setBookmarks(loaded);
    });
    return () => { cancelled = true; };
  }, [open, profiles]);

  const items = React.useMemo(
    () => buildCommandPaletteItems({
      profiles,
      terminalSessions,
      activeTerminalSessionId,
      sftpConnections,
      bookmarks,
      portForwardRuntimes,
      label: t,
      navigate: (section, tab) => {
        const app = useAppStore.getState();
        app.setActiveSection(section);
        if (tab) app.setActiveWorkbenchTab(tab);
      },
      openSettings: (section) => {
        useAppStore.getState().openSettings(section);
      },
      connect: (profileId, target) => {
        document.dispatchEvent(new CustomEvent('termbridge:connect-profile', {
          detail: { profileId, target },
        }));
      },
      openHostTool: (profileId, tool) => {
        const app = useAppStore.getState();
        app.setActiveSection('workbench');
        app.setActiveWorkbenchTab('connections');
        document.dispatchEvent(new CustomEvent('termbridge:open-host-tool', {
          detail: { profileId, tool },
        }));
      },
      switchTerminal: (sessionId) => {
        useTerminalStore.getState().setActiveSession(sessionId);
        useAppStore.getState().setActiveSection('terminal');
      },
      switchSftp: (connectionId) => {
        useSftpStore.getState().setActiveConnection(connectionId);
        useAppStore.getState().setActiveSection('sftp');
      },
      openBookmark: (profile, bookmark) => {
        openHostPath(profile, bookmark.path, 'sftp', bookmark.side);
      },
      runQuickAction: async (profile, action) => {
        if (action.kind === 'directory') {
          openHostPath(profile, action.path, action.target);
        } else if (action.kind === 'connection') {
          runHostConnectionAction(profile.id, action.action);
        } else {
          try {
            const result = await insertHostCommandSnippet(profile.id, action.command);
            if (result === 'inserted') info(t('hostQuickActions.inserted'));
            else showError(t('hostQuickActions.noTerminal'));
          } catch {
            showError(t('hostQuickActions.insertFailed'));
          }
        }
      },
      splitTerminal: (direction) => {
        useAppStore.getState().setActiveSection('terminal');
        document.dispatchEvent(new CustomEvent('termbridge:split-terminal-pane', {
          detail: { direction },
        }));
      },
      startForward: async (profile, ruleId) => {
        const rule = profile.portForwards?.find((candidate) => candidate.id === ruleId);
        if (rule) await usePortForwardStore.getState().startRule(profile, rule, 'manual');
      },
    }),
    [
      bookmarks,
      info,
      portForwardRuntimes,
      profiles,
      sftpConnections,
      showError,
      t,
      terminalSessions,
      activeTerminalSessionId,
    ],
  );
  const filteredItems = React.useMemo(
    () => items.filter((item) => matchesQuery(item, query)),
    [items, query],
  );

  React.useEffect(() => {
    const firstEnabled = filteredItems.findIndex((item) => !item.disabled);
    setActiveIndex(firstEnabled >= 0 ? firstEnabled : 0);
  }, [filteredItems, open, query]);

  const runItem = React.useCallback((item: CommandPaletteItem | undefined): void => {
    if (!item || item.disabled) return;
    setOpen(false);
    setQuery('');
    void Promise.resolve()
      .then(() => item.run())
      .catch(() => showError(t('commandPalette.actionFailed')));
  }, [showError, t]);

  const groups: PaletteGroup[] = [
    'navigation',
    'connection',
    'session',
    'bookmark',
    'quickAction',
    'forward',
    'settings',
  ];

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => {
      setOpen(nextOpen);
      if (!nextOpen) setQuery('');
    }}>
      <DialogContent className="top-[18%] max-w-2xl translate-y-0 gap-3 p-4" showCloseButton={false}>
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
                setActiveIndex((index) => findEnabledItemIndex(filteredItems, index, 1));
              } else if (event.key === 'ArrowUp') {
                event.preventDefault();
                setActiveIndex((index) => findEnabledItemIndex(filteredItems, index, -1));
              } else if (event.key === 'Enter') {
                event.preventDefault();
                runItem(filteredItems[activeIndex]);
              }
            }}
          />
        </InputGroup>

        <div className="max-h-[min(32rem,65vh)] overflow-y-auto">
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
                  const Icon = item.icon;
                  return (
                    <Button
                      key={item.id}
                      variant="ghost"
                      className={cn(
                        'h-auto w-full justify-start gap-3 px-2 py-2 text-left',
                        itemIndex === activeIndex && 'bg-accent text-accent-foreground',
                      )}
                      disabled={item.disabled}
                      title={item.disabledReason}
                      onMouseMove={() => {
                        if (!item.disabled) setActiveIndex(itemIndex);
                      }}
                      onClick={() => runItem(item)}
                    >
                      <Icon data-icon="inline-start" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm">{item.label}</span>
                        {(item.disabledReason || item.detail) && (
                          <span className="block truncate text-xs text-muted-foreground">
                            {item.disabledReason ?? item.detail}
                          </span>
                        )}
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
