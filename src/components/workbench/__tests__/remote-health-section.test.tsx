import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RemoteHealthSection } from '../remote-health-section';
import { useProfileStore } from '@/stores/profileStore';
import { useRemoteHealthStore } from '@/stores/remoteHealthStore';
import { useAgentStore } from '@/stores/agentStore';
import { useTerminalStore } from '@/stores/terminalStore';
import type {
  ConnectionProfile,
  RemoteHealthSnapshot,
  RemoteHealthSnapshotResult,
} from '@/types';

const mocks = vi.hoisted(() => ({ connect: vi.fn() }));

vi.mock('@/hooks/useI18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
    ready: true,
    locale: 'en-US',
    setLocale: () => {},
  }),
}));

vi.mock('@/hooks/useConnectSession', () => ({
  useConnectSession: () => ({ connect: mocks.connect, openLocal: vi.fn() }),
}));

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

beforeEach(() => {
  mocks.connect.mockReset();
  useAgentStore.getState().clear();
  useProfileStore.setState({ profiles: [profile], initialized: true });
  useRemoteHealthStore.setState({ entries: {}, selectedProfileId: profile.id });
  useTerminalStore.setState({ sessions: [], activeSessionId: null });
});

describe('RemoteHealthSection authorization', () => {
  it('does not collect until the user approves the one-shot read-only scope', async () => {
    const result: RemoteHealthSnapshotResult = {
      operationId: 'remote-health:test',
      profileId: profile.id,
      status: 'cancelled',
      checkedAt: Date.now(),
      source: {
        kind: 'sshReadOnly',
        commandSetVersion: 'termbridge-read-only-v1',
        profileId: profile.id,
        host: profile.host,
        port: profile.port,
        username: profile.username,
      },
    };
    const collect = vi.fn().mockResolvedValue(result);
    useRemoteHealthStore.setState({ collect });
    render(<RemoteHealthSection />);

    fireEvent.click(screen.getByRole('button', { name: 'remoteHealth.collect' }));
    expect(collect).not.toHaveBeenCalled();

    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('remoteHealth.authorization.scope')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', {
      name: 'remoteHealth.authorization.confirm',
    }));

    await waitFor(() => expect(collect).toHaveBeenCalledOnce());
    expect(collect).toHaveBeenCalledWith(profile, true);
  });

  it('reuses the connected profile when handing an abnormal snapshot to the Agent', async () => {
    const checkedAt = Date.parse('2026-08-23T08:00:00.000Z');
    const source = {
      kind: 'sshReadOnly' as const,
      commandSetVersion: 'termbridge-read-only-v1',
      profileId: profile.id,
      host: profile.host,
      port: profile.port,
      username: profile.username,
    };
    const snapshot: RemoteHealthSnapshot = {
      system: {
        osFamily: 'linux',
        hostname: 'prod-1',
        kernelVersion: '6.8.0',
        architecture: 'x86_64',
        cpuCount: 4,
        uptimeSecs: 3_600,
      },
      cpu: { usagePercent: 96 },
      memory: { totalBytes: 100, usedBytes: 50, availableBytes: 50, usagePercent: 50 },
      disk: {
        totalBytes: 100,
        usedBytes: 20,
        availableBytes: 80,
        usagePercent: 20,
        mountPoint: '/',
      },
      load: { oneMinute: 0.2, fiveMinutes: 0.1, fifteenMinutes: 0.05 },
    };
    useRemoteHealthStore.setState({
      selectedProfileId: profile.id,
      entries: {
        [profile.id]: {
          profileId: profile.id,
          phase: 'idle',
          snapshot,
          snapshotCheckedAt: checkedAt,
          snapshotSource: source,
          lastResult: {
            operationId: 'remote-health:test',
            profileId: profile.id,
            status: 'success',
            checkedAt,
            source,
            snapshot,
          },
        },
      },
    });
    useTerminalStore.setState({
      sessions: [{
        sessionId: 'session-health',
        title: profile.name,
        host: profile.host,
        port: profile.port,
        username: profile.username,
        profileId: profile.id,
        status: 'connected',
      }],
      activeSessionId: null,
    });
    const diagnosis = vi.fn();
    document.addEventListener('termbridge:start-health-diagnosis', diagnosis);

    try {
      render(<RemoteHealthSection />);
      fireEvent.click(screen.getByRole('button', { name: 'remoteHealth.diagnose' }));

      await waitFor(() => expect(diagnosis).toHaveBeenCalledOnce());
      expect(mocks.connect).not.toHaveBeenCalled();
      expect((diagnosis.mock.calls[0][0] as CustomEvent).detail).toMatchObject({
        profileId: profile.id,
        sessionId: 'session-health',
        context: { content: expect.stringContaining(`Profile ID: ${profile.id}`) },
      });
      expect(useTerminalStore.getState().activeSessionId).toBe('session-health');
    } finally {
      document.removeEventListener('termbridge:start-health-diagnosis', diagnosis);
    }
  });
});
