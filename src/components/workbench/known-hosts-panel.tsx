import React, { useEffect, useState } from 'react';
import { useI18n } from '@/hooks/useI18n';
import { useToast } from '@/hooks/useToast';
import { useKnownHostsStore } from '@/stores/knownHostsStore';
import { PanelEmptyState, PanelLoadingState } from '@/components/ui/empty-state';
import { Button } from '@/components/ui/button';
import { ResponsiveCardGrid } from '@/components/ui/responsive-card-grid';
import { ScrollArea } from '@/components/ui/scroll-area';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ConfirmDeleteDialog } from '@/components/ui/confirm-delete-dialog';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  CircleAlertIcon,
  FingerprintIcon,
  PlusIcon,
  SearchXIcon,
  ShieldCheckIcon,
  Trash2Icon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { IconActionButton } from './icon-action-button';
import { ManagementCard, ManagementCardIcon } from './management-card';
import { MANAGEMENT_CARD_MIN_WIDTH, keyTypeBadgeClass } from './shared';
import {
  WorkbenchPage,
  WorkbenchPageContent,
  WorkbenchPageHeader,
  WorkbenchSearchInput,
} from './workbench-page';

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
      <WorkbenchPage>
        <WorkbenchPageHeader
          icon={ShieldCheckIcon}
          title={t('workbench.knownHosts.title')}
          description={t('workbench.knownHosts.count', {
            count: filteredHosts.length,
            total: hosts.length,
          })}
          actions={(
            <>
              <WorkbenchSearchInput
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t('workbench.knownHosts.searchPlaceholder')}
                aria-label={t('workbench.knownHosts.searchPlaceholder')}
              />
              <Button variant="outline" size="sm" onClick={loadHosts}>
                {t('common.refresh')}
              </Button>
            </>
          )}
        />
        <ScrollArea className="min-h-0 flex-1">
          <WorkbenchPageContent>
        {error && (
          <Alert variant="destructive">
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
          </WorkbenchPageContent>
        </ScrollArea>
      </WorkbenchPage>
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
    </TooltipProvider>
  );
};
