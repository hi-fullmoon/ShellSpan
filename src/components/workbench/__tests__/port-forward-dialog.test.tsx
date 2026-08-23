import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PortForwardDialog } from '../port-forward-dialog';
import { usePortForwardStore } from '@/stores/portForwardStore';
import { useProfileStore } from '@/stores/profileStore';
import type { ConnectionProfile } from '@/types';

vi.mock('@/hooks/useI18n', () => ({
  useI18n: () => ({
    t: (key: string, variables?: Record<string, string | number>) => (
      variables ? `${key}:${JSON.stringify(variables)}` : key
    ),
  }),
}));

const initialPortForwardState = usePortForwardStore.getState();

const profile: ConnectionProfile = {
  id: 'profile-1',
  name: 'Production',
  host: 'prod.example.com',
  port: 22,
  username: 'alice',
  authMethod: 'password',
  portForwards: [
    {
      id: 'running-rule',
      name: 'Database',
      kind: 'local',
      localPort: 15432,
      remoteHost: '127.0.0.1',
      remotePort: 5432,
      autoStart: true,
    },
    {
      id: 'failed-rule',
      name: 'Preview',
      kind: 'local',
      localPort: 13000,
      remoteHost: '127.0.0.1',
      remotePort: 3000,
      autoStart: false,
    },
  ],
  createdAt: 1,
  updatedAt: 1,
};

describe('PortForwardDialog', () => {
  const stop = vi.fn().mockResolvedValue(undefined);
  const retry = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    vi.clearAllMocks();
    useProfileStore.setState({ profiles: [profile], initialized: true });
    usePortForwardStore.setState({
      ...initialPortForwardState,
      stop,
      retry,
      runtimes: [
        {
          operationId: 'op-running',
          profileId: profile.id,
          configId: 'running-rule',
          name: 'Database',
          kind: 'local',
          mode: 'auto',
          status: 'running',
          startedAt: 1_700_000_000_000,
          bytesSent: 2048,
          bytesReceived: 4096,
          ownerIds: ['terminal:one'],
        },
        {
          operationId: 'op-failed',
          profileId: profile.id,
          configId: 'failed-rule',
          name: 'Preview',
          kind: 'local',
          mode: 'manual',
          status: 'failed',
          bytesSent: 0,
          bytesReceived: 0,
          lastError: 'local port 127.0.0.1:13000 is already in use',
          errorCategory: 'portInUse',
          ownerIds: [],
        },
      ],
    });
  });

  afterEach(() => {
    usePortForwardStore.setState(initialPortForwardState, true);
  });

  it('shows lifecycle, traffic counters, port conflicts, stop, and retry controls', () => {
    render(<PortForwardDialog profile={profile} onClose={vi.fn()} />);

    expect(screen.getByText('Database')).toBeInTheDocument();
    expect(screen.getByText('2.0 KB')).toBeInTheDocument();
    expect(screen.getByText('4.0 KB')).toBeInTheDocument();
    expect(screen.getByText('portForward.error.portInUseTitle')).toBeInTheDocument();
    expect(screen.getByText(/already in use/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'portForward.stop' }));
    expect(stop).toHaveBeenCalledWith('op-running');

    fireEvent.click(screen.getByRole('button', { name: 'portForward.retry' }));
    expect(retry).toHaveBeenCalledWith('op-failed');
  });
});
