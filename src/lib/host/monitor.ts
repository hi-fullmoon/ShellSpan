import type { DiskInfo, HealthStatus, SystemHealth } from '@/types';

export const MEMORY_WARNING_THRESHOLD = 90;
export const MEMORY_ERROR_THRESHOLD = 95;

/** Uses the mount point on Windows so the monitor identifies the actual drive
 *  (for example, `C:\\`) instead of showing only its volume label. */
export function formatDiskHint(disk: DiskInfo, platform: string): string | undefined {
  const mountPoint = disk.mountPoint.trim();
  const name = disk.name?.trim();
  return platform === 'windows' ? mountPoint || name : name || mountPoint || undefined;
}

/** Derives the overall health status from the latest system memory pressure. */
export function deriveHealthStatus(health: SystemHealth): HealthStatus {
  const ratio = health.system.memoryUsagePercent;
  if (!Number.isFinite(ratio)) {
    return 'error';
  }
  if (ratio >= MEMORY_ERROR_THRESHOLD) {
    return 'error';
  }
  if (ratio >= MEMORY_WARNING_THRESHOLD) {
    return 'warning';
  }
  return 'ok';
}

/** Formats a duration in seconds as a compact human string, e.g. "2h 13m". */
export function formatUptime(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) {
    return '-';
  }
  const seconds = Math.floor(totalSeconds % 60);
  const minutes = Math.floor((totalSeconds / 60) % 60);
  const hours = Math.floor((totalSeconds / 3600) % 24);
  const days = Math.floor(totalSeconds / 86400);

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (seconds > 0 && parts.length < 2) parts.push(`${seconds}s`);
  return parts.join(' ') || '0s';
}

/** Formats a timestamp as a zero-padded 24-hour clock (HH:mm:ss) so its
 *  character width is stable regardless of the time of day. */
export function formatClockTime(timestamp: number): string {
  const date = new Date(timestamp);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
