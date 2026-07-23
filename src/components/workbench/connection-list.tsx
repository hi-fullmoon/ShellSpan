import React, { useState } from 'react';
import { useI18n } from '@/hooks/useI18n';
import { useDebouncedCallback } from '@/hooks/useDebouncedCallback';
import { Button } from '@/components/ui/button';
import { PanelEmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { ResponsiveCardGrid } from '@/components/ui/responsive-card-grid';
import { TooltipProvider } from '@/components/ui/tooltip';
import { IconActionButton } from './icon-action-button';
import { ManagementCard, ManagementCardIcon } from './management-card';
import type { ConnectionProfile } from '@/types';
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
} from 'lucide-react';

const CARD_ACTION_DEBOUNCE_MS = 500;

export interface ConnectionListProps {
  profiles: ConnectionProfile[];
  onAdd: () => void;
  onEdit: (profile: ConnectionProfile) => void;
  onDelete: (profile: ConnectionProfile) => void;
  onConnectTerminal: (profile: ConnectionProfile) => void;
  onConnectSftp: (profile: ConnectionProfile) => void;
  onDuplicate: (profile: ConnectionProfile) => void;
}

export const ConnectionList: React.FC<ConnectionListProps> = ({
  profiles,
  onAdd,
  onEdit,
  onDelete,
  onConnectTerminal,
  onConnectSftp,
  onDuplicate,
}) => {
  const { t } = useI18n();
  const [query, setQuery] = useState('');

  const normalizedQuery = query.trim().toLowerCase();
  const filteredProfiles = profiles.filter((profile) => {
    if (!normalizedQuery) return true;
    const haystack = [
      profile.name,
      profile.host,
      profile.username,
      String(profile.port),
      profile.jumpHost?.host,
      profile.jumpHost?.username,
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();

    return haystack.includes(normalizedQuery);
  });

  if (profiles.length === 0) {
    return (
      <PanelEmptyState
        title={t('workbench.connections.empty')}
        description={t('workbench.connections.emptyDescription')}
        icon={<MonitorIcon className="size-5" />}
        action={
          <Button
            variant="default"
            size="default"
            onClick={onAdd}
            data-icon="inline-start"
          >
            <PlusIcon data-icon="inline-start" />
            {t('workbench.connections.new')}
          </Button>
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
                className="h-8 pl-7"
              />
            </div>
            <Button variant="default" size="sm" onClick={onAdd}>
              {t('workbench.connections.new')}
            </Button>
          </div>
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
              breakpoints={[
                { minWidth: 800, columns: 2 },
                { minWidth: 900, columns: 3 },
              ]}
              gap="0.375rem"
            >
              {filteredProfiles.map((profile) => (
                <ConnectionCard
                  key={profile.id}
                  profile={profile}
                  onEdit={() => onEdit(profile)}
                  onDelete={() => onDelete(profile)}
                  onConnectTerminal={() => onConnectTerminal(profile)}
                  onConnectSftp={() => onConnectSftp(profile)}
                  onDuplicate={() => onDuplicate(profile)}
                />
              ))}
            </ResponsiveCardGrid>
          )}
        </div>
      </div>
    </TooltipProvider>
  );
};

interface ConnectionCardProps {
  profile: ConnectionProfile;
  onEdit: () => void;
  onDelete: () => void;
  onConnectTerminal: () => void;
  onConnectSftp: () => void;
  onDuplicate: () => void;
}

const ConnectionCard: React.FC<ConnectionCardProps> = ({
  profile,
  onEdit,
  onDelete,
  onConnectTerminal,
  onConnectSftp,
  onDuplicate,
}) => {
  const { t } = useI18n();
  const handleConnectTerminal = useDebouncedCallback(
    onConnectTerminal,
    CARD_ACTION_DEBOUNCE_MS,
  );
  const handleConnectSftp = useDebouncedCallback(
    onConnectSftp,
    CARD_ACTION_DEBOUNCE_MS,
  );
  const handleEdit = useDebouncedCallback(onEdit, CARD_ACTION_DEBOUNCE_MS);
  const handleDuplicate = useDebouncedCallback(
    onDuplicate,
    CARD_ACTION_DEBOUNCE_MS,
  );
  const handleDelete = useDebouncedCallback(onDelete, CARD_ACTION_DEBOUNCE_MS);

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
          <span className="rounded-md bg-app-primary/10 px-2 py-1 text-[10px] text-app-primary">
            {profile.authMethod === 'password'
              ? t('connection.form.auth.password')
              : profile.authMethod === 'keychainKey'
                ? t('connection.form.auth.keychainKey')
                : t('connection.form.auth.keyPath')}
          </span>
          {profile.jumpHost && (
            <span className="rounded-md bg-app-surface-muted px-2 py-1 text-[10px] text-muted-foreground">
              {t('connection.form.jumpHost')}
            </span>
          )}
        </div>
      </div>
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
          <IconActionButton
            onClick={handleConnectTerminal}
            aria-label={t('workbench.connections.connectTerminal')}
            tooltip={t('workbench.connections.connectTerminal')}
          >
            <TerminalIcon data-icon="inline-start" />
          </IconActionButton>
          <IconActionButton
            onClick={handleConnectSftp}
            aria-label={t('workbench.connections.connectSftp')}
            tooltip={t('workbench.connections.connectSftp')}
          >
            <FolderIcon data-icon="inline-start" />
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
};
