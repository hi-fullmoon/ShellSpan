import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ConnectionImportDialog } from '../connection-import-dialog';

vi.mock('@/hooks/useI18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
    ready: true,
    locale: 'en-US',
    setLocale: () => {},
  }),
}));

const candidates = [
  {
    id: 'existing',
    source: 'openssh' as const,
    name: 'Existing',
    host: 'existing.test',
    port: 22,
    username: 'deploy',
    authMethod: 'password' as const,
    warnings: [],
    conflict: true,
  },
  {
    id: 'new',
    source: 'openssh' as const,
    name: 'New',
    host: 'new.test',
    port: 22,
    username: 'deploy',
    authMethod: 'password' as const,
    warnings: [],
    conflict: false,
  },
];

describe('ConnectionImportDialog', () => {
  it('skips conflicts by default and imports only the explicit selection', async () => {
    const onImport = vi.fn(async () => undefined);
    render(
      <ConnectionImportDialog
        open={true}
        candidates={candidates}
        importing={false}
        onClose={() => {}}
        onImport={onImport}
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole('checkbox', { name: /Existing/ })).not.toBeChecked();
      expect(screen.getByRole('checkbox', { name: /New/ })).toBeChecked();
    });

    fireEvent.click(screen.getByRole('button', {
      name: 'workbench.connections.importSelected',
    }));

    expect(onImport).toHaveBeenCalledWith(['new']);
  });
});
