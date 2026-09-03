import { fireEvent, render, screen } from '@testing-library/react';
import { TriangleAlertIcon } from 'lucide-react';
import { describe, expect, it, vi } from 'vitest';
import { ConfirmationDialog } from '@/components/ui/confirmation-dialog';

vi.mock('@/hooks/useI18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

describe('ConfirmationDialog', () => {
  it('provides the shared compact confirmation layout and action semantics', () => {
    const onConfirm = vi.fn();

    render(
      <ConfirmationDialog
        open
        onOpenChange={vi.fn()}
        title="Confirm action"
        description="This action needs confirmation."
        confirmLabel="Continue"
        confirmVariant="destructive"
        media={<TriangleAlertIcon />}
        onConfirm={onConfirm}
      />,
    );

    const dialog = screen.getByRole('alertdialog');
    const header = dialog.querySelector('[data-slot="alert-dialog-header"]');
    const confirmButton = screen.getByRole('button', { name: 'Continue' });
    const cancelButton = screen.getByRole('button', { name: 'common.cancel' });

    expect(dialog).toHaveClass('max-w-sm', 'gap-0', 'overflow-hidden', 'p-0');
    expect(header).toHaveClass('border-b', 'px-4', 'py-3');
    expect(confirmButton).toHaveClass('bg-destructive', 'h-8');
    expect(cancelButton).toHaveClass('h-8');
    expect(dialog.querySelector('[data-slot="alert-dialog-media"]')).toBeInTheDocument();

    fireEvent.click(confirmButton);
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it('renders supplemental confirmation details in the shared body', () => {
    render(
      <ConfirmationDialog
        open
        onOpenChange={vi.fn()}
        title="Authorize"
        description="Review the requested scope."
        confirmLabel="Allow"
        onConfirm={vi.fn()}
      >
        <div data-testid="confirmation-details">Scope details</div>
      </ConfirmationDialog>,
    );

    expect(screen.getByTestId('confirmation-details')).toBeInTheDocument();
  });

  it('supports extra-small actions for compact settings flows', () => {
    render(
      <ConfirmationDialog
        open
        onOpenChange={vi.fn()}
        title="Confirm setting"
        description="This setting needs confirmation."
        confirmLabel="Continue"
        buttonSize="xs"
        onConfirm={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: 'Continue' })).toHaveClass('h-6');
    expect(screen.getByRole('button', { name: 'common.cancel' })).toHaveClass('h-6');
  });
});
