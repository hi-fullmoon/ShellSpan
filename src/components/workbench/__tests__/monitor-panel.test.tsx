import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MonitorPanel } from '../monitor-panel';
import { useAppStore } from '@/stores/appStore';
import { useMonitorStore } from '@/stores/monitorStore';

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
});
