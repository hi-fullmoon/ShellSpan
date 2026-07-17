import React, { useEffect, useState } from 'react';
import { useI18n } from '@/hooks/useI18n';
import { useKnownHostsStore } from '@/stores/knownHostsStore';
import { Button } from '@/components/ui/button';
import { EmptyState, Spinner } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { ResponsiveCardGrid } from '@/components/ui/responsive-card-grid';
import { AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogAction, AlertDialogCancel } from '@/components/ui/alert-dialog';
import { ShieldCheckIcon, Trash2Icon } from 'lucide-react';

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
      <div className="flex shrink-0 flex-col gap-2 border-b border-app-border px-3 py-1.5 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <div className="text-sm font-medium text-app-text">
            {t('workbench.knownHosts.title')}
          </div>
          <div className="text-[11px] text-muted-foreground">
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
              className="h-8"
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
                className="group flex flex-col gap-2 rounded-[10px] border border-app-border bg-app-surface p-2 transition-all hover:border-app-primary/30 hover:shadow-[var(--shadow-card)]"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-app-primary/10 text-app-primary">
                      <ShieldCheckIcon className="h-3.5 w-3.5" />
                    </div>
                    <div className="flex min-w-0 flex-col">
                      <span className="truncate text-xs font-medium text-app-text">
                        {host.host}:{host.port}
                      </span>
                      <span className="truncate text-[11px] text-muted-foreground">
                        {t('workbench.knownHosts.keyType')}: {host.keyType}
                      </span>
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => confirmRemove(host.host, host.port)}
                    aria-label={t('common.delete')}
                  >
                    <Trash2Icon className="text-destructive" />
                  </Button>
                </div>
                <div className="rounded-md border border-app-border bg-muted px-2 py-1.5">
                  <div className="text-[10px] uppercase tracking-[0.08em] text-muted-foreground">
                    {t('workbench.knownHosts.fingerprint')}
                  </div>
                  <div
                    className="break-all font-mono text-[10px] text-app-text"
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
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
      >
        <AlertDialogContent className="min-w-0 max-w-sm gap-0 overflow-hidden border-app-border bg-app-surface p-0">
          <AlertDialogHeader className="place-items-start px-4 py-2.5 text-left">
            <AlertDialogTitle className="text-sm leading-5">
              {t('workbench.knownHosts.removeTitle')}
            </AlertDialogTitle>
          </AlertDialogHeader>
          <div className="min-w-0 max-w-full overflow-hidden px-4 py-3">
            <AlertDialogDescription className="block min-w-0 max-w-full break-all text-left leading-5 text-app-text">
              {removing
                ? t('workbench.knownHosts.removeConfirm', {
                    host: removing.host,
                    port: removing.port,
                  })
                : ''}
            </AlertDialogDescription>
          </div>
          <AlertDialogFooter className="mx-0 mb-0 rounded-none border-t-0 bg-app-surface px-4 py-2.5">
            <AlertDialogCancel size="sm">
              {t('common.cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              size="sm"
              onClick={handleRemove}
            >
              {t('common.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};
