import React, { useEffect } from 'react';
import { useI18n } from '@/hooks/useI18n';
import { useKnownHostsStore } from '@/stores/knownHostsStore';
import { Button } from '@/components/ui/Button';
import { EmptyState, Spinner } from '@/components/ui/EmptyState';
import { ConfirmDialog } from '@/components/ui/Dialog';

export const KnownHostsPanel: React.FC = () => {
  const { t } = useI18n();
  const { hosts, loading, loadHosts, removeHost } = useKnownHostsStore();
  const [removing, setRemoving] = React.useState<{
    host: string;
    port: number;
  } | null>(null);

  useEffect(() => {
    loadHosts();
  }, [loadHosts]);

  const confirmRemove = (host: string, port: number): void => {
    setRemoving({ host, port });
  };

  const handleRemove = async (): Promise<void> => {
    if (!removing) return;
    await removeHost(removing.host, removing.port);
    setRemoving(null);
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-9 items-center justify-between border-b border-app-border px-3">
        <span className="text-sm font-medium text-app-text">
          {t('workbench.knownHosts.title')}
        </span>
        <Button variant="secondary" size="sm" onClick={loadHosts}>
          {t('common.refresh')}
        </Button>
      </div>
      <div className="flex-1 overflow-y-auto">
        {loading && hosts.length === 0 && (
          <div className="flex h-full items-center justify-center">
            <Spinner />
          </div>
        )}
        {!loading && hosts.length === 0 && (
          <div className="flex h-full items-center justify-center">
            <EmptyState title={t('workbench.knownHosts.empty')} />
          </div>
        )}
        {hosts.map((host) => (
          <div
            key={`${host.host}:${host.port}`}
            className="flex items-center justify-between border-b border-app-border px-3 py-2 hover:bg-app-surface-muted"
          >
            <div className="flex flex-col">
              <span className="text-xs font-medium text-app-text">
                {host.host}:{host.port}
              </span>
              <span className="font-mono text-[10px] text-app-text-soft">
                {host.keyType} {host.fingerprint}
              </span>
            </div>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => confirmRemove(host.host, host.port)}
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
        ))}
      </div>
      <ConfirmDialog
        open={!!removing}
        onClose={() => setRemoving(null)}
        onConfirm={handleRemove}
        title={t('workbench.knownHosts.title')}
        message={
          removing
            ? t('workbench.knownHosts.removeConfirm', {
                host: removing.host,
                port: removing.port,
              })
            : ''
        }
        confirmText={t('common.delete')}
        cancelText={t('common.cancel')}
      />
    </div>
  );
};
