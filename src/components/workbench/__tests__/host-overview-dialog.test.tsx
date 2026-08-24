import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { HostOverviewDialog } from '../host-overview-dialog';
import type { ConnectionProfile } from '@/types';

vi.mock('@/hooks/useI18n', () => ({
  useI18n: () => ({
    t: (key: string, variables?: Record<string, string | number>) => (
      variables ? `${key}:${JSON.stringify(variables)}` : key
    ),
  }),
}));

const profile: ConnectionProfile = {
  id: 'profile-overview',
  name: 'Production',
  host: 'prod.example.com',
  port: 22,
  username: 'alice',
  authMethod: 'password',
  createdAt: 1,
  updatedAt: 1,
};

describe('HostOverviewDialog', () => {
  it('uses the shared compact dialog layout and card density', () => {
    render(<HostOverviewDialog profile={profile} onClose={vi.fn()} />);

    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveClass('flex', 'flex-col', 'gap-0', 'overflow-hidden');
    expect(dialog.querySelector('[data-slot="dialog-header"]')).toHaveClass('border-b');
    expect(dialog.querySelector('[data-slot="dialog-footer"]')).not.toHaveClass(
      'border-t',
      'bg-app-surface-muted/30',
    );
    dialog.querySelectorAll('[data-slot="card"]').forEach((card) => {
      expect(card).toHaveAttribute('data-size', 'sm');
    });
  });
});
