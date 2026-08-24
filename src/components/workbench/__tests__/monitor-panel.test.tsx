import { render, screen } from '@testing-library/react';
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
  it('renders remote host snapshots separately from local app monitoring', () => {
    render(<MonitorPanel />);
    const remote = screen.getByText('remote-health-layer');
    const local = screen.getByText('workbench.monitor.localTitle');
    expect(remote.compareDocumentPosition(local) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText('workbench.monitor.localDescription')).toBeInTheDocument();
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

  it('prioritizes the live overview and consolidates local detail cards', () => {
    useMonitorStore.setState({
      snapshot,
      history: [
        { ts: 1, rssBytes: 480 * 1024 * 1024, cpuPercent: 12 },
        { ts: 2, rssBytes: snapshot.app.rssBytes, cpuPercent: snapshot.app.cpuPercent },
      ],
      lastUpdatedAt: 2,
    });

    render(<MonitorPanel />);

    const overview = screen.getByText('workbench.monitor.overviewTitle');
    const remote = screen.getByText('remote-health-layer');
    expect(overview.compareDocumentPosition(remote) & Node.DOCUMENT_POSITION_FOLLOWING)
      .toBeTruthy();
    expect(screen.getByText('workbench.monitor.appProcessDescription')).toBeInTheDocument();
    expect(screen.getByText('workbench.monitor.systemDescription')).toBeInTheDocument();
    expect(screen.getAllByRole('progressbar')).toHaveLength(4);
    const processCard = screen.getByText('workbench.monitor.appProcessDescription')
      .closest('[data-slot="card"]');
    expect(processCard).toBeInTheDocument();
    expect(processCard?.querySelector('[data-slot="card-footer"]')).toBeNull();
  });
});
