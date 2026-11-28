import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PortForwardPanel } from '../port-forward-panel';
import {
  WORKBENCH_VIEW_STORAGE_KEYS,
  readWorkbenchViewMode,
  saveWorkbenchViewMode,
} from '../workbench-view-mode';
import { usePortForwardStore } from '@/stores/portForwardStore';
import { useProfileStore } from '@/stores/profileStore';
import { useWorkbenchToolsStore } from '@/stores/workbenchToolsStore';
import type { ConnectionProfile } from '@/types';

vi.mock('@/hooks/useI18n', () => ({
  useI18n: () => ({
    t: (key: string, variables?: Record<string, string | number>) => (
      variables ? `${key}:${JSON.stringify(variables)}` : key
    ),
  }),
}));

const initialPortForwardState = usePortForwardStore.getState();

const prodProfile: ConnectionProfile = {
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

const stagingProfile: ConnectionProfile = {
  id: 'profile-2',
  name: 'Staging',
  host: 'staging.example.com',
  port: 2222,
  username: 'ops',
  authMethod: 'key',
  portForwards: [
    {
      id: 'socks-rule',
      name: 'Internal Proxy',
      kind: 'dynamic',
      localPort: 1080,
      remoteHost: '',
      remotePort: 0,
      autoStart: false,
    },
  ],
  createdAt: 2,
  updatedAt: 2,
};

describe('PortForwardPanel', () => {
  const stop = vi.fn().mockResolvedValue(undefined);
  const retry = vi.fn().mockResolvedValue(undefined);
  const updateProfile = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    vi.clearAllMocks();
    saveWorkbenchViewMode(WORKBENCH_VIEW_STORAGE_KEYS.portForwards, 'card');
    updateProfile.mockResolvedValue(undefined);
    useProfileStore.setState({
      profiles: [prodProfile, stagingProfile],
      initialized: true,
      updateProfile,
    });
    useWorkbenchToolsStore.setState({
      portForwardProfileId: 'all',
      quickActionsProfileId: 'all',
      overviewProfileId: null,
      pendingPortForwardDraft: null,
    });
    usePortForwardStore.setState({
      ...initialPortForwardState,
      stop,
      retry,
      runtimes: [
        {
          operationId: 'op-running',
          profileId: prodProfile.id,
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
          profileId: prodProfile.id,
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

  it('shows cross-host rules, lifecycle controls, traffic counters, and conflict alerts', () => {
    render(<PortForwardPanel />);

    expect(screen.getByText('Database')).toBeInTheDocument();
    expect(screen.getByText('Preview')).toBeInTheDocument();
    expect(screen.getByText('Internal Proxy')).toBeInTheDocument();
    expect(screen.getByLabelText('portForward.sent: 2.0 KB')).toBeInTheDocument();
    expect(screen.getByLabelText('portForward.received: 4.0 KB')).toBeInTheDocument();
    expect(screen.getByText('2.0 KB')).toBeInTheDocument();
    expect(screen.getByText('4.0 KB')).toBeInTheDocument();
    expect(screen.getByText('portForward.error.portInUseTitle')).toBeInTheDocument();
    expect(screen.getByText(/already in use/)).toBeInTheDocument();

    const metrics = document.querySelector('[data-slot="port-forward-metrics"]');
    expect(metrics).not.toBeNull();
    expect(metrics).toHaveClass('flex', 'items-center', 'justify-between', 'leading-4');
    expect(metrics).not.toHaveClass('border');
    metrics?.querySelectorAll('[tabindex="0"]').forEach((item) => {
      expect(item).toHaveClass('gap-1');
    });

    const cards = document.querySelectorAll('[data-slot="management-card"]');
    expect(cards).toHaveLength(3);
    cards.forEach((card) => {
      expect(card).toHaveClass('rounded-lg', 'border', 'bg-app-surface', 'p-2.5');
    });
    expect(document.querySelector('[title]')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'portForward.stop' }));
    expect(stop).toHaveBeenCalledWith('op-running');

    fireEvent.click(screen.getByRole('button', { name: 'portForward.retry' }));
    expect(retry).toHaveBeenCalledWith('op-failed');
  });

  it('filters rules by status and selected host with readable Select labels', () => {
    render(<PortForwardPanel />);

    expect(screen.getByRole('combobox', { name: 'portForward.hostFilter' })).toHaveTextContent(
      'portForward.allHosts',
    );

    fireEvent.click(screen.getByRole('button', { name: 'portForward.filter.active' }));
    expect(screen.getByText('Database')).toBeInTheDocument();
    expect(screen.queryByText('Preview')).not.toBeInTheDocument();
    expect(screen.queryByText('Internal Proxy')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'portForward.filter.all' }));
    act(() => {
      useWorkbenchToolsStore.getState().selectPortForwardProfile(stagingProfile.id);
    });

    expect(screen.getByRole('combobox', { name: 'portForward.hostFilter' })).toHaveTextContent(
      'Staging',
    );
    expect(screen.getByText('Internal Proxy')).toBeInTheDocument();
    expect(screen.queryByText('Database')).not.toBeInTheDocument();
  });

  it('opens a right-side Drawer without footer border-t and hides remote fields in dynamic mode', async () => {
    render(<PortForwardPanel />);

    fireEvent.click(screen.getByRole('button', { name: 'portForward.create' }));
    const drawer = screen.getByRole('dialog');
    expect(drawer).toHaveAttribute('data-slot', 'drawer-content');
    const drawerFooter = drawer.querySelector('[data-slot="drawer-footer"]');
    expect(drawerFooter).not.toHaveClass('border-t');
    expect(drawerFooter).toHaveClass('shrink-0', 'px-4', 'pb-4', 'pt-3');
    expect(drawer.querySelector('[data-slot="scroll-area"]')).toHaveClass('min-h-0', 'flex-1');
    expect(screen.queryByText('portForward.validation.name')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'common.save' }));
    expect(screen.getByText('portForward.validation.name')).toBeInTheDocument();
    expect(updateProfile).not.toHaveBeenCalled();

    expect(screen.getByLabelText('portForward.form.name')).toHaveAttribute(
      'placeholder',
      'portForward.form.namePlaceholder',
    );
    expect(screen.getByLabelText('portForward.form.listenPort')).toHaveAttribute('placeholder', '8080');
    expect(screen.getByLabelText('portForward.form.remoteTargetHost')).toHaveAttribute('placeholder', '127.0.0.1');
    expect(screen.getByLabelText('portForward.form.remoteTargetPort')).toHaveAttribute('placeholder', '5432');

    fireEvent.click(screen.getByRole('button', { name: 'portForward.kind.remote' }));
    expect(screen.getByLabelText('portForward.form.localTargetPort')).toHaveAttribute('placeholder', '3000');
    expect(screen.getByLabelText('portForward.form.remoteListenHost')).toHaveAttribute('placeholder', '127.0.0.1');
    expect(screen.getByLabelText('portForward.form.remoteListenPort')).toHaveAttribute('placeholder', '8080');

    fireEvent.click(screen.getByRole('button', { name: 'portForward.kind.dynamic' }));
    expect(screen.getByLabelText('portForward.form.name')).toHaveAttribute(
      'placeholder',
      'portForward.form.namePlaceholderDynamic',
    );
    expect(screen.getByLabelText('portForward.form.listenPort')).toHaveAttribute('placeholder', '1080');
    expect(screen.queryByLabelText('portForward.form.remoteTargetHost')).toBeNull();
    expect(screen.queryByLabelText('portForward.form.remoteListenHost')).toBeNull();

    fireEvent.change(screen.getByLabelText('portForward.form.name'), { target: { value: 'SOCKS' } });
    fireEvent.change(screen.getByLabelText('portForward.form.listenPort'), { target: { value: '1088' } });
    fireEvent.click(screen.getByRole('button', { name: 'common.save' }));

    await waitFor(() => {
      expect(updateProfile).toHaveBeenCalledWith(prodProfile.id, {
        portForwards: expect.arrayContaining([
          expect.objectContaining({
            name: 'SOCKS',
            kind: 'dynamic',
            localPort: 1088,
            remoteHost: '',
            remotePort: 0,
          }),
        ]),
      });
    });
  });

  it('consumes a pending proposal draft and pre-fills the Drawer', async () => {
    useWorkbenchToolsStore.getState().requestPortForwardDraft(stagingProfile.id, {
      name: 'Proposed Web',
      kind: 'local',
      localPort: 8080,
      remoteHost: '127.0.0.1',
      remotePort: 80,
      autoStart: true,
    });

    render(<PortForwardPanel />);

    expect(await screen.findByDisplayValue('Proposed Web')).toBeInTheDocument();
    expect(screen.getByDisplayValue('8080')).toBeInTheDocument();
    expect(useWorkbenchToolsStore.getState().pendingPortForwardDraft).toBeNull();
  });

  it('requires confirmation before stopping and deleting a forwarding rule', async () => {
    render(<PortForwardPanel />);

    const deleteButtons = screen.getAllByRole('button', { name: 'common.delete' });
    fireEvent.click(deleteButtons[0]);

    expect(updateProfile).not.toHaveBeenCalled();
    const alertDialog = await screen.findByRole('alertdialog');
    expect(alertDialog).toHaveTextContent('portForward.deleteTitle');
    expect(alertDialog).toHaveTextContent('portForward.deleteConfirmActive:{"name":"Database"}');

    fireEvent.click(screen.getByRole('button', { name: 'common.delete' }));

    await waitFor(() => {
      expect(stop).toHaveBeenCalledWith('op-running');
      expect(updateProfile).toHaveBeenCalledWith(prodProfile.id, {
        portForwards: [prodProfile.portForwards![1]],
      });
    });
  });

  it('keeps the single-line metrics slot stable across idle, starting, running, and stopped states', () => {
    useProfileStore.setState({
      profiles: [{ ...prodProfile, portForwards: [prodProfile.portForwards![0]] }],
      initialized: true,
      updateProfile,
    });
    usePortForwardStore.setState({ ...initialPortForwardState, runtimes: [] });

    render(<PortForwardPanel />);
    expect(document.querySelector('[data-slot="port-forward-metrics-spacer"]')).toHaveClass('h-4');
    expect(document.querySelector('[data-slot="port-forward-metrics"]')).toBeNull();

    act(() => {
      usePortForwardStore.setState({
        runtimes: [
          {
            operationId: 'op-starting',
            profileId: prodProfile.id,
            configId: 'running-rule',
            name: 'Database',
            kind: 'local',
            mode: 'manual',
            status: 'starting',
            bytesSent: 0,
            bytesReceived: 0,
            ownerIds: [],
          },
        ],
      });
    });
    expect(document.querySelector('[data-slot="port-forward-metrics"]')).toHaveClass('h-4');
    expect(document.querySelector('[data-slot="port-forward-metrics-spacer"]')).toBeNull();

    act(() => {
      usePortForwardStore.setState({
        runtimes: [
          {
            operationId: 'op-starting',
            profileId: prodProfile.id,
            configId: 'running-rule',
            name: 'Database',
            kind: 'local',
            mode: 'manual',
            status: 'running',
            startedAt: 1_700_000_000_000,
            bytesSent: 0,
            bytesReceived: 0,
            ownerIds: [],
          },
        ],
      });
    });
    expect(document.querySelector('[data-slot="port-forward-metrics"]')).toHaveClass('h-4');

    act(() => {
      usePortForwardStore.setState({
        runtimes: [
          {
            operationId: 'op-starting',
            profileId: prodProfile.id,
            configId: 'running-rule',
            name: 'Database',
            kind: 'local',
            mode: 'manual',
            status: 'stopped',
            startedAt: 1_700_000_000_000,
            stoppedAt: 1_700_000_005_000,
            bytesSent: 0,
            bytesReceived: 0,
            ownerIds: [],
          },
        ],
      });
    });
    expect(document.querySelector('[data-slot="port-forward-metrics"]')).toHaveClass('h-4');
  });

  it('shows a loading state while profiles are still hydrating', () => {
    useProfileStore.setState({ profiles: [], initialized: false, updateProfile });
    const { container } = render(<PortForwardPanel />);

    expect(container.querySelector('svg.animate-spin')).toBeInTheDocument();
    expect(container.querySelector('[data-slot="panel-empty-state"]')).toBeNull();
    expect(screen.queryByText('portForward.noProfilesTitle')).not.toBeInTheDocument();
  });

  it('switches to table view, sorts by rule name, and persists the preference locally', () => {
    const { unmount } = render(<PortForwardPanel />);

    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'workbench.connections.view.table' }));

    expect(readWorkbenchViewMode(WORKBENCH_VIEW_STORAGE_KEYS.portForwards)).toBe('table');
    const table = screen.getByRole('table', { name: 'workbench.portForwards.title' });
    expect(within(table).getAllByRole('row')).toHaveLength(4);
    expect(within(table).getByText('Database')).toBeInTheDocument();
    expect(within(table).getByText('Internal Proxy')).toBeInTheDocument();

    const nameSort = within(table).getByRole('button', {
      name: 'workbench.connections.table.sortBy:{"column":"portForward.table.name"}',
    });
    fireEvent.click(nameSort);
    const orderedNames = () => within(table)
      .getAllByRole('row')
      .slice(1)
      .map((row) => row.querySelector('td')?.textContent ?? '');
    expect(orderedNames()[0]).toContain('Database');
    expect(orderedNames()[1]).toContain('Internal Proxy');
    expect(orderedNames()[2]).toContain('Preview');

    fireEvent.click(nameSort);
    expect(orderedNames()[0]).toContain('Preview');

    unmount();
    render(<PortForwardPanel />);
    expect(screen.getByRole('table', { name: 'workbench.portForwards.title' })).toBeInTheDocument();
  });
});
