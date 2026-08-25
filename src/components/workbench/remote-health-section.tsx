import { useEffect, useMemo, useState } from 'react';
import {
  Clock3Icon,
  CpuIcon,
  HardDriveIcon,
  MemoryStickIcon,
  ServerCogIcon,
  ShieldCheckIcon,
} from 'lucide-react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogMedia,
} from '@/components/ui/alert-dialog';
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
import { Spinner } from '@/components/ui/empty-state';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { ResponsiveCardGrid } from '@/components/ui/responsive-card-grid';
import {
  CompactAlertDialogBody,
  CompactAlertDialogContent,
  CompactAlertDialogDescription,
  CompactAlertDialogFooter,
  CompactAlertDialogHeader,
  CompactAlertDialogTitle,
} from '@/components/ui/compact-alert-dialog';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useI18n } from '@/hooks/useI18n';
import { useConnectSession } from '@/hooks/useConnectSession';
import {
  buildRemoteHealthDiagnosticRequest,
  deriveRemoteHealthStatuses,
  isRemoteHealthSnapshotStale,
  remoteHealthResultMatchesProfile,
} from '@/lib/remote-health';
import { findConnectedTerminalSession } from '@/lib/host-quick-actions';
import { formatClockTime, formatUptime } from '@/lib/monitor';
import { cn, formatBytes } from '@/lib/utils';
import { useAiStore } from '@/stores/aiStore';
import { useAgentStore } from '@/stores/agentStore';
import { useAppStore } from '@/stores/appStore';
import { useProfileStore } from '@/stores/profileStore';
import { useRemoteHealthStore, type RemoteHealthEntry } from '@/stores/remoteHealthStore';
import { useTerminalStore } from '@/stores/terminalStore';
import { useToastStore } from '@/stores/toastStore';
import type {
  ConnectionProfile,
  HealthStatus,
  RemoteHealthSnapshotResult,
} from '@/types';

const REMOTE_METRIC_BREAKPOINTS = [
  { minWidth: 420, columns: 2 },
  { minWidth: 760, columns: 4 },
] as const;

function snapshotResult(entry: RemoteHealthEntry): RemoteHealthSnapshotResult | undefined {
  if (!entry.snapshot || entry.snapshotCheckedAt === undefined || !entry.snapshotSource) {
    return undefined;
  }
  return {
    operationId: entry.lastResult?.operationId ?? `remote-health:snapshot:${entry.profileId}`,
    profileId: entry.profileId,
    status: 'success',
    checkedAt: entry.snapshotCheckedAt,
    source: entry.snapshotSource,
    snapshot: entry.snapshot,
  };
}

function statusBadgeVariant(status: HealthStatus): 'outline' | 'secondary' | 'destructive' {
  if (status === 'error') return 'destructive';
  if (status === 'warning') return 'secondary';
  return 'outline';
}

function statusDotClass(status: HealthStatus): string {
  if (status === 'error') return 'bg-app-error';
  if (status === 'warning') return 'bg-app-warning';
  return 'bg-app-success';
}

function RemoteHealthStatusBadge({ status }: { status: HealthStatus }): React.JSX.Element {
  const { t } = useI18n();
  return (
    <Badge variant={statusBadgeVariant(status)}>
      <span
        aria-hidden
        data-slot="health-status-dot"
        className={cn('size-1.5 rounded-full', statusDotClass(status))}
      />
      {t(`workbench.monitor.status.${status}`)}
    </Badge>
  );
}

function RemoteMetricCard({
  icon: Icon,
  label,
  value,
  detail,
  status,
}: {
  icon: React.ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;
  label: string;
  value: string;
  detail: string;
  status: HealthStatus;
}): React.JSX.Element {
  return (
    <Card size="sm">
      <CardHeader>
        <CardDescription className="flex items-center gap-2">
          <Icon className="size-3.5" aria-hidden />
          {label}
        </CardDescription>
        <CardAction>
          <RemoteHealthStatusBadge status={status} />
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-1">
        <CardTitle className="font-mono text-lg tabular-nums">{value}</CardTitle>
        <p className="truncate text-xs text-muted-foreground" title={detail}>{detail}</p>
      </CardContent>
    </Card>
  );
}

function resultErrorKey(status: RemoteHealthSnapshotResult['status']):
  | 'remoteHealth.error.unauthorized'
  | 'remoteHealth.error.cancelled'
  | 'remoteHealth.error.timedOut'
  | 'remoteHealth.error.unsupported'
  | 'remoteHealth.error.failed' {
  if (status === 'unauthorized') return 'remoteHealth.error.unauthorized';
  if (status === 'cancelled') return 'remoteHealth.error.cancelled';
  if (status === 'timedOut') return 'remoteHealth.error.timedOut';
  if (status === 'unsupported') return 'remoteHealth.error.unsupported';
  return 'remoteHealth.error.failed';
}

export function RemoteHealthSection(): React.JSX.Element {
  const { t } = useI18n();
  const profiles = useProfileStore((state) => state.profiles);
  const selectedProfileId = useRemoteHealthStore((state) => state.selectedProfileId);
  const entries = useRemoteHealthStore((state) => state.entries);
  const selectProfile = useRemoteHealthStore((state) => state.selectProfile);
  const collect = useRemoteHealthStore((state) => state.collect);
  const cancel = useRemoteHealthStore((state) => state.cancel);
  const { connect } = useConnectSession();
  const [authorizationProfileId, setAuthorizationProfileId] = useState<string>();
  const [now, setNow] = useState(Date.now());

  const selectedProfile = profiles.find((profile) => profile.id === selectedProfileId)
    ?? profiles[0];
  const profileItems = useMemo(
    () => profiles.map((profile) => ({
      value: profile.id,
      label: `${profile.name} · ${profile.username}@${profile.host}:${profile.port}`,
    })),
    [profiles],
  );
  const entry = selectedProfile ? entries[selectedProfile.id] : undefined;
  const remoteSnapshot = entry?.snapshot;
  const capturedResult = entry ? snapshotResult(entry) : undefined;
  const sourceMatchesProfile = Boolean(
    selectedProfile
    && capturedResult
    && remoteHealthResultMatchesProfile(selectedProfile, capturedResult),
  );
  const statuses = useMemo(
    () => remoteSnapshot ? deriveRemoteHealthStatuses(remoteSnapshot) : undefined,
    [remoteSnapshot],
  );
  const stale = Boolean(remoteSnapshot) && (
    !sourceMatchesProfile
    || isRemoteHealthSnapshotStale(entry?.lastResult, entry?.snapshotCheckedAt, now)
  );
  const busy = entry?.phase === 'preparing'
    || entry?.phase === 'collecting'
    || entry?.phase === 'cancelling';
  const authorizationProfile = profiles.find((profile) => profile.id === authorizationProfileId);

  useEffect(() => {
    if (!selectedProfileId && profiles[0]) selectProfile(profiles[0].id);
  }, [profiles, selectProfile, selectedProfileId]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const diagnose = async (profile: ConnectionProfile): Promise<void> => {
    if (!capturedResult) return;
    const activeRun = useAgentStore.getState().run;
    if (activeRun?.phase === 'planning') {
      useToastStore.getState().addToast(t('remoteHealth.diagnosisBusy'), 'info');
      return;
    }
    let sessionId = findConnectedTerminalSession(profile.id);
    if (!sessionId) {
      await connect(profile);
      sessionId = findConnectedTerminalSession(profile.id);
    }
    if (!sessionId) return;
    const request = buildRemoteHealthDiagnosticRequest(profile, capturedResult);
    useTerminalStore.getState().setActiveSession(sessionId);
    useAppStore.getState().setActiveSection('terminal');
    useAiStore.getState().setOpen(true);
    document.dispatchEvent(new CustomEvent('termbridge:start-health-diagnosis', {
      detail: {
        profileId: profile.id,
        sessionId,
        goal: request.goal,
        context: request.context,
      },
    }));
  };

  return (
    <section aria-labelledby="remote-health-heading" className="flex flex-col gap-2.5">
      <div
        data-slot="remote-health-section-header"
        className="flex flex-col gap-3 @min-[42rem]:flex-row @min-[42rem]:items-center @min-[42rem]:justify-between"
      >
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2 id="remote-health-heading" className="text-sm font-medium text-foreground">
            {t('remoteHealth.title')}
          </h2>
          <p className="text-xs text-muted-foreground">{t('remoteHealth.description')}</p>
        </div>
        {selectedProfile && (
          <Button
            size="sm"
            className="shrink-0 self-start @min-[42rem]:self-auto"
            onClick={() => setAuthorizationProfileId(selectedProfile.id)}
            disabled={busy}
          >
            {busy && <Spinner data-icon="inline-start" />}
            {entry?.phase === 'preparing'
              ? t('remoteHealth.preparing')
              : entry?.phase === 'collecting' || entry?.phase === 'cancelling'
                ? t('remoteHealth.collecting')
                : remoteSnapshot
                  ? t('remoteHealth.collectAgain')
                  : t('remoteHealth.collect')}
          </Button>
        )}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{selectedProfile?.name ?? t('remoteHealth.noProfile')}</CardTitle>
          {selectedProfile && (
            <CardDescription>
              {selectedProfile.username}@{selectedProfile.host}:{selectedProfile.port}
            </CardDescription>
          )}
          {statuses && (
            <CardAction>
              <div className="flex items-center gap-1">
                {stale && <Badge variant="secondary">{t('remoteHealth.stale')}</Badge>}
                <RemoteHealthStatusBadge status={statuses.overall} />
              </div>
            </CardAction>
          )}
        </CardHeader>

        <CardContent className="flex flex-col gap-3">
          {profiles.length > 0 ? (
            <FieldGroup>
              <Field className="sm:flex-row sm:items-center sm:justify-between sm:gap-3">
                <FieldLabel htmlFor="remote-health-profile">{t('remoteHealth.profile')}</FieldLabel>
                <Select
                  items={profileItems}
                  value={selectedProfile?.id}
                  onValueChange={(value) => value && selectProfile(value)}
                  disabled={busy}
                >
                  <SelectTrigger id="remote-health-profile" className="w-full sm:w-72">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {profileItems.map((item) => (
                        <SelectItem key={item.value} value={item.value}>
                          {item.label}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
            </FieldGroup>
          ) : (
            <p className="text-xs text-muted-foreground">
              {t('remoteHealth.noProfileDescription')}
            </p>
          )}

          {entry?.lastResult && entry.lastResult.status !== 'success' && (
            <Alert variant={entry.lastResult.status === 'cancelled' ? 'default' : 'destructive'}>
              <ServerCogIcon />
              <AlertTitle>{t(resultErrorKey(entry.lastResult.status))}</AlertTitle>
              <AlertDescription className="flex flex-col gap-1">
                <p>
                  {t('remoteHealth.attemptMetadata', {
                    time: formatClockTime(entry.lastResult.checkedAt),
                    source: entry.lastResult.source.commandSetVersion,
                  })}
                </p>
                {entry.lastResult.error && (
                  <details>
                    <summary className="cursor-pointer text-xs">{t('common.errorDetails')}</summary>
                    <code className="mt-1 block break-all text-xs">{entry.lastResult.error}</code>
                  </details>
                )}
                {remoteSnapshot && <p>{t('remoteHealth.previousSnapshotRetained')}</p>}
              </AlertDescription>
            </Alert>
          )}

          {remoteSnapshot && statuses ? (
            <>
              <ResponsiveCardGrid
                columns={1}
                breakpoints={REMOTE_METRIC_BREAKPOINTS}
                gap="0.625rem"
              >
                <RemoteMetricCard
                  icon={CpuIcon}
                  label={t('workbench.monitor.cpu')}
                  value={`${remoteSnapshot.cpu.usagePercent.toFixed(1)}%`}
                  detail={t('remoteHealth.cpuDetail', { count: remoteSnapshot.system.cpuCount })}
                  status={statuses.cpu}
                />
                <RemoteMetricCard
                  icon={MemoryStickIcon}
                  label={t('workbench.monitor.memory')}
                  value={`${remoteSnapshot.memory.usagePercent.toFixed(1)}%`}
                  detail={`${formatBytes(remoteSnapshot.memory.usedBytes)} / ${formatBytes(remoteSnapshot.memory.totalBytes)}`}
                  status={statuses.memory}
                />
                <RemoteMetricCard
                  icon={HardDriveIcon}
                  label={t('workbench.monitor.disk')}
                  value={`${remoteSnapshot.disk.usagePercent.toFixed(1)}%`}
                  detail={`${remoteSnapshot.disk.mountPoint} · ${formatBytes(remoteSnapshot.disk.usedBytes)} / ${formatBytes(remoteSnapshot.disk.totalBytes)}`}
                  status={statuses.disk}
                />
                <RemoteMetricCard
                  icon={Clock3Icon}
                  label={t('remoteHealth.load')}
                  value={remoteSnapshot.load.oneMinute.toFixed(2)}
                  detail={`${remoteSnapshot.load.fiveMinutes.toFixed(2)} · ${remoteSnapshot.load.fifteenMinutes.toFixed(2)}`}
                  status={statuses.load}
                />
              </ResponsiveCardGrid>

              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <Badge variant="outline">
                  {remoteSnapshot.system.osFamily} {remoteSnapshot.system.osVersion ?? ''}
                </Badge>
                <span>{remoteSnapshot.system.hostname}</span>
                <span>{remoteSnapshot.system.kernelVersion} · {remoteSnapshot.system.architecture}</span>
                <span>{t('remoteHealth.uptime', { value: formatUptime(remoteSnapshot.system.uptimeSecs) })}</span>
                {entry.snapshotCheckedAt !== undefined && (
                  <span>{t('remoteHealth.collectedAt', { time: formatClockTime(entry.snapshotCheckedAt) })}</span>
                )}
                {entry.snapshotSource && (
                  <span>
                    {t('remoteHealth.source', {
                      source: `${entry.snapshotSource.kind} · ${entry.snapshotSource.commandSetVersion}`,
                    })}
                  </span>
                )}
              </div>
            </>
          ) : profiles.length > 0 ? (
            <Alert>
              <ServerCogIcon />
              <AlertTitle>{t('remoteHealth.empty')}</AlertTitle>
              <AlertDescription>{t('remoteHealth.emptyDescription')}</AlertDescription>
            </Alert>
          ) : null}

          {selectedProfile && (
            entry?.phase === 'collecting'
            || entry?.phase === 'cancelling'
            || Boolean(statuses && statuses.overall !== 'ok' && capturedResult && sourceMatchesProfile)
          ) && (
            <div data-slot="remote-health-actions" className="flex flex-wrap justify-end gap-2 pt-1">
              {entry?.phase === 'collecting' || entry?.phase === 'cancelling' ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void cancel(selectedProfile.id)}
                  disabled={entry.phase === 'cancelling'}
                >
                  {entry.phase === 'cancelling'
                    ? t('remoteHealth.cancelling')
                    : t('common.cancel')}
                </Button>
              ) : null}
              {statuses && statuses.overall !== 'ok' && capturedResult && sourceMatchesProfile && (
                <Button variant="secondary" size="sm" onClick={() => void diagnose(selectedProfile)}>
                  {t('remoteHealth.diagnose')}
                </Button>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <AlertDialog
        open={Boolean(authorizationProfile)}
        onOpenChange={(open) => !open && setAuthorizationProfileId(undefined)}
      >
        <CompactAlertDialogContent className="max-w-md">
          <CompactAlertDialogHeader>
            <AlertDialogMedia className="mb-0"><ShieldCheckIcon /></AlertDialogMedia>
            <CompactAlertDialogTitle>{t('remoteHealth.authorization.title')}</CompactAlertDialogTitle>
            <CompactAlertDialogDescription>
              {t('remoteHealth.authorization.description', {
                host: authorizationProfile
                  ? `${authorizationProfile.username}@${authorizationProfile.host}:${authorizationProfile.port}`
                  : '',
              })}
            </CompactAlertDialogDescription>
          </CompactAlertDialogHeader>
          <CompactAlertDialogBody>
            <Alert variant="default">
              <ShieldCheckIcon />
              <AlertTitle>{t('remoteHealth.authorization.scopeTitle')}</AlertTitle>
              <AlertDescription>{t('remoteHealth.authorization.scope')}</AlertDescription>
            </Alert>
          </CompactAlertDialogBody>
          <CompactAlertDialogFooter>
            <AlertDialogCancel size="sm">{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              size="sm"
              onClick={() => {
                if (authorizationProfile) void collect(authorizationProfile, true);
                setAuthorizationProfileId(undefined);
              }}
            >
              {t('remoteHealth.authorization.confirm')}
            </AlertDialogAction>
          </CompactAlertDialogFooter>
        </CompactAlertDialogContent>
      </AlertDialog>
    </section>
  );
}
