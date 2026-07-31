import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { PermissionsDialog } from '../sftp-dialogs';

vi.mock('@/hooks/useI18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
    locale: 'en-US',
  }),
}));

describe('PermissionsDialog', () => {
  const renderDialog = (onConfirm = vi.fn(), onClose = vi.fn()) => {
    render(
      <PermissionsDialog open onClose={onClose} onConfirm={onConfirm} defaultValue={0o644} />,
    );
    return { onConfirm, onClose };
  };

  it('confirms a valid octal value', () => {
    const { onConfirm, onClose } = renderDialog();
    const input = screen.getByRole('textbox');

    fireEvent.change(input, { target: { value: '755' } });
    fireEvent.click(screen.getByRole('button', { name: 'common.save' }));

    expect(onConfirm).toHaveBeenCalledWith(0o755);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('accepts a four-digit octal value', () => {
    const { onConfirm } = renderDialog();
    const input = screen.getByRole('textbox');

    fireEvent.change(input, { target: { value: '0755' } });
    fireEvent.click(screen.getByRole('button', { name: 'common.save' }));

    expect(onConfirm).toHaveBeenCalledWith(0o755);
  });

  it('rejects trailing garbage instead of silently parsing a prefix', () => {
    const { onConfirm, onClose } = renderDialog();
    const input = screen.getByRole('textbox');

    fireEvent.change(input, { target: { value: '755abc' } });

    const saveButton = screen.getByRole('button', { name: 'common.save' });
    expect(saveButton).toBeDisabled();

    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('rejects digits outside the octal range', () => {
    const { onConfirm, onClose } = renderDialog();
    const input = screen.getByRole('textbox');

    fireEvent.change(input, { target: { value: '999' } });

    expect(screen.getByRole('button', { name: 'common.save' })).toBeDisabled();
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});
