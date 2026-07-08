import React from 'react';
import { cn } from '@/lib/utils';
import { useI18n } from '@/hooks/useI18n';
import { Button } from '@/components/ui/Button';
import { useSftpStore } from '@/stores/sftpStore';
import { useAppStore } from '@/stores/appStore';

export const SftpTabBar: React.FC = () => {
  const { t } = useI18n();
  const connections = useSftpStore((state) => state.connections);
  const activeConnectionId = useSftpStore((state) => state.activeConnectionId);
  const setActiveConnection = useSftpStore((state) => state.setActiveConnection);
  const removeConnection = useSftpStore((state) => state.removeConnection);
  const setActiveSection = useAppStore((state) => state.setActiveSection);

  return (
    <div className="flex h-9 items-center gap-1 border-b border-app-border bg-app-surface-muted px-2">
      {connections.map((conn) => (
        <button
          key={conn.id}
          onClick={() => setActiveConnection(conn.id)}
          className={cn(
            'group flex h-7 max-w-40 items-center gap-2 rounded-lg px-2.5 text-xs transition-colors',
            activeConnectionId === conn.id
              ? 'bg-app-surface text-app-text shadow-sm'
              : 'text-app-text-soft hover:bg-app-surface/50 hover:text-app-text',
          )}
        >
          <span className="flex-1 truncate text-center">{conn.title}</span>
          <span
            onClick={(e) => {
              e.stopPropagation();
              removeConnection(conn.id);
            }}
            className="hidden h-4 w-4 items-center justify-center rounded hover:bg-app-border group-hover:flex"
          >
            ×
          </span>
        </button>
      ))}
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setActiveSection('workbench')}
        className="ml-auto"
      >
        + {t('sftp.newTab')}
      </Button>
    </div>
  );
};
