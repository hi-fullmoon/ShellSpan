import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { SftpUploadConflictDialog } from '../sftp-upload-conflict-dialog';

vi.mock('@/hooks/useI18n', () => ({
  useI18n: () => ({
    t: (key: string, values?: Record<string, string>) =>
      key === 'sftp.conflict.message'
        ? `${values?.name} already exists. What would you like to do?`
        : key,
  }),
}));

describe('SftpUploadConflictDialog', () => {
  it('constrains long file names without widening the dialog', () => {
    const targetName = `.zcompdump-${'very-long-file-name-'.repeat(8)}.zwc`;

    render(
      <SftpUploadConflictDialog
        open
        conflict={{
          localPath: `/tmp/${targetName}`,
          targetName,
          existingKind: 'file',
          remainingConflicts: 0,
        }}
        onClose={vi.fn()}
        onResolve={vi.fn()}
      />,
    );

    const popup = document.body.querySelector('[data-slot="dialog-content"]');
    expect(popup).toHaveClass('w-[calc(100%-2rem)]', 'min-w-0');

    expect(screen.getByText(/already exists/)).toHaveClass(
      'min-w-0',
      'break-words',
    );

    const fileName = screen.getByText(targetName);
    expect(fileName).toHaveClass('w-full', 'truncate');
    expect(fileName.parentElement).toHaveClass('min-w-0', 'flex-1');
    expect(fileName.parentElement?.parentElement).toHaveClass(
      'min-w-0',
      'overflow-hidden',
    );
    expect(
      screen.queryByRole('button', { name: 'sftp.conflict.replace' }),
    ).not.toBeInTheDocument();
  });

  it('offers a replace action for directory conflicts', () => {
    const onResolve = vi.fn();
    render(
      <SftpUploadConflictDialog
        open
        conflict={{
          localPath: '/tmp/assets',
          targetName: 'assets',
          existingKind: 'directory',
          remainingConflicts: 0,
        }}
        onClose={vi.fn()}
        onResolve={onResolve}
      />,
    );

    fireEvent.click(
      screen.getByRole('button', { name: 'sftp.conflict.replace' }),
    );

    expect(onResolve).toHaveBeenCalledWith('replace', false);
  });
});
