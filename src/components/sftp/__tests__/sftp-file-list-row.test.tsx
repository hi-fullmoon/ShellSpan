import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SftpFileListRow } from '../sftp-file-list-row';
import type { FileEntry } from '../file-entry-formatters';

vi.mock('@/hooks/useI18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
    locale: 'en-US',
  }),
}));

const entry: FileEntry = {
  path: '/home/user/a-very-long-file-name.txt',
  name: 'a-very-long-file-name.txt',
  kind: 'file',
  size: 100,
};

function renderRow() {
  return render(
    <SftpFileListRow
      entry={entry}
      side="local"
      selected={false}
      batchMode={false}
      selectedEntries={[]}
      onSelect={vi.fn()}
      onDoubleClick={vi.fn()}
      onContextMenu={vi.fn()}
    />,
  );
}

function mockFileNameWidth(scrollWidth: number, clientWidth: number): void {
  vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(
    function getScrollWidth(this: HTMLElement) {
      return this.textContent === entry.name ? scrollWidth : 0;
    },
  );
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(
    function getClientWidth(this: HTMLElement) {
      return this.textContent === entry.name ? clientWidth : 0;
    },
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('SftpFileListRow file name tooltip', () => {
  it('shows the full file name when the rendered name is truncated', async () => {
    mockFileNameWidth(240, 120);
    renderRow();

    await userEvent.hover(screen.getByText(entry.name));

    await waitFor(() => {
      expect(document.querySelector('[data-slot="tooltip-content"]')).toHaveTextContent(
        entry.name,
      );
    });
  });

  it('does not show a tooltip when the full file name fits', async () => {
    mockFileNameWidth(120, 120);
    renderRow();

    await userEvent.hover(screen.getByText(entry.name));

    expect(document.querySelector('[data-slot="tooltip-content"]')).not.toBeInTheDocument();
  });
});
