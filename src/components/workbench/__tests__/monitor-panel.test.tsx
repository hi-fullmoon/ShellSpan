import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MonitorPanel } from '../monitor-panel';
import { useAppStore } from '@/stores/appStore';
import { useMonitorStore } from '@/stores/monitorStore';
import type { SystemHealth } from '@/types';

const snapshot: SystemHealth = {
  app: {
    pid: 4200,
    rssBytes: 512 * 1024 * 1024,
    vszBytes: 1024 * 1024 * 1024,
    cpuPercent: 18.5,
    threads: 12,
    uptimeSecs: 5400,
  },
  system: {
    totalMemoryBytes: 16 * 1024 * 1024 * 1024,
    usedMemoryBytes: 10 * 1024 * 1024 * 1024,
    freeMemoryBytes: 6 * 1024 * 1024 * 1024,
    memoryUsagePercent: 62.5,
    totalSwapBytes: 2 * 1024 * 1024 * 1024,
    usedSwapBytes: 256 * 1024 * 1024,
    freeSwapBytes: 1792 * 1024 * 1024,
    cpuPercent: 24,
  },
  disk: {
    totalBytes: 512 * 1024 * 1024 * 1024,
    usedBytes: 320 * 1024 * 1024 * 1024,
    freeBytes: 192 * 1024 * 1024 * 1024,
    usagePercent: 62.5,
    mountPoint: '/',
    name: 'Macintosh HD',
  },
  appInfo: {
    version: '2.0.49',
    platform: 'macos',
    arch: 'arm64',
  },
};

vi.mock('@/hooks/useI18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
    ready: true,
    locale: 'en-US',
    setLocale: () => {},
  }),
}));

vi.mock('../remote-health-section', () => ({
  RemoteHealthSection: () => <section>remote-health-layer</section>,
}));

beforeEach(() => {
  useAppStore.setState({ activeSection: 'workbench' });
  useMonitorStore.setState({
    snapshot: undefined,
    history: [],
    status: 'ok',
    loading: false,
    error: undefined,
    lastUpdatedAt: undefined,
    paused: true,
    disconnectEvents: [],
  });
});

describe('MonitorPanel health layers', () => {
  it('separates local monitoring from remote host snapshots with tabs', async () => {
    const user = userEvent.setup();
    render(<MonitorPanel />);

    expect(screen.getByText('workbench.monitor.localDescription')).toBeInTheDocument();
    expect(screen.queryByText('remote-health-layer')).not.toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: 'workbench.monitor.remote' }));

    expect(screen.getByText('remote-health-layer')).toBeInTheDocument();
    expect(screen.queryByText('workbench.monitor.localDescription')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'workbench.monitor.resume' }))
      .not.toBeInTheDocument();
    expect(screen.getByRole('banner').querySelector('p')).toBeNull();
  });

  it('renders header actions as text buttons', () => {
    render(<MonitorPanel />);

    const resume = screen.getByRole('button', { name: 'workbench.monitor.resume' });
    const refresh = screen.getByRole('button', { name: 'common.refresh' });
    expect(resume).toHaveTextContent('workbench.monitor.resume');
    expect(refresh).toHaveTextContent('common.refresh');
    expect(resume.querySelector('svg')).toBeNull();
    expect(refresh.querySelector('svg')).toBeNull();
  });

  it('keeps empty connection states compact', () => {
    render(<MonitorPanel />);

    const disconnectEmptyState = screen.getByText('workbench.monitor.noDisconnects').parentElement;
    const sftpEmptyState = screen.getByText('workbench.monitor.noSftpConnections').parentElement;

    expect(disconnectEmptyState).toHaveClass('min-h-16');
    expect(sftpEmptyState).toHaveClass('min-h-16');
    expect(disconnectEmptyState).not.toHaveClass('h-52');
    expect(sftpEmptyState).not.toHaveClass('h-64');
  });

  it('flattens local monitoring into peer cards', () => {
    useMonitorStore.setState({
      snapshot,
      history: [
        { ts: 1, rssBytes: 480 * 1024 * 1024, cpuPercent: 12 },
        { ts: 2, rssBytes: snapshot.app.rssBytes, cpuPercent: snapshot.app.cpuPercent },
      ],
      lastUpdatedAt: 2,
    });

    render(<MonitorPanel />);

    const overviewHeading = screen.getByText('workbench.monitor.overviewTitle');
    const connectionHeading = screen.getByText('workbench.monitor.connectionHealth');
    const processCard = screen.getByText('workbench.monitor.appProcess')
      .closest('[data-slot="card"]');
    const systemCard = screen.getByText('workbench.monitor.system')
      .closest('[data-slot="card"]');

    expect(overviewHeading.closest('[data-slot="card"]')).toBeNull();
    expect(connectionHeading.closest('[data-slot="card"]')).toBeNull();
    expect(processCard).toBeInTheDocument();
    expect(systemCard).toBeInTheDocument();
    expect(processCard).not.toBe(systemCard);
    expect(screen.getAllByRole('progressbar')).toHaveLength(4);
    expect(document.querySelectorAll('[data-slot="card"]')).toHaveLength(5);
    expect(screen.queryByText('remote-health-layer')).not.toBeInTheDocument();
  });
});
