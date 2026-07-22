import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import {
  SftpFileListHeader,
  type SftpFileListHeaderProps,
} from '../sftp-file-list-header';

vi.mock('@/hooks/useI18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
    locale: 'en-US',
  }),
}));

function renderHeader(props: Partial<SftpFileListHeaderProps> = {}) {
  const defaultProps: SftpFileListHeaderProps = {
    side: 'local',
    sortColumn: 'name',
    sortDirection: 'default',
    onSort: vi.fn(),
  };
  return render(<SftpFileListHeader {...defaultProps} {...props} />);
}

describe('SftpFileListHeader', () => {
  it('places the bottom border and text colors on each header cell', () => {
    const { container } = renderHeader({ sortColumn: 'name', sortDirection: 'asc' });
    const header = container.firstElementChild;
    const cells = screen.getAllByRole('button');

    expect(header).not.toHaveClass('border-b', 'text-muted-foreground');
    cells.forEach((cell) => {
      expect(cell).toHaveClass('border-b', 'border-app-border/50');
    });
    expect(screen.getByRole('button', { name: 'sftp.columns.name' })).toHaveClass('text-app-text');
    expect(screen.getByRole('button', { name: 'sftp.columns.dateModified' })).toHaveClass('text-muted-foreground');
  });

  it('does not show a sort icon when sortDirection is default', () => {
    renderHeader({ sortColumn: 'name', sortDirection: 'default' });

    expect(screen.queryByTestId('sort-icon-name')).not.toBeInTheDocument();
  });

  it('shows an ascending sort icon for the active column', () => {
    renderHeader({ sortColumn: 'name', sortDirection: 'asc' });

    expect(screen.getByTestId('sort-icon-name')).toBeInTheDocument();
  });

  it('shows a descending sort icon for the active column', () => {
    renderHeader({ sortColumn: 'modifiedAt', sortDirection: 'desc' });

    expect(screen.getByTestId('sort-icon-modifiedAt')).toBeInTheDocument();
  });

  it('does not show a sort icon for inactive columns', () => {
    renderHeader({ sortColumn: 'name', sortDirection: 'asc' });

    expect(screen.queryByTestId('sort-icon-modifiedAt')).not.toBeInTheDocument();
  });
});
