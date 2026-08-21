import React, { useEffect, useMemo } from 'react';
import {
  ActivityIcon,
  CircleAlertIcon,
  Clock3Icon,
  CpuIcon,
  HardDriveIcon,
  Layers3Icon,
  MemoryStickIcon,
  NetworkIcon,
  PauseIcon,
  PlayIcon,
  RefreshCwIcon,
  ServerIcon,
  TerminalIcon,
} from 'lucide-react';
import { useI18n } from '@/hooks/useI18n';
import { useAppStore } from '@/stores/appStore';
import { useTerminalStore } from '@/stores/terminalStore';
import { getSftpPaneSource, useSftpStore } from '@/stores/sftpStore';
import { MONITOR_POLL_INTERVAL_MS, useMonitorStore } from '@/stores/monitorStore';
import type { ClosedReasonKind, DisconnectEvent, HealthStatus } from '@/types';
import type { LocaleKey } from '@/locales';
import { cn, formatBytes } from '@/lib/utils';
import { formatClockTime, formatDiskHint, formatUptime } from '@/lib/monitor';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { PanelEmptyState, PanelLoadingState } from '@/components/ui/empty-state';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { TooltipProvider } from '@/components/ui/tooltip';
import { TrendArea } from '@/components/ui/trend-area';
import { IconActionButton } from './icon-action-button';

const DISCONNECT_REASON_KEY: Record<ClosedReasonKind, LocaleKey> = {
  local_close: 'workbench.monitor.reason.localClose',
  controller_dropped: 'workbench.monitor.reason.controllerDropped',
  remote_exit: 'workbench.monitor.reason.remoteExit',
  transport_disconnect: 'workbench.monitor.reason.transportDisconnect',
  error: 'workbench.monitor.reason.error',
};

type Tone = HealthStatus | 'connecting' | 'muted';

function toneDotClass(tone: Tone): string {
  switch (tone) {
    case 'ok':
      return 'bg-app-success';
    case 'warning':
      return 'bg-app-warning';
    case 'error':
      return 'bg-app-error';
    case 'connecting':
      return 'bg-app-primary';
    default:
      return 'bg-muted-foreground';
  }
}

function toneBarClass(tone: Tone): string {
  switch (tone) {
    case 'warning':
      return 'bg-app-warning';
    case 'error':
      return 'bg-app-error';
    case 'muted':
      return 'bg-muted-foreground';
    default:
      return 'bg-app-primary';
  }
}

function toneTextClass(tone: Tone): string {
  switch (tone) {
    case 'ok':
      return 'text-app-success';
    case 'warning':
      return 'text-app-warning';
    case 'error':
      return 'text-app-error';
    case 'connecting':
      return 'text-app-primary';
    default:
      return 'text-muted-foreground';
  }
}

function usageRatio(used: number, total: number): number {
  if (total <= 0) return 0;
  return (used / total) * 100;
}

function usageTone(percent: number): HealthStatus {
  if (!Number.isFinite(percent) || percent >= 95) return 'error';
  if (percent >= 80) return 'warning';
  return 'ok';
}

const HealthBadge: React.FC<{ status: HealthStatus }> = ({ status }) => {
  const { t } = useI18n();
  const label = {
    ok: t('workbench.monitor.status.ok'),
    warning: t('workbench.monitor.status.warning'),
    error: t('workbench.monitor.status.error'),
  }[status];

  return (
    <Badge variant={status === 'error' ? 'destructive' : 'outline'}>
      <span aria-hidden className={cn('size-1.5 rounded-full', toneDotClass(status))} />
      {label}
    </Badge>
  );
};

const SectionHeading: React.FC<{ id: string; title: string; description?: string }> = ({
  id,
  title,
  description,
}) => (
  <div className="flex flex-col gap-0.5">
    <h2 id={id} className="text-sm font-medium text-foreground">
      {title}
    </h2>
    {description && <p className="text-xs text-muted-foreground">{description}</p>}
  </div>
);

const MetricCard: React.FC<{
  icon: React.ElementType;
  label: string;
  value: string;
  hint?: string;
  data?: number[];
  chartTone?: 'primary' | 'warning';
}> = ({ icon: Icon, label, value, hint, data, chartTone = 'primary' }) => (
  <Card size="sm" className="min-h-32">
    <CardHeader>
      <CardDescription>{label}</CardDescription>
      <CardAction>
        <div className="flex size-7 items-center justify-center rounded-md bg-muted text-muted-foreground">
          <Icon className="size-3.5" aria-hidden />
        </div>
      </CardAction>
    </CardHeader>
    <CardContent
      className={cn('flex flex-1 flex-col gap-1', !data && 'justify-center pb-4')}
    >
      <div className="font-mono text-xl font-semibold tracking-tight text-foreground tabular-nums">
        {value}
      </div>
      {hint && <p className="truncate text-xs text-muted-foreground">{hint}</p>}
      {data && (
        <TrendArea
          data={data}
          height={34}
          className={cn(
            'mt-auto pt-2',
            chartTone === 'warning' ? 'text-app-warning' : 'text-app-primary',
          )}
          aria-label={label}
        />
      )}
    </CardContent>
  </Card>
);

const UsageBar: React.FC<{ percent: number; tone?: Tone }> = ({ percent, tone = 'ok' }) => {
  const clamped = Math.min(100, Math.max(0, Number.isFinite(percent) ? percent : 0));
  return (
    <div
      className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(clamped)}
    >
      <div
        className={cn('h-full rounded-full transition-[width] duration-500', toneBarClass(tone))}
        style={{ width: `${clamped}%` }}
      />
    </div>
  );
};

const ResourceCard: React.FC<{
  icon: React.ElementType;
  label: string;
  value: string;
  percent: number;
  tone?: Tone;
  hint?: string;
}> = ({ icon: Icon, label, value, percent, tone = 'ok', hint }) => (
  <Card size="sm">
    <CardHeader>
      <div className="flex items-center gap-2">
        <Icon className="size-4 text-muted-foreground" aria-hidden />
        <CardTitle>{label}</CardTitle>
      </div>
      <CardAction>
        <span className="font-mono text-xs font-medium text-foreground tabular-nums">
          {Math.round(percent)}%
        </span>
      </CardAction>
    </CardHeader>
    <CardContent className="flex flex-col gap-2">
      <UsageBar percent={percent} tone={tone} />
      <div className="flex min-w-0 items-center justify-between gap-3 text-xs">
        <span className="shrink-0 whitespace-nowrap font-mono text-foreground tabular-nums">
          {value}
        </span>
        {hint && (
          <span className="min-w-0 truncate text-right text-muted-foreground" title={hint}>
            {hint}
          </span>
        )}
      </div>
    </CardContent>
  </Card>
);

const StatusCount: React.FC<{ tone: Tone; count: number; label: string }> = ({
  tone,
  count,
  label,
}) => (
  <div className="flex min-w-0 items-center gap-2 rounded-lg bg-muted/60 px-2.5 py-2">
    <span aria-hidden className={cn('size-2 shrink-0 rounded-full', toneDotClass(tone))} />
    <div className="min-w-0">
      <div className="font-mono text-sm font-semibold text-foreground tabular-nums">{count}</div>
      <div className="truncate text-[11px] text-muted-foreground">{label}</div>
    </div>
  </div>
);

const DisconnectRow: React.FC<{ event: DisconnectEvent }> = ({ event }) => {
  const { t } = useI18n();
  const label = event.host || event.title || t('workbench.monitor.unknownHost');
  return (
    <div className="flex items-center gap-3 py-2">
      <span
        aria-hidden
        className={cn(
          'size-2 shrink-0 rounded-full',
          event.retryable ? 'bg-app-warning' : 'bg-app-error',
        )}
      />
      <div className="min-w-0 flex-1">
        <div className="truncate font-mono text-xs text-foreground">{label}</div>
        <div className="truncate text-[11px] text-muted-foreground">
          {t(DISCONNECT_REASON_KEY[event.reasonKind])}
        </div>
      </div>
      <div className="shrink-0 text-right">
        <div className={cn('text-[11px]', toneTextClass(event.retryable ? 'warning' : 'error'))}>
          {event.retryable
            ? t('workbench.monitor.retryable')
            : t('workbench.monitor.notRetryable')}
        </div>
        <div className="font-mono text-[11px] text-muted-foreground tabular-nums">
          {formatClockTime(event.at)}
        </div>
      </div>
    </div>
  );
};

export const MonitorPanel: React.FC = () => {
  const { t } = useI18n();
  const {
    snapshot,
    history,
    status,
    loading,
    error,
    lastUpdatedAt,
    paused,
    setPaused,
    refresh,
    disconnectEvents,
  } = useMonitorStore();
  const activeSection = useAppStore((state) => state.activeSection);
  const sessions = useTerminalStore((state) => state.sessions);
  const sftpConnections = useSftpStore((state) => state.connections);

  useEffect(() => {
    if (activeSection !== 'workbench' || paused) return;
    void refresh();
    const timer = setInterval(() => void refresh(), MONITOR_POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [activeSection, paused, refresh]);

  const rssHistory = useMemo(() => history.map((sample) => sample.rssBytes), [history]);
  const cpuHistory = useMemo(() => history.map((sample) => sample.cpuPercent), [history]);

  const sessionCounts = useMemo(() => {
    const counts = { connected: 0, connecting: 0, disconnected: 0, error: 0 };
    for (const session of sessions) {
      if (session.status === 'connected') counts.connected += 1;
      else if (session.status === 'connecting') counts.connecting += 1;
      else if (session.status === 'error') counts.error += 1;
      else counts.disconnected += 1;
    }
    return counts;
  }, [sessions]);

  const sftpRemotePanes = useMemo(
    () =>
      sftpConnections.flatMap((connection) => {
        const panes: Array<{ id: string; title: string; path: string; error?: string }> = [];
        if (getSftpPaneSource(connection, 'local') === 'remote') {
          panes.push({
            id: `${connection.id}-left`,
            title: connection.leftTitle ?? connection.title,
            path: connection.localPath,
            error: connection.localError,
          });
        }
        if (getSftpPaneSource(connection, 'remote') === 'remote') {
          panes.push({
            id: `${connection.id}-right`,
            title: connection.title,
            path: connection.remotePath,
            error: connection.remoteError,
          });
        }
        return panes;
      }),
    [sftpConnections],
  );

  const sftpErrorCount = useMemo(
    () => sftpRemotePanes.filter((pane) => pane.error).length,
    [sftpRemotePanes],
  );
  const sftpActiveCount = sftpRemotePanes.length - sftpErrorCount;
  const recentDisconnects = useMemo(() => [...disconnectEvents].reverse(), [disconnectEvents]);

  return (
    <TooltipProvider>
      <div className="flex h-full flex-col bg-background">
        <header className="flex shrink-0 items-center justify-between gap-3 border-b bg-card/80 px-4 py-3">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <ActivityIcon className="size-4" aria-hidden />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h1 className="truncate text-base font-semibold text-foreground">
                  {t('workbench.monitor.title')}
                </h1>
                <HealthBadge status={status} />
              </div>
              <p className="truncate text-xs text-muted-foreground">
                {lastUpdatedAt !== undefined ? (
                  <>
                    {t('workbench.monitor.updatedAt')}{' '}
                    <span className="font-mono tabular-nums">{formatClockTime(lastUpdatedAt)}</span>
                  </>
                ) : (
                  t('workbench.monitor.noDataDescription')
                )}
              </p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {paused && (
              <Badge variant="secondary">
                <PauseIcon data-icon="inline-start" />
                {t('workbench.monitor.paused')}
              </Badge>
            )}
            <IconActionButton
              tooltip={paused ? t('workbench.monitor.resume') : t('workbench.monitor.pause')}
              aria-label={paused ? t('workbench.monitor.resume') : t('workbench.monitor.pause')}
              onClick={() => setPaused(!paused)}
            >
              {paused ? <PlayIcon /> : <PauseIcon />}
            </IconActionButton>
            <IconActionButton
              tooltip={t('common.refresh')}
              aria-label={t('common.refresh')}
              onClick={() => void refresh()}
              disabled={paused}
            >
              <RefreshCwIcon className={cn(loading && 'animate-spin')} />
            </IconActionButton>
          </div>
        </header>

        <ScrollArea className="min-h-0 flex-1">
          <main className="mx-auto flex w-full max-w-screen-2xl flex-col gap-5 p-3 sm:p-4">
            {error && !snapshot && (
              <Alert variant="destructive">
                <CircleAlertIcon />
                <AlertTitle>{t('workbench.monitor.loadFailed')}</AlertTitle>
                <AlertDescription>
                  <p>{t('common.loadFailedDescription')}</p>
                  <details className="mt-1">
                    <summary className="cursor-pointer text-xs">{t('common.errorDetails')}</summary>
                    <code className="mt-1 block break-all text-xs">{error}</code>
                  </details>
                </AlertDescription>
              </Alert>
            )}

            {loading && !snapshot && <PanelLoadingState />}

            {!snapshot && !loading && !error && (
              <PanelEmptyState
                icon={<ActivityIcon />}
                title={t('workbench.monitor.noData')}
                description={t('workbench.monitor.noDataDescription')}
              />
            )}

            {snapshot && (
              <>
                <section aria-labelledby="monitor-process-heading" className="flex flex-col gap-2.5">
                  <SectionHeading
                    id="monitor-process-heading"
                    title={t('workbench.monitor.appProcess')}
                  />
                  <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
                    <MetricCard
                      icon={MemoryStickIcon}
                      label={t('workbench.monitor.rss')}
                      value={formatBytes(snapshot.app.rssBytes)}
                      hint={`${t('workbench.monitor.vsz')} ${formatBytes(snapshot.app.vszBytes)}`}
                      data={rssHistory}
                    />
                    <MetricCard
                      icon={CpuIcon}
                      label={t('workbench.monitor.cpu')}
                      value={`${snapshot.app.cpuPercent.toFixed(1)}%`}
                      data={cpuHistory}
                      chartTone="warning"
                    />
                    <MetricCard
                      icon={Layers3Icon}
                      label={t('workbench.monitor.threads')}
                      value={snapshot.app.threads != null ? String(snapshot.app.threads) : '—'}
                    />
                    <MetricCard
                      icon={Clock3Icon}
                      label={t('workbench.monitor.uptime')}
                      value={formatUptime(snapshot.app.uptimeSecs)}
                    />
                  </div>
                </section>

                <section aria-labelledby="monitor-system-heading" className="flex flex-col gap-2.5">
                  <SectionHeading id="monitor-system-heading" title={t('workbench.monitor.system')} />
                  <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
                    <ResourceCard
                      icon={MemoryStickIcon}
                      label={t('workbench.monitor.memory')}
                      value={`${formatBytes(snapshot.system.usedMemoryBytes)} / ${formatBytes(snapshot.system.totalMemoryBytes)}`}
                      percent={snapshot.system.memoryUsagePercent}
                      tone={usageTone(snapshot.system.memoryUsagePercent)}
                    />
                    <ResourceCard
                      icon={Layers3Icon}
                      label={t('workbench.monitor.swap')}
                      value={`${formatBytes(snapshot.system.usedSwapBytes)} / ${formatBytes(snapshot.system.totalSwapBytes)}`}
                      percent={usageRatio(
                        snapshot.system.usedSwapBytes,
                        snapshot.system.totalSwapBytes,
                      )}
                      tone={usageTone(
                        usageRatio(
                          snapshot.system.usedSwapBytes,
                          snapshot.system.totalSwapBytes,
                        ),
                      )}
                    />
                    <ResourceCard
                      icon={CpuIcon}
                      label={t('workbench.monitor.cpu')}
                      value={`${snapshot.system.cpuPercent.toFixed(1)}%`}
                      percent={snapshot.system.cpuPercent}
                      tone={usageTone(snapshot.system.cpuPercent)}
                    />
                    <ResourceCard
                      icon={HardDriveIcon}
                      label={t('workbench.monitor.disk')}
                      value={`${formatBytes(snapshot.disk.usedBytes)} / ${formatBytes(snapshot.disk.totalBytes)}`}
                      percent={snapshot.disk.usagePercent}
                      tone={usageTone(snapshot.disk.usagePercent)}
                      hint={formatDiskHint(snapshot.disk, snapshot.appInfo.platform)}
                    />
                  </div>
                </section>

                <section aria-labelledby="monitor-connections-heading" className="flex flex-col gap-2.5">
                  <SectionHeading
                    id="monitor-connections-heading"
                    title={t('workbench.monitor.connectionHealth')}
                  />
                  <div className="grid grid-cols-1 items-stretch gap-2.5 xl:grid-cols-2">
                    <Card className="h-full">
                      <CardHeader>
                        <div className="flex items-center gap-2">
                          <TerminalIcon className="size-4 text-muted-foreground" aria-hidden />
                          <CardTitle>{t('workbench.monitor.terminalSessions')}</CardTitle>
                        </div>
                        <CardDescription>{t('workbench.monitor.recentDisconnects')}</CardDescription>
                      </CardHeader>
                      <CardContent className="flex flex-1 flex-col gap-3">
                        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                          <StatusCount
                            tone="ok"
                            count={sessionCounts.connected}
                            label={t('workbench.monitor.connected')}
                          />
                          <StatusCount
                            tone="connecting"
                            count={sessionCounts.connecting}
                            label={t('workbench.monitor.connecting')}
                          />
                          <StatusCount
                            tone="warning"
                            count={sessionCounts.disconnected}
                            label={t('workbench.monitor.disconnected')}
                          />
                          <StatusCount
                            tone="error"
                            count={sessionCounts.error}
                            label={t('workbench.monitor.error')}
                          />
                        </div>
                        <Separator />
                        {recentDisconnects.length > 0 ? (
                          <div className="flex max-h-48 flex-col overflow-auto">
                            {recentDisconnects.map((event, index) => (
                              <React.Fragment key={`${event.sessionId}-${event.at}`}>
                                {index > 0 && <Separator />}
                                <DisconnectRow event={event} />
                              </React.Fragment>
                            ))}
                          </div>
                        ) : (
                          <div className="flex min-h-20 flex-1 items-center justify-center text-xs text-muted-foreground">
                            {t('workbench.monitor.noDisconnects')}
                          </div>
                        )}
                      </CardContent>
                    </Card>

                    <Card className="h-full">
                      <CardHeader>
                        <div className="flex items-center gap-2">
                          <NetworkIcon className="size-4 text-muted-foreground" aria-hidden />
                          <CardTitle>{t('workbench.monitor.sftpConnections')}</CardTitle>
                        </div>
                        <CardDescription>
                          {t('workbench.monitor.sftpDescription')}
                        </CardDescription>
                        <CardAction>
                          <div className="flex items-center gap-1.5">
                            <Badge variant={sftpActiveCount > 0 ? 'outline' : 'secondary'}>
                              <span
                                aria-hidden
                                className={cn(
                                  'size-1.5 rounded-full',
                                  sftpActiveCount > 0 ? 'bg-app-success' : 'bg-muted-foreground',
                                )}
                              />
                              {sftpActiveCount} {t('workbench.monitor.active')}
                            </Badge>
                            {sftpErrorCount > 0 && (
                              <Badge variant="destructive">
                                {sftpErrorCount} {t('workbench.monitor.error')}
                              </Badge>
                            )}
                          </div>
                        </CardAction>
                      </CardHeader>
                      <CardContent className="flex flex-1 flex-col">
                        {sftpRemotePanes.length > 0 ? (
                          <div className="flex max-h-64 flex-col overflow-auto">
                            {sftpRemotePanes.map((pane, index) => {
                              const hasError = Boolean(pane.error);
                              return (
                                <React.Fragment key={pane.id}>
                                  {index > 0 && <Separator />}
                                  <div className="flex items-center gap-3 py-2.5">
                                    <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                                      <ServerIcon className="size-3.5" aria-hidden />
                                    </div>
                                    <div className="min-w-0 flex-1">
                                      <div className="truncate font-mono text-xs text-foreground">
                                        {pane.title}
                                      </div>
                                      <div className="truncate font-mono text-[11px] text-muted-foreground">
                                        {pane.path}
                                      </div>
                                    </div>
                                    <Badge variant={hasError ? 'destructive' : 'outline'}>
                                      <span
                                        aria-hidden
                                        className={cn(
                                          'size-1.5 rounded-full',
                                          hasError ? 'bg-app-error' : 'bg-app-success',
                                        )}
                                      />
                                      {hasError
                                        ? t('workbench.monitor.sftpError')
                                        : t('workbench.monitor.sftpOk')}
                                    </Badge>
                                  </div>
                                </React.Fragment>
                              );
                            })}
                          </div>
                        ) : (
                          <div className="flex min-h-32 flex-1 items-center justify-center text-xs text-muted-foreground">
                            {t('workbench.monitor.noSftpConnections')}
                          </div>
                        )}
                      </CardContent>
                    </Card>
                  </div>
                </section>

              </>
            )}
          </main>
        </ScrollArea>
      </div>
    </TooltipProvider>
  );
};
