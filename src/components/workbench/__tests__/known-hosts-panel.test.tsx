import { fireEvent, render, screen, within, waitFor } from '@testing-library/react';
import { useToastStore } from '@/stores/toastStore';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { KnownHostsPanel } from '../known-hosts-panel';
import {
  WORKBENCH_VIEW_STORAGE_KEYS,
  readWorkbenchViewMode,
  saveWorkbenchViewMode,
} from '../workbench-view-mode';

const { loadHosts, removeHost } = vi.hoisted(() => ({
  loadHosts: vi.fn().mockResolvedValue(undefined),
  removeHost: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/hooks/useI18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('@/stores/knownHostsStore', () => ({
  useKnownHostsStore: () => ({
    hosts: [
      {
        host: 'prod.example.com',
        port: 22,
        keyType: 'ED25519',
        fingerprint: 'SHA256:fingerprint',
      },
    ],
    loading: false,
    error: undefined,
    loadHosts,
    removeHost,
  }),
}));

describe('KnownHostsPanel', () => {
  beforeEach(() => {
    saveWorkbenchViewMode(WORKBENCH_VIEW_STORAGE_KEYS.knownHosts, 'card');
  });

  it('confirms fingerprint copying on the button without a success toast', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    useToastStore.setState({ toasts: [] });
    render(<KnownHostsPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'workbench.knownHosts.copyFingerprint' }));
    const copied = await screen.findByRole('button', { name: 'common.copied' });
    expect(copied.querySelector('.lucide-check')).toBeInTheDocument();
    expect(writeText).toHaveBeenCalledExactlyOnceWith('SHA256:fingerprint');
    expect(useToastStore.getState().toasts).toHaveLength(0);
    await waitFor(() => expect(copied).toHaveAccessibleName('workbench.knownHosts.copyFingerprint'), { timeout: 2_000 });
  });

  it('provides labeled search and refresh actions in the header', () => {
    render(<KnownHostsPanel />);

    const header = screen.getByRole('banner');
    expect(within(header).getByRole('button', { name: 'common.refresh' }))
      .toHaveTextContent('common.refresh');
    const search = within(header).getByRole('textbox', {
      name: 'workbench.knownHosts.searchPlaceholder',
    });
    expect(search.parentElement).toHaveAttribute('data-slot', 'input-group');
  });

  it('spaces known-host cards with the compact grid gap', () => {
    const { container } = render(<KnownHostsPanel />);

    const grid = container.querySelector('.grid') as HTMLElement;
    expect(grid).toHaveStyle({ gap: '0.5rem' });
  });

  it('uses the compact file-manager delete confirmation style', () => {
    render(<KnownHostsPanel />);

    fireEvent.click(screen.getByLabelText('common.delete'));

    const dialog = screen.getByRole('alertdialog');
    const deleteButton = screen.getByRole('button', { name: 'common.delete' });
    const cancelButton = screen.getByRole('button', { name: 'common.cancel' });
    expect(dialog).toHaveClass('gap-0', 'overflow-hidden', 'p-0');
    expect(deleteButton).toHaveClass('bg-destructive', 'h-8');
    expect(deleteButton.querySelector('svg')).toBeNull();
    expect(cancelButton.querySelector('svg')).toBeNull();
    expect(
      screen.getByText('workbench.knownHosts.removeTitle'),
    ).toBeInTheDocument();
  });

  it('switches to table view, renders host fingerprints, and persists the preference locally', () => {
    const { unmount } = render(<KnownHostsPanel />);
    expect(screen.queryByRole('table')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'workbench.connections.view.table' }));
    expect(readWorkbenchViewMode(WORKBENCH_VIEW_STORAGE_KEYS.knownHosts)).toBe('table');

    const table = screen.getByRole('table', { name: 'workbench.knownHosts.title' });
    expect(within(table).getAllByRole('row')).toHaveLength(2);
    expect(within(table).getByText('prod.example.com:22')).toBeInTheDocument();
    expect(within(table).getAllByText('SHA256:fingerprint').length).toBeGreaterThanOrEqual(1);

    unmount();
    render(<KnownHostsPanel />);
    expect(screen.getByRole('table', { name: 'workbench.knownHosts.title' })).toBeInTheDocument();
  });
});
