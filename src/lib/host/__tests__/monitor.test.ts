import { describe, expect, it } from 'vitest';
import { deriveHealthStatus, formatClockTime, formatDiskHint, formatUptime } from '../monitor';
import type { DiskInfo, SystemHealth } from '@/types';

function healthWithMemoryRatio(ratio: number): SystemHealth {
  return {
    app: {
      pid: 1,
      rssBytes: 0,
      vszBytes: 0,
      cpuPercent: 0,
      uptimeSecs: 0,
    },
    system: {
      totalMemoryBytes: 100,
      usedMemoryBytes: ratio,
      freeMemoryBytes: 100 - ratio,
      memoryUsagePercent: ratio,
      totalSwapBytes: 0,
      usedSwapBytes: 0,
      freeSwapBytes: 0,
      cpuPercent: 0,
    },
    disk: {
      totalBytes: 0,
      usedBytes: 0,
      freeBytes: 0,
      usagePercent: 0,
      mountPoint: '/',
    },
    appInfo: { version: '1.0.0', platform: 'macos', arch: 'aarch64' },
  };
}

describe('formatDiskHint', () => {
  const disk: DiskInfo = {
    totalBytes: 100,
    usedBytes: 50,
    freeBytes: 50,
    usagePercent: 50,
    mountPoint: 'C:\\',
    name: 'Windows',
  };

  it('shows the specific drive on Windows', () => {
    expect(formatDiskHint(disk, 'windows')).toBe('C:\\');
  });

  it('keeps the volume name on other platforms', () => {
    expect(formatDiskHint({ ...disk, mountPoint: '/' }, 'macos')).toBe('Windows');
  });

  it('falls back when the preferred field is empty', () => {
    expect(formatDiskHint({ ...disk, mountPoint: '' }, 'windows')).toBe('Windows');
    expect(formatDiskHint({ ...disk, mountPoint: '/', name: undefined }, 'linux')).toBe('/');
  });
});

describe('deriveHealthStatus', () => {
  it('returns ok below the warning threshold', () => {
    expect(deriveHealthStatus(healthWithMemoryRatio(50))).toBe('ok');
    expect(deriveHealthStatus(healthWithMemoryRatio(89.9))).toBe('ok');
  });

  it('returns warning from 90 up to 95', () => {
    expect(deriveHealthStatus(healthWithMemoryRatio(90))).toBe('warning');
    expect(deriveHealthStatus(healthWithMemoryRatio(94.9))).toBe('warning');
  });

  it('returns error at or above 95', () => {
    expect(deriveHealthStatus(healthWithMemoryRatio(95))).toBe('error');
    expect(deriveHealthStatus(healthWithMemoryRatio(100))).toBe('error');
  });

  it('returns error for non-finite ratios', () => {
    expect(deriveHealthStatus(healthWithMemoryRatio(Number.NaN))).toBe('error');
    expect(deriveHealthStatus(healthWithMemoryRatio(Number.POSITIVE_INFINITY))).toBe('error');
  });
});

describe('formatUptime', () => {
  it('formats sub-minute durations in seconds', () => {
    expect(formatUptime(0)).toBe('0s');
    expect(formatUptime(59)).toBe('59s');
  });

  it('promotes to minutes once a minute passes', () => {
    expect(formatUptime(60)).toBe('1m');
    expect(formatUptime(3661)).toBe('1h 1m');
  });

  it('includes days when present', () => {
    expect(formatUptime(90061)).toBe('1d 1h 1m');
  });

  it('omits trailing zero units at exact hour/day boundaries', () => {
    expect(formatUptime(3600)).toBe('1h');
    expect(formatUptime(86400)).toBe('1d');
    expect(formatUptime(7200)).toBe('2h');
  });

  it('handles invalid input', () => {
    expect(formatUptime(Number.NaN)).toBe('-');
    expect(formatUptime(-5)).toBe('-');
  });
});

describe('formatClockTime', () => {
  it('zero-pads hours, minutes and seconds to a fixed width', () => {
    const date = new Date(2026, 0, 1, 9, 5, 3);
    expect(formatClockTime(date.getTime())).toBe('09:05:03');
    expect(formatClockTime(date.getTime())).toHaveLength(8);
  });

  it('formats two-digit hours without leading space', () => {
    const date = new Date(2026, 0, 1, 23, 59, 59);
    expect(formatClockTime(date.getTime())).toBe('23:59:59');
  });

  it('always produces the same character length across times', () => {
    const morning = new Date(2026, 0, 1, 9, 0, 0).getTime();
    const afternoon = new Date(2026, 0, 1, 15, 58, 27).getTime();
    expect(formatClockTime(morning).length).toBe(formatClockTime(afternoon).length);
  });
});
