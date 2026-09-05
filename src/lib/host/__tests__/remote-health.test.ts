import { describe, expect, it } from 'vitest';
import {
  deriveRemoteHealthStatuses,
  isRemoteHealthSnapshotStale,
  REMOTE_HEALTH_STALE_AFTER_MS,
} from '../remote-health';
import type {
  ConnectionProfile,
  RemoteHealthSnapshot,
  RemoteHealthSnapshotResult,
} from '@/types';

const profile: ConnectionProfile = {
  id: 'profile-health',
  name: 'Production',
  host: 'prod.example.com',
  port: 22,
  username: 'root',
  authMethod: 'password',
  createdAt: 0,
  updatedAt: 0,
};

function snapshot(overrides: Partial<RemoteHealthSnapshot> = {}): RemoteHealthSnapshot {
  return {
    system: {
      osFamily: 'linux',
      hostname: 'prod-1',
      kernelVersion: '6.8.0',
      architecture: 'x86_64',
      cpuCount: 4,
      uptimeSecs: 3600,
    },
    cpu: { usagePercent: 92 },
    memory: {
      totalBytes: 100,
      usedBytes: 86,
      availableBytes: 14,
      usagePercent: 86,
    },
    disk: {
      totalBytes: 100,
      usedBytes: 40,
      availableBytes: 60,
      usagePercent: 40,
      mountPoint: '/',
    },
    load: { oneMinute: 3, fiveMinutes: 2, fifteenMinutes: 1 },
    ...overrides,
  };
}

function result(status: RemoteHealthSnapshotResult['status'] = 'success'):
RemoteHealthSnapshotResult {
  return {
    operationId: 'remote-health:test',
    profileId: profile.id,
    status,
    checkedAt: Date.parse('2026-08-23T08:00:00.000Z'),
    source: {
      kind: 'sshReadOnly',
      commandSetVersion: 'shellspan-read-only-v1',
      profileId: profile.id,
      host: profile.host,
      port: profile.port,
      username: profile.username,
    },
    snapshot: status === 'success' ? snapshot() : undefined,
  };
}

describe('remote health semantics', () => {
  it('derives an overall abnormal status from bounded per-metric thresholds', () => {
    expect(deriveRemoteHealthStatuses(snapshot())).toEqual({
      cpu: 'error',
      memory: 'warning',
      disk: 'ok',
      load: 'ok',
      overall: 'error',
    });
  });

  it('marks snapshots stale by age or after a failed refresh', () => {
    const success = result();
    expect(isRemoteHealthSnapshotStale(
      success,
      success.checkedAt,
      success.checkedAt + REMOTE_HEALTH_STALE_AFTER_MS - 1,
    )).toBe(false);
    expect(isRemoteHealthSnapshotStale(
      success,
      success.checkedAt,
      success.checkedAt + REMOTE_HEALTH_STALE_AFTER_MS,
    )).toBe(true);
    expect(isRemoteHealthSnapshotStale(result('timedOut'), success.checkedAt, success.checkedAt + 1))
      .toBe(true);
  });

});
