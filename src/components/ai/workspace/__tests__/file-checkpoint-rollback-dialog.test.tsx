import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  invokeListFileCheckpoints,
  invokePreviewFileCheckpoint,
  invokeRestoreFileCheckpoint,
  invokeRestoreFileCheckpointsBatch,
  showSuccess,
  showError,
} = vi.hoisted(() => ({
  invokeListFileCheckpoints: vi.fn(),
  invokePreviewFileCheckpoint: vi.fn(),
  invokeRestoreFileCheckpoint: vi.fn(),
  invokeRestoreFileCheckpointsBatch: vi.fn(),
  showSuccess: vi.fn(),
  showError: vi.fn(),
}));

const mockT = (key: string, values?: Record<string, string | number>) => (
  values ? `${key}:${JSON.stringify(values)}` : key
);

vi.mock('@/hooks/useI18n', () => ({
  useI18n: () => ({ t: mockT }),
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
    invokeRestoreFileCheckpointsBatch,
  };
});

import { FileCheckpointRollbackDialog } from '../file-checkpoint-rollback-dialog';

describe('FileCheckpointRollbackDialog', () => {
  beforeEach(() => {
    invokeListFileCheckpoints.mockReset();
    invokePreviewFileCheckpoint.mockReset();
    invokeRestoreFileCheckpoint.mockReset();
    invokeRestoreFileCheckpointsBatch.mockReset();
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
      modifiedAfterAgent: false,
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
      expect(invokeRestoreFileCheckpoint).toHaveBeenCalledWith('session-remote', 'checkpoint-1', false);
    });
    expect(showSuccess).toHaveBeenCalledWith(
      'ai.checkpointRollback.restoreSuccess:{"path":"/etc/nginx/nginx.conf"}',
    );
  });

  it('shows manual-edit conflict warning and supports batch rollback with conflict confirmation', async () => {
    const cp1 = {
      checkpointId: 'cp-1',
      taskId: 'task-1',
      targetId: 'remote-1',
      targetKind: 'remote' as const,
      targetPath: '/etc/nginx/nginx.conf',
      originalSha256: 'sha-a',
      postWriteSha256: 'sha-a-after',
      originalByteLength: 20,
      createdAtUnixMs: 1_700_000_000_000,
      expiresAtUnixMs: 1_700_604_800_000,
    };
    const cp2 = {
      checkpointId: 'cp-2',
      taskId: 'task-1',
      targetId: 'remote-1',
      targetKind: 'remote' as const,
      targetPath: '/etc/nginx/upstream.conf',
      originalSha256: 'sha-b',
      postWriteSha256: 'sha-b-after',
      originalByteLength: 20,
      createdAtUnixMs: 1_700_000_001_000,
      expiresAtUnixMs: 1_700_604_800_000,
    };
    invokeListFileCheckpoints.mockResolvedValue([cp1, cp2]);
    invokePreviewFileCheckpoint.mockResolvedValue({
      checkpointId: 'cp-1',
      targetPath: '/etc/nginx/nginx.conf',
      targetKind: 'remote',
      existedBefore: true,
      currentExists: true,
      unchanged: false,
      modifiedAfterAgent: true,
      isBinary: false,
      truncated: false,
      unifiedDiff: '@@ -1 +1 @@\n-manual\n+orig\n',
    });
    invokeRestoreFileCheckpointsBatch
      .mockResolvedValueOnce({
        restored: [{ checkpoint: { ...cp2, restoredAtUnixMs: 1_700_000_200_000 }, action: 'restored' }],
        conflicts: ['cp-1'],
        failed: [],
      })
      .mockResolvedValueOnce({
        restored: [{ checkpoint: { ...cp1, restoredAtUnixMs: 1_700_000_300_000 }, action: 'restored' }],
        conflicts: [],
        failed: [],
      });

    render(<FileCheckpointRollbackDialog sessionId="session-batch" />);
    fireEvent.click(await screen.findByTestId('file-checkpoint-rollback-trigger'));
    expect(await screen.findByTestId('file-checkpoint-conflict-alert')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'ai.checkpointRollback.selectAll' }));
    fireEvent.click(await screen.findByTestId('file-checkpoint-batch-restore'));
    const firstConfirm = await screen.findAllByRole('button', { name: 'ai.checkpointRollback.restore' });
    fireEvent.click(firstConfirm[firstConfirm.length - 1]);

    await waitFor(() => {
      expect(invokeRestoreFileCheckpointsBatch).toHaveBeenCalledWith('session-batch', ['cp-1', 'cp-2'], false);
    });

    const overwriteBtn = await screen.findByRole('button', { name: 'ai.checkpointRollback.confirmConflictOverwrite' });
    fireEvent.click(overwriteBtn);

    await waitFor(() => {
      expect(invokeRestoreFileCheckpointsBatch).toHaveBeenLastCalledWith('session-batch', ['cp-1'], true);
    });
  });

  it('skips streaming refreshes while refreshEnabled is false and uses created-file conflict copy', async () => {
    const createdLocal = {
      checkpointId: 'cp-new',
      taskId: 'task-1',
      targetId: 'local-1',
      targetKind: 'local' as const,
      targetPath: '/tmp/new-file.conf',
      postWriteSha256: 'sha-after',
      originalByteLength: 0,
      createdAtUnixMs: 1_700_000_000_000,
      expiresAtUnixMs: 1_700_604_800_000,
    };
    invokeListFileCheckpoints.mockResolvedValue([createdLocal]);
    invokePreviewFileCheckpoint.mockResolvedValue({
      checkpointId: 'cp-new',
      targetPath: '/tmp/new-file.conf',
      targetKind: 'local',
      existedBefore: false,
      currentExists: true,
      unchanged: false,
      modifiedAfterAgent: true,
      isBinary: false,
      truncated: false,
      unifiedDiff: '@@ -1 +0,0 @@\n-manual edit\n',
    });

    const { rerender } = render(
      <FileCheckpointRollbackDialog sessionId="session-stream" refreshSignal={1} refreshEnabled={false} />,
    );
    expect(invokeListFileCheckpoints).not.toHaveBeenCalled();

    rerender(
      <FileCheckpointRollbackDialog sessionId="session-stream" refreshSignal={2} refreshEnabled={true} />,
    );
    fireEvent.click(await screen.findByTestId('file-checkpoint-rollback-trigger'));
    expect(await screen.findByTestId('file-checkpoint-conflict-alert')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'ai.checkpointRollback.restore' }));
    expect(
      await screen.findByText('ai.checkpointRollback.confirmConflictTrashLocal:{"path":"/tmp/new-file.conf"}'),
    ).toBeInTheDocument();
  });
});
