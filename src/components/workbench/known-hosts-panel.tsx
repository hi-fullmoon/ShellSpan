import React, { useEffect, useState } from 'react';
import { useI18n } from '@/hooks/useI18n';
import { useToast } from '@/hooks/useToast';
import { useKnownHostsStore } from '@/stores/knownHostsStore';
import { PanelEmptyState, PanelLoadingState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { ResponsiveCardGrid } from '@/components/ui/responsive-card-grid';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ConfirmDeleteDialog } from '@/components/ui/confirm-delete-dialog';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  CircleAlertIcon,
  FingerprintIcon,
  PlusIcon,
  RefreshCwIcon,
  SearchIcon,
  SearchXIcon,
  ShieldCheckIcon,
  Trash2Icon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { IconActionButton } from './icon-action-button';
import { ManagementCard, ManagementCardIcon } from './management-card';
import { MANAGEMENT_CARD_MIN_WIDTH, keyTypeBadgeClass } from './shared';

export interface KnownHostsPanelProps {
  onCreateConnection?: (host: string, port: number) => void;
}

export const KnownHostsPanel: React.FC<KnownHostsPanelProps> = ({
  onCreateConnection,
}) => {
  const { t } = useI18n();
  const { error: showError } = useToast();
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
    try {
      await removeHost(removing.host, removing.port);
      setRemoving(null);
    } catch {
      showError(t('workbench.knownHosts.removeFailed'));
    }
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
      <div className="flex shrink-0 flex-col gap-2 border-b border-app-border/50 px-3 py-1.5 sm:flex-row sm:items-center sm:justify-between">
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
          <div className="relative min-w-0 flex-1 sm:w-64">
            <SearchIcon className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('workbench.knownHosts.searchPlaceholder')}
              aria-label={t('workbench.knownHosts.searchPlaceholder')}
              className="h-8 pl-7"
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
          <Alert variant="destructive" className="mb-2">
            <CircleAlertIcon />
            <AlertTitle>{t('workbench.knownHosts.loadFailed')}</AlertTitle>
            <AlertDescription>
              <p>{t('common.loadFailedDescription')}</p>
              <details className="mt-1">
                <summary className="cursor-pointer text-xs">{t('common.errorDetails')}</summary>
                <code className="mt-1 block break-all text-xs">{error}</code>
              </details>
            </AlertDescription>
          </Alert>
        )}
        {loading && hosts.length === 0 && (
          <PanelLoadingState />
        )}
        {!loading && !error && hosts.length === 0 && (
          <PanelEmptyState
            title={t('workbench.knownHosts.empty')}
            description={t('workbench.knownHosts.emptyDescription')}
            icon={<ShieldCheckIcon className="size-5" />}
          />
        )}
        {!loading && hosts.length > 0 && filteredHosts.length === 0 && (
          <PanelEmptyState
            title={t('workbench.knownHosts.filteredEmpty')}
            description={t('common.noSearchResults')}
            icon={<SearchXIcon className="size-5" />}
          />
        )}
        {filteredHosts.length > 0 && (
          <ResponsiveCardGrid
            columns={1}
            minColumnWidth={MANAGEMENT_CARD_MIN_WIDTH}
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
                  {onCreateConnection && (
                    <IconActionButton
                      onClick={() => onCreateConnection(host.host, host.port)}
                      aria-label={t('workbench.knownHosts.createConnection')}
                      tooltip={t('workbench.knownHosts.createConnection')}
                      className="opacity-0 focus-visible:opacity-100 group-hover:opacity-100"
                    >
                      <PlusIcon
                        data-icon="inline-start"
                        className="text-app-primary"
                      />
                    </IconActionButton>
                  )}
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
      <ConfirmDeleteDialog
        open={!!removing}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
        title={t('workbench.knownHosts.removeTitle')}
        description={
          removing
            ? t('workbench.knownHosts.removeConfirm', {
                host: removing.host,
                port: removing.port,
              })
            : ''
        }
        onConfirm={handleRemove}
      />
      </div>
    </TooltipProvider>
  );
};
