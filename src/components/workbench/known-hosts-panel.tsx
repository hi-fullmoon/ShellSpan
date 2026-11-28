import React, { useEffect, useMemo, useState } from 'react';
import { useI18n } from '@/hooks/useI18n';
import { useToast } from '@/hooks/useToast';
import { useKnownHostsStore } from '@/stores/knownHostsStore';
import { PanelEmptyState, PanelLoadingState } from '@/components/ui/empty-state';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from '@/components/ui/popover';
import { CopyButton } from '@/components/ui/copy-button';
import type { KnownHostEntry } from '@/types';
import { ResponsiveCardGrid } from '@/components/ui/responsive-card-grid';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ConfirmDeleteDialog } from '@/components/ui/confirm-delete-dialog';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  CircleAlertIcon,
  InfoIcon,
  FingerprintIcon,
  PlusIcon,
  RefreshCwIcon,
  SearchXIcon,
  ShieldCheckIcon,
  Trash2Icon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { IconActionButton } from './icon-action-button';
import { ManagementCard, ManagementCardIcon, ManagementCardText } from './management-card';
import { MANAGEMENT_CARD_MIN_WIDTH } from './shared';
import {
  WorkbenchPage,
  WorkbenchPageContent,
  WorkbenchPageHeader,
  WorkbenchPageToolbar,
  WorkbenchSearchInput,
} from './workbench-page';
import {
  WORKBENCH_TABLE_ACTION_GROUP_CLASS,
  WORKBENCH_TABLE_CELL_CLASS,
  WORKBENCH_TABLE_COMPACT_ACTION_CELL_CLASS,
  WORKBENCH_TABLE_DESTRUCTIVE_ICON_BUTTON_CLASS,
  WORKBENCH_TABLE_HEAD_CLASS,
  WORKBENCH_TABLE_HEADER_ROW_CLASS,
  WORKBENCH_TABLE_ICON_BUTTON_CLASS,
  WORKBENCH_TABLE_ROW_CLASS,
  WORKBENCH_TABLE_TAG_CLASS,
  WORKBENCH_VIEW_STORAGE_KEYS,
  WorkbenchSortableHead,
  WorkbenchTableFrame,
  WorkbenchViewModeToggle,
  nextWorkbenchTableSort,
  useWorkbenchViewMode,
  type WorkbenchTableSort,
} from './workbench-view-mode';

type KnownHostSortColumn = 'host';

export interface KnownHostsPanelProps {
  onCreateConnection?: (host: string, port: number) => void;
}

export const KnownHostsPanel: React.FC<KnownHostsPanelProps> = ({
  onCreateConnection,
}) => {
  const { t, locale } = useI18n();
  const { error: showError } = useToast();
  const { hosts, loading, error, loadHosts, removeHost } = useKnownHostsStore();
  const [removing, setRemoving] = React.useState<{
    host: string;
    port: number;
  } | null>(null);
  const [query, setQuery] = useState('');
  const [viewMode, setViewMode] = useWorkbenchViewMode(WORKBENCH_VIEW_STORAGE_KEYS.knownHosts);
  const [tableSort, setTableSort] = useState<WorkbenchTableSort<KnownHostSortColumn> | null>(null);

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
  const groupedHosts = new Map<string, { host: string; port: number; keys: KnownHostEntry[] }>();
  for (const host of filteredHosts) {
    const id = JSON.stringify([host.host, host.port]);
    const group = groupedHosts.get(id);
    if (group) group.keys.push(host);
    else groupedHosts.set(id, { host: host.host, port: host.port, keys: [host] });
  }
  const groupedHostList = Array.from(groupedHosts.values());
  const tableHosts = useMemo(() => {
    if (viewMode !== 'table' || !tableSort) return groupedHostList;
    const collator = new Intl.Collator(locale || 'en-US', { numeric: true, sensitivity: 'base' });
    const direction = tableSort.direction === 'asc' ? 1 : -1;
    return [...groupedHostList].sort((left, right) => {
      const hostCompare = collator.compare(left.host, right.host);
      if (hostCompare !== 0) return direction * hostCompare;
      return direction * (left.port - right.port);
    });
  }, [groupedHostList, locale, tableSort, viewMode]);

  return (
    <TooltipProvider>
      <WorkbenchPage>
        <WorkbenchPageHeader
          icon={ShieldCheckIcon}
          title={t('workbench.knownHosts.title')}
          titleMeta={(
            <Popover>
              <PopoverTrigger render={<Button variant="ghost" size="icon-xs" className="size-5 text-muted-foreground" aria-label={t('workbench.knownHosts.help')} />}>
                <InfoIcon />
              </PopoverTrigger>
              <PopoverContent align="start" className="max-w-[calc(100vw-2rem)]">
                <PopoverTitle>{t('workbench.knownHosts.help')}</PopoverTitle>
                <div className="flex flex-col gap-3 text-xs text-muted-foreground">
                  <p>{t('workbench.knownHosts.description')}</p>
                  <section className="flex flex-col gap-1">
                    <h3 className="font-medium text-foreground">{t('workbench.knownHosts.verifyTitle')}</h3>
                    <p>{t('workbench.knownHosts.verifyDescription')}</p>
                  </section>
                  <section className="flex flex-col gap-1">
                    <h3 className="font-medium text-foreground">{t('workbench.knownHosts.changedTitle')}</h3>
                    <p>{t('workbench.knownHosts.changedDescription')}</p>
                  </section>
                </div>
              </PopoverContent>
            </Popover>
          )}
          description={t(normalizedQuery ? 'workbench.knownHosts.filteredCount' : 'workbench.knownHosts.count', {
            hosts: groupedHosts.size,
            keys: filteredHosts.length,
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
              <Button variant="outline" size="sm" onClick={loadHosts} disabled={loading}>
                <RefreshCwIcon data-icon="inline-start" className={cn(loading && 'animate-spin')} />
                {t('common.refresh')}
              </Button>
            </>
          )}
        />
        {hosts.length > 0 && (
          <WorkbenchPageToolbar className="flex-row flex-wrap items-center gap-1.5">
            <WorkbenchViewModeToggle value={viewMode} onChange={setViewMode} />
          </WorkbenchPageToolbar>
        )}
        <ScrollArea className="min-h-0 flex-1">
          <WorkbenchPageContent
            className={cn(
              viewMode === 'table' && filteredHosts.length > 0 && 'p-0',
            )}
          >
        {error && (
          <Alert variant="destructive">
            <CircleAlertIcon />
            <AlertTitle>{t('workbench.knownHosts.loadFailed')}</AlertTitle>
            <AlertDescription>
              <p>{t('common.loadFailedDescription')}</p>
              <details className="mt-1">
                <summary className="cursor-default text-xs">{t('common.errorDetails')}</summary>
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
        {filteredHosts.length > 0 && viewMode === 'table' && (
          <WorkbenchTableFrame slot="known-hosts-table">
            <Table aria-label={t('workbench.knownHosts.title')} className="table-fixed text-xs">
              <TableHeader className="sticky top-0 z-10 bg-background">
                <TableRow className={WORKBENCH_TABLE_HEADER_ROW_CLASS}>
                  <WorkbenchSortableHead
                    column="host"
                    label={t('workbench.knownHosts.table.host')}
                    sort={tableSort}
                    onSort={(column) => setTableSort((current) => nextWorkbenchTableSort(current, column))}
                    className="@min-[40rem]:w-[30%] @min-[56rem]:w-[26%]"
                  />
                  <TableHead className={cn(WORKBENCH_TABLE_HEAD_CLASS, 'hidden @min-[40rem]:table-cell')}>
                    {t('workbench.knownHosts.table.keys')}
                  </TableHead>
                  <TableHead className={cn(WORKBENCH_TABLE_HEAD_CLASS, 'w-[5.25rem] text-right')}>
                    {t('workbench.knownHosts.table.actions')}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody className="[&_tr:last-child]:border-b">
                {tableHosts.map((host) => (
                  <TableRow
                    key={`${host.host}:${host.port}`}
                    data-slot="known-hosts-table-row"
                    className={WORKBENCH_TABLE_ROW_CLASS}
                  >
                    <TableCell className={cn(WORKBENCH_TABLE_CELL_CLASS, 'align-top')}>
                      <div className="flex min-w-0 items-center gap-2">
                        <ShieldCheckIcon
                          className="size-4 shrink-0 text-muted-foreground/75 transition-colors group-hover:text-foreground"
                          aria-hidden
                        />
                        <div className="flex min-w-0 flex-1 flex-col gap-1">
                          <ManagementCardText
                            text={`${host.host}:${host.port}`}
                            className="font-mono text-[13px] font-medium tabular-nums text-foreground"
                          />
                          <div className="flex flex-col gap-1 @min-[40rem]:hidden">
                            {host.keys.map((key) => {
                              const prefix = `${key.keyType} `;
                              const fingerprint = key.fingerprint.startsWith(prefix)
                                ? key.fingerprint.slice(prefix.length)
                                : key.fingerprint;
                              return (
                                <div key={`${key.keyType}:${key.fingerprint}`} className="flex min-w-0 items-center gap-1">
                                  <Badge variant="secondary" size="sm" className={cn(WORKBENCH_TABLE_TAG_CLASS, 'shrink-0 bg-muted/80 font-mono text-[10px] text-foreground/85')}>
                                    {key.keyType}
                                  </Badge>
                                  <ManagementCardText
                                    text={fingerprint}
                                    className="flex-1 font-mono text-[11px] text-muted-foreground"
                                  />
                                  <CopyButton
                                    text={fingerprint}
                                    label={t('workbench.knownHosts.copyFingerprint', { keyType: key.keyType })}
                                    errorLabel={t('workbench.knownHosts.copyFailed')}
                                    iconOnly
                                    size="icon-xs"
                                    className="size-6! shrink-0 text-muted-foreground opacity-75 hover:text-foreground group-hover:opacity-100"
                                  />
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className={cn(WORKBENCH_TABLE_CELL_CLASS, 'hidden @min-[40rem]:table-cell')}>
                      <div className="flex min-w-0 flex-col gap-1">
                        {host.keys.map((key) => {
                          const prefix = `${key.keyType} `;
                          const fingerprint = key.fingerprint.startsWith(prefix)
                            ? key.fingerprint.slice(prefix.length)
                            : key.fingerprint;
                          return (
                            <div key={`${key.keyType}:${key.fingerprint}`} className="flex min-w-0 items-center gap-1.5">
                              <Badge variant="secondary" size="sm" className={cn(WORKBENCH_TABLE_TAG_CLASS, 'shrink-0 bg-muted/80 font-mono text-[10px] text-foreground/85')}>
                                {key.keyType}
                              </Badge>
                              <ManagementCardText
                                text={fingerprint}
                                className="flex-1 font-mono text-[11px] text-muted-foreground"
                              />
                              <CopyButton
                                text={fingerprint}
                                label={t('workbench.knownHosts.copyFingerprint', { keyType: key.keyType })}
                                errorLabel={t('workbench.knownHosts.copyFailed')}
                                iconOnly
                                size="icon-xs"
                                className="size-6! shrink-0 text-muted-foreground opacity-70 hover:text-foreground group-hover:opacity-100"
                              />
                            </div>
                          );
                        })}
                      </div>
                    </TableCell>
                    <TableCell className={cn(WORKBENCH_TABLE_COMPACT_ACTION_CELL_CLASS, 'align-top')}>
                      <div className={WORKBENCH_TABLE_ACTION_GROUP_CLASS}>
                        {onCreateConnection && (
                          <IconActionButton
                            className={WORKBENCH_TABLE_ICON_BUTTON_CLASS}
                            onClick={() => onCreateConnection(host.host, host.port)}
                            aria-label={t('workbench.knownHosts.createConnection')}
                            tooltip={t('workbench.knownHosts.createConnection')}
                          >
                            <PlusIcon data-icon="inline-start" />
                          </IconActionButton>
                        )}
                        <IconActionButton
                          className={WORKBENCH_TABLE_DESTRUCTIVE_ICON_BUTTON_CLASS}
                          onClick={() => confirmRemove(host.host, host.port)}
                          aria-label={t('common.delete')}
                          tooltip={t('common.delete')}
                        >
                          <Trash2Icon data-icon="inline-start" />
                        </IconActionButton>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </WorkbenchTableFrame>
        )}
        {filteredHosts.length > 0 && viewMode === 'card' && (
          <ResponsiveCardGrid
            columns={1}
            minColumnWidth={MANAGEMENT_CARD_MIN_WIDTH}
            gap="0.5rem"
          >
            {groupedHostList.map((host) => (
              <ManagementCard key={`${host.host}:${host.port}`}>
                <div className="flex items-center gap-2.5">
                  <ManagementCardIcon>
                    <ShieldCheckIcon />
                  </ManagementCardIcon>
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <span className="truncate text-[13px] font-medium leading-tight text-app-text">
                      {host.host}:{host.port}
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
                {host.keys.map((key) => {
                  const prefix = `${key.keyType} `;
                  const fingerprint = key.fingerprint.startsWith(prefix)
                    ? key.fingerprint.slice(prefix.length)
                    : key.fingerprint;
                  return (
                    <div key={`${key.keyType}:${key.fingerprint}`} className="group/fingerprint relative flex items-start gap-1 rounded-md border border-app-border/60 bg-muted/60 px-2.5 py-2">
                      <FingerprintIcon className="mt-0.5 size-3 shrink-0 text-muted-foreground" />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1">
                          <Badge variant="secondary" size="sm">{key.keyType}</Badge>
                          <span className="text-[10px] text-muted-foreground">{t('workbench.knownHosts.fingerprint')}</span>
                        </div>
                        <div className="mt-0.5 break-all font-mono text-[11px] leading-relaxed text-app-text">
                          {fingerprint}
                        </div>
                      </div>
                      <CopyButton
                        text={fingerprint}
                        label={t('workbench.knownHosts.copyFingerprint', { keyType: key.keyType })}
                        errorLabel={t('workbench.knownHosts.copyFailed')}
                        iconOnly
                        size="icon-xs"
                        className="absolute right-1 top-1 size-6! text-muted-foreground opacity-0 group-hover/fingerprint:opacity-100 focus-visible:opacity-100"
                      />
                    </div>
                  );
                })}
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
