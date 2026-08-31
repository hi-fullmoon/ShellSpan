import React, { useEffect, useMemo } from 'react';
import {
  ActivityIcon,
  CircleAlertIcon,
  CpuIcon,
  HardDriveIcon,
  Layers3Icon,
  MemoryStickIcon,
  PauseIcon,
  PlayIcon,
  RefreshCwIcon,
  ServerIcon,
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
import { Button } from '@/components/ui/button';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  PanelEmptyState,
  PanelLoadingState,
  Spinner,
} from '@/components/ui/empty-state';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { TooltipProvider } from '@/components/ui/tooltip';
import { TrendArea } from '@/components/ui/trend-area';
import { RemoteHealthSection } from './remote-health-section';
import {
  WorkbenchPage,
  WorkbenchPageContent,
  WorkbenchPageHeader,
} from './workbench-page';

const DISCONNECT_REASON_KEY: Record<ClosedReasonKind, LocaleKey> = {
  local_close: 'workbench.monitor.reason.localClose',
  controller_dropped: 'workbench.monitor.reason.controllerDropped',
  remote_exit: 'workbench.monitor.reason.remoteExit',
  transport_disconnect: 'workbench.monitor.reason.transportDisconnect',
  error: 'workbench.monitor.reason.error',
};

type Tone = HealthStatus | 'connecting' | 'muted';

interface SftpRemotePane {
  id: string;
  title: string;
  path: string;
  error?: string;
}

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

const ProcessTrend: React.FC<{
  icon: React.ElementType;
  label: string;
  value: string;
  detail: string;
  data: number[];
  tone?: 'primary' | 'warning';
}> = ({ icon: Icon, label, value, detail, data, tone = 'primary' }) => (
  <div className="flex min-h-28 min-w-0 flex-col gap-1.5 rounded-lg border border-border/70 bg-muted/30 px-3 py-2.5">
    <div className="flex items-start justify-between gap-3">
      <div className="flex min-w-0 items-center gap-2 text-xs font-medium text-muted-foreground">
        <Icon aria-hidden />
        <span className="truncate">{label}</span>
      </div>
      <span className="font-mono text-xl font-semibold tracking-tight text-foreground tabular-nums">
        {value}
      </span>
    </div>
    <span className="truncate text-xs text-muted-foreground" title={detail}>{detail}</span>
    <TrendArea
      data={data}
      height={38}
      className={cn('mt-auto', tone === 'warning' ? 'text-app-warning' : 'text-app-primary')}
      aria-label={label}
    />
  </div>
);

const RuntimeStat: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="flex min-w-0 flex-col gap-1">
    <dt className="text-[11px] text-muted-foreground">{label}</dt>
    <dd className="truncate font-mono text-sm font-semibold text-foreground tabular-nums" title={value}>
      {value}
    </dd>
  </div>
);

const ResourceRow: React.FC<{
  icon: React.ElementType;
  label: string;
  value: string;
  percent: number;
  tone?: Tone;
  hint?: string;
}> = ({ icon: Icon, label, value, percent, tone = 'ok', hint }) => (
  <div className="flex flex-col gap-2 rounded-lg border border-border/70 bg-muted/30 p-3">
    <div className="flex min-w-0 items-center justify-between gap-3">
      <div className="flex min-w-0 items-center gap-2 text-sm font-medium text-foreground">
        <Icon aria-hidden />
        <span className="truncate">{label}</span>
      </div>
      <span className={cn('font-mono text-sm font-semibold tabular-nums', toneTextClass(tone))}>
        {Math.round(percent)}%
      </span>
    </div>
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
  </div>
);

const StatusCount: React.FC<{ tone: Tone; count: number; label: string }> = ({
  tone,
  count,
  label,
}) => (
  <div className="flex min-w-0 items-center gap-2 rounded-lg border border-border/60 bg-muted/30 px-2.5 py-2">
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

const DisconnectList: React.FC<{ events: DisconnectEvent[] }> = ({ events }) => {
  const rows = events.map((event, index) => (
    <React.Fragment key={`${event.sessionId}-${event.at}`}>
      {index > 0 && <Separator />}
      <DisconnectRow event={event} />
    </React.Fragment>
  ));

  return events.length > 3 ? (
    <ScrollArea className="h-40 pr-3">
      {rows}
    </ScrollArea>
  ) : (
    <div>{rows}</div>
  );
};

const SftpPaneList: React.FC<{ panes: SftpRemotePane[] }> = ({ panes }) => {
  const { t } = useI18n();
  const rows = panes.map((pane, index) => {
    const hasError = Boolean(pane.error);
    return (
      <React.Fragment key={pane.id}>
        {index > 0 && <Separator />}
        <div className="flex items-center gap-3 py-2.5">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
            <ServerIcon aria-hidden />
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate font-mono text-xs text-foreground">{pane.title}</div>
            <div className="truncate font-mono text-[11px] text-muted-foreground">{pane.path}</div>
          </div>
          <Badge variant={hasError ? 'destructive' : 'outline'}>
            {hasError ? t('workbench.monitor.sftpError') : t('workbench.monitor.sftpOk')}
          </Badge>
        </div>
      </React.Fragment>
    );
  });

  return panes.length > 3 ? (
    <ScrollArea className="h-44 pr-3">
      {rows}
    </ScrollArea>
  ) : (
    <div>{rows}</div>
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
        const panes: SftpRemotePane[] = [];
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
  const connectionIssueCount = sessionCounts.disconnected + sessionCounts.error + sftpErrorCount;
  const headerDescription = lastUpdatedAt !== undefined ? (
    <>
      {t('workbench.monitor.updatedAt')}{' '}
      <span className="font-mono tabular-nums">{formatClockTime(lastUpdatedAt)}</span>
    </>
  ) : t('workbench.monitor.noDataDescription');

  return (
    <TooltipProvider>
      <WorkbenchPage>
        <WorkbenchPageHeader
          icon={ActivityIcon}
          title={t('workbench.monitor.title')}
          description={headerDescription}
          titleMeta={paused ? (
            <Badge variant="secondary">{t('workbench.monitor.paused')}</Badge>
          ) : undefined}
          actions={(
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPaused(!paused)}
              >
                {paused
                  ? <PlayIcon data-icon="inline-start" />
                  : <PauseIcon data-icon="inline-start" />}
                {t(paused ? 'workbench.monitor.resume' : 'workbench.monitor.pause')}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void refresh()}
                disabled={paused}
              >
                {loading
                  ? <Spinner data-icon="inline-start" />
                  : <RefreshCwIcon data-icon="inline-start" />}
                {t('common.refresh')}
              </Button>
            </>
          )}
        />

        <ScrollArea className="min-h-0 flex-1">
          <WorkbenchPageContent className="gap-4">
            <section aria-labelledby="local-monitor-heading" className="flex flex-col gap-3">
              <h2 id="local-monitor-heading" className="sr-only">
                {t('workbench.monitor.localTitle')}
              </h2>

              {error && !snapshot && (
                <Alert variant="destructive">
                  <CircleAlertIcon />
                  <AlertTitle>{t('workbench.monitor.loadFailed')}</AlertTitle>
                  <AlertDescription>
                    <p>{t('common.loadFailedDescription')}</p>
                    <details className="mt-1">
                      <summary className="cursor-pointer text-xs">
                        {t('common.errorDetails')}
                      </summary>
                      <code className="mt-1 block break-all text-xs">{error}</code>
                    </details>
                  </AlertDescription>
                </Alert>
              )}

              {loading && !snapshot && <PanelLoadingState className="min-h-32" />}

              {!snapshot && !loading && !error && (
                <PanelEmptyState
                  className="min-h-32"
                  icon={<ActivityIcon />}
                  title={t('workbench.monitor.noData')}
                  description={t('workbench.monitor.noDataDescription')}
                />
              )}

              {snapshot && (
                <div className="grid items-stretch gap-3 @min-[72rem]:grid-cols-12">
                  <Card
                    aria-labelledby="monitor-process-heading"
                    size="sm"
                    className="h-full @min-[72rem]:col-span-7"
                  >
                    <CardHeader>
                      <CardTitle id="monitor-process-heading">
                        {t('workbench.monitor.appProcess')}
                      </CardTitle>
                      <CardDescription>
                        {t('workbench.monitor.appProcessDescription')}
                      </CardDescription>
                      <CardAction className="flex items-center gap-1.5">
                        <HealthBadge status={status} />
                        <Badge variant="outline">PID {snapshot.app.pid}</Badge>
                      </CardAction>
                    </CardHeader>
                    <CardContent className="flex flex-col gap-2.5">
                      <div className="grid gap-3 @min-[38rem]:grid-cols-2">
                        <ProcessTrend
                          icon={MemoryStickIcon}
                          label={t('workbench.monitor.rss')}
                          value={formatBytes(snapshot.app.rssBytes)}
                          detail={t('workbench.monitor.memoryTrend')}
                          data={rssHistory}
                        />
                        <ProcessTrend
                          icon={CpuIcon}
                          label={t('workbench.monitor.cpu')}
                          value={`${snapshot.app.cpuPercent.toFixed(1)}%`}
                          detail={t('workbench.monitor.cpuTrend')}
                          data={cpuHistory}
                          tone="warning"
                        />
                      </div>
                      <dl className="grid grid-cols-2 gap-4 rounded-lg bg-muted/35 px-3 py-2.5 @min-[38rem]:grid-cols-3">
                        <RuntimeStat
                          label={t('workbench.monitor.vsz')}
                          value={formatBytes(snapshot.app.vszBytes)}
                        />
                        <RuntimeStat
                          label={t('workbench.monitor.threads')}
                          value={snapshot.app.threads != null
                            ? String(snapshot.app.threads)
                            : '—'}
                        />
                        <RuntimeStat
                          label={t('workbench.monitor.uptime')}
                          value={formatUptime(snapshot.app.uptimeSecs)}
                        />
                      </dl>
                    </CardContent>
                  </Card>

                  <Card
                    aria-labelledby="monitor-system-heading"
                    size="sm"
                    className="h-full @min-[72rem]:col-span-5"
                  >
                    <CardHeader>
                      <CardTitle id="monitor-system-heading">
                        {t('workbench.monitor.system')}
                      </CardTitle>
                      <CardDescription>{t('workbench.monitor.systemDescription')}</CardDescription>
                      <CardAction>
                        <Badge variant="outline">
                          {snapshot.appInfo.platform} / {snapshot.appInfo.arch}
                        </Badge>
                      </CardAction>
                    </CardHeader>
                    <CardContent>
                      <div className="grid gap-3 @min-[42rem]:grid-cols-2">
                        <ResourceRow
                          icon={MemoryStickIcon}
                          label={t('workbench.monitor.memory')}
                          value={`${formatBytes(snapshot.system.usedMemoryBytes)} / ${formatBytes(snapshot.system.totalMemoryBytes)}`}
                          percent={snapshot.system.memoryUsagePercent}
                          tone={usageTone(snapshot.system.memoryUsagePercent)}
                        />
                        <ResourceRow
                          icon={CpuIcon}
                          label={t('workbench.monitor.cpu')}
                          value={`${snapshot.system.cpuPercent.toFixed(1)}%`}
                          percent={snapshot.system.cpuPercent}
                          tone={usageTone(snapshot.system.cpuPercent)}
                        />
                        <ResourceRow
                          icon={Layers3Icon}
                          label={t('workbench.monitor.swap')}
                          value={`${formatBytes(snapshot.system.usedSwapBytes)} / ${formatBytes(snapshot.system.totalSwapBytes)}`}
                          percent={usageRatio(
                            snapshot.system.usedSwapBytes,
                            snapshot.system.totalSwapBytes,
                          )}
                          tone={usageTone(usageRatio(
                            snapshot.system.usedSwapBytes,
                            snapshot.system.totalSwapBytes,
                          ))}
                        />
                        <ResourceRow
                          icon={HardDriveIcon}
                          label={t('workbench.monitor.disk')}
                          value={`${formatBytes(snapshot.disk.usedBytes)} / ${formatBytes(snapshot.disk.totalBytes)}`}
                          percent={snapshot.disk.usagePercent}
                          tone={usageTone(snapshot.disk.usagePercent)}
                          hint={formatDiskHint(snapshot.disk, snapshot.appInfo.platform)}
                        />
                      </div>
                    </CardContent>
                  </Card>
                </div>
              )}
            </section>

            <section aria-labelledby="monitor-connections-heading">
              <Card size="sm">
                <CardHeader>
                  <CardTitle id="monitor-connections-heading">
                    {t('workbench.monitor.connectionHealth')}
                  </CardTitle>
                  <CardDescription>
                    {t('workbench.monitor.connectionBreakdown', {
                      terminal: sessionCounts.connected,
                      sftp: sftpActiveCount,
                      issues: connectionIssueCount,
                    })}
                  </CardDescription>
                  {connectionIssueCount > 0 && (
                    <CardAction>
                      <Badge variant="destructive">
                        {connectionIssueCount} {t('workbench.monitor.error')}
                      </Badge>
                    </CardAction>
                  )}
                </CardHeader>
                <CardContent className="flex flex-col gap-3">
                  <div className="flex flex-col gap-2">
                    <div className="text-xs font-medium text-muted-foreground">
                      {t('workbench.monitor.terminalSessions')}
                    </div>
                    <div className="grid grid-cols-2 gap-2 @min-[42rem]:grid-cols-4">
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
                  </div>

                  {(sftpRemotePanes.length > 0 || recentDisconnects.length > 0) && (
                    <div
                      className={cn(
                        'grid gap-3',
                        sftpRemotePanes.length > 0
                          && recentDisconnects.length > 0
                          && '@min-[52rem]:grid-cols-2',
                      )}
                    >
                      {sftpRemotePanes.length > 0 && (
                        <section
                          aria-labelledby="sftp-health-heading"
                          className="min-w-0 rounded-lg border border-border/70 px-3"
                        >
                          <div className="flex min-h-11 items-center justify-between gap-3 border-b border-border/60">
                            <h3 id="sftp-health-heading" className="min-w-0 truncate text-sm font-medium">
                              {t('workbench.monitor.sftpConnections')}
                            </h3>
                            <div className="flex shrink-0 items-center gap-1.5">
                              <Badge variant="outline">
                                {sftpActiveCount} {t('workbench.monitor.active')}
                              </Badge>
                              {sftpErrorCount > 0 && (
                                <Badge variant="destructive">
                                  {sftpErrorCount} {t('workbench.monitor.error')}
                                </Badge>
                              )}
                            </div>
                          </div>
                          <SftpPaneList panes={sftpRemotePanes} />
                        </section>
                      )}

                      {recentDisconnects.length > 0 && (
                        <section
                          aria-labelledby="recent-disconnects-heading"
                          className="min-w-0 rounded-lg border border-border/70 px-3"
                        >
                          <div className="flex min-h-11 items-center justify-between gap-3 border-b border-border/60">
                            <h3 id="recent-disconnects-heading" className="min-w-0 truncate text-sm font-medium">
                              {t('workbench.monitor.recentDisconnects')}
                            </h3>
                            <Badge variant="secondary">{recentDisconnects.length}</Badge>
                          </div>
                          <DisconnectList events={recentDisconnects} />
                        </section>
                      )}
                    </div>
                  )}
                </CardContent>
              </Card>
            </section>

            <RemoteHealthSection />
          </WorkbenchPageContent>
        </ScrollArea>
      </WorkbenchPage>
    </TooltipProvider>
  );
};
