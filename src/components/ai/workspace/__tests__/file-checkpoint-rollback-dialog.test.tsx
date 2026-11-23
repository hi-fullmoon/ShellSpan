import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  invokeListFileCheckpoints,
  invokePreviewFileCheckpoint,
  invokeRestoreFileCheckpoint,
  showSuccess,
  showError,
} = vi.hoisted(() => ({
  invokeListFileCheckpoints: vi.fn(),
  invokePreviewFileCheckpoint: vi.fn(),
  invokeRestoreFileCheckpoint: vi.fn(),
  showSuccess: vi.fn(),
  showError: vi.fn(),
}));

vi.mock('@/hooks/useI18n', () => ({
  useI18n: () => ({
    t: (key: string, values?: Record<string, string | number>) => (
      values ? `${key}:${JSON.stringify(values)}` : key
    ),
  }),
}));

vi.mock('@/hooks/useToast', () => ({
  useToast: () => ({
    success: showSuccess,
    error: showError,
  }),
}));

vi.mock('@/lib/ipc/tauri', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ipc/tauri')>();
  return {
    ...actual,
    invokeListFileCheckpoints,
    invokePreviewFileCheckpoint,
    invokeRestoreFileCheckpoint,
  };
});

import { FileCheckpointRollbackDialog } from '../file-checkpoint-rollback-dialog';

describe('FileCheckpointRollbackDialog', () => {
  beforeEach(() => {
    invokeListFileCheckpoints.mockReset();
    invokePreviewFileCheckpoint.mockReset();
    invokeRestoreFileCheckpoint.mockReset();
    showSuccess.mockReset();
    showError.mockReset();
  });

  it('renders nothing when the session has no file checkpoints', async () => {
    invokeListFileCheckpoints.mockResolvedValue([]);
    const { container } = render(<FileCheckpointRollbackDialog sessionId="session-empty" />);
    await waitFor(() => expect(invokeListFileCheckpoints).toHaveBeenCalledWith('session-empty'));
    expect(container).toBeEmptyDOMElement();
  });

  it('previews diff and restores a remote file checkpoint after confirmation', async () => {
    const checkpoint = {
      checkpointId: 'checkpoint-1',
      taskId: 'task-1',
      targetId: 'remote-1',
      targetKind: 'remote' as const,
      targetPath: '/etc/nginx/nginx.conf',
      originalSha256: 'abc123',
      originalByteLength: 20,
      createdAtUnixMs: 1_700_000_000_000,
      expiresAtUnixMs: 1_700_604_800_000,
    };
    invokeListFileCheckpoints.mockResolvedValue([checkpoint]);
    invokePreviewFileCheckpoint.mockResolvedValue({
      checkpointId: 'checkpoint-1',
      targetPath: '/etc/nginx/nginx.conf',
      targetKind: 'remote',
      existedBefore: true,
      currentExists: true,
      unchanged: false,
      isBinary: false,
      truncated: false,
      unifiedDiff: '@@ -1 +1 @@\n-worker_processes 4;\n+worker_processes 1;\n',
    });
    invokeRestoreFileCheckpoint.mockResolvedValue({
      checkpoint: { ...checkpoint, restoredAtUnixMs: 1_700_000_100_000 },
      action: 'restored',
    });

    render(<FileCheckpointRollbackDialog sessionId="session-remote" />);
    const trigger = await screen.findByTestId('file-checkpoint-rollback-trigger');
    expect(trigger).toHaveTextContent('1');

    fireEvent.click(trigger);
    await screen.findByText(/worker_processes 1;/);

    const restoreBtn = screen.getByRole('button', { name: 'ai.checkpointRollback.restore' });
    fireEvent.click(restoreBtn);

    const confirmHeading = await screen.findByText('ai.checkpointRollback.confirmTitle');
    expect(confirmHeading).toBeInTheDocument();
    const confirmButtons = screen.getAllByRole('button', { name: 'ai.checkpointRollback.restore' });
    fireEvent.click(confirmButtons[confirmButtons.length - 1]);

    await waitFor(() => {
      expect(invokeRestoreFileCheckpoint).toHaveBeenCalledWith('session-remote', 'checkpoint-1');
    });
    expect(showSuccess).toHaveBeenCalledWith(
      'ai.checkpointRollback.restoreSuccess:{"path":"/etc/nginx/nginx.conf"}',
    );
  });
});
