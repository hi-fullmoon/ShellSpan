import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  invokeListFileCheckpoints,
  invokePreviewFileCheckpoint,
  invokeRestoreFileCheckpoint,
  invokeRestoreFileCheckpointsBatch,
  showSuccess,
  showError,
  useI18nMock,
} = vi.hoisted(() => ({
  invokeListFileCheckpoints: vi.fn(),
  invokePreviewFileCheckpoint: vi.fn(),
  invokeRestoreFileCheckpoint: vi.fn(),
  invokeRestoreFileCheckpointsBatch: vi.fn(),
  showSuccess: vi.fn(),
  showError: vi.fn(),
  useI18nMock: vi.fn(),
}));

const mockT = (key: string, values?: Record<string, string | number>) => (
  values ? `${key}:${JSON.stringify(values)}` : key
);

vi.mock('@/hooks/useI18n', () => ({
  useI18n: () => useI18nMock() ?? { t: mockT },
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

  it('discards stale preview responses when switching between checkpoints rapidly', async () => {
    const cp1 = {
      checkpointId: 'cp-1',
      taskId: 'task-1',
      targetId: 'local-1',
      targetKind: 'local' as const,
      targetPath: '/tmp/first.conf',
      originalSha256: 'sha-1',
      postWriteSha256: 'sha-1b',
      originalByteLength: 10,
      createdAtUnixMs: 1_700_000_000_000,
      expiresAtUnixMs: 1_700_604_800_000,
    };
    const cp2 = {
      ...cp1,
      checkpointId: 'cp-2',
      targetPath: '/tmp/second.conf',
    };
    invokeListFileCheckpoints.mockResolvedValue([cp1, cp2]);

    let resolveFirstPreview!: (value: unknown) => void;
    invokePreviewFileCheckpoint
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirstPreview = resolve; }))
      .mockResolvedValueOnce({
        checkpointId: 'cp-2',
        targetPath: '/tmp/second.conf',
        targetKind: 'local',
        existedBefore: true,
        currentExists: true,
        unchanged: false,
        modifiedAfterAgent: false,
        isBinary: false,
        truncated: false,
        unifiedDiff: '@@ -1 +1 @@\n-second-new\n+second-old\n',
      });

    render(<FileCheckpointRollbackDialog sessionId="session-race" />);
    fireEvent.click(await screen.findByTestId('file-checkpoint-rollback-trigger'));
    await waitFor(() => expect(invokePreviewFileCheckpoint).toHaveBeenCalledWith('session-race', 'cp-1'));

    fireEvent.click(await screen.findByText('/tmp/second.conf'));
    expect(await screen.findByText(/-second-new/)).toBeInTheDocument();

    resolveFirstPreview({
      checkpointId: 'cp-1',
      targetPath: '/tmp/first.conf',
      targetKind: 'local',
      existedBefore: true,
      currentExists: true,
      unchanged: false,
      modifiedAfterAgent: true,
      isBinary: false,
      truncated: false,
      unifiedDiff: '@@ -1 +1 @@\n-first-new\n+first-old\n',
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByTestId('file-checkpoint-conflict-alert')).toBeNull();
    expect(screen.getByText(/-second-new/)).toBeInTheDocument();
  });

  it('does not refetch checkpoints when translator or count callback identity changes', async () => {
    invokeListFileCheckpoints.mockResolvedValue([
      {
        checkpointId: 'cp-1',
        taskId: 'task-1',
        targetId: 'local-1',
        targetKind: 'local',
        targetPath: '/tmp/app.conf',
        originalSha256: 'sha-1',
        originalByteLength: 10,
        createdAtUnixMs: 1_700_000_000_000,
        expiresAtUnixMs: 1_700_604_800_000,
      },
    ]);

    useI18nMock.mockReturnValue({ t: (key: string, values?: Record<string, string | number>) => mockT(key, values) });
    const { rerender } = render(
      <FileCheckpointRollbackDialog
        sessionId="session-locale"
        onCheckpointsCountChange={() => {}}
      />,
    );
    await screen.findByTestId('file-checkpoint-rollback-trigger');
    expect(invokeListFileCheckpoints).toHaveBeenCalledTimes(1);

    useI18nMock.mockReturnValue({ t: (key: string, values?: Record<string, string | number>) => `en:${mockT(key, values)}` });
    rerender(
      <FileCheckpointRollbackDialog
        sessionId="session-locale"
        onCheckpointsCountChange={() => {}}
      />,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(invokeListFileCheckpoints).toHaveBeenCalledTimes(1);
    useI18nMock.mockReset();
  });

  it('renders text-only action buttons without icons and structured diff stats', async () => {
    const cp = {
      checkpointId: 'cp-ui-1',
      taskId: 'task-1',
      targetId: 'remote-1',
      targetKind: 'remote' as const,
      targetPath: '/root/agent-smoke-test.md',
      originalSha256: 'sha-1',
      originalByteLength: 42,
      createdAtUnixMs: 1_700_000_000_000,
      expiresAtUnixMs: 1_700_604_800_000,
    };
    invokeListFileCheckpoints.mockResolvedValue([cp]);
    invokePreviewFileCheckpoint.mockResolvedValue({
      checkpointId: 'cp-ui-1',
      targetPath: '/root/agent-smoke-test.md',
      targetKind: 'remote',
      existedBefore: true,
      currentExists: true,
      unchanged: false,
      modifiedAfterAgent: false,
      isBinary: false,
      truncated: false,
      unifiedDiff: '@@ -1,2 +1,2 @@\n-old line\n+new line\n context\n',
    });

    render(<FileCheckpointRollbackDialog sessionId="session-ui" />);
    const trigger = await screen.findByTestId('file-checkpoint-rollback-trigger');
    expect(trigger).toHaveClass('size-7', 'relative');
    expect(trigger).toHaveAttribute('aria-label', 'ai.checkpointRollback.buttonWithCount:{"count":1}');
    expect(trigger.querySelector('svg')).not.toBeNull();
    const badge = trigger.querySelector('[data-slot="ai-header-icon-badge"]');
    expect(badge).toHaveTextContent('1');
    expect(badge).toHaveAttribute('data-tone', 'neutral');

    fireEvent.click(trigger);
    const diffViewer = await screen.findByTestId('file-checkpoint-diff-viewer');
    expect(diffViewer.querySelectorAll('[data-diff-line="removed"]')).toHaveLength(1);
    expect(diffViewer.querySelectorAll('[data-diff-line="added"]')).toHaveLength(1);
    expect(screen.getByTestId('file-checkpoint-diff-stats')).toHaveTextContent('+1-1');

    const selectAllBtn = screen.getByRole('button', { name: 'ai.checkpointRollback.selectAll' });
    const refreshBtn = screen.getByRole('button', { name: 'ai.checkpointRollback.refresh' });
    const restoreBtn = screen.getByRole('button', { name: 'ai.checkpointRollback.restore' });
    expect(selectAllBtn.querySelector('svg')).toBeNull();
    expect(refreshBtn.querySelector('svg')).toBeNull();
    expect(restoreBtn.querySelector('svg')).toBeNull();

    fireEvent.click(selectAllBtn);
    const batchBtn = await screen.findByTestId('file-checkpoint-batch-restore');
    expect(batchBtn.querySelector('svg')).toBeNull();
  });
});
