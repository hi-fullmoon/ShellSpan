import React, { useEffect, useState } from 'react';
import { useI18n } from '@/hooks/useI18n';
import { useKnownHostsStore } from '@/stores/knownHostsStore';
import { Button } from '@/components/ui/Button';
import { EmptyState, Spinner } from '@/components/ui/EmptyState';
import { Input } from '@/components/ui/Input';
import { ResponsiveCardGrid } from '@/components/ui/ResponsiveCardGrid';
import { AlertDialog } from '@/components/ui/AlertDialog';

export const KnownHostsPanel: React.FC = () => {
  const { t } = useI18n();
  const { hosts, loading, error, loadHosts, removeHost } = useKnownHostsStore();
  const [removing, setRemoving] = React.useState<{
    host: string;
    port: number;
  } | null>(null);
  const [query, setQuery] = useState('');

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

  const normalizedQuery = query.trim().toLowerCase();
  const filteredHosts = hosts.filter((host) => {
    if (!normalizedQuery) return true;
    return [host.host, host.keyType, host.fingerprint, String(host.port)]
      .join(' ')
      .toLowerCase()
      .includes(normalizedQuery);
  });

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 flex-col gap-2 border-b border-app-border px-3 py-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <div className="text-sm font-medium text-app-text">
            {t('workbench.knownHosts.title')}
          </div>
          <div className="text-[11px] text-app-text-soft">
            {t('workbench.knownHosts.count', {
              count: filteredHosts.length,
              total: hosts.length,
            })}
          </div>
        </div>
        <div className="flex w-full items-center gap-2 sm:w-auto">
          <div className="min-w-0 flex-1 sm:w-64">
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('workbench.knownHosts.searchPlaceholder')}
            />
          </div>
          <Button variant="secondary" size="sm" onClick={loadHosts}>
            {t('common.refresh')}
          </Button>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto p-2">
        {error && (
          <div className="mb-2 rounded-lg border border-app-error/30 bg-app-error/10 px-3 py-2 text-xs text-app-error">
            {t('workbench.knownHosts.loadFailed')}: {error}
          </div>
        )}
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
        {!loading && hosts.length > 0 && filteredHosts.length === 0 && (
          <div className="flex h-full items-center justify-center">
            <EmptyState title={t('workbench.knownHosts.filteredEmpty')} />
          </div>
        )}
        {filteredHosts.length > 0 && (
          <ResponsiveCardGrid
            columns={1}
            breakpoints={[
              { minWidth: 800, columns: 2 },
              { minWidth: 900, columns: 3 },
            ]}
            gap="0.375rem"
          >
            {filteredHosts.map((host) => (
              <div
                key={`${host.host}:${host.port}`}
                className="group flex flex-col gap-2 rounded-lg border border-app-border bg-app-surface p-2 shadow-[var(--shadow-card)] transition-colors hover:border-app-primary/50"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-app-primary/10 text-app-primary">
                      <svg
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        className="h-3.5 w-3.5"
                      >
                        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                        <path d="M9 12l2 2 4-4" />
                      </svg>
                    </div>
                    <div className="flex min-w-0 flex-col">
                      <span className="truncate text-xs font-medium text-app-text">
                        {host.host}:{host.port}
                      </span>
                      <span className="truncate text-[11px] text-app-text-soft">
                        {t('workbench.knownHosts.keyType')}: {host.keyType}
                      </span>
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => confirmRemove(host.host, host.port)}
                    title={t('common.delete')}
                  >
                    <svg
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      className="h-3.5 w-3.5 text-app-error"
                    >
                      <polyline points="3 6 5 6 21 6" />
                      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                    </svg>
                  </Button>
                </div>
                <div className="rounded-md border border-app-border/80 bg-app-background/40 px-2 py-1.5">
                  <div className="text-[10px] uppercase tracking-[0.08em] text-app-text-soft">
                    {t('workbench.knownHosts.fingerprint')}
                  </div>
                  <div
                    className="break-all font-mono text-[10px] text-app-text"
                    title={host.fingerprint}
                  >
                    {host.fingerprint}
                  </div>
                </div>
              </div>
            ))}
          </ResponsiveCardGrid>
        )}
      </div>
      <AlertDialog
        open={!!removing}
        onClose={() => setRemoving(null)}
        onConfirm={handleRemove}
        title={t('common.delete')}
        description={
          removing
            ? t('workbench.knownHosts.removeConfirm', {
                host: removing.host,
                port: removing.port,
              })
            : ''
        }
        confirmText={t('common.delete')}
        cancelText={t('common.cancel')}
        variant="danger"
      />
    </div>
  );
};
