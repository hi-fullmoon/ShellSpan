import React, { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Select as SelectPrimitive } from '@base-ui/react/select';
import { useI18n } from '@/hooks/useI18n';
import { useDebouncedCallback } from '@/hooks/useDebouncedCallback';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { PanelEmptyState, PanelLoadingState } from '@/components/ui/empty-state';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Badge } from '@/components/ui/badge';
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from '@/components/ui/popover';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Select, SelectContent, SelectGroup, SelectItem, SelectValue } from '@/components/ui/select';
import { IconActionButton } from './icon-action-button';
import { ManagementCard, ManagementCardIcon } from './management-card';
import { HostOverviewDialog } from './host-overview-dialog';
import type { ConnectionProfile } from '@/types';
import { useRecentProfilesStore } from '@/stores/recentProfilesStore';
import {
  nextConnectionTableSort,
  sortConnectionsForTable,
  type ConnectionTableSort,
  type ConnectionTableSortColumn,
} from '@/lib/connections/connection-view';
import {
  WORKBENCH_TABLE_ACTION_CELL_CLASS,
  WORKBENCH_TABLE_ACTION_GROUP_CLASS,
  WORKBENCH_TABLE_CELL_CLASS,
  WORKBENCH_TABLE_HEAD_CLASS,
  WORKBENCH_TABLE_HEADER_CLASS,
  WORKBENCH_TABLE_HEADER_ROW_CLASS,
  WORKBENCH_TABLE_ICON_BUTTON_CLASS,
  WORKBENCH_TABLE_ROW_CLASS,
  WORKBENCH_TABLE_TAG_CLASS,
  WORKBENCH_VIEW_STORAGE_KEYS,
  WorkbenchSortableHead,
  WorkbenchTableFrame,
  WorkbenchViewModeToggle,
  useWorkbenchViewMode,
} from './workbench-view-mode';
import { cn } from '@/lib/utils';
import {
  CopyIcon,
  ChevronDownIcon,
  CornerDownRightIcon,
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
  FingerprintIcon,
  ShieldCheckIcon,
  ShieldQuestionMarkIcon,
} from 'lucide-react';
import { WorkbenchPage, WorkbenchPageContent, WorkbenchPageHeader, WorkbenchPageScrollArea, WorkbenchSearchInput, WorkbenchPageToolbar } from './workbench-page';

const CARD_ACTION_DEBOUNCE_MS = 500;
const AUTH_METHOD_ICONS: Record<ConnectionProfile['authMethod'], React.ElementType> = {
  password: LockKeyholeIcon,
  key: KeyRoundIcon,
  agent: FingerprintIcon,
  keyboardInteractive: ShieldQuestionMarkIcon,
};
const CONNECTION_TRANSFER_MENU_ITEM_CLASS =
  "[&_svg:not([class*='size-'])]:size-3.5 [&>svg]:translate-y-px [&>svg]:text-muted-foreground";
// Keep column changes in the same layout pass as AI-panel resizing while scaling columns on wide screens.
export const ConnectionCardGrid = ({ children }: { children: React.ReactNode }) => (
  <div className="grid w-full grid-cols-[repeat(auto-fill,minmax(min(100%,19rem),1fr))] gap-2">
    {children}
  </div>
);
const CONNECTION_MENU_ITEM_CLASS =
  "gap-1 px-2.5 py-1.5 text-xs [&_svg:not([class*='size-'])]:size-3.5 [&>svg]:self-center [&>svg]:translate-y-px text-app-text focus:text-app-primary [&_svg]:text-muted-foreground focus:[&_svg]:text-app-primary";
const CONNECTION_MENU_DESTRUCTIVE_ITEM_CLASS = "gap-1 px-2.5 py-1.5 text-xs [&_svg:not([class*='size-'])]:size-3.5 [&>svg]:self-center [&>svg]:translate-y-[0.5px]";

export interface ConnectionListProps {
  profiles: ConnectionProfile[];
  initialized: boolean;
  onAdd: () => void;
  onEdit: (profile: ConnectionProfile) => void;
  onDelete: (profile: ConnectionProfile) => void;
  onConnectTerminal: (profile: ConnectionProfile) => void;
  onConnectSftp: (profile: ConnectionProfile) => void;
  onOpenHealth?: (profile: ConnectionProfile) => void;
  onOpenPortForward?: (profile: ConnectionProfile) => void;
  onOpenQuickActions?: (profile: ConnectionProfile) => void;
  onOpenOverview?: (profile: ConnectionProfile) => void;
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
  onOpenPortForward = () => {},
  onOpenQuickActions = () => {},
  onOpenOverview,
  onDuplicate,
  onToggleFavorite,
  onImport,
  onExport,
}) => {
  const { t, locale } = useI18n();
  const [query, setQuery] = useState('');
  const [activityFilter, setActivityFilter] = useState<'all' | 'favorites' | 'recent'>('all');
  const [groupFilter, setGroupFilter] = useState('all');
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [viewMode, handleViewModeChange] = useWorkbenchViewMode(WORKBENCH_VIEW_STORAGE_KEYS.connections);
  const [tableSort, setTableSort] = useState<ConnectionTableSort | null>(null);
  const [overviewProfile, setOverviewProfile] = useState<ConnectionProfile>();
  const recentIds = useRecentProfilesStore((state) => state.recentIds);

  const handleTableSort = useCallback((column: ConnectionTableSortColumn): void => {
    setTableSort((current) => nextConnectionTableSort(current, column));
  }, []);

  const groups = useMemo(
    () =>
      [...new Set(profiles.map((profile) => profile.group?.trim()).filter((group): group is string => Boolean(group)))].sort((left, right) =>
        left.localeCompare(right),
      ),
    [profiles],
  );

  const normalizedQuery = query.trim().toLowerCase();
  const tags = useMemo(
    () => [...new Set(profiles.flatMap(profile => profile.tags ?? []).map(tag => tag.trim()).filter(Boolean))]
      .sort((left, right) => left.localeCompare(right)),
    [profiles],
  );
  const activeTags = useMemo(() => selectedTags.filter(tag => tags.includes(tag)), [selectedTags, tags]);
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
      if (activeTags.length > 0 && !profile.tags?.some(tag => activeTags.includes(tag.trim()))) return false;
      return true;
    });
  }, [profiles, normalizedQuery, activityFilter, groupFilter, recentIds, activeTags]);

  const tableProfiles = useMemo(
    () => (viewMode === 'table'
      ? sortConnectionsForTable(filteredProfiles, tableSort, locale, (method) => t(`connection.form.auth.${method}`))
      : filteredProfiles),
    [filteredProfiles, locale, t, tableSort, viewMode],
  );

  const handleOverview = useCallback((profile: ConnectionProfile): void => {
    if (onOpenOverview) {
      onOpenOverview(profile);
    } else {
      setOverviewProfile(profile);
    }
  }, [onOpenOverview]);

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
              <Tooltip>
                <TooltipTrigger render={
                  <WorkbenchSearchInput
                    data-slot="input-group-control"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder={t('workbench.connections.searchPlaceholder')}
                    aria-label={t('workbench.connections.searchPlaceholder')}
                  />
                } />
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
                    <DropdownMenuItem className={CONNECTION_TRANSFER_MENU_ITEM_CLASS} onClick={onImport}>
                      <DownloadIcon />
                      {t('workbench.connections.import')}
                    </DropdownMenuItem>
                    <DropdownMenuItem className={CONNECTION_TRANSFER_MENU_ITEM_CLASS} onClick={onExport}>
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
            {(groups.length > 0 || tags.length > 0) && (
              <Separator orientation="vertical" aria-hidden="true" className="mx-0.5 h-3 data-vertical:self-center" />
            )}
            {groups.length > 0 && (
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
            )}
            {tags.length > 0 && (
              <DropdownMenu>
                <DropdownMenuTrigger render={
                  <Button variant={activeTags.length === 0 ? 'ghost' : 'secondary'} size="xs"
                    className="min-w-0 max-w-40 shrink focus-visible:bg-accent data-popup-open:bg-accent"
                    aria-label={t('workbench.connections.tagFilter')} />
                }>
                  <span className="min-w-0 truncate">
                    {activeTags.length === 0 ? t('workbench.connections.allTags') : activeTags.length === 1
                      ? activeTags[0] : t('workbench.connections.selectedTags', { count: activeTags.length })}
                  </span>
                  <ChevronDownIcon aria-hidden data-icon="inline-end" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-max max-w-[min(16rem,var(--available-width))]">
                  <DropdownMenuGroup>
                    <DropdownMenuCheckboxItem checked={activeTags.length === 0} closeOnClick={false}
                      onCheckedChange={() => setSelectedTags([])}>
                      {t('workbench.connections.allTags')}
                    </DropdownMenuCheckboxItem>
                  </DropdownMenuGroup>
                  <DropdownMenuSeparator />
                  <DropdownMenuGroup>
                    {tags.map(tag => (
                      <DropdownMenuCheckboxItem key={tag} checked={activeTags.includes(tag)} closeOnClick={false}
                        onCheckedChange={checked => setSelectedTags(current => checked
                          ? [...current.filter(value => tags.includes(value) && value !== tag), tag]
                          : current.filter(value => tags.includes(value) && value !== tag))}>
                        <span className="min-w-0 truncate" title={tag}>{tag}</span>
                      </DropdownMenuCheckboxItem>
                    ))}
                  </DropdownMenuGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            <WorkbenchViewModeToggle value={viewMode} onChange={handleViewModeChange} />
          </WorkbenchPageToolbar>
        )}

        <WorkbenchPageScrollArea
          viewportClassName={viewMode === 'table' && filteredProfiles.length > 0 ? 'scroll-pt-8' : undefined}
        >
          <WorkbenchPageContent
            className={cn(
              viewMode === 'table' && filteredProfiles.length > 0 && 'p-0',
            )}
          >
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
            ) : viewMode === 'table' ? (
              <ConnectionTable
                profiles={tableProfiles}
                sort={tableSort}
                onSort={handleTableSort}
                onEdit={onEdit}
                onDelete={onDelete}
                onConnectTerminal={onConnectTerminal}
                onConnectSftp={onConnectSftp}
                onOpenHealth={onOpenHealth}
                onDuplicate={onDuplicate}
                onToggleFavorite={onToggleFavorite}
                onOverview={handleOverview}
                onPortForward={onOpenPortForward}
                onQuickActions={onOpenQuickActions}
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
                    onOverview={handleOverview}
                    onPortForward={onOpenPortForward}
                    onQuickActions={onOpenQuickActions}
                  />
                ))}
              </ConnectionCardGrid>
            )}
          </WorkbenchPageContent>
        </WorkbenchPageScrollArea>
      </WorkbenchPage>
      {!onOpenOverview && (
        <HostOverviewDialog profile={overviewProfile} onClose={() => setOverviewProfile(undefined)} />
      )}
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

interface ConnectionActionsProps extends ConnectionCardProps {
  displayName: string;
  menuAlign?: 'start' | 'end';
  compact?: boolean;
}

const ConnectionActions = React.memo<ConnectionActionsProps>(
  ({
    profile,
    displayName,
    menuAlign = 'start',
    compact = false,
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
    const actionButtonClass = compact ? WORKBENCH_TABLE_ICON_BUTTON_CLASS : 'size-8';

    return (
      <div className={compact ? WORKBENCH_TABLE_ACTION_GROUP_CLASS : 'flex shrink-0 items-center justify-end gap-1'}>
        <div className={cn('flex items-center', compact ? 'flex-nowrap gap-0.5' : 'flex-wrap gap-1')}>
          <IconActionButton
            className={actionButtonClass}
            onClick={handleConnectTerminal}
            aria-label={t('workbench.connections.connectTerminal')}
            tooltip={t('workbench.connections.connectTerminal')}
          >
            <TerminalIcon data-icon="inline-start" />
          </IconActionButton>
          <IconActionButton
            className={actionButtonClass}
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
                      className={actionButtonClass}
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
            align={menuAlign}
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
    );
  },
);

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
    const authLabel = t(`connection.form.auth.${profile.authMethod}`);
    const AuthIcon = AUTH_METHOD_ICONS[profile.authMethod];

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
              (profile.group || tags.length > 0) && 'hidden @min-[25rem]/connection-card:inline-flex',
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
        <div className="mt-auto flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-1">
            {profile.sandboxMode && (
              <Badge
                variant="secondary"
                className="min-w-0 max-w-full shrink gap-1"
                data-connection-sandbox-mode={profile.sandboxMode}
              >
                <ShieldCheckIcon aria-hidden="true" className="size-3 shrink-0" />
                <ConnectionText text={t(`connection.sandbox.badge.${profile.sandboxMode}`)} kind="sandbox" />
              </Badge>
            )}
          </div>
          <ConnectionActions
            profile={profile}
            displayName={displayName}
            onEdit={onEdit}
            onDelete={onDelete}
            onConnectTerminal={onConnectTerminal}
            onConnectSftp={onConnectSftp}
            onOpenHealth={onOpenHealth}
            onDuplicate={onDuplicate}
            onToggleFavorite={onToggleFavorite}
            onOverview={onOverview}
            onPortForward={onPortForward}
            onQuickActions={onQuickActions}
          />
        </div>
      </ManagementCard>
    );
  },
);

interface ConnectionTableProps extends Omit<ConnectionCardProps, 'profile'> {
  profiles: ConnectionProfile[];
  sort: ConnectionTableSort | null;
  onSort: (column: ConnectionTableSortColumn) => void;
}

const ConnectionTableRow = React.memo<ConnectionCardProps>(
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
    const address = `${profile.username}@${profile.host}:${profile.port}`;
    const tags = profile.tags ?? [];
    const authLabel = t(`connection.form.auth.${profile.authMethod}`);
    const AuthIcon = AUTH_METHOD_ICONS[profile.authMethod];

    return (
      <TableRow data-slot="connection-table-row" className={WORKBENCH_TABLE_ROW_CLASS}>
        <TableCell className={WORKBENCH_TABLE_CELL_CLASS}>
          <div className="flex min-w-0 items-center gap-2">
            <MonitorIcon
              className="size-4 shrink-0 text-muted-foreground/75 transition-colors group-hover:text-foreground"
              aria-hidden
            />
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <div className="flex min-w-0 items-center gap-1">
                <ConnectionText text={displayName} kind="name" className="text-[13px] font-medium text-foreground" />
                {profile.favorite && (
                  <StarIcon
                    className="size-3.5 shrink-0 fill-current text-app-warning"
                    aria-label={t('workbench.connections.filter.favorites')}
                  />
                )}
                {profile.sandboxMode && (
                  <Badge
                    variant="secondary"
                    size="sm"
                    className={cn(WORKBENCH_TABLE_TAG_CLASS, 'max-w-24 shrink-0 gap-1 bg-muted/75 text-muted-foreground')}
                    data-connection-sandbox-mode={profile.sandboxMode}
                  >
                    <ShieldCheckIcon aria-hidden="true" className="size-3 shrink-0" />
                    <ConnectionText text={t(`connection.sandbox.badge.${profile.sandboxMode}`)} kind="sandbox" />
                  </Badge>
                )}
              </div>
              <span className="truncate font-mono text-[11px] tabular-nums text-muted-foreground @min-[36rem]:hidden">
                {address}
              </span>
            </div>
          </div>
        </TableCell>
        <TableCell className={cn(WORKBENCH_TABLE_CELL_CLASS, 'hidden @min-[36rem]:table-cell')}>
          <div className="flex min-w-0 flex-col gap-0.5">
            <ConnectionText text={address} kind="address" className="font-mono text-xs tabular-nums text-foreground/85" />
            {profile.jumpHost && (
              <div className="flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground/80">
                <CornerDownRightIcon className="size-3 shrink-0 opacity-65" aria-hidden />
                <ConnectionText
                  text={`${t('connection.form.jumpHost')}: ${profile.jumpHost.username}@${profile.jumpHost.host}:${profile.jumpHost.port}`}
                  kind="jump-host"
                  className="font-mono tabular-nums"
                />
              </div>
            )}
          </div>
        </TableCell>
        <TableCell className={cn(WORKBENCH_TABLE_CELL_CLASS, 'hidden @min-[52rem]:table-cell')}>
          <span className="inline-flex min-w-0 max-w-full items-center gap-1 text-xs text-muted-foreground">
            <AuthIcon className="size-3.5 shrink-0 opacity-75" aria-hidden />
            <span className="truncate">{authLabel}</span>
          </span>
        </TableCell>
        <TableCell className={cn(WORKBENCH_TABLE_CELL_CLASS, 'hidden @min-[44rem]:table-cell')}>
          {profile.group || tags.length > 0 ? (
            <div className="flex min-w-0 flex-nowrap items-center gap-1">
              {profile.group && (
                <Badge variant="secondary" className={cn(WORKBENCH_TABLE_TAG_CLASS, 'min-w-0 max-w-28 shrink-0 bg-muted/80 text-foreground/85')}>
                  <ConnectionText text={profile.group} />
                </Badge>
              )}
              {tags[0] && (
                <Badge variant="outline" className={cn(WORKBENCH_TABLE_TAG_CLASS, 'min-w-0 max-w-24 shrink border-app-border/75 text-muted-foreground')}>
                  <ConnectionText text={tags[0]} />
                </Badge>
              )}
              {tags.length > 1 && (
                <Popover>
                  <PopoverTrigger
                    aria-label={t('workbench.connections.moreTags', { count: tags.length })}
                    render={<Badge variant="outline" className={cn(WORKBENCH_TABLE_TAG_CLASS, 'border-app-border/75 text-muted-foreground hover:text-foreground')} render={<button type="button" />} />}
                  >
                    <span>+{tags.length - 1}</span>
                  </PopoverTrigger>
                  <PopoverContent align="end">
                    <PopoverTitle>{t('connection.form.tags')}</PopoverTitle>
                    <div className="flex flex-wrap gap-1">
                      {tags.map((tag) => (
                        <Badge key={tag} variant="outline" className="min-w-0 max-w-24">
                          <ConnectionText text={tag} />
                        </Badge>
                      ))}
                    </div>
                  </PopoverContent>
                </Popover>
              )}
            </div>
          ) : (
            <span className="text-muted-foreground/40" aria-hidden="true">—</span>
          )}
        </TableCell>
        <TableCell className={cn(WORKBENCH_TABLE_CELL_CLASS, 'hidden @min-[62rem]:table-cell')} data-slot="connection-notes">
          {profile.notes?.trim() ? (
            <ConnectionText text={profile.notes} kind="notes" className="text-xs text-muted-foreground" />
          ) : (
            <span className="text-muted-foreground/40" aria-hidden="true">—</span>
          )}
        </TableCell>
        <TableCell className={WORKBENCH_TABLE_ACTION_CELL_CLASS}>
          <ConnectionActions
            profile={profile}
            displayName={displayName}
            menuAlign="end"
            compact
            onEdit={onEdit}
            onDelete={onDelete}
            onConnectTerminal={onConnectTerminal}
            onConnectSftp={onConnectSftp}
            onOpenHealth={onOpenHealth}
            onDuplicate={onDuplicate}
            onToggleFavorite={onToggleFavorite}
            onOverview={onOverview}
            onPortForward={onPortForward}
            onQuickActions={onQuickActions}
          />
        </TableCell>
      </TableRow>
    );
  },
);

const ConnectionTable: React.FC<ConnectionTableProps> = ({
  profiles,
  sort,
  onSort,
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

  return (
    <WorkbenchTableFrame slot="connection-table">
      <Table
        aria-label={t('workbench.connections.title')}
        containerClassName="overflow-visible"
        className="table-fixed text-xs"
      >
        <TableHeader className={WORKBENCH_TABLE_HEADER_CLASS}>
          <TableRow className={WORKBENCH_TABLE_HEADER_ROW_CLASS}>
            <WorkbenchSortableHead
              column="name"
              label={t('workbench.connections.table.name')}
              sort={sort}
              onSort={onSort}
            />
            <WorkbenchSortableHead
              column="address"
              label={t('workbench.connections.table.address')}
              sort={sort}
              onSort={onSort}
              className="hidden @min-[36rem]:table-cell @min-[36rem]:w-[38%] @min-[44rem]:w-[30%] @min-[52rem]:w-[25%] @min-[62rem]:w-[22%]"
            />
            <WorkbenchSortableHead
              column="auth"
              label={t('workbench.connections.table.auth')}
              sort={sort}
              onSort={onSort}
              className="hidden w-28 @min-[52rem]:table-cell"
            />
            <WorkbenchSortableHead
              column="group"
              label={t('workbench.connections.table.organization')}
              sort={sort}
              onSort={onSort}
              className="hidden @min-[44rem]:table-cell @min-[44rem]:w-[24%] @min-[52rem]:w-[21%] @min-[62rem]:w-[17%]"
            />
            <TableHead className={cn(WORKBENCH_TABLE_HEAD_CLASS, 'hidden @min-[62rem]:table-cell @min-[62rem]:w-[16%]')}>
              {t('workbench.connections.table.notes')}
            </TableHead>
            <TableHead className={cn(WORKBENCH_TABLE_HEAD_CLASS, 'w-[7.25rem] text-right')}>
              {t('workbench.connections.table.actions')}
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody className="[&_tr:last-child]:border-b">
          {profiles.map((profile) => (
            <ConnectionTableRow
              key={profile.id}
              profile={profile}
              onEdit={onEdit}
              onDelete={onDelete}
              onConnectTerminal={onConnectTerminal}
              onConnectSftp={onConnectSftp}
              onOpenHealth={onOpenHealth}
              onDuplicate={onDuplicate}
              onToggleFavorite={onToggleFavorite}
              onOverview={onOverview}
              onPortForward={onPortForward}
              onQuickActions={onQuickActions}
            />
          ))}
        </TableBody>
      </Table>
    </WorkbenchTableFrame>
  );
};
