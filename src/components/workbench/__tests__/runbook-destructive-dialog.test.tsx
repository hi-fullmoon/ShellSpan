import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { RunbookRunItem, RunbookTarget } from '@/types/runbook';
import { RunbookDestructiveDialog } from '../runbook-destructive-dialog';

vi.mock('@/hooks/useI18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

const target: RunbookTarget = {
  profileId: 'profile-prod',
  name: 'Production',
  host: 'prod.example.test',
  port: 2222,
  username: 'operator',
};

const item: RunbookRunItem = {
  id: 'remove-cache',
  kind: 'step',
  description: 'Remove stale cache',
  commandPreview: 'sudo rm -rf /var/cache/example',
  risk: 'destructive',
  impact: 'Removes the selected cache directory.',
  rollback: 'Restore the directory from the latest backup.',
  safeToRetry: false,
  timeoutSeconds: 30,
  status: 'awaitingApproval',
};

describe('RunbookDestructiveDialog', () => {
  it('keeps the complete target identity visible and uses a scroll-safe destructive action', () => {
    const onConfirm = vi.fn();
    render(
      <RunbookDestructiveDialog
        open
        onOpenChange={vi.fn()}
        title="Confirm destructive operation"
        description="Review the target and command."
        target={target}
        item={item}
        onConfirm={onConfirm}
      />,
    );

    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveClass(
      'max-h-[min(720px,calc(100vh-2rem))]',
      'overflow-hidden',
    );
    expect(within(dialog).getByText('Production · operator@prod.example.test:2222'))
      .toBeInTheDocument();
    expect(dialog.querySelector('[data-slot="scroll-area"]')).toHaveClass(
      'max-h-[min(540px,calc(100vh-12rem))]',
    );
    expect(dialog.querySelector('[data-slot="alert-dialog-footer"]')).not.toHaveClass(
      'border-t',
      'bg-app-surface-muted/30',
    );

    const confirm = within(dialog).getByRole('button', { name: 'runbook.confirmDestructive' });
    expect(confirm).toHaveClass('bg-destructive');
    fireEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledOnce();
  });
});
