import React, { useMemo, useState } from 'react';
import { useI18n } from '@/hooks/useI18n';
import { useDebouncedCallback } from '@/hooks/useDebouncedCallback';
import { Button } from '@/components/ui/button';
import { PanelEmptyState, PanelLoadingState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { ResponsiveCardGrid } from '@/components/ui/responsive-card-grid';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { IconActionButton } from './icon-action-button';
import { ManagementCard, ManagementCardIcon } from './management-card';
import { HostOverviewDialog } from './host-overview-dialog';
import { PortForwardDialog } from './port-forward-dialog';
import type { ConnectionProfile } from '@/types';
import { useRecentProfilesStore } from '@/stores/recentProfilesStore';
import {
  CopyIcon,
  FolderIcon,
  MonitorIcon,
  PencilIcon,
  PlusIcon,
  SearchIcon,
  SearchXIcon,
  TerminalIcon,
  Trash2Icon,
  UploadIcon,
  DownloadIcon,
  StarIcon,
  InfoIcon,
  CableIcon,
} from 'lucide-react';

const CARD_ACTION_DEBOUNCE_MS = 500;
const CONNECTION_CARD_BREAKPOINTS = [
  { minWidth: 640, columns: 2 },
  { minWidth: 900, columns: 3 },
] as const;

export interface ConnectionListProps {
  profiles: ConnectionProfile[];
  initialized: boolean;
  onAdd: () => void;
  onEdit: (profile: ConnectionProfile) => void;
  onDelete: (profile: ConnectionProfile) => void;
  onConnectTerminal: (profile: ConnectionProfile) => void;
  onConnectSftp: (profile: ConnectionProfile) => void;
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
  const recentIds = useRecentProfilesStore((state) => state.recentIds);

  const groups = useMemo(() => [...new Set(
    profiles.map((profile) => profile.group?.trim()).filter((group): group is string => Boolean(group)),
  )].sort((left, right) => left.localeCompare(right)), [profiles]);

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

  if (profiles.length === 0) {
    if (!initialized) {
      return <PanelLoadingState />;
    }
    return (
      <PanelEmptyState
        title={t('workbench.connections.empty')}
        description={t('workbench.connections.emptyDescription')}
        icon={<MonitorIcon className="size-5" />}
        action={
          <div className="flex gap-2">
            <Button variant="outline" size="default" onClick={onImport}>
              <UploadIcon data-icon="inline-start" />
              {t('workbench.connections.import')}
            </Button>
            <Button variant="default" size="default" onClick={onAdd}>
              <PlusIcon data-icon="inline-start" />
              {t('workbench.connections.new')}
            </Button>
          </div>
        }
      />
    );
  }

  return (
    <TooltipProvider>
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex shrink-0 flex-col gap-2 border-b border-app-border/50 px-3 py-1.5 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <div className="text-sm font-medium text-app-text">
              {t('workbench.connections.title')}
            </div>
            <div className="text-[11px] text-muted-foreground">
              {t('workbench.connections.count', {
                count: filteredProfiles.length,
                total: profiles.length,
              })}
            </div>
          </div>
          <div className="flex w-full items-center gap-2 sm:w-auto">
            <div className="relative min-w-0 flex-1 sm:w-64">
              <SearchIcon className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t('workbench.connections.searchPlaceholder')}
                aria-label={t('workbench.connections.searchPlaceholder')}
                className="h-8 pl-7"
              />
            </div>
            <Button variant="outline" size="sm" onClick={onImport} aria-label={t('workbench.connections.import')}>
              <UploadIcon />
            </Button>
            <Button variant="outline" size="sm" onClick={onExport} aria-label={t('workbench.connections.export')}>
              <DownloadIcon />
            </Button>
            <Button variant="default" size="sm" onClick={onAdd}>
              {t('workbench.connections.new')}
            </Button>
          </div>
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-app-border/50 px-3 py-1.5">
          {(['all', 'favorites', 'recent'] as const).map((filter) => (
            <Button
              key={filter}
              variant={activityFilter === filter ? 'secondary' : 'ghost'}
              size="xs"
              onClick={() => setActivityFilter(filter)}
            >
              {t(`workbench.connections.filter.${filter}`)}
            </Button>
          ))}
          {groups.length > 0 && (
            <Select value={groupFilter} onValueChange={(value) => setGroupFilter(value ?? 'all')}>
              <SelectTrigger size="sm" className="ml-auto w-40" aria-label={t('workbench.connections.groupFilter')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t('workbench.connections.allGroups')}</SelectItem>
                {groups.map((group) => <SelectItem key={group} value={group}>{group}</SelectItem>)}
              </SelectContent>
            </Select>
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {filteredProfiles.length === 0 ? (
            <PanelEmptyState
              title={t('workbench.connections.filteredEmpty')}
              description={t('common.noSearchResults')}
              icon={<SearchXIcon className="size-5" />}
            />
          ) : (
            <ResponsiveCardGrid
              columns={1}
              breakpoints={CONNECTION_CARD_BREAKPOINTS}
              gap="0.375rem"
            >
              {filteredProfiles.map((profile) => (
                <ConnectionCard
                  key={profile.id}
                  profile={profile}
                  onEdit={onEdit}
                  onDelete={onDelete}
                  onConnectTerminal={onConnectTerminal}
                  onConnectSftp={onConnectSftp}
                  onDuplicate={onDuplicate}
                  onToggleFavorite={onToggleFavorite}
                  onOverview={setOverviewProfile}
                  onPortForward={setForwardProfile}
                />
              ))}
            </ResponsiveCardGrid>
          )}
        </div>
      </div>
      <HostOverviewDialog profile={overviewProfile} onClose={() => setOverviewProfile(undefined)} />
      <PortForwardDialog profile={forwardProfile} onClose={() => setForwardProfile(undefined)} />
    </TooltipProvider>
  );
};

interface ConnectionCardProps {
  profile: ConnectionProfile;
  onEdit: (profile: ConnectionProfile) => void;
  onDelete: (profile: ConnectionProfile) => void;
  onConnectTerminal: (profile: ConnectionProfile) => void;
  onConnectSftp: (profile: ConnectionProfile) => void;
  onDuplicate: (profile: ConnectionProfile) => void;
  onToggleFavorite: (profile: ConnectionProfile) => void;
  onOverview: (profile: ConnectionProfile) => void;
  onPortForward: (profile: ConnectionProfile) => void;
}

const ConnectionCard = React.memo<ConnectionCardProps>(({
  profile,
  onEdit,
  onDelete,
  onConnectTerminal,
  onConnectSftp,
  onDuplicate,
  onToggleFavorite,
  onOverview,
  onPortForward,
}) => {
  const { t } = useI18n();
  const handleConnectTerminal = useDebouncedCallback(
    () => onConnectTerminal(profile),
    CARD_ACTION_DEBOUNCE_MS,
  );
  const handleConnectSftp = useDebouncedCallback(
    () => onConnectSftp(profile),
    CARD_ACTION_DEBOUNCE_MS,
  );
  const handleEdit = useDebouncedCallback(() => onEdit(profile), CARD_ACTION_DEBOUNCE_MS);
  const handleDuplicate = useDebouncedCallback(
    () => onDuplicate(profile),
    CARD_ACTION_DEBOUNCE_MS,
  );
  const handleDelete = useDebouncedCallback(() => onDelete(profile), CARD_ACTION_DEBOUNCE_MS);
  const handleToggleFavorite = useDebouncedCallback(
    () => onToggleFavorite(profile),
    CARD_ACTION_DEBOUNCE_MS,
  );

  return (
    <ManagementCard>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-2">
          <ManagementCardIcon>
            <MonitorIcon />
          </ManagementCardIcon>
          <div className="flex min-w-0 flex-col">
            <span className="truncate text-sm font-medium text-app-text">
              {profile.name}
            </span>
            <span className="truncate text-xs text-muted-foreground">
              {profile.username}@{profile.host}:{profile.port}
            </span>
          </div>
        </div>
        <div className="flex flex-wrap gap-1">
          <Badge variant={profile.authMethod === 'password' ? 'secondary' : 'outline'}>
            {profile.authMethod === 'password'
              ? t('connection.form.auth.password')
              : t('connection.form.auth.key')}
          </Badge>
          {profile.jumpHost && (
            <Badge variant="outline">
              {t('connection.form.jumpHost')}
            </Badge>
          )}
          {profile.group && <Badge variant="secondary">{profile.group}</Badge>}
          {(profile.tags ?? []).map((tag) => <Badge key={tag} variant="outline">{tag}</Badge>)}
        </div>
      </div>
      {profile.notes && (
        <p className="line-clamp-2 text-xs text-muted-foreground" title={profile.notes}>
          {profile.notes}
        </p>
      )}
      {profile.jumpHost && (
        <div className="rounded-lg border border-app-border bg-muted px-2.5 py-2">
          <div className="text-[10px] uppercase tracking-[0.08em] text-muted-foreground">
            {t('connection.form.jumpHost')}
          </div>
          <div className="truncate text-xs text-app-text">
            {profile.jumpHost.username}@{profile.jumpHost.host}:{profile.jumpHost.port}
          </div>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-1">
        <div className="flex flex-wrap items-center gap-1 sm:justify-end">
          <Button size="xs" onClick={handleConnectTerminal}>
            <TerminalIcon data-icon="inline-start" />
            {t('workbench.connections.connectTerminal')}
          </Button>
          <IconActionButton
            onClick={handleConnectSftp}
            aria-label={t('workbench.connections.connectSftp')}
            tooltip={t('workbench.connections.connectSftp')}
          >
            <FolderIcon data-icon="inline-start" />
          </IconActionButton>
          <IconActionButton
            onClick={() => onPortForward(profile)}
            aria-label={t('portForward.open')}
            tooltip={t('portForward.open')}
          >
            <CableIcon />
          </IconActionButton>
          <IconActionButton
            onClick={() => onOverview(profile)}
            aria-label={t('hostOverview.open')}
            tooltip={t('hostOverview.open')}
          >
            <InfoIcon />
          </IconActionButton>
          <IconActionButton
            onClick={handleToggleFavorite}
            aria-label={profile.favorite
              ? t('workbench.connections.unfavorite')
              : t('workbench.connections.favorite')}
            tooltip={profile.favorite
              ? t('workbench.connections.unfavorite')
              : t('workbench.connections.favorite')}
          >
            <StarIcon className={profile.favorite ? 'fill-current text-app-warning' : undefined} />
          </IconActionButton>
          <IconActionButton
            onClick={handleEdit}
            aria-label={t('common.edit')}
            tooltip={t('common.edit')}
          >
            <PencilIcon data-icon="inline-start" />
          </IconActionButton>
          <IconActionButton
            onClick={handleDuplicate}
            aria-label={t('common.duplicate')}
            tooltip={t('common.duplicate')}
          >
            <CopyIcon data-icon="inline-start" />
          </IconActionButton>
          <IconActionButton
            onClick={handleDelete}
            aria-label={t('common.delete')}
            tooltip={t('common.delete')}
          >
            <Trash2Icon data-icon="inline-start" className="text-app-error" />
          </IconActionButton>
        </div>
      </div>
    </ManagementCard>
  );
});
