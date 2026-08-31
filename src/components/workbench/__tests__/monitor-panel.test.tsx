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
  it('shows local monitoring and remote snapshots on one page without redundant sections', () => {
    render(<MonitorPanel />);

    expect(screen.getByText('workbench.monitor.localTitle')).toHaveClass('sr-only');
    expect(screen.queryByText('workbench.monitor.localDescription')).not.toBeInTheDocument();
    expect(screen.getByText('remote-health-layer')).toBeInTheDocument();
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'workbench.monitor.resume' }))
      .toBeInTheDocument();
    expect(screen.getByRole('banner').querySelector('p')).not.toBeNull();
  });

  it('renders header actions with leading icons', () => {
    render(<MonitorPanel />);

    const resume = screen.getByRole('button', { name: 'workbench.monitor.resume' });
    const refresh = screen.getByRole('button', { name: 'common.refresh' });
    expect(resume).toHaveTextContent('workbench.monitor.resume');
    expect(refresh).toHaveTextContent('common.refresh');
    expect(resume.querySelector('[data-icon="inline-start"]')).toBeInTheDocument();
    expect(refresh.querySelector('[data-icon="inline-start"]')).toBeInTheDocument();
  });

  it('omits empty SFTP and disconnect detail regions', () => {
    render(<MonitorPanel />);

    const connectionHeading = screen.getByText('workbench.monitor.connectionHealth');
    const connectionCard = connectionHeading.closest('[data-slot="card"]');

    expect(connectionCard).toBeInTheDocument();
    expect(screen.queryByText('workbench.monitor.noDisconnects')).not.toBeInTheDocument();
    expect(screen.queryByText('workbench.monitor.noSftpConnections')).not.toBeInTheDocument();
    expect(connectionCard).toContainElement(screen.getByText('workbench.monitor.terminalSessions'));
  });

  it('aligns process and system monitoring in one responsive grid', () => {
    useMonitorStore.setState({
      snapshot,
      history: [
        { ts: 1, rssBytes: 480 * 1024 * 1024, cpuPercent: 12 },
        { ts: 2, rssBytes: snapshot.app.rssBytes, cpuPercent: snapshot.app.cpuPercent },
      ],
      lastUpdatedAt: 2,
    });

    render(<MonitorPanel />);

    const overviewHeading = screen.getByText('workbench.monitor.localTitle');
    const connectionHeading = screen.getByText('workbench.monitor.connectionHealth');
    const processCard = screen.getByText('workbench.monitor.appProcess')
      .closest('[data-slot="card"]');
    const systemCard = screen.getByText('workbench.monitor.system')
      .closest('[data-slot="card"]');

    expect(overviewHeading).toHaveClass('sr-only');
    expect(connectionHeading.closest('[data-slot="card"]')).toBeInTheDocument();
    expect(processCard).toBeInTheDocument();
    expect(systemCard).toBeInTheDocument();
    expect(screen.getByText('workbench.monitor.appProcess').querySelector('svg')).toBeNull();
    expect(screen.getByText('workbench.monitor.system').querySelector('svg')).toBeNull();
    expect(connectionHeading.querySelector('svg')).toBeNull();
    expect(processCard).not.toBe(systemCard);
    expect(processCard?.parentElement).toBe(systemCard?.parentElement);
    expect(processCard?.nextElementSibling).toBe(systemCard);
    expect(processCard?.parentElement).toHaveClass('grid', 'items-stretch');
    expect(processCard).toHaveClass('@min-[72rem]:col-span-7');
    expect(systemCard).toHaveClass('@min-[72rem]:col-span-5');
    const rssTrend = screen.getByRole('img', { name: 'workbench.monitor.rss' });
    expect(rssTrend).toHaveAttribute('viewBox', '0 0 300 38');
    expect(rssTrend.parentElement).toHaveClass('min-h-28', 'gap-1.5', 'py-2.5');
    expect(screen.getAllByRole('progressbar')).toHaveLength(4);
    expect(document.querySelectorAll('[data-slot="card"]')).toHaveLength(3);
    expect(screen.getByText('remote-health-layer')).toBeInTheDocument();
  });
});
