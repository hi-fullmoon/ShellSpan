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

    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveClass('flex', 'flex-col', 'gap-0', 'overflow-hidden');
    expect(dialog.querySelector('[data-slot="dialog-header"]')).toHaveClass('border-b');
    expect(dialog.querySelector('[data-slot="dialog-footer"]')).not.toHaveClass(
      'border-t',
      'bg-app-surface-muted/30',
    );
    dialog.querySelectorAll('[data-slot="card"]').forEach((card) => {
      expect(card).toHaveAttribute('data-size', 'sm');
      expect(card).toHaveClass('shrink-0');
    });

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

  it('hides remote target fields and drops the 3-column grid in dynamic SOCKS5 mode', () => {
    render(<PortForwardDialog profile={profile} onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'portForward.create' }));
    expect(screen.getByLabelText('portForward.form.name')).toHaveAttribute('placeholder', 'portForward.form.namePlaceholder');
    expect(screen.getByLabelText('portForward.form.listenPort')).toHaveAttribute('placeholder', '8080');
    expect(screen.getByLabelText('portForward.form.remoteTargetHost')).toHaveAttribute('placeholder', '127.0.0.1');
    expect(screen.getByLabelText('portForward.form.remoteTargetPort')).toHaveAttribute('placeholder', '5432');
    const localPortField = screen.getByLabelText('portForward.form.listenPort').closest('[data-slot="field"]')!;
    const portGrid = localPortField.parentElement!;
    expect(portGrid).toHaveClass('@min-[30rem]:grid-cols-3');

    fireEvent.click(screen.getByRole('button', { name: 'portForward.kind.remote' }));
    expect(screen.getByLabelText('portForward.form.localTargetPort')).toHaveAttribute('placeholder', '3000');
    expect(screen.getByLabelText('portForward.form.remoteListenHost')).toHaveAttribute('placeholder', '127.0.0.1');
    expect(screen.getByLabelText('portForward.form.remoteListenPort')).toHaveAttribute('placeholder', '8080');

    fireEvent.click(screen.getByRole('button', { name: 'portForward.kind.dynamic' }));
    expect(screen.getByLabelText('portForward.form.name')).toHaveAttribute('placeholder', 'portForward.form.namePlaceholderDynamic');
    expect(screen.getByLabelText('portForward.form.listenPort')).toHaveAttribute('placeholder', '1080');
    expect(portGrid).not.toHaveClass('@min-[30rem]:grid-cols-3');
    expect(screen.queryByLabelText('portForward.form.remoteTargetHost')).toBeNull();
    expect(screen.queryByLabelText('portForward.form.remoteListenHost')).toBeNull();
    expect(screen.queryByLabelText('portForward.form.remoteTargetPort')).toBeNull();
    expect(screen.queryByLabelText('portForward.form.remoteListenPort')).toBeNull();
  });
});
