import type {
  ConnectionProfile,
  HealthStatus,
  RemoteHealthSnapshot,
  RemoteHealthSnapshotResult,
} from '@/types';
import type { AiContext } from '@/types/ai';

export const REMOTE_HEALTH_STALE_AFTER_MS = 5 * 60 * 1000;
export const REMOTE_HEALTH_TIMEOUT_MS = 20_000;

export interface RemoteHealthMetricStatuses {
  cpu: HealthStatus;
  memory: HealthStatus;
  disk: HealthStatus;
  load: HealthStatus;
  overall: HealthStatus;
}

export function remoteHealthResultMatchesProfile(
  profile: ConnectionProfile,
  result: RemoteHealthSnapshotResult,
): boolean {
  return result.profileId === profile.id
    && result.source.profileId === profile.id
    && result.source.kind === 'sshReadOnly'
    && result.source.host === profile.host
    && result.source.port === profile.port
    && result.source.username === profile.username;
}

function thresholdStatus(value: number, warning: number, error: number): HealthStatus {
  if (!Number.isFinite(value) || value < 0 || value >= error) return 'error';
  if (value >= warning) return 'warning';
  return 'ok';
}

export function deriveRemoteHealthStatuses(
  snapshot: RemoteHealthSnapshot,
): RemoteHealthMetricStatuses {
  const cpu = thresholdStatus(snapshot.cpu.usagePercent, 75, 90);
  const memory = thresholdStatus(snapshot.memory.usagePercent, 85, 95);
  const disk = thresholdStatus(snapshot.disk.usagePercent, 85, 95);
  const loadPerCpu = snapshot.system.cpuCount > 0
    ? snapshot.load.oneMinute / snapshot.system.cpuCount
    : Number.NaN;
  const load = thresholdStatus(loadPerCpu, 1, 2);
  const values = [cpu, memory, disk, load];
  const overall = values.includes('error')
    ? 'error'
    : values.includes('warning')
      ? 'warning'
      : 'ok';
  return { cpu, memory, disk, load, overall };
}

export function isRemoteHealthSnapshotStale(
  result: RemoteHealthSnapshotResult | undefined,
  snapshotCheckedAt: number | undefined,
  now = Date.now(),
): boolean {
  if (snapshotCheckedAt === undefined) return false;
  if (!result || result.status !== 'success' || result.checkedAt !== snapshotCheckedAt) return true;
  return now - snapshotCheckedAt >= REMOTE_HEALTH_STALE_AFTER_MS;
}

function formatPercent(value: number): string {
  return `${value.toFixed(1)}%`;
}

export function buildRemoteHealthDiagnosticRequest(
  profile: ConnectionProfile,
  result: RemoteHealthSnapshotResult,
): { goal: string; context: AiContext } {
  if (!remoteHealthResultMatchesProfile(profile, result) || !result.snapshot) {
    throw new Error('remote health snapshot does not match the selected profile');
  }
  const { snapshot, source } = result;
  const collectedAt = new Date(result.checkedAt).toISOString();
  const sourceLabel = `SSH read-only · ${source.username}@${source.host}:${source.port} · ${source.commandSetVersion}`;
  const content = [
    `Profile ID: ${profile.id}`,
    `Host: ${profile.name} · ${profile.username}@${profile.host}:${profile.port}`,
    `Collected at: ${collectedAt}`,
    `Source: ${sourceLabel}`,
    `System: ${snapshot.system.osFamily} ${snapshot.system.osVersion ?? ''} · kernel ${snapshot.system.kernelVersion} · ${snapshot.system.architecture} · ${snapshot.system.cpuCount} CPU(s)`,
    `Uptime: ${snapshot.system.uptimeSecs} seconds`,
    `CPU usage: ${formatPercent(snapshot.cpu.usagePercent)}`,
    `Memory usage: ${formatPercent(snapshot.memory.usagePercent)} (${snapshot.memory.usedBytes}/${snapshot.memory.totalBytes} bytes)`,
    `Disk usage: ${formatPercent(snapshot.disk.usagePercent)} (${snapshot.disk.usedBytes}/${snapshot.disk.totalBytes} bytes at ${snapshot.disk.mountPoint})`,
    `Load average: ${snapshot.load.oneMinute.toFixed(2)}, ${snapshot.load.fiveMinutes.toFixed(2)}, ${snapshot.load.fifteenMinutes.toFixed(2)}`,
  ].join('\n');
  return {
    goal: `Diagnose the abnormal metrics in this remote health snapshot. Treat the collection time and source as evidence boundaries, and propose only read-only verification steps.\n\n${content}`,
    context: {
      label: `${profile.username}@${profile.host} · remote health · ${collectedAt}`,
      content,
    },
  };
}
