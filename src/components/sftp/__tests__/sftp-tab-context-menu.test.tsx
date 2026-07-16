import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SftpTabContextMenu } from '../sftp-tab-context-menu';
import type { SftpConnection } from '@/stores/sftpStore';

vi.mock('@/hooks/useI18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

const connection = {
  id: 'sftp-1',
  title: 'SFTP Tab',
  connection: {},
} as SftpConnection;

describe('SftpTabContextMenu', () => {
  it('clears the rename dialog state before the context menu is reopened', () => {
    const onClose = vi.fn();
    const { rerender } = render(
      <SftpTabContextMenu
        open
        x={10}
        y={10}
        connection={connection}
        onClose={onClose}
      />,
    );

    fireEvent.click(screen.getByText('common.rename'));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.getByDisplayValue('SFTP Tab')).toBeInTheDocument();

    rerender(
      <SftpTabContextMenu
        open={false}
        x={0}
        y={0}
        connection={null}
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByText('common.cancel'));

    rerender(
      <SftpTabContextMenu
        open
        x={20}
        y={20}
        connection={connection}
        onClose={onClose}
      />,
    );

    expect(screen.queryByDisplayValue('SFTP Tab')).not.toBeInTheDocument();
    expect(screen.getByText('common.rename')).toBeInTheDocument();
  });
});
