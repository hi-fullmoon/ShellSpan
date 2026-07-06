import React from 'react';
import { cn } from '@/lib/utils';
import { useI18n } from '@/hooks/useI18n';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import type { ConnectionProfile } from '@/types';

export interface ConnectionListProps {
  profiles: ConnectionProfile[];
  onEdit: (profile: ConnectionProfile) => void;
  onDelete: (profile: ConnectionProfile) => void;
  onConnectTerminal: (profile: ConnectionProfile) => void;
  onConnectSftp: (profile: ConnectionProfile) => void;
  onDuplicate: (profile: ConnectionProfile) => void;
  onPortForward: (profile: ConnectionProfile) => void;
}

export const ConnectionList: React.FC<ConnectionListProps> = ({
  profiles,
  onEdit,
  onDelete,
  onConnectTerminal,
  onConnectSftp,
  onDuplicate,
  onPortForward,
}) => {
  const { t } = useI18n();

  if (profiles.length === 0) {
    return (
      <div className="flex h-full items-center justify-center">
        <EmptyState title={t('workbench.connections.empty')} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1 overflow-y-auto p-2">
      {profiles.map((profile) => (
        <ConnectionCard
          key={profile.id}
          profile={profile}
          onEdit={() => onEdit(profile)}
          onDelete={() => onDelete(profile)}
          onConnectTerminal={() => onConnectTerminal(profile)}
          onConnectSftp={() => onConnectSftp(profile)}
          onDuplicate={() => onDuplicate(profile)}
          onPortForward={() => onPortForward(profile)}
        />
      ))}
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
  onPortForward: () => void;
}

const ConnectionCard: React.FC<ConnectionCardProps> = ({
  profile,
  onEdit,
  onDelete,
  onConnectTerminal,
  onConnectSftp,
  onDuplicate,
  onPortForward,
}) => {
  const { t } = useI18n();

  return (
    <div className="group flex flex-col gap-2 rounded-xl border border-app-border bg-app-surface p-3 shadow-[var(--shadow-card)] transition-colors hover:border-app-primary/50">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-app-primary/10 text-app-primary">
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
          <div className="flex flex-col">
            <span className="text-sm font-medium text-app-text">
              {profile.name}
            </span>
            <span className="text-xs text-app-text-soft">
              {profile.username}@{profile.host}:{profile.port}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-1">
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
            onClick={onPortForward}
            title="Port forwards"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              className="h-4 w-4"
            >
              <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
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
