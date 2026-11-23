import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as tauri from '@/lib/ipc/tauri';
import { SandboxSyncDialog } from '../sandbox-sync-dialog';

describe('SandboxSyncDialog', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('stays hidden when the sandbox session has no imported source baseline', async () => {
    vi.spyOn(tauri, 'invokeSandboxDiff').mockResolvedValue(null);
    const { container } = render(<SandboxSyncDialog sessionId="session-blank" />);
    await waitFor(() => expect(tauri.invokeSandboxDiff).toHaveBeenCalledWith('session-blank'));
    expect(container).toBeEmptyDOMElement();
  });

  it('displays changes, disables conflicted items, and applies selected paths', async () => {
    const user = userEvent.setup();
    const diffSpy = vi.spyOn(tauri, 'invokeSandboxDiff').mockResolvedValue({
      sourceRoot: '/Users/demo/project',
      totalChanges: 2,
      conflictCount: 1,
      changes: [
        { path: 'src/app.ts', kind: 'modified', conflict: false, sandboxSize: 42, sourceSize: 40 },
        { path: 'README.md', kind: 'modified', conflict: true, sandboxSize: 12, sourceSize: 14 },
      ],
    });
    const applySpy = vi.spyOn(tauri, 'invokeSandboxApply').mockResolvedValue({
      applied: ['src/app.ts'],
      skippedConflicts: [],
      errors: [],
    });
    const fileDiffSpy = vi.spyOn(tauri, 'invokeSandboxFileDiff').mockResolvedValue({
      path: 'src/app.ts',
      isBinary: false,
      truncated: false,
      unifiedDiff: '@@ -1 +1 @@\n-export const v = 1;\n+export const v = 2;\n',
    });

    render(<SandboxSyncDialog sessionId="session-imported" />);
    const trigger = await screen.findByRole('button', { name: /2/ });
    await user.click(trigger);

    const fileRowButton = await screen.findByRole('button', { name: /src\/app\.ts/ });
    expect(screen.getByText('README.md')).toBeInTheDocument();

    await user.click(fileRowButton);
    await waitFor(() => expect(fileDiffSpy).toHaveBeenCalledWith('session-imported', 'src/app.ts'));
    expect(await screen.findByText('+export const v = 2;')).toBeInTheDocument();

    const applyButton = screen.getByRole('button', { name: /\(1\)/ });
    await user.click(applyButton);

    await waitFor(() => {
      expect(applySpy).toHaveBeenCalledWith({
        sessionId: 'session-imported',
        paths: ['src/app.ts'],
        allowOverwriteConflicts: false,
      });
    });
    expect(diffSpy).toHaveBeenCalledTimes(3);
  });
});
