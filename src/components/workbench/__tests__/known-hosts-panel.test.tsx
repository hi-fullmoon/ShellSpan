import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { KnownHostsPanel } from '../known-hosts-panel';

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
  it('renders the header refresh action as a text button', () => {
    render(<KnownHostsPanel />);

    expect(screen.getByRole('button', { name: 'common.refresh' }))
      .toHaveTextContent('common.refresh');
    const search = screen.getByRole('textbox', {
      name: 'workbench.knownHosts.searchPlaceholder',
    });
    expect(search.parentElement).toHaveAttribute('data-slot', 'input-group');
    expect(search.parentElement).toHaveClass(
      'min-w-0',
      'w-64',
      'max-w-full',
      'flex-none',
    );
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
});
