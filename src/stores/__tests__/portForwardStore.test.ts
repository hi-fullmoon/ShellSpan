import { beforeEach, describe, expect, it, vi } from 'vitest';
import { usePortForwardStore } from '../portForwardStore';
import type { ConnectionProfile, PortForwardRule, PortForwardRuntime } from '@/types';

const {
  invokeListPortForwards,
  invokeStartPortForward,
  invokeStopAllPortForwards,
  invokeStopPortForward,
} = vi.hoisted(() => ({
  invokeListPortForwards: vi.fn().mockResolvedValue([]),
  invokeStartPortForward: vi.fn(),
  invokeStopAllPortForwards: vi.fn().mockResolvedValue([]),
  invokeStopPortForward: vi.fn(),
}));

vi.mock('@/lib/tauri', () => ({
  buildRemoteConnectionRequest: (profile: ConnectionProfile) => ({
    host: profile.host,
    port: profile.port,
    username: profile.username,
    authMethod: profile.authMethod,
    password: profile.password,
  }),
  invokeListPortForwards,
  invokeStartPortForward,
  invokeStopAllPortForwards,
  invokeStopPortForward,
}));

vi.mock('@/lib/password-prompt', () => ({
  promptForMissingPassword: vi.fn(async (profile: ConnectionProfile) => profile),
}));

vi.mock('@/lib/keychain-key-prompt', () => ({
  ensureKeychainKeyForProfile: vi.fn(async (profile: ConnectionProfile) => profile),
}));

const profile: ConnectionProfile = {
  id: 'profile-1',
  name: 'Production',
  host: 'prod.example.com',
  port: 22,
  username: 'alice',
  authMethod: 'password',
  password: 'secret',
  createdAt: 1,
  updatedAt: 1,
};

const rule: PortForwardRule = {
  id: 'rule-1',
  name: 'Database',
  kind: 'local',
  localPort: 15432,
  remoteHost: '127.0.0.1',
  remotePort: 5432,
  autoStart: true,
};

function runtime(
  operationId: string,
  status: PortForwardRuntime['status'],
): PortForwardRuntime {
  return {
    operationId,
    profileId: profile.id,
    configId: rule.id,
    name: rule.name,
    kind: rule.kind,
    mode: 'auto',
    status,
    bytesSent: 0,
    bytesReceived: 0,
  };
}

describe('portForwardStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invokeListPortForwards.mockResolvedValue([]);
    invokeStopAllPortForwards.mockResolvedValue([]);
    usePortForwardStore.setState({ runtimes: [], initialized: false });
  });

  it('deduplicates auto starts and stops after the last owner closes', async () => {
    invokeStartPortForward.mockImplementation(async (request) => runtime(request.operationId, 'starting'));
    invokeStopPortForward.mockImplementation(async (operationId) => runtime(operationId, 'stopping'));

    await usePortForwardStore.getState().startRule(profile, rule, 'auto', 'terminal:one', true);
    await usePortForwardStore.getState().startRule(profile, rule, 'auto', 'sftp:two:remote', true);

    expect(invokeStartPortForward).toHaveBeenCalledTimes(1);
    expect(usePortForwardStore.getState().runtimes[0].ownerIds).toEqual([
      'terminal:one',
      'sftp:two:remote',
    ]);

    await usePortForwardStore.getState().stopOwner('terminal:one');
    expect(invokeStopPortForward).not.toHaveBeenCalled();

    await usePortForwardStore.getState().stopOwner('sftp:two:remote');
    expect(invokeStopPortForward).toHaveBeenCalledTimes(1);
    expect(usePortForwardStore.getState().runtimes[0].status).toBe('stopping');
  });

  it('turns an occupied local port into visible failed state', async () => {
    invokeStartPortForward.mockRejectedValue(
      new Error('local port 127.0.0.1:15432 is already in use or unavailable'),
    );

    const result = await usePortForwardStore
      .getState()
      .startRule(profile, rule, 'manual', undefined, true);

    expect(result).toMatchObject({
      status: 'failed',
      errorCategory: 'portInUse',
      lastError: expect.stringContaining('already in use'),
    });
  });

  it('hydrates backend lifecycle history while preserving frontend owners', async () => {
    usePortForwardStore.setState({
      runtimes: [{ ...runtime('op-1', 'starting'), ownerIds: ['terminal:one'] }],
    });
    invokeListPortForwards.mockResolvedValue([{ ...runtime('op-1', 'running'), startedAt: 10 }]);

    await usePortForwardStore.getState().hydrate();

    expect(usePortForwardStore.getState().runtimes[0]).toMatchObject({
      status: 'running',
      ownerIds: ['terminal:one'],
      startedAt: 10,
    });
  });

  it('stops a forward whose only owner closes while native startup is in flight', async () => {
    let resolveStart!: (value: PortForwardRuntime) => void;
    invokeStartPortForward.mockImplementationOnce((request) => new Promise((resolve) => {
      resolveStart = (value) => resolve(value);
      expect(request.profileId).toBe(profile.id);
    }));
    invokeStopPortForward.mockImplementation(async (operationId) => runtime(operationId, 'stopping'));

    const starting = usePortForwardStore
      .getState()
      .startRule(profile, rule, 'auto', 'terminal:short-lived', true);
    await vi.waitFor(() => expect(invokeStartPortForward).toHaveBeenCalledTimes(1));
    const operationId = usePortForwardStore.getState().runtimes[0].operationId;

    await usePortForwardStore.getState().stopOwner('terminal:short-lived');
    resolveStart(runtime(operationId, 'starting'));
    await starting;

    expect(invokeStopPortForward).toHaveBeenCalledWith(operationId);
    expect(usePortForwardStore.getState().runtimes[0]).toMatchObject({
      status: 'stopping',
      ownerIds: [],
    });
  });

  it('waits for a stopping listener before starting the same rule again', async () => {
    usePortForwardStore.setState({
      runtimes: [{ ...runtime('op-old', 'stopping'), ownerIds: [] }],
    });
    invokeStartPortForward.mockImplementation(async (request) => runtime(request.operationId, 'starting'));

    const starting = usePortForwardStore
      .getState()
      .startRule(profile, rule, 'auto', 'sftp:new:remote:summary', true);
    await Promise.resolve();
    expect(invokeStartPortForward).not.toHaveBeenCalled();

    usePortForwardStore.getState().applyRuntime(runtime('op-old', 'stopped'));
    await starting;

    expect(invokeStartPortForward).toHaveBeenCalledTimes(1);
    expect(usePortForwardStore.getState().runtimes[0].ownerIds).toContain(
      'sftp:new:remote:summary',
    );
  });
});
