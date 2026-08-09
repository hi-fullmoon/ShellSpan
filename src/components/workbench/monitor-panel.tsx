import React, { useEffect, useMemo } from 'react';
import { ActivityIcon, PauseIcon, PlayIcon, RefreshCwIcon } from 'lucide-react';
import { useI18n } from '@/hooks/useI18n';
import { useAppStore } from '@/stores/appStore';
import { useTerminalStore } from '@/stores/terminalStore';
import { useSftpStore } from '@/stores/sftpStore';
import { useMonitorStore, MONITOR_POLL_INTERVAL_MS } from '@/stores/monitorStore';
import type { ClosedReasonKind, DisconnectEvent, HealthStatus } from '@/types';
import type { LocaleKey } from '@/locales';
import { cn, formatBytes } from '@/lib/utils';
import { formatClockTime, formatUptime } from '@/lib/monitor';
import { PanelEmptyState, PanelLoadingState } from '@/components/ui/empty-state';
import { ScrollArea } from '@/components/ui/scroll-area';
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

const STATUS_COUNT_TONES = {
  ok: 'bg-app-success/10 text-app-success',
  connecting: 'bg-app-primary/10 text-app-primary',
  warning: 'bg-app-warning/10 text-app-warning',
  error: 'bg-app-error/10 text-app-error',
} as const;

type Tone = HealthStatus;

function toneBarClass(tone: Tone): string {
  switch (tone) {
    case 'warning':
      return 'bg-app-warning';
    case 'error':
      return 'bg-app-error';
    default:
      return 'bg-app-primary';
  }
}

function usageRatio(used: number, total: number): number {
  if (total <= 0) return 0;
  return (used / total) * 100;
}

/** Card shell matching the workbench `ManagementCard` visual (rounded-lg +
 *  border) without its interactive hover/selected states. */
const MonitorCard: React.FC<{ className?: string; children: React.ReactNode }> = ({
  className,
  children,
}) => (
  <div
    className={cn(
      'flex min-w-0 flex-col gap-2.5 rounded-lg border border-app-border bg-app-surface p-3',
      className,
    )}
  >
    {children}
  </div>
);

const SectionLabel: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="px-1 pt-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
    {children}
  </div>
);

const HealthBadge: React.FC<{ status: HealthStatus }> = ({ status }) => {
  const { t } = useI18n();
  const className = {
    ok: 'bg-app-success/10 text-app-success',
    warning: 'bg-app-warning/10 text-app-warning',
    error: 'bg-app-error/10 text-app-error',
  }[status];
  const label = {
    ok: t('workbench.monitor.status.ok'),
    warning: t('workbench.monitor.status.warning'),
    error: t('workbench.monitor.status.error'),
  }[status];
  return (
    <span
      className={cn(
        'inline-flex h-5 items-center gap-1 rounded px-2 text-[11px] font-medium',
        className,
      )}
    >
      <span aria-hidden className="size-1.5 rounded-full bg-current" />
      {label}
    </span>
  );
};

const MetricTile: React.FC<{
  label: string;
  value: string;
  hint?: string;
}> = ({ label, value, hint }) => (
  <MonitorCard className="gap-1">
    <span className="text-[11px] text-muted-foreground">{label}</span>
    <span className="font-mono text-sm font-medium text-app-text">{value}</span>
    {hint && <span className="text-[11px] text-app-text-soft">{hint}</span>}
  </MonitorCard>
);

const UsageBar: React.FC<{ percent: number; tone: Tone }> = ({ percent, tone }) => {
  const clamped = Math.min(100, Math.max(0, Number.isFinite(percent) ? percent : 0));
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-app-surface-muted">
      <div
        className={cn('h-full rounded-full transition-[width] duration-500', toneBarClass(tone))}
        style={{ width: `${clamped}%` }}
      />
    </div>
  );
};

const SystemCard: React.FC<{
  title: string;
  values: string[];
  percent: number;
  tone?: Tone;
  hint?: string;
}> = ({ title, values, percent, tone = 'ok', hint }) => (
  <MonitorCard className="gap-1.5">
    <span className="text-[11px] text-muted-foreground">{title}</span>
    <span className="font-mono text-xs text-app-text">{values.join(' · ')}</span>
    <UsageBar percent={percent} tone={tone} />
    {hint && <span className="truncate text-[11px] text-app-text-soft">{hint}</span>}
  </MonitorCard>
);

const TrendCard: React.FC<{
  title: string;
  className?: string;
  data: number[];
  formatValue: (value: number) => string;
  latest?: number;
}> = ({ title, className, data, formatValue, latest }) => (
  <MonitorCard className="gap-1.5">
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-[11px] text-muted-foreground">{title}</span>
      {latest !== undefined && (
        <span className="font-mono text-xs font-medium text-app-text">
          {formatValue(latest)}
        </span>
      )}
    </div>
    <TrendArea data={data} className={className} aria-label={title} />
  </MonitorCard>
);

const StatusCount: React.FC<{
  tone: keyof typeof STATUS_COUNT_TONES;
  count: number;
  label: string;
}> = ({ tone, count, label }) => (
  <span
    className={cn(
      'inline-flex h-5 items-center gap-1 rounded px-1.5 text-[11px] font-medium',
      STATUS_COUNT_TONES[tone],
    )}
  >
    <span className="font-mono">{count}</span>
    {label}
  </span>
);

const DisconnectRow: React.FC<{ event: DisconnectEvent }> = ({ event }) => {
  const { t } = useI18n();
  const label = event.host || event.title || t('workbench.monitor.unknownHost');
  return (
    <div className="flex items-center justify-between gap-2 rounded-md bg-app-surface-muted/60 px-2 py-1">
      <div className="flex min-w-0 items-center gap-2">
        <span className="truncate font-mono text-xs text-app-text">{label}</span>
        <span className="shrink-0 text-[11px] text-app-text-soft">
          {t(DISCONNECT_REASON_KEY[event.reasonKind])}
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <span
          className={cn(
            'text-[11px]',
            event.retryable ? 'text-app-success' : 'text-app-warning',
          )}
        >
          {event.retryable ? t('workbench.monitor.retryable') : t('workbench.monitor.notRetryable')}
        </span>
        <span className="font-mono text-[11px] text-app-text-soft">
          {new Date(event.at).toLocaleTimeString()}
        </span>
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
    if (activeSection !== 'workbench' || paused) {
      return;
    }
    void refresh();
    const timer = setInterval(() => {
      void refresh();
    }, MONITOR_POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [activeSection, paused, refresh]);

  const rssHistory = useMemo(() => history.map((sample) => sample.rssBytes), [history]);
  const cpuHistory = useMemo(() => history.map((sample) => sample.cpuPercent), [history]);

  const latestRss = rssHistory.length > 0 ? rssHistory[rssHistory.length - 1] : undefined;
  const latestCpu = cpuHistory.length > 0 ? cpuHistory[cpuHistory.length - 1] : undefined;

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

  const sftpErrorCount = useMemo(
    () => sftpConnections.filter((conn) => conn.remoteError || conn.localError).length,
    [sftpConnections],
  );

  const recentDisconnects = useMemo(() => [...disconnectEvents].reverse(), [disconnectEvents]);

  return (
    <TooltipProvider>
      <div className="flex h-full flex-col">
        <div className="flex shrink-0 flex-col gap-2 border-b border-app-border/50 px-3 py-1.5 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-center gap-2">
            <div className="min-w-0">
              <h1 className="text-sm font-medium text-app-text">
                {t('workbench.monitor.title')}
              </h1>
              {lastUpdatedAt !== undefined && (
                <p className="truncate text-[11px] text-muted-foreground">
                  {t('workbench.monitor.updatedAt')}{' '}
                  <span className="font-mono tabular-nums">
                    {formatClockTime(lastUpdatedAt)}
                  </span>
                </p>
              )}
            </div>
            <HealthBadge status={status} />
          </div>
          <div className="flex items-center gap-1.5">
            {paused && (
              <span className="text-[11px] text-app-warning">{t('workbench.monitor.paused')}</span>
            )}
            <IconActionButton
              tooltip={paused ? t('workbench.monitor.resume') : t('workbench.monitor.pause')}
              aria-label={paused ? t('workbench.monitor.resume') : t('workbench.monitor.pause')}
              onClick={() => setPaused(!paused)}
              className="size-7 text-app-text hover:bg-app-text/10"
            >
              {paused ? <PlayIcon /> : <PauseIcon />}
            </IconActionButton>
            <IconActionButton
              tooltip={t('common.refresh')}
              aria-label={t('common.refresh')}
              onClick={() => void refresh()}
              disabled={paused}
              className="size-7 text-app-text hover:bg-app-text/10"
            >
              <RefreshCwIcon />
            </IconActionButton>
          </div>
        </div>

        <ScrollArea className="min-h-0 flex-1">
          <div className="p-2">
          {error && !snapshot && (
            <div className="mb-2 rounded-lg border border-app-error/30 bg-app-error/10 px-3 py-2 text-xs text-app-error">
              {t('workbench.monitor.loadFailed')}: {error}
            </div>
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
            <div className="flex flex-col gap-2">
              <SectionLabel>{t('workbench.monitor.appProcess')}</SectionLabel>
              <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
                <MetricTile
                  label={t('workbench.monitor.rss')}
                  value={formatBytes(snapshot.app.rssBytes)}
                  hint={`${t('workbench.monitor.vsz')} ${formatBytes(snapshot.app.vszBytes)}`}
                />
                <MetricTile
                  label={t('workbench.monitor.cpu')}
                  value={`${snapshot.app.cpuPercent.toFixed(1)}%`}
                />
                <MetricTile
                  label={t('workbench.monitor.threads')}
                  value={snapshot.app.threads != null ? String(snapshot.app.threads) : '—'}
                />
                <MetricTile
                  label={t('workbench.monitor.uptime')}
                  value={formatUptime(snapshot.app.uptimeSecs)}
                />
              </div>

              <SectionLabel>{t('workbench.monitor.system')}</SectionLabel>
              <div className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-4">
                <SystemCard
                  title={t('workbench.monitor.memory')}
                  values={[
                    formatBytes(snapshot.system.usedMemoryBytes),
                    formatBytes(snapshot.system.totalMemoryBytes),
                  ]}
                  percent={snapshot.system.memoryUsagePercent}
                  tone={status}
                />
                <SystemCard
                  title={t('workbench.monitor.swap')}
                  values={[
                    formatBytes(snapshot.system.usedSwapBytes),
                    formatBytes(snapshot.system.totalSwapBytes),
                  ]}
                  percent={usageRatio(
                    snapshot.system.usedSwapBytes,
                    snapshot.system.totalSwapBytes,
                  )}
                />
                <SystemCard
                  title={t('workbench.monitor.cpu')}
                  values={[`${snapshot.system.cpuPercent.toFixed(1)}%`]}
                  percent={snapshot.system.cpuPercent}
                />
                <SystemCard
                  title={t('workbench.monitor.disk')}
                  values={[
                    formatBytes(snapshot.disk.usedBytes),
                    formatBytes(snapshot.disk.totalBytes),
                  ]}
                  percent={snapshot.disk.usagePercent}
                  hint={snapshot.disk.name || snapshot.disk.mountPoint}
                />
              </div>

              <SectionLabel>{t('workbench.monitor.connectionHealth')}</SectionLabel>
              <MonitorCard className="gap-3">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-[11px] text-muted-foreground">
                      {t('workbench.monitor.terminalSessions')}
                    </span>
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

                  <div className="flex flex-col gap-1.5">
                    <div className="text-[11px] text-muted-foreground">
                      {t('workbench.monitor.recentDisconnects')}
                    </div>
                    {recentDisconnects.length > 0 ? (
                      recentDisconnects.map((event) => (
                        <DisconnectRow key={`${event.sessionId}-${event.at}`} event={event} />
                      ))
                    ) : (
                      <div className="text-[11px] text-app-text-soft/60">
                        {t('workbench.monitor.noDisconnects')}
                      </div>
                    )}
                  </div>

                  <div className="flex flex-col gap-1.5">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-[11px] text-muted-foreground">
                        {t('workbench.monitor.sftpConnections')}
                      </span>
                      <StatusCount
                        tone="ok"
                        count={sftpConnections.length}
                        label={t('workbench.monitor.active')}
                      />
                      <StatusCount
                        tone="error"
                        count={sftpErrorCount}
                        label={t('workbench.monitor.error')}
                      />
                    </div>
                    {sftpConnections.length > 0 ? (
                      sftpConnections.map((conn) => {
                        const hasError = Boolean(conn.remoteError || conn.localError);
                        return (
                          <div
                            key={conn.id}
                            className="flex items-center justify-between gap-2 rounded-md bg-app-surface-muted/60 px-2 py-1"
                          >
                            <span className="truncate font-mono text-xs text-app-text">
                              {conn.title}
                              <span className="ml-1.5 text-app-text-soft">
                                {conn.remotePath || conn.localPath}
                              </span>
                            </span>
                            <span
                              className={cn(
                                'flex shrink-0 items-center gap-1 text-[11px]',
                                hasError ? 'text-app-error' : 'text-app-success',
                              )}
                            >
                              <span aria-hidden className="size-1.5 rounded-full bg-current" />
                              {hasError
                                ? t('workbench.monitor.sftpError')
                                : t('workbench.monitor.sftpOk')}
                            </span>
                          </div>
                        );
                      })
                    ) : (
                      <div className="text-[11px] text-app-text-soft/60">
                        {t('workbench.monitor.noSftpConnections')}
                      </div>
                    )}
                  </div>
              </MonitorCard>

              <SectionLabel>{t('workbench.monitor.trends')}</SectionLabel>
              <div className="grid grid-cols-1 gap-2 lg:grid-cols-2">
                <TrendCard
                  title={t('workbench.monitor.memoryTrend')}
                  className="text-app-primary"
                  data={rssHistory}
                  formatValue={formatBytes}
                  latest={latestRss}
                />
                <TrendCard
                  title={t('workbench.monitor.cpuTrend')}
                  className="text-app-warning"
                  data={cpuHistory}
                  formatValue={(value) => `${value.toFixed(1)}%`}
                  latest={latestCpu}
                />
              </div>

              <SectionLabel>{t('workbench.monitor.appInfo')}</SectionLabel>
              <MonitorCard className="gap-1">
                <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-app-text-soft">
                  <span>
                    {t('workbench.monitor.version')}:{' '}
                    <code className="font-mono text-app-text">{snapshot.appInfo.version}</code>
                  </span>
                  <span>
                    {t('workbench.monitor.platform')}:{' '}
                    <code className="font-mono text-app-text">
                      {snapshot.appInfo.platform}-{snapshot.appInfo.arch}
                    </code>
                  </span>
                </div>
              </MonitorCard>
            </div>
          )}
          </div>
        </ScrollArea>
      </div>
    </TooltipProvider>
  );
};
