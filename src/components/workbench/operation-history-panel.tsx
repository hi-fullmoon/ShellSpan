import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Clock3Icon,
  RefreshCwIcon,
  SearchIcon,
  ShieldCheckIcon,
} from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogDescription,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  CompactDialogContent,
  CompactDialogHeader,
} from '@/components/ui/compact-dialog';
import { Dialog } from '@/components/ui/dialog';
import { EmptyState, PanelLoadingState } from '@/components/ui/empty-state';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group';
import { ScrollArea, ScrollAreaContent } from '@/components/ui/scroll-area';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  CompactAlertDialogBody,
  CompactAlertDialogContent,
  CompactAlertDialogFooter,
  CompactAlertDialogHeader,
  CompactAlertDialogTitle,
} from '@/components/ui/compact-alert-dialog';
import { useI18n } from '@/hooks/useI18n';
import { useToast } from '@/hooks/useToast';
import type { LocaleKey } from '@/locales';
import {
  clearOperationHistory,
  exportOperationHistory,
  getOperationHistorySettings,
  groupOperationHistory,
  listOperationHistory,
  setOperationHistoryRetention,
} from '@/lib/operation-history';
import type {
  OperationHistoryCategory,
  OperationHistoryEvent,
  OperationHistoryFilter,
  OperationHistoryStatus,
  OperationHistoryTask,
} from '@/types/operation-history';
import {
  WorkbenchPage,
  WorkbenchPageContent,
  WorkbenchPageHeader,
  WORKBENCH_SEARCH_WIDTH_CLASS,
} from './workbench-page';

const CATEGORIES: OperationHistoryCategory[] = [
  'connection',
  'terminal',
  'sftp',
  'localFile',
  'portForward',
  'remoteHealth',
  'runbook',
  'multiHost',
];

const STATUSES: OperationHistoryStatus[] = [
  'running',
  'succeeded',
  'partialSuccess',
  'failed',
  'cancelled',
  'timedOut',
  'identityMismatch',
  'unauthorized',
  'rejected',
  'skipped',
  'paused',
  'stopped',
  'recovered',
];

const RETENTION_OPTIONS = [7, 30, 90, 365, 0] as const;

function statusVariant(status: OperationHistoryStatus): 'default' | 'secondary' | 'outline' | 'destructive' {
  if (status === 'succeeded' || status === 'recovered') return 'default';
  if (['failed', 'timedOut', 'identityMismatch', 'unauthorized', 'rejected'].includes(status)) return 'destructive';
  if (['running', 'cancelling', 'partialSuccess', 'paused'].includes(status)) return 'secondary';
  return 'outline';
}

function targetLabel(event: OperationHistoryEvent): string {
  if (event.targets.length === 0) return '—';
  return event.targets.map((target) => target.kind === 'local'
    ? target.sessionId ? `local · ${target.sessionId}` : 'local'
    : `${target.username ? `${target.username}@` : ''}${target.host ?? '?'}:${target.port ?? '?'}`,
  ).join(', ');
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString();
}

export const OperationHistoryPanel: React.FC = () => {
  const { t } = useI18n();
  const { error: showError, success: showSuccess } = useToast();
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState<OperationHistoryCategory | 'all'>('all');
  const [status, setStatus] = useState<OperationHistoryStatus | 'all'>('all');
  const [range, setRange] = useState<'day' | 'week' | 'month' | 'all'>('month');
  const [retentionDays, setRetentionDays] = useState(90);
  const [tasks, setTasks] = useState<OperationHistoryTask[]>([]);
  const [totalTasks, setTotalTasks] = useState(0);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [selected, setSelected] = useState<OperationHistoryTask>();
  const [confirmClear, setConfirmClear] = useState(false);
  const [exporting, setExporting] = useState(false);

  const filter = useMemo<OperationHistoryFilter>(() => ({
    category: category === 'all' ? undefined : category,
    status: status === 'all' ? undefined : status,
    search: search.trim() || undefined,
    from: range === 'all'
      ? undefined
      : Date.now() - {
          day: 86_400_000,
          week: 7 * 86_400_000,
          month: 30 * 86_400_000,
        }[range],
  }), [category, range, search, status]);

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    setLoadError(false);
    try {
      const page = await listOperationHistory(filter);
      setTasks(groupOperationHistory(page.events));
      setTotalTasks(page.totalTasks);
      setTruncated(page.truncated);
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    void getOperationHistorySettings()
      .then((settings) => setRetentionDays(settings.retentionDays))
      .catch(() => setLoadError(true));
  }, []);

  const handleRetentionChange = async (value: string | null): Promise<void> => {
    const next = Number(value);
    if (!RETENTION_OPTIONS.includes(next as (typeof RETENTION_OPTIONS)[number])) return;
    const previous = retentionDays;
    setRetentionDays(next);
    try {
      const removed = await setOperationHistoryRetention(next);
      showSuccess(t('operationHistory.retentionSaved', { count: removed }));
      await refresh();
    } catch {
      setRetentionDays(previous);
      showError(t('operationHistory.retentionFailed'));
    }
  };

  const handleExport = async (format: 'markdown' | 'json'): Promise<void> => {
    setExporting(true);
    try {
      const path = await exportOperationHistory(format, filter);
      if (path) showSuccess(t('operationHistory.exported', { path }));
    } catch {
      showError(t('operationHistory.exportFailed'));
    } finally {
      setExporting(false);
    }
  };

  const handleClear = async (): Promise<void> => {
    try {
      const removed = await clearOperationHistory();
      setConfirmClear(false);
      setSelected(undefined);
      showSuccess(t('operationHistory.cleared', { count: removed }));
      await refresh();
    } catch {
      showError(t('operationHistory.clearFailed'));
    }
  };

  return (
    <WorkbenchPage>
      <WorkbenchPageHeader
        icon={Clock3Icon}
        title={t('operationHistory.title')}
        description={t('operationHistory.description')}
        actions={(
          <>
            <Select value={String(retentionDays)} onValueChange={(value) => void handleRetentionChange(value)}>
              <SelectTrigger
                size="sm"
                aria-label={t('operationHistory.retention')}
                className="w-36 data-[size=sm]:h-8"
              >
                <SelectValue>
                  {retentionDays === 0
                    ? t('operationHistory.retentionForever')
                    : t('operationHistory.retentionDays', { count: retentionDays })}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {RETENTION_OPTIONS.map((days) => (
                    <SelectItem key={days} value={String(days)}>
                      {days === 0
                        ? t('operationHistory.retentionForever')
                        : t('operationHistory.retentionDays', { count: days })}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            <Button variant="outline" size="sm" disabled={exporting} onClick={() => void handleExport('markdown')}>
              Markdown
            </Button>
            <Button variant="outline" size="sm" disabled={exporting} onClick={() => void handleExport('json')}>
              JSON
            </Button>
            <Button variant="outline" size="sm" onClick={() => setConfirmClear(true)}>
              {t('operationHistory.clear')}
            </Button>
          </>
        )}
      />

      <ScrollArea className="min-h-0 flex-1">
        <WorkbenchPageContent>
          <Alert>
            <ShieldCheckIcon />
            <AlertTitle>{t('operationHistory.privacyTitle')}</AlertTitle>
            <AlertDescription>{t('operationHistory.privacyDescription')}</AlertDescription>
          </Alert>

          <div className="flex flex-wrap items-center gap-2">
            <InputGroup className={`h-8 min-w-52 ${WORKBENCH_SEARCH_WIDTH_CLASS}`}>
              <InputGroupAddon>
                <SearchIcon />
              </InputGroupAddon>
              <InputGroupInput
                aria-label={t('operationHistory.search')}
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={t('operationHistory.searchPlaceholder')}
              />
            </InputGroup>
            <Select value={category} onValueChange={(value) => setCategory((value ?? 'all') as OperationHistoryCategory | 'all')}>
              <SelectTrigger
                size="sm"
                aria-label={t('operationHistory.category')}
                className="w-40 data-[size=sm]:h-8"
              >
                <SelectValue>
                  {category === 'all'
                    ? t('operationHistory.allCategories')
                    : t(`operationHistory.category.${category}` as LocaleKey)}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="all">{t('operationHistory.allCategories')}</SelectItem>
                  {CATEGORIES.map((value) => (
                    <SelectItem key={value} value={value}>
                      {t(`operationHistory.category.${value}` as LocaleKey)}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            <Select value={status} onValueChange={(value) => setStatus((value ?? 'all') as OperationHistoryStatus | 'all')}>
              <SelectTrigger
                size="sm"
                aria-label={t('operationHistory.status')}
                className="w-40 data-[size=sm]:h-8"
              >
                <SelectValue>
                  {status === 'all'
                    ? t('operationHistory.allStatuses')
                    : t(`operationHistory.status.${status}` as LocaleKey)}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="all">{t('operationHistory.allStatuses')}</SelectItem>
                  {STATUSES.map((value) => (
                    <SelectItem key={value} value={value}>
                      {t(`operationHistory.status.${value}` as LocaleKey)}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            <Select value={range} onValueChange={(value) => setRange((value ?? 'month') as typeof range)}>
              <SelectTrigger
                size="sm"
                aria-label={t('operationHistory.range')}
                className="w-32 data-[size=sm]:h-8"
              >
                <SelectValue>{t(`operationHistory.range.${range}` as LocaleKey)}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {(['day', 'week', 'month', 'all'] as const).map((value) => (
                    <SelectItem key={value} value={value}>
                      {t(`operationHistory.range.${value}` as LocaleKey)}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            <Button
              variant="ghost"
              size="sm"
              className="size-8"
              aria-label={t('operationHistory.refresh')}
              onClick={() => void refresh()}
            >
              <RefreshCwIcon />
            </Button>
          </div>

          {truncated && (
            <Alert variant="destructive">
              <AlertTitle>{t('operationHistory.truncatedTitle')}</AlertTitle>
              <AlertDescription>{t('operationHistory.truncatedDescription')}</AlertDescription>
            </Alert>
          )}

          <div className="flex min-h-56 flex-1 flex-col">
            {loading ? (
              <PanelLoadingState label={t('operationHistory.loading')} />
            ) : loadError ? (
              <EmptyState
                icon={<RefreshCwIcon />}
                title={t('operationHistory.loadFailed')}
                description={t('operationHistory.loadFailedDescription')}
                action={<Button variant="outline" size="sm" onClick={() => void refresh()}>{t('operationHistory.retry')}</Button>}
              />
            ) : tasks.length === 0 ? (
              <EmptyState
                icon={<Clock3Icon />}
                title={t('operationHistory.empty')}
                description={t('operationHistory.emptyDescription')}
              />
            ) : (
              <div className="flex flex-col gap-3 pb-2">
                <p className="text-xs text-muted-foreground">
                  {t('operationHistory.resultCount', { shown: tasks.length, total: totalTasks })}
                </p>
                <Table aria-label={t('operationHistory.title')} className="min-w-[960px]">
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t('operationHistory.occurredAt')}</TableHead>
                      <TableHead>{t('operationHistory.action')}</TableHead>
                      <TableHead>{t('operationHistory.target')}</TableHead>
                      <TableHead>{t('operationHistory.category')}</TableHead>
                      <TableHead>{t('operationHistory.risk')}</TableHead>
                      <TableHead>{t('operationHistory.status')}</TableHead>
                      <TableHead className="text-center">{t('operationHistory.events')}</TableHead>
                      <TableHead><span className="sr-only">{t('operationHistory.viewDetails')}</span></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {tasks.map((task) => {
                      const target = targetLabel(task.latest);
                      return (
                        <TableRow key={task.taskId}>
                          <TableCell>{formatTime(task.latest.occurredAt)}</TableCell>
                          <TableCell>
                            <div className="flex min-w-0 flex-col gap-1">
                              <span className="font-medium text-foreground">
                                {t(`operationHistory.action.${task.latest.action}` as LocaleKey)}
                              </span>
                              <span className="max-w-56 truncate font-mono text-xs text-muted-foreground" title={task.taskId}>
                                {task.taskId}
                              </span>
                            </div>
                          </TableCell>
                          <TableCell>
                            <span className="block max-w-56 truncate" title={target}>{target}</span>
                          </TableCell>
                          <TableCell>
                            <Badge variant="outline">
                              {t(`operationHistory.category.${task.latest.category}` as LocaleKey)}
                            </Badge>
                          </TableCell>
                          <TableCell>
                            {task.latest.risk ? (
                              <Badge variant={task.latest.risk === 'destructive' ? 'destructive' : 'secondary'}>
                                {t(`operationHistory.risk.${task.latest.risk}` as LocaleKey)}
                              </Badge>
                            ) : '—'}
                          </TableCell>
                          <TableCell>
                            <Badge variant={statusVariant(task.latest.status)}>
                              {t(`operationHistory.status.${task.latest.status}` as LocaleKey)}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-center">{task.events.length}</TableCell>
                          <TableCell className="text-right">
                            <Button variant="ghost" size="sm" onClick={() => setSelected(task)}>
                              {t('operationHistory.viewDetails')}
                            </Button>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            )}
          </div>
        </WorkbenchPageContent>
      </ScrollArea>

      <Dialog open={selected !== undefined} onOpenChange={(open) => { if (!open) setSelected(undefined); }}>
        <CompactDialogContent className="max-w-2xl">
          <CompactDialogHeader
            title={t('operationHistory.detailsTitle')}
            description={selected?.taskId}
          />
          <ScrollArea className="h-[min(640px,calc(100vh-8rem))] min-h-0">
            <ScrollAreaContent
              className="flex min-w-0 flex-col gap-3 px-6 py-4"
            >
              {selected?.events.map((event, index) => (
                <React.Fragment key={event.eventId}>
                  {index > 0 && <Separator />}
                  <div className="flex flex-col gap-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant={statusVariant(event.status)}>
                          {t(`operationHistory.status.${event.status}` as LocaleKey)}
                        </Badge>
                        <span className="text-sm font-medium">
                          {t(`operationHistory.event.${event.eventKind}` as LocaleKey)}
                        </span>
                      </div>
                      <span className="text-xs text-muted-foreground">{formatTime(event.occurredAt)}</span>
                    </div>
                    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
                      <dt className="text-muted-foreground">{t('operationHistory.operationId')}</dt>
                      <dd className="break-all font-mono">{event.operationId}</dd>
                      <dt className="text-muted-foreground">{t('operationHistory.target')}</dt>
                      <dd className="break-all">{targetLabel(event)}</dd>
                      {event.subjectId && (
                        <>
                          <dt className="text-muted-foreground">{t('operationHistory.subject')}</dt>
                          <dd className="break-all">{event.subjectId}</dd>
                        </>
                      )}
                      {event.exitCode !== undefined && (
                        <>
                          <dt className="text-muted-foreground">{t('operationHistory.exitCode')}</dt>
                          <dd>{event.exitCode}</dd>
                        </>
                      )}
                      {event.itemCount !== undefined && (
                        <>
                          <dt className="text-muted-foreground">{t('operationHistory.itemCount')}</dt>
                          <dd>{event.itemCount}</dd>
                        </>
                      )}
                      {event.batchIndex !== undefined && event.batchTotal !== undefined && (
                        <>
                          <dt className="text-muted-foreground">{t('operationHistory.batch')}</dt>
                          <dd>{event.batchIndex}/{event.batchTotal}</dd>
                        </>
                      )}
                      {event.errorCategory && (
                        <>
                          <dt className="text-muted-foreground">{t('operationHistory.errorCategory')}</dt>
                          <dd>{t(`operationHistory.error.${event.errorCategory}` as LocaleKey)}</dd>
                        </>
                      )}
                    </dl>
                    {event.commandPreview && (
                      <div className="flex flex-col gap-1">
                        <span className="text-xs text-muted-foreground">{t('operationHistory.commandPreview')}</span>
                        <code className="overflow-x-auto rounded-md bg-muted p-2 text-xs">{event.commandPreview}</code>
                      </div>
                    )}
                    {event.evidence.length > 0 && (
                      <div className="flex flex-col gap-1">
                        <span className="text-xs text-muted-foreground">{t('operationHistory.evidence')}</span>
                        <div className="flex flex-wrap gap-1">
                          {event.evidence.map((evidence) => (
                            <Badge key={`${evidence.kind}:${evidence.operationId}`} variant="outline">
                              {evidence.kind}: {evidence.operationId}
                            </Badge>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </React.Fragment>
              ))}
            </ScrollAreaContent>
          </ScrollArea>
        </CompactDialogContent>
      </Dialog>

      <AlertDialog open={confirmClear} onOpenChange={setConfirmClear}>
        <CompactAlertDialogContent>
          <CompactAlertDialogHeader>
            <CompactAlertDialogTitle>{t('operationHistory.clearTitle')}</CompactAlertDialogTitle>
          </CompactAlertDialogHeader>
          <CompactAlertDialogBody>
            <AlertDialogDescription className="text-left leading-5 text-app-text">
              {t('operationHistory.clearDescription')}
            </AlertDialogDescription>
          </CompactAlertDialogBody>
          <CompactAlertDialogFooter>
            <AlertDialogCancel size="sm">{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" size="sm" onClick={() => void handleClear()}>
              {t('operationHistory.clearConfirm')}
            </AlertDialogAction>
          </CompactAlertDialogFooter>
        </CompactAlertDialogContent>
      </AlertDialog>
    </WorkbenchPage>
  );
};
