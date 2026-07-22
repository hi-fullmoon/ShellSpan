import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { UpdateRestartDialog } from '@/components/update-restart-dialog';

vi.mock('@/hooks/useI18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}));

describe('UpdateRestartDialog', () => {
  it('stays open until the user chooses an update action', () => {
    const onLater = vi.fn();

    render(
      <UpdateRestartDialog
        open
        version="2.1.0"
        hasActiveSessions={false}
        downloadProgress={100}
        onInstallNow={vi.fn()}
        onLater={onLater}
      />,
    );

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('update.restartDialog.title')).toBeInTheDocument();
    expect(onLater).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'update.restartDialog.later' }));
    expect(onLater).toHaveBeenCalledTimes(1);
  });
});
