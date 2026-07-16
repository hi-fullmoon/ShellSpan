import React, { useState } from 'react';
import { useI18n } from '@/hooks/useI18n';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { ResponsiveCardGrid } from '@/components/ui/responsive-card-grid';
import type { ConnectionProfile } from '@/types';
import { MonitorIcon, PlusIcon, TerminalIcon, FolderIcon, PencilIcon, CopyIcon, Trash2Icon } from 'lucide-react';

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
      <div className="flex h-full items-center justify-center">
        <EmptyState
          title={t('workbench.connections.empty')}
          description={t('workbench.connections.emptyDescription')}
          icon={
            <MonitorIcon className="h-6 w-6" />
          }
          action={
            <Button variant="default" size="default" onClick={onAdd} data-icon="inline-start">
              <PlusIcon />
              {t('workbench.connections.new')}
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-col gap-2 border-b border-app-border px-3 py-2 sm:flex-row sm:items-center sm:justify-between">
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
          <div className="min-w-0 flex-1 sm:w-64">
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('workbench.connections.searchPlaceholder')}
            />
          </div>
          <Button variant="default" size="default" onClick={onAdd}>
            {t('workbench.connections.new')}
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {filteredProfiles.length === 0 ? (
          <div className="flex h-full items-center justify-center">
            <EmptyState title={t('workbench.connections.filteredEmpty')} />
          </div>
        ) : (
          <ResponsiveCardGrid
            columns={1}
            breakpoints={[
              { minWidth: 800, columns: 2 },
              { minWidth: 900, columns: 3 },
            ]}
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

  return (
    <div className="group flex flex-col gap-3 rounded-[10px] border border-app-border bg-app-surface p-3 transition-all hover:border-app-primary/30 hover:shadow-[var(--shadow-card)]">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-2">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-app-primary/10 text-app-primary">
            <MonitorIcon className="h-4 w-4" />
          </div>
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
              : t('connection.form.auth.key')}
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
          <Button
            variant="ghost"
            size="icon"
            onClick={onConnectTerminal}
            title={t('workbench.connections.connectTerminal')}
          >
            <TerminalIcon />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={onConnectSftp}
            title={t('workbench.connections.connectSftp')}
          >
            <FolderIcon />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={onEdit}
            title={t('common.edit')}
          >
            <PencilIcon />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={onDuplicate}
            title={t('common.duplicate')}
          >
            <CopyIcon />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={onDelete}
            title={t('common.delete')}
          >
            <Trash2Icon className="text-app-error" />
          </Button>
        </div>
      </div>
    </div>
  );
};
