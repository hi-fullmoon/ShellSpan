import React, { useState } from 'react';
import { useI18n } from '@/hooks/useI18n';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { ResponsiveCardGrid } from '@/components/ui/responsive-card-grid';
import type { ConnectionProfile } from '@/types';

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
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              className="h-6 w-6"
            >
              <rect x="2" y="3" width="20" height="14" rx="2" />
              <line x1="8" y1="21" x2="16" y2="21" />
              <line x1="12" y1="17" x2="12" y2="21" />
              <line x1="6" y1="8" x2="6.01" y2="8" />
              <line x1="10" y1="8" x2="10.01" y2="8" />
              <line x1="14" y1="8" x2="14.01" y2="8" />
            </svg>
          }
          action={
            <Button variant="primary" size="md" onClick={onAdd}>
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                className="h-3.5 w-3.5"
              >
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
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
          <div className="text-[11px] text-app-text-soft">
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
          <Button variant="primary" size="sm" onClick={onAdd}>
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
    <div className="group flex flex-col gap-3 rounded-xl border border-app-border bg-app-surface p-3 shadow-[var(--shadow-card)] transition-colors hover:border-app-primary/50">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-2">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-app-primary/10 text-app-primary">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              className="h-4 w-4"
            >
              <rect x="2" y="3" width="20" height="14" rx="2" />
              <line x1="8" y1="21" x2="16" y2="21" />
              <line x1="12" y1="17" x2="12" y2="21" />
            </svg>
          </div>
          <div className="flex min-w-0 flex-col">
            <span className="truncate text-sm font-medium text-app-text">
              {profile.name}
            </span>
            <span className="truncate text-xs text-app-text-soft">
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
            <span className="rounded-md bg-app-border/60 px-2 py-1 text-[10px] text-app-text-soft">
              {t('connection.form.jumpHost')}
            </span>
          )}
        </div>
      </div>
      {profile.jumpHost && (
        <div className="rounded-lg border border-app-border/80 bg-app-background/40 px-2.5 py-2">
          <div className="text-[10px] uppercase tracking-[0.08em] text-app-text-soft">
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
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              className="h-4 w-4"
            >
              <polyline points="4 17 10 11 4 5" />
              <line x1="12" y1="19" x2="20" y2="19" />
            </svg>
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={onConnectSftp}
            title={t('workbench.connections.connectSftp')}
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              className="h-4 w-4"
            >
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
            </svg>
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={onEdit}
            title={t('common.edit')}
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              className="h-4 w-4"
            >
              <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
            </svg>
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={onDuplicate}
            title={t('common.duplicate')}
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              className="h-4 w-4"
            >
              <rect x="9" y="9" width="13" height="13" rx="2" />
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
            </svg>
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={onDelete}
            title={t('common.delete')}
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              className="h-4 w-4 text-app-error"
            >
              <polyline points="3 6 5 6 21 6" />
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
            </svg>
          </Button>
        </div>
      </div>
    </div>
  );
};
