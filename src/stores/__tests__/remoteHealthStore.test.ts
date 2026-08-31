import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isRemoteHealthSnapshotStale } from '@/lib/remote-health';
import { useProfileStore } from '@/stores/profileStore';
import { useRemoteHealthStore } from '../remoteHealthStore';
import type {
  ConnectionProfile,
  RemoteHealthSnapshotResult,
} from '@/types';

const mocks = vi.hoisted(() => ({
  collect: vi.fn(),
  cancel: vi.fn(),
}));

vi.mock('@/lib/tauri', async () => {
  const actual = await vi.importActual<typeof import('@/lib/tauri')>('@/lib/tauri');
  return {
    ...actual,
    invokeCollectRemoteHealthSnapshot: mocks.collect,
    invokeCancelRemoteHealthSnapshot: mocks.cancel,
  };
});

const profile: ConnectionProfile = {
  id: 'profile-1',
  name: 'Production',
  host: 'prod.example.com',
  port: 22,
  username: 'root',
  authMethod: 'password',
  password: 'in-memory-secret',
  createdAt: 0,
  updatedAt: 0,
};

function result(
  status: RemoteHealthSnapshotResult['status'],
  operationId = 'remote-health:result',
): RemoteHealthSnapshotResult {
  return {
    operationId,
    profileId: profile.id,
    status,
    checkedAt: 1_000,
    source: {
      kind: 'sshReadOnly',
      commandSetVersion: 'shellspan-read-only-v1',
      profileId: profile.id,
      host: profile.host,
      port: profile.port,
      username: profile.username,
    },
    snapshot: status === 'success' ? {
      system: {
        osFamily: 'linux',
        hostname: 'prod-1',
        kernelVersion: '6.8.0',
        architecture: 'x86_64',
        cpuCount: 4,
        uptimeSecs: 10,
      },
      cpu: { usagePercent: 10 },
      memory: { totalBytes: 100, usedBytes: 50, availableBytes: 50, usagePercent: 50 },
      disk: {
        totalBytes: 100,
        usedBytes: 20,
        availableBytes: 80,
        usagePercent: 20,
        mountPoint: '/',
      },
      load: { oneMinute: 0.2, fiveMinutes: 0.1, fifteenMinutes: 0.05 },
    } : undefined,
    error: status === 'success' ? undefined : `${status} detail`,
  };
}

beforeEach(() => {
  mocks.collect.mockReset();
  mocks.cancel.mockReset().mockResolvedValue(undefined);
  useRemoteHealthStore.setState({ entries: {}, selectedProfileId: undefined });
  useProfileStore.setState({
    profiles: [profile],
    ensurePassword: vi.fn(async (value: ConnectionProfile) => value),
  });
});

describe('useRemoteHealthStore', () => {
  it('requires explicit authorization before invoking the backend', async () => {
    const denied = await useRemoteHealthStore.getState().collect(profile, false);
    expect(denied.status).toBe('unauthorized');
    expect(denied.profileId).toBe(profile.id);
    expect(denied.source.profileId).toBe(profile.id);
    expect(mocks.collect).not.toHaveBeenCalled();
  });

  it('collects with the selected profile identity and keeps a successful snapshot', async () => {
    mocks.collect.mockImplementation(async ({ operationId }) => result('success', operationId));
    await useRemoteHealthStore.getState().collect(profile, true);

    expect(mocks.collect).toHaveBeenCalledWith(expect.objectContaining({
      profileId: profile.id,
      authorized: true,
      connection: expect.objectContaining({
        host: profile.host,
        username: profile.username,
        password: profile.password,
      }),
    }));
    expect(useRemoteHealthStore.getState().entries[profile.id]).toMatchObject({
      phase: 'idle',
      snapshotCheckedAt: 1_000,
      snapshotSource: { profileId: profile.id },
      lastResult: { status: 'success', profileId: profile.id },
    });
  });

  it('retains the last success as stale data after timeout', async () => {
    mocks.collect
      .mockImplementationOnce(async ({ operationId }) => result('success', operationId))
      .mockImplementationOnce(async ({ operationId }) => result('timedOut', operationId));
    await useRemoteHealthStore.getState().collect(profile, true);
    await useRemoteHealthStore.getState().collect(profile, true);

    const entry = useRemoteHealthStore.getState().entries[profile.id];
    expect(entry.snapshot).toBeDefined();
    expect(entry.lastResult?.status).toBe('timedOut');
    expect(isRemoteHealthSnapshotStale(entry.lastResult, entry.snapshotCheckedAt, 1_001))
      .toBe(true);
  });

  it('fails closed when the backend returns another profile identity', async () => {
    mocks.collect.mockImplementation(async ({ operationId }) => ({
      ...result('success', operationId),
      profileId: 'profile-2',
    }));
    const failed = await useRemoteHealthStore.getState().collect(profile, true);
    expect(failed.status).toBe('failed');
    expect(useRemoteHealthStore.getState().entries[profile.id].snapshot).toBeUndefined();
  });

  it('fails closed when the backend returns another operation or source endpoint', async () => {
    mocks.collect.mockImplementationOnce(async ({ operationId }) => {
      const success = result('success', operationId);
      return {
        ...success,
        source: { ...success.source, host: 'other.example.com' },
      };
    });
    expect((await useRemoteHealthStore.getState().collect(profile, true)).status).toBe('failed');

    mocks.collect.mockResolvedValue(result('success', 'remote-health:another-operation'));
    expect((await useRemoteHealthStore.getState().collect(profile, true)).status).toBe('failed');
  });

  it('cancels the active operation and settles with backend cancellation metadata', async () => {
    let resolveCollection!: (value: RemoteHealthSnapshotResult) => void;
    mocks.collect.mockImplementation(() => new Promise((resolve) => {
      resolveCollection = resolve;
    }));
    const pending = useRemoteHealthStore.getState().collect(profile, true);
    await vi.waitFor(() => {
      expect(useRemoteHealthStore.getState().entries[profile.id].phase).toBe('collecting');
    });
    const operationId = useRemoteHealthStore.getState().entries[profile.id].operationId;
    await useRemoteHealthStore.getState().cancel(profile.id);
    expect(mocks.cancel).toHaveBeenCalledWith(operationId);
    resolveCollection(result('cancelled', operationId));
    await pending;
    expect(useRemoteHealthStore.getState().entries[profile.id].lastResult?.status)
      .toBe('cancelled');
  });
});
