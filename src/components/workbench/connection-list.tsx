import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '@/hooks/useI18n';
import { useDebouncedCallback } from '@/hooks/useDebouncedCallback';
import { Button } from '@/components/ui/button';
import { PanelEmptyState, PanelLoadingState } from '@/components/ui/empty-state';
import { ResponsiveCardGrid } from '@/components/ui/responsive-card-grid';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Badge } from '@/components/ui/badge';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { IconActionButton } from './icon-action-button';
import { ManagementCard, ManagementCardIcon } from './management-card';
import { HostOverviewDialog } from './host-overview-dialog';
import { PortForwardDialog } from './port-forward-dialog';
import { HostQuickActionsDialog } from './host-quick-actions-dialog';
import type { ConnectionProfile } from '@/types';
import { useRecentProfilesStore } from '@/stores/recentProfilesStore';
import {
  CopyIcon,
  EllipsisIcon,
  FolderIcon,
  MonitorIcon,
  PencilIcon,
  SearchXIcon,
  ServerIcon,
  Trash2Icon,
  StarIcon,
  TerminalIcon,
  InfoIcon,
  CableIcon,
  DownloadIcon,
  HeartPulseIcon,
  HistoryIcon,
  ListIcon,
  PlusIcon,
  UploadIcon,
  ZapIcon,
} from 'lucide-react';
import { WorkbenchPage, WorkbenchPageContent, WorkbenchPageHeader, WorkbenchSearchInput, WorkbenchPageToolbar } from './workbench-page';

const CARD_ACTION_DEBOUNCE_MS = 500;
const CONNECTION_CARD_BREAKPOINTS = [
  { minWidth: 640, columns: 2 },
  { minWidth: 900, columns: 3 },
] as const;
const CONNECTION_MENU_ITEM_CLASS =
  'gap-2 px-2.5 py-1.5 text-xs text-app-text focus:bg-app-primary/10 focus:text-app-primary [&_svg]:text-muted-foreground focus:[&_svg]:text-app-primary';
const CONNECTION_MENU_DESTRUCTIVE_ITEM_CLASS = 'gap-2 px-2.5 py-1.5 text-xs';

export interface ConnectionListProps {
  profiles: ConnectionProfile[];
  initialized: boolean;
  onAdd: () => void;
  onEdit: (profile: ConnectionProfile) => void;
  onDelete: (profile: ConnectionProfile) => void;
  onConnectTerminal: (profile: ConnectionProfile) => void;
  onConnectSftp: (profile: ConnectionProfile) => void;
  onOpenHealth?: (profile: ConnectionProfile) => void;
  onDuplicate: (profile: ConnectionProfile) => void;
  onToggleFavorite: (profile: ConnectionProfile) => void;
  onImport: () => void;
  onExport: () => void;
}

export const ConnectionList: React.FC<ConnectionListProps> = ({
  profiles,
  initialized,
  onAdd,
  onEdit,
  onDelete,
  onConnectTerminal,
  onConnectSftp,
  onOpenHealth = () => {},
  onDuplicate,
  onToggleFavorite,
  onImport,
  onExport,
}) => {
  const { t } = useI18n();
  const [query, setQuery] = useState('');
  const [activityFilter, setActivityFilter] = useState<'all' | 'favorites' | 'recent'>('all');
  const [groupFilter, setGroupFilter] = useState('all');
  const [overviewProfile, setOverviewProfile] = useState<ConnectionProfile>();
  const [forwardProfile, setForwardProfile] = useState<ConnectionProfile>();
  const [quickActionProfile, setQuickActionProfile] = useState<ConnectionProfile>();
  const recentIds = useRecentProfilesStore((state) => state.recentIds);

  const groups = useMemo(
    () =>
      [...new Set(profiles.map((profile) => profile.group?.trim()).filter((group): group is string => Boolean(group)))].sort((left, right) =>
        left.localeCompare(right),
      ),
    [profiles],
  );

  const normalizedQuery = query.trim().toLowerCase();
  const filteredProfiles = useMemo(() => {
    return profiles.filter((profile) => {
      const haystack = [
        profile.name,
        profile.host,
        profile.username,
        String(profile.port),
        profile.jumpHost?.host,
        profile.jumpHost?.username,
        profile.group,
        ...(profile.tags ?? []),
        profile.notes,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();

      if (normalizedQuery && !haystack.includes(normalizedQuery)) return false;
      if (activityFilter === 'favorites' && !profile.favorite) return false;
      if (activityFilter === 'recent' && !recentIds.includes(profile.id)) return false;
      if (groupFilter !== 'all' && profile.group !== groupFilter) return false;
      return true;
    });
  }, [profiles, normalizedQuery, activityFilter, groupFilter, recentIds]);

  useEffect(() => {
    const handleOpenHostTool = (event: Event): void => {
      const detail = (
        event as CustomEvent<{
          profileId?: string;
          tool?: 'portForward' | 'overview' | 'quickActions';
        }>
      ).detail;
      const target = profiles.find((profile) => profile.id === detail?.profileId);
      if (!target) return;
      if (detail.tool === 'portForward') setForwardProfile(target);
      else if (detail.tool === 'overview') setOverviewProfile(target);
      else if (detail.tool === 'quickActions') setQuickActionProfile(target);
    };
    document.addEventListener('termbridge:open-host-tool', handleOpenHostTool);
    return () => document.removeEventListener('termbridge:open-host-tool', handleOpenHostTool);
  }, [profiles]);

  return (
    <TooltipProvider>
      <WorkbenchPage>
        <WorkbenchPageHeader
          icon={ServerIcon}
          title={t('workbench.connections.title')}
          description={t('workbench.connections.count', {
            count: filteredProfiles.length,
            total: profiles.length,
          })}
          actions={
            <>
              <WorkbenchSearchInput
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t('workbench.connections.searchPlaceholder')}
                aria-label={t('workbench.connections.searchPlaceholder')}
              />
              <Button variant="outline" size="sm" onClick={onImport}>
                <UploadIcon data-icon="inline-start" />
                {t('workbench.connections.import')}
              </Button>
              <Button variant="outline" size="sm" onClick={onExport}>
                <DownloadIcon data-icon="inline-start" />
                {t('workbench.connections.export')}
              </Button>
              <Button variant="default" size="sm" onClick={onAdd}>
                <PlusIcon data-icon="inline-start" />
                {t('workbench.connections.new')}
              </Button>
            </>
          }
        />

        {profiles.length > 0 && (
          <WorkbenchPageToolbar className="flex-row flex-wrap items-center gap-1.5">
            {(['all', 'favorites', 'recent'] as const).map((filter) => {
              const FilterIcon = filter === 'favorites'
                ? StarIcon
                : filter === 'recent'
                  ? HistoryIcon
                  : ListIcon;
              return (
                <Button key={filter} variant={activityFilter === filter ? 'secondary' : 'ghost'} size="xs" onClick={() => setActivityFilter(filter)}>
                  <FilterIcon data-icon="inline-start" />
                  {t(`workbench.connections.filter.${filter}`)}
                </Button>
              );
            })}
            {groups.length > 0 && (
              <Select value={groupFilter} onValueChange={(value) => setGroupFilter(value ?? 'all')}>
                <SelectTrigger size="sm" className="ml-auto w-40" aria-label={t('workbench.connections.groupFilter')}>
                  <SelectValue>{groupFilter === 'all' ? t('workbench.connections.allGroups') : groupFilter}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="all">{t('workbench.connections.allGroups')}</SelectItem>
                    {groups.map((group) => (
                      <SelectItem key={group} value={group}>
                        {group}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            )}
          </WorkbenchPageToolbar>
        )}

        <ScrollArea className="min-h-0 flex-1">
          <WorkbenchPageContent>
            {!initialized && profiles.length === 0 ? (
              <PanelLoadingState />
            ) : profiles.length === 0 ? (
              <PanelEmptyState
                title={t('workbench.connections.empty')}
                description={t('workbench.connections.emptyDescription')}
                icon={<MonitorIcon className="size-5" />}
              />
            ) : filteredProfiles.length === 0 ? (
              <PanelEmptyState
                title={t('workbench.connections.filteredEmpty')}
                description={t('common.noSearchResults')}
                icon={<SearchXIcon className="size-5" />}
              />
            ) : (
              <ResponsiveCardGrid columns={1} breakpoints={CONNECTION_CARD_BREAKPOINTS} gap="0.375rem">
                {filteredProfiles.map((profile) => (
                  <ConnectionCard
                    key={profile.id}
                    profile={profile}
                    onEdit={onEdit}
                    onDelete={onDelete}
                    onConnectTerminal={onConnectTerminal}
                    onConnectSftp={onConnectSftp}
                    onOpenHealth={onOpenHealth}
                    onDuplicate={onDuplicate}
                    onToggleFavorite={onToggleFavorite}
                    onOverview={setOverviewProfile}
                    onPortForward={setForwardProfile}
                    onQuickActions={setQuickActionProfile}
                  />
                ))}
              </ResponsiveCardGrid>
            )}
          </WorkbenchPageContent>
        </ScrollArea>
      </WorkbenchPage>
      <HostOverviewDialog profile={overviewProfile} onClose={() => setOverviewProfile(undefined)} />
      <PortForwardDialog profile={forwardProfile} onClose={() => setForwardProfile(undefined)} />
      <HostQuickActionsDialog profile={quickActionProfile} onClose={() => setQuickActionProfile(undefined)} />
    </TooltipProvider>
  );
};

interface ConnectionCardProps {
  profile: ConnectionProfile;
  onEdit: (profile: ConnectionProfile) => void;
  onDelete: (profile: ConnectionProfile) => void;
  onConnectTerminal: (profile: ConnectionProfile) => void;
  onConnectSftp: (profile: ConnectionProfile) => void;
  onOpenHealth: (profile: ConnectionProfile) => void;
  onDuplicate: (profile: ConnectionProfile) => void;
  onToggleFavorite: (profile: ConnectionProfile) => void;
  onOverview: (profile: ConnectionProfile) => void;
  onPortForward: (profile: ConnectionProfile) => void;
  onQuickActions: (profile: ConnectionProfile) => void;
}

const ConnectionNotes: React.FC<{ notes: string }> = ({ notes }) => {
  const notesRef = useRef<HTMLParagraphElement>(null);
  const [isTruncated, setIsTruncated] = useState(false);

  const updateTruncation = useCallback(() => {
    const element = notesRef.current;
    if (!element) return;
    const nextIsTruncated = element.scrollWidth > element.clientWidth;
    setIsTruncated((current) => (current === nextIsTruncated ? current : nextIsTruncated));
  }, []);

  useLayoutEffect(() => {
    updateTruncation();
    const element = notesRef.current;
    if (!element || typeof ResizeObserver === 'undefined') return;

    const observer = new ResizeObserver(updateTruncation);
    observer.observe(element);
    return () => observer.disconnect();
  }, [notes, updateTruncation]);

  return (
    <Tooltip disabled={!isTruncated}>
      <TooltipTrigger
        render={<p ref={notesRef} className="truncate text-xs text-muted-foreground" onFocus={updateTruncation} onMouseEnter={updateTruncation} />}
      >
        {notes}
      </TooltipTrigger>
      <TooltipContent className="max-w-sm whitespace-pre-wrap break-words">{notes}</TooltipContent>
    </Tooltip>
  );
};

const ConnectionCard = React.memo<ConnectionCardProps>(
  ({
    profile,
    onEdit,
    onDelete,
    onConnectTerminal,
    onConnectSftp,
    onOpenHealth,
    onDuplicate,
    onToggleFavorite,
    onOverview,
    onPortForward,
    onQuickActions,
  }) => {
    const { t } = useI18n();
    const handleConnectTerminal = useDebouncedCallback(() => onConnectTerminal(profile), CARD_ACTION_DEBOUNCE_MS);
    const handleConnectSftp = useDebouncedCallback(() => onConnectSftp(profile), CARD_ACTION_DEBOUNCE_MS);
    const handleOpenHealth = useDebouncedCallback(() => onOpenHealth(profile), CARD_ACTION_DEBOUNCE_MS);
    const handleEdit = useDebouncedCallback(() => onEdit(profile), CARD_ACTION_DEBOUNCE_MS);
    const handleDuplicate = useDebouncedCallback(() => onDuplicate(profile), CARD_ACTION_DEBOUNCE_MS);
    const handleDelete = useDebouncedCallback(() => onDelete(profile), CARD_ACTION_DEBOUNCE_MS);
    const handleToggleFavorite = useDebouncedCallback(() => onToggleFavorite(profile), CARD_ACTION_DEBOUNCE_MS);
    const handleOverview = useDebouncedCallback(() => onOverview(profile), CARD_ACTION_DEBOUNCE_MS);
    const handlePortForward = useDebouncedCallback(() => onPortForward(profile), CARD_ACTION_DEBOUNCE_MS);
    const handleQuickActions = useDebouncedCallback(() => onQuickActions(profile), CARD_ACTION_DEBOUNCE_MS);

    return (
      <ManagementCard>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-center gap-2">
            <ManagementCardIcon>
              <MonitorIcon />
            </ManagementCardIcon>
            <div className="flex min-w-0 flex-col">
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="truncate text-sm font-medium text-app-text">{profile.name}</span>
                {profile.favorite && (
                  <StarIcon className="size-3.5 shrink-0 fill-current text-app-warning" aria-label={t('workbench.connections.filter.favorites')} />
                )}
              </span>
              <span className="truncate text-xs text-muted-foreground">
                {profile.username}@{profile.host}:{profile.port}
              </span>
            </div>
          </div>
          <div className="flex flex-wrap gap-1">
            <Badge variant={profile.authMethod === 'password' ? 'secondary' : 'outline'}>
              {profile.authMethod === 'password' ? t('connection.form.auth.password') : t('connection.form.auth.key')}
            </Badge>
            {profile.jumpHost && <Badge variant="outline">{t('connection.form.jumpHost')}</Badge>}
            {profile.group && <Badge variant="secondary">{profile.group}</Badge>}
            {(profile.tags ?? []).map((tag) => (
              <Badge key={tag} variant="outline">
                {tag}
              </Badge>
            ))}
          </div>
        </div>
        {profile.notes && <ConnectionNotes notes={profile.notes} />}
        {profile.jumpHost && (
          <div className="rounded-lg border border-app-border bg-muted px-2.5 py-2">
            <div className="text-[10px] uppercase tracking-[0.08em] text-muted-foreground">{t('connection.form.jumpHost')}</div>
            <div className="truncate text-xs text-app-text">
              {profile.jumpHost.username}@{profile.jumpHost.host}:{profile.jumpHost.port}
            </div>
          </div>
        )}
        <div className="mt-auto flex flex-wrap items-center gap-1">
          <div className="flex w-full items-center justify-end gap-1">
            <div className="flex flex-wrap items-center gap-1">
              <IconActionButton
                className="size-8"
                onClick={handleConnectTerminal}
                aria-label={t('workbench.connections.connectTerminal')}
                tooltip={t('workbench.connections.connectTerminal')}
              >
                <TerminalIcon data-icon="inline-start" />
              </IconActionButton>
              <IconActionButton
                className="size-8"
                onClick={handleConnectSftp}
                aria-label={t('workbench.connections.connectSftp')}
                tooltip={t('workbench.connections.connectSftp')}
              >
                <FolderIcon data-icon="inline-start" />
              </IconActionButton>
            </div>
            <DropdownMenu>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <DropdownMenuTrigger
                      render={
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-8"
                          aria-label={t('workbench.connections.moreActions', { name: profile.name })}
                        />
                      }
                    />
                  }
                >
                  <EllipsisIcon data-icon="inline-start" />
                </TooltipTrigger>
                <TooltipContent>{t('workbench.connections.moreActions', { name: profile.name })}</TooltipContent>
              </Tooltip>
              <DropdownMenuContent
                align="start"
                className="w-52 border border-app-border bg-app-surface p-1 text-app-text shadow-[var(--shadow-dialog)] ring-0"
              >
                <DropdownMenuGroup>
                  <DropdownMenuItem className={CONNECTION_MENU_ITEM_CLASS} onClick={handleOpenHealth}>
                    <HeartPulseIcon />
                    {t('remoteHealth.open')}
                  </DropdownMenuItem>
                  <DropdownMenuItem className={CONNECTION_MENU_ITEM_CLASS} onClick={handlePortForward}>
                    <CableIcon />
                    {t('portForward.open')}
                  </DropdownMenuItem>
                  <DropdownMenuItem className={CONNECTION_MENU_ITEM_CLASS} onClick={handleQuickActions}>
                    <ZapIcon />
                    {t('hostQuickActions.open')}
                  </DropdownMenuItem>
                  <DropdownMenuItem className={CONNECTION_MENU_ITEM_CLASS} onClick={handleOverview}>
                    <InfoIcon />
                    {t('hostOverview.open')}
                  </DropdownMenuItem>
                </DropdownMenuGroup>
                <DropdownMenuSeparator className="mx-0 my-1" />
                <DropdownMenuGroup>
                  <DropdownMenuItem className={CONNECTION_MENU_ITEM_CLASS} onClick={handleToggleFavorite}>
                    <StarIcon className={profile.favorite ? 'fill-current text-app-warning' : undefined} />
                    {profile.favorite ? t('workbench.connections.unfavorite') : t('workbench.connections.favorite')}
                  </DropdownMenuItem>
                  <DropdownMenuItem className={CONNECTION_MENU_ITEM_CLASS} onClick={handleEdit}>
                    <PencilIcon />
                    {t('common.edit')}
                  </DropdownMenuItem>
                  <DropdownMenuItem className={CONNECTION_MENU_ITEM_CLASS} onClick={handleDuplicate}>
                    <CopyIcon />
                    {t('common.duplicate')}
                  </DropdownMenuItem>
                </DropdownMenuGroup>
                <DropdownMenuSeparator className="mx-0 my-1" />
                <DropdownMenuGroup>
                  <DropdownMenuItem variant="destructive" className={CONNECTION_MENU_DESTRUCTIVE_ITEM_CLASS} onClick={handleDelete}>
                    <Trash2Icon />
                    {t('common.delete')}
                  </DropdownMenuItem>
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </ManagementCard>
    );
  },
);
