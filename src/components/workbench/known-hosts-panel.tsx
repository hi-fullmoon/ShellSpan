import React, { useEffect, useState } from 'react';
import { useI18n } from '@/hooks/useI18n';
import { useKnownHostsStore } from '@/stores/knownHostsStore';
import { EmptyState, Spinner } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { ResponsiveCardGrid } from '@/components/ui/responsive-card-grid';
import { TooltipProvider } from '@/components/ui/tooltip';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  FingerprintIcon,
  RefreshCwIcon,
  ShieldCheckIcon,
  Trash2Icon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { IconActionButton } from './icon-action-button';
import { ManagementCard, ManagementCardIcon } from './management-card';

const KEY_TYPE_BADGE_STYLES: Record<string, string> = {
  ED25519: 'bg-app-primary/10 text-app-primary',
  ECDSA: 'bg-violet-500/10 text-violet-600 dark:text-violet-400',
  RSA: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
};

const keyTypeBadgeClass = (keyType: string): string =>
  KEY_TYPE_BADGE_STYLES[keyType.toUpperCase()] ??
  'bg-app-surface-muted text-muted-foreground';

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
    <TooltipProvider>
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
          <IconActionButton
            className="size-7 text-app-text hover:bg-app-text/10"
            aria-label={t('common.refresh')}
            tooltip={t('common.refresh')}
            onClick={loadHosts}
          >
            <RefreshCwIcon
              data-icon="inline-start"
              className={cn(loading && 'animate-spin')}
            />
          </IconActionButton>
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
              <ManagementCard key={`${host.host}:${host.port}`}>
                <div className="flex items-center gap-2.5">
                  <ManagementCardIcon>
                    <ShieldCheckIcon />
                  </ManagementCardIcon>
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <span className="truncate text-[13px] font-medium leading-tight text-app-text">
                      {host.host}:{host.port}
                    </span>
                    <span
                      className={cn(
                        'w-fit rounded-md px-1.5 py-0.5 text-[10px] font-medium leading-none tracking-wide',
                        keyTypeBadgeClass(host.keyType),
                      )}
                    >
                      {host.keyType}
                    </span>
                  </div>
                  <IconActionButton
                    onClick={() => confirmRemove(host.host, host.port)}
                    aria-label={t('common.delete')}
                    tooltip={t('common.delete')}
                    className="opacity-0 focus-visible:opacity-100 group-hover:opacity-100"
                  >
                    <Trash2Icon
                      data-icon="inline-start"
                      className="text-destructive"
                    />
                  </IconActionButton>
                </div>
                <div className="flex items-start gap-2 rounded-md border border-app-border/60 bg-muted/60 px-2.5 py-2">
                  <FingerprintIcon className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground" />
                  <div className="min-w-0">
                    <div className="text-[10px] font-medium uppercase leading-tight tracking-[0.08em] text-muted-foreground">
                      {t('workbench.knownHosts.fingerprint')}
                    </div>
                    <div className="mt-0.5 break-all font-mono text-[11px] leading-relaxed text-app-text">
                      {host.fingerprint}
                    </div>
                  </div>
                </div>
              </ManagementCard>
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
    </TooltipProvider>
  );
};
