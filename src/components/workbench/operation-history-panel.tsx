import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Clock3Icon,
  FileJsonIcon,
  FileTextIcon,
  RefreshCwIcon,
  SearchIcon,
  ShieldCheckIcon,
  Trash2Icon,
} from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
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
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { EmptyState, PanelLoadingState } from '@/components/ui/empty-state';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
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
    <div className="flex h-full min-h-0 flex-col gap-3 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-base font-semibold">{t('operationHistory.title')}</h1>
          <p className="text-sm text-muted-foreground">{t('operationHistory.description')}</p>
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          <Select value={String(retentionDays)} onValueChange={(value) => void handleRetentionChange(value)}>
            <SelectTrigger size="sm" aria-label={t('operationHistory.retention')} className="w-36">
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
            <FileTextIcon data-icon="inline-start" />
            Markdown
          </Button>
          <Button variant="outline" size="sm" disabled={exporting} onClick={() => void handleExport('json')}>
            <FileJsonIcon data-icon="inline-start" />
            JSON
          </Button>
          <Button variant="outline" size="sm" onClick={() => setConfirmClear(true)}>
            <Trash2Icon data-icon="inline-start" />
            {t('operationHistory.clear')}
          </Button>
        </div>
      </div>

      <Alert>
        <ShieldCheckIcon />
        <AlertTitle>{t('operationHistory.privacyTitle')}</AlertTitle>
        <AlertDescription>{t('operationHistory.privacyDescription')}</AlertDescription>
      </Alert>

      <div className="flex flex-wrap items-center gap-2">
        <InputGroup className="min-w-52 flex-1">
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
          <SelectTrigger aria-label={t('operationHistory.category')} className="w-40">
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
          <SelectTrigger aria-label={t('operationHistory.status')} className="w-40">
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
          <SelectTrigger aria-label={t('operationHistory.range')} className="w-32">
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
        <Button variant="ghost" size="icon" aria-label={t('operationHistory.refresh')} onClick={() => void refresh()}>
          <RefreshCwIcon />
        </Button>
      </div>

      {truncated && (
        <Alert variant="destructive">
          <AlertTitle>{t('operationHistory.truncatedTitle')}</AlertTitle>
          <AlertDescription>{t('operationHistory.truncatedDescription')}</AlertDescription>
        </Alert>
      )}

      <div className="min-h-0 flex-1">
        {loading ? (
          <PanelLoadingState label={t('operationHistory.loading')} />
        ) : loadError ? (
          <EmptyState
            icon={<RefreshCwIcon />}
            title={t('operationHistory.loadFailed')}
            description={t('operationHistory.loadFailedDescription')}
            action={<Button variant="outline" onClick={() => void refresh()}>{t('operationHistory.retry')}</Button>}
          />
        ) : tasks.length === 0 ? (
          <EmptyState
            icon={<Clock3Icon />}
            title={t('operationHistory.empty')}
            description={t('operationHistory.emptyDescription')}
          />
        ) : (
          <ScrollArea className="h-full pr-2">
            <div className="flex flex-col gap-3 pb-2">
              <p className="text-xs text-muted-foreground">
                {t('operationHistory.resultCount', { shown: tasks.length, total: totalTasks })}
              </p>
              {tasks.map((task) => (
                <Card key={task.taskId} size="sm">
                  <CardHeader>
                    <CardTitle>{t(`operationHistory.action.${task.latest.action}` as LocaleKey)}</CardTitle>
                    <CardDescription>
                      {targetLabel(task.latest)} · {formatTime(task.latest.occurredAt)}
                    </CardDescription>
                    <CardAction>
                      <Badge variant={statusVariant(task.latest.status)}>
                        {t(`operationHistory.status.${task.latest.status}` as LocaleKey)}
                      </Badge>
                    </CardAction>
                  </CardHeader>
                  <CardContent className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <Badge variant="outline">{t(`operationHistory.category.${task.latest.category}` as LocaleKey)}</Badge>
                    {task.latest.risk && (
                      <Badge variant={task.latest.risk === 'destructive' ? 'destructive' : 'secondary'}>
                        {t(`operationHistory.risk.${task.latest.risk}` as LocaleKey)}
                      </Badge>
                    )}
                    <span>{t('operationHistory.eventCount', { count: task.events.length })}</span>
                    <span className="truncate">{task.taskId}</span>
                  </CardContent>
                  <CardFooter className="justify-end">
                    <Button variant="ghost" size="sm" onClick={() => setSelected(task)}>
                      {t('operationHistory.viewDetails')}
                    </Button>
                  </CardFooter>
                </Card>
              ))}
            </div>
          </ScrollArea>
        )}
      </div>

      <Dialog open={selected !== undefined} onOpenChange={(open) => { if (!open) setSelected(undefined); }}>
        <DialogContent className="max-h-[85vh] max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t('operationHistory.detailsTitle')}</DialogTitle>
            <DialogDescription>{selected?.taskId}</DialogDescription>
          </DialogHeader>
          <ScrollArea className="max-h-[65vh] pr-3">
            <div className="flex flex-col gap-3">
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
            </div>
          </ScrollArea>
        </DialogContent>
      </Dialog>

      <AlertDialog open={confirmClear} onOpenChange={setConfirmClear}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('operationHistory.clearTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('operationHistory.clearDescription')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => void handleClear()}>
              <Trash2Icon data-icon="inline-start" />
              {t('operationHistory.clearConfirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};
