import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Select as SelectPrimitive } from '@base-ui/react/select';
import { useI18n } from '@/hooks/useI18n';
import { useDebouncedCallback } from '@/hooks/useDebouncedCallback';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { PanelEmptyState, PanelLoadingState } from '@/components/ui/empty-state';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Badge } from '@/components/ui/badge';
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from '@/components/ui/popover';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Select, SelectContent, SelectGroup, SelectItem, SelectValue } from '@/components/ui/select';
import { IconActionButton } from './icon-action-button';
import { ManagementCard, ManagementCardIcon } from './management-card';
import { HostOverviewDialog } from './host-overview-dialog';
import { PortForwardDialog } from './port-forward-dialog';
import { HostQuickActionsDialog } from './host-quick-actions-dialog';
import type { ConnectionProfile } from '@/types';
import { useRecentProfilesStore } from '@/stores/recentProfilesStore';
import { cn } from '@/lib/utils';
import {
  CopyIcon,
  ChevronDownIcon,
  DownloadIcon,
  EllipsisIcon,
  FolderIcon,
  MonitorIcon,
  PencilIcon,
  PlusIcon,
  SearchXIcon,
  ServerIcon,
  Trash2Icon,
  StarIcon,
  TerminalIcon,
  UploadIcon,
  InfoIcon,
  CableIcon,
  HeartPulseIcon,
  ZapIcon,
  KeyRoundIcon,
  LockKeyholeIcon,
} from 'lucide-react';
import { WorkbenchPage, WorkbenchPageContent, WorkbenchPageHeader, WorkbenchSearchInput, WorkbenchPageToolbar } from './workbench-page';

const CARD_ACTION_DEBOUNCE_MS = 500;
// Keep column changes in the same layout pass as AI-panel resizing.
export const ConnectionCardGrid = ({ children }: { children: React.ReactNode }) => (
  <div className="@container/connections w-full">
    <div className="grid grid-cols-1 gap-2 @min-[640px]/connections:grid-cols-2 @min-[900px]/connections:grid-cols-3">
      {children}
    </div>
  </div>
);
const CONNECTION_MENU_ITEM_CLASS =
  'gap-1 px-2.5 py-1.5 text-xs [&>svg]:size-4 [&>svg]:self-center text-app-text focus:bg-app-primary/10 focus:text-app-primary [&_svg]:text-muted-foreground focus:[&_svg]:text-app-primary';
const CONNECTION_MENU_DESTRUCTIVE_ITEM_CLASS = 'gap-1 px-2.5 py-1.5 text-xs [&>svg]:size-4 [&>svg]:self-center';

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
    document.addEventListener('shellspan:open-host-tool', handleOpenHostTool);
    return () => document.removeEventListener('shellspan:open-host-tool', handleOpenHostTool);
  }, [profiles]);

  return (
    <TooltipProvider>
      <WorkbenchPage>
        <WorkbenchPageHeader
          compactActions
          icon={ServerIcon}
          title={t('workbench.connections.title')}
          description={t('workbench.connections.count', {
            count: filteredProfiles.length,
            total: profiles.length,
          })}
          actions={
            <>
              <Tooltip>
                <TooltipTrigger render={<WorkbenchSearchInput
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t('workbench.connections.searchPlaceholder')}
                aria-label={t('workbench.connections.searchPlaceholder')}
                containerClassName="max-w-64 flex-1 @min-[48rem]:flex-none"
                />} />
                <TooltipContent>{t('workbench.connections.searchHint')}</TooltipContent>
              </Tooltip>
              <Button variant="default" size="sm" onClick={onAdd}>
                <PlusIcon data-icon="inline-start" />
                {t('workbench.connections.new')}
              </Button>
              <DropdownMenu>
                <Tooltip>
                  <TooltipTrigger render={
                    <DropdownMenuTrigger render={
                      <Button variant="secondary" size="icon-sm"
                        className="shrink-0 focus-visible:bg-accent data-popup-open:bg-accent"
                        aria-label={t('workbench.connections.actions')} />
                    } />
                  }>
                    <EllipsisIcon aria-hidden data-icon="inline-start" />
                  </TooltipTrigger>
                  <TooltipContent>{t('workbench.connections.actions')}</TooltipContent>
                </Tooltip>
                <DropdownMenuContent align="end" className="w-max min-w-0">
                  <DropdownMenuGroup>
                    <DropdownMenuItem onClick={onImport}>
                      <DownloadIcon />
                      {t('workbench.connections.import')}
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={onExport}>
                      <UploadIcon />
                      {t('workbench.connections.export')}
                    </DropdownMenuItem>
                  </DropdownMenuGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            </>
          }
        />

        {profiles.length > 0 && (
          <WorkbenchPageToolbar className="flex-row flex-wrap items-center gap-1.5">
            {(['all', 'favorites', 'recent'] as const).map((filter) => (
              <Button key={filter} variant={activityFilter === filter ? 'secondary' : 'ghost'} size="xs" onClick={() => setActivityFilter(filter)}>
                {t(`workbench.connections.filter.${filter}`)}
              </Button>
            ))}
            {groups.length > 0 && (
              <>
                <Separator orientation="vertical" aria-hidden="true" className="mx-0.5 h-3 data-vertical:self-center" />
                <Select
                  items={[{ value: 'all', label: t('workbench.connections.allGroups') }, ...groups.map(group => ({ value: group, label: group }))]}
                  value={groupFilter} onValueChange={(value) => setGroupFilter(value ?? 'all')}>
                  <SelectPrimitive.Trigger
                    render={<Button variant={groupFilter === 'all' ? 'ghost' : 'secondary'} size="xs" />}
                    className="min-w-0 max-w-40 shrink focus-visible:bg-accent data-popup-open:bg-accent"
                    aria-label={t('workbench.connections.groupFilter')}>
                    <SelectValue />
                    <SelectPrimitive.Icon><ChevronDownIcon aria-hidden data-icon="inline-end" /></SelectPrimitive.Icon>
                  </SelectPrimitive.Trigger>
                  <SelectContent align="start" alignItemWithTrigger={false}>
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
              </>
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
              <ConnectionCardGrid>
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
              </ConnectionCardGrid>
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

const ConnectionText: React.FC<{ text: string; className?: string; kind?: string }> = ({ text, className, kind = 'label' }) => {
  const notesRef = useRef<HTMLSpanElement>(null);
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
  }, [text, updateTruncation]);

  return (
    <Tooltip disabled={!isTruncated}>
      <TooltipTrigger
        render={<span ref={notesRef} data-connection-text={kind} tabIndex={isTruncated ? 0 : undefined}
          className={cn('block min-w-0 truncate', className)} onFocus={updateTruncation} onMouseEnter={updateTruncation} />}
      >
        {text}
      </TooltipTrigger>
      <TooltipContent className="max-w-sm whitespace-pre-wrap break-words">{text}</TooltipContent>
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
    const displayName = profile.name.trim() || profile.host;
    const tags = profile.tags ?? [];
    const authLabel = profile.authMethod === 'password' ? t('connection.form.auth.password') : t('connection.form.auth.key');
    const AuthIcon = profile.authMethod === 'password' ? LockKeyholeIcon : KeyRoundIcon;
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
      <ManagementCard className="@container/connection-card">
        <div className="flex items-center justify-between gap-2">
          <div data-slot="connection-identity" className="flex min-w-[50%] flex-1 items-center gap-2">
            <ManagementCardIcon>
              <MonitorIcon />
            </ManagementCardIcon>
            <div className="flex min-w-0 flex-col">
              <span className="flex min-w-0 items-center gap-1">
                <ConnectionText text={displayName} kind="name" className="text-sm font-medium text-app-text" />
                {profile.favorite && (
                  <StarIcon className="size-3.5 shrink-0 fill-current text-app-warning" aria-label={t('workbench.connections.filter.favorites')} />
                )}
              </span>
              <span className="truncate text-xs text-muted-foreground">
                {profile.username}@{profile.host}:{profile.port}
              </span>
            </div>
          </div>
          <div data-slot="connection-labels" className="flex min-w-0 max-w-[45%] flex-nowrap items-center gap-1">
            <Tooltip>
              <TooltipTrigger render={<span tabIndex={0} aria-label={authLabel} className="inline-flex size-5 shrink-0 items-center justify-center text-muted-foreground" />}>
                <AuthIcon className="size-3.5" aria-hidden />
              </TooltipTrigger>
              <TooltipContent>{authLabel}</TooltipContent>
            </Tooltip>
            {profile.jumpHost && <Badge variant="outline" className={cn('min-w-0 max-w-24 shrink',
              profile.group && tags.length > 1 && 'hidden @min-[25rem]/connection-card:inline-flex',
            )}><span className="truncate">{t('connection.form.jumpHost')}</span></Badge>}
            {profile.group && <Badge variant="secondary" className="min-w-0 max-w-[min(6rem,40%)] shrink-0"><ConnectionText text={profile.group} /></Badge>}
            {tags[0] && (
              <Badge variant="outline" className={cn('min-w-0 max-w-24 shrink',
                tags.length > 1 && 'hidden @min-[25rem]/connection-card:inline-flex',
              )}>
                <ConnectionText text={tags[0]} />
              </Badge>
            )}
            {tags.length > 1 && (
              <Popover>
                <PopoverTrigger
                  aria-label={t('workbench.connections.moreTags', { count: tags.length })}
                  render={<Badge variant="outline" render={<button type="button" />} />}
                >
                  <span className="@min-[25rem]/connection-card:hidden">+{tags.length}</span>
                  <span className="hidden @min-[25rem]/connection-card:inline">+{tags.length - 1}</span>
                </PopoverTrigger>
                <PopoverContent align="end">
                  <PopoverTitle>{t('connection.form.tags')}</PopoverTitle>
                  <div className="flex flex-wrap gap-1">
                    {tags.map(tag => <Badge key={tag} variant="outline" className="min-w-0 max-w-24">
                      <ConnectionText text={tag} />
                    </Badge>)}
                  </div>
                </PopoverContent>
              </Popover>
            )}
          </div>
        </div>
        <div className="min-h-4" data-slot="connection-notes">
          {profile.notes?.trim() && <ConnectionText text={profile.notes} kind="notes" className="text-xs text-muted-foreground" />}
        </div>
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
                          aria-label={t('workbench.connections.moreActions', { name: displayName })}
                        />
                      }
                    />
                  }
                >
                  <EllipsisIcon data-icon="inline-start" />
                </TooltipTrigger>
                <TooltipContent>{t('workbench.connections.moreActions', { name: displayName })}</TooltipContent>
              </Tooltip>
              <DropdownMenuContent
                align="start"
                className="w-52 border border-app-border bg-app-surface p-1 text-app-text shadow-[var(--shadow-dialog)] ring-0"
              >
                <DropdownMenuGroup>
                  <DropdownMenuItem className={CONNECTION_MENU_ITEM_CLASS} onClick={handleToggleFavorite}>
                    <StarIcon className={profile.favorite ? 'fill-current text-app-warning' : undefined} />
                    <span className="relative top-px">{profile.favorite ? t('workbench.connections.unfavorite') : t('workbench.connections.favorite')}</span>
                  </DropdownMenuItem>
                  <DropdownMenuItem className={CONNECTION_MENU_ITEM_CLASS} onClick={handleEdit}>
                    <PencilIcon />
                    <span className="relative top-px">{t('common.edit')}</span>
                  </DropdownMenuItem>
                  <DropdownMenuItem className={CONNECTION_MENU_ITEM_CLASS} onClick={handleDuplicate}>
                    <CopyIcon />
                    <span className="relative top-px">{t('common.duplicate')}</span>
                  </DropdownMenuItem>
                </DropdownMenuGroup>
                <DropdownMenuSeparator className="mx-0 my-1" />
                <DropdownMenuGroup>
                  <DropdownMenuItem className={CONNECTION_MENU_ITEM_CLASS} onClick={handleOpenHealth}>
                    <HeartPulseIcon />
                    <span className="relative top-px">{t('remoteHealth.open')}</span>
                  </DropdownMenuItem>
                  <DropdownMenuItem className={CONNECTION_MENU_ITEM_CLASS} onClick={handlePortForward}>
                    <CableIcon />
                    <span className="relative top-px">{t('portForward.open')}</span>
                  </DropdownMenuItem>
                  <DropdownMenuItem className={CONNECTION_MENU_ITEM_CLASS} onClick={handleQuickActions}>
                    <ZapIcon />
                    <span className="relative top-px">{t('hostQuickActions.open')}</span>
                  </DropdownMenuItem>
                  <DropdownMenuItem className={CONNECTION_MENU_ITEM_CLASS} onClick={handleOverview}>
                    <InfoIcon />
                    <span className="relative top-px">{t('hostOverview.open')}</span>
                  </DropdownMenuItem>
                </DropdownMenuGroup>
                <DropdownMenuSeparator className="mx-0 my-1" />
                <DropdownMenuGroup>
                  <DropdownMenuItem variant="destructive" className={CONNECTION_MENU_DESTRUCTIVE_ITEM_CLASS} onClick={handleDelete}>
                    <Trash2Icon />
                    <span className="relative top-px">{t('common.delete')}</span>
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
