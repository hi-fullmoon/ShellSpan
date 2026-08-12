import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  hasActivePathOperation,
  isTransferComplete,
  useTransferStore,
  waitForPathIdle,
  type TransferOperation,
} from '@/stores/transferStore';

const operation: TransferOperation = {
  operationId: 'upload-1',
  kind: 'upload',
  currentPath: '/tmp/file.png',
  totalBytes: 100,
  processedBytes: 0,
  totalSteps: 1,
  completedSteps: 0,
};

describe('transferStore', () => {
  beforeEach(() => {
    useTransferStore.setState({ operations: [] });
  });

  it('marks a transfer as failed and clears the error when retrying', async () => {
    const retry = vi.fn().mockResolvedValue(undefined);
    useTransferStore.getState().addOperation({ ...operation, retry });
    useTransferStore.getState().markOperationFailed(operation.operationId, 'offline');

    expect(useTransferStore.getState().operations[0]).toMatchObject({
      status: 'failed',
      error: 'offline',
    });

    await useTransferStore.getState().retryOperation(operation.operationId);

    expect(retry).toHaveBeenCalledOnce();
    expect(useTransferStore.getState().operations[0]).toMatchObject({
      status: 'running',
      error: undefined,
    });
  });

  it('keeps a failed state when the retry fails again', async () => {
    const retry = vi.fn().mockRejectedValue(new Error('still offline'));
    useTransferStore.getState().addOperation({ ...operation, retry });

    await useTransferStore.getState().retryOperation(operation.operationId);

    expect(useTransferStore.getState().operations[0]).toMatchObject({
      status: 'failed',
      error: 'still offline',
    });
  });

  it('places new transfers before existing transfers', () => {
    useTransferStore.getState().addOperation(operation);
    useTransferStore.getState().addOperation({
      ...operation,
      operationId: 'upload-2',
      currentPath: '/tmp/new-file.png',
    });

    expect(
      useTransferStore.getState().operations.map((item) => item.operationId),
    ).toEqual(['upload-2', 'upload-1']);
  });

  it('keeps the concrete file name when a progress event omits its path', () => {
    useTransferStore.getState().addOperation(operation);

    useTransferStore.getState().updateUpload({
      operationId: operation.operationId,
      currentPath: undefined,
      totalBytes: 100,
      uploadedBytes: 100,
      totalSteps: 1,
      completedSteps: 1,
    });

    expect(useTransferStore.getState().operations[0]?.currentPath).toBe(
      '/tmp/file.png',
    );
  });

  it('detects active operations on the same path and its descendants', () => {
    useTransferStore.getState().addOperation({
      ...operation,
      kind: 'download',
      connectionId: 'connection-1',
      paths: ['/remote/archive'],
      status: 'running',
    });

    expect(hasActivePathOperation('connection-1', ['/remote/archive/file.zip'])).toBe(true);
    expect(hasActivePathOperation('connection-1', ['/remote/other.txt'])).toBe(false);
    expect(hasActivePathOperation('connection-2', ['/remote/archive'])).toBe(false);
  });

  it('keeps a path occupied until backend cancellation finishes', async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    useTransferStore.getState().addOperation({
      ...operation,
      kind: 'download',
      connectionId: 'connection-1',
      paths: ['/remote/file.zip'],
      status: 'running',
      cancel,
    });

    await useTransferStore.getState().cancelOperation(operation.operationId);

    expect(cancel).toHaveBeenCalledOnce();
    expect(useTransferStore.getState().operations[0]?.status).toBe('cancelling');
    expect(hasActivePathOperation('connection-1', ['/remote/file.zip'])).toBe(true);
  });

  it('isolates identical paths by remote connection and tracks both copy ends', () => {
    useTransferStore.getState().addOperation({
      ...operation,
      kind: 'remote-copy',
      status: 'running',
      pathScopes: [
        { connectionId: 'source', paths: ['/shared/report.txt'] },
        { connectionId: 'destination', paths: ['/shared/report.txt'] },
      ],
    });

    expect(hasActivePathOperation('source', ['/shared/report.txt'])).toBe(true);
    expect(hasActivePathOperation('destination', ['/shared/report.txt'])).toBe(true);
    expect(hasActivePathOperation('unrelated', ['/shared/report.txt'])).toBe(false);
  });

  it('updates byte and step progress for remote copies', () => {
    useTransferStore.getState().addOperation({
      ...operation,
      kind: 'remote-copy',
      operationId: 'remote-copy-progress',
    });

    useTransferStore.getState().updateRemoteCopy({
      operationId: 'remote-copy-progress',
      currentPath: '/source/report.txt',
      totalBytes: 200,
      copiedBytes: 80,
      totalSteps: 2,
      completedSteps: 1,
    });

    expect(useTransferStore.getState().operations[0]).toMatchObject({
      currentPath: '/source/report.txt',
      totalBytes: 200,
      processedBytes: 80,
      totalSteps: 2,
      completedSteps: 1,
    });
  });

  it('ignores stale progress events that arrive after completion', () => {
    useTransferStore.getState().addOperation({
      ...operation,
      kind: 'upload',
      connectionId: 'connection-1',
      paths: ['/remote/dir'],
      status: 'running',
      totalSteps: 3,
      completedSteps: 1,
    });

    useTransferStore.getState().markOperationCompleted(operation.operationId);
    // A backend event queued before the invoke resolved gets delivered late.
    useTransferStore.getState().updateUpload({
      operationId: operation.operationId,
      currentPath: '/tmp/file.png',
      totalBytes: 100,
      uploadedBytes: 40,
      totalSteps: 3,
      completedSteps: 1,
    });

    expect(useTransferStore.getState().operations[0]).toMatchObject({
      status: 'completed',
      completedSteps: 3,
    });
    expect(hasActivePathOperation('connection-1', ['/remote/dir'])).toBe(false);
  });

  it('keeps deleted paths free when a stale delete event arrives late', () => {
    useTransferStore.getState().addOperation({
      ...operation,
      kind: 'delete',
      connectionId: 'connection-1',
      paths: ['/remote/file.txt'],
      status: 'running',
      totalSteps: 1,
      completedSteps: 0,
    });

    useTransferStore.getState().markOperationCompleted(operation.operationId);
    useTransferStore.getState().updateDelete({
      operationId: operation.operationId,
      currentPath: '/remote/file.txt',
      totalSteps: 5,
      completedSteps: 2,
    });

    expect(
      hasActivePathOperation('connection-1', ['/remote/file.txt']),
    ).toBe(false);
  });

  it('still tracks progress for running delete operations', () => {
    // Deletes report entries removed so far with an unknown total (0);
    // progress events must keep applying while the operation runs.
    useTransferStore.getState().addOperation({
      ...operation,
      kind: 'delete',
      status: 'running',
      totalSteps: 0,
      completedSteps: 1,
    });

    useTransferStore.getState().updateDelete({
      operationId: operation.operationId,
      currentPath: '/remote/other.txt',
      totalSteps: 0,
      completedSteps: 2,
    });

    expect(useTransferStore.getState().operations[0]).toMatchObject({
      totalSteps: 0,
      completedSteps: 2,
    });
  });

  it('does not treat a running delete as complete when counters momentarily match', () => {
    // Delete totals grow as entries are discovered, so a running delete can
    // briefly reach completedSteps === totalSteps between discoveries; only
    // the explicit completion status may mark it complete.
    const runningDelete: TransferOperation = {
      ...operation,
      kind: 'delete',
      status: 'running',
      totalSteps: 6,
      completedSteps: 6,
    };

    expect(isTransferComplete(runningDelete)).toBe(false);
    expect(
      isTransferComplete({ ...runningDelete, status: 'completed' }),
    ).toBe(true);
  });

  it('waitForPathIdle resolves immediately when nothing is busy', async () => {
    await expect(
      waitForPathIdle([{ connectionId: 'connection-1', paths: ['/remote/a'] }]),
    ).resolves.toBeUndefined();
  });

  it('waitForPathIdle resolves once the blocking operation completes', async () => {
    useTransferStore.getState().addOperation({
      ...operation,
      kind: 'download',
      connectionId: 'connection-1',
      paths: ['/remote/archive'],
      status: 'running',
    });

    let resolved = false;
    const waiting = waitForPathIdle([
      { connectionId: 'connection-1', paths: ['/remote/archive/file.zip'] },
    ]).then(() => {
      resolved = true;
    });

    await Promise.resolve();
    expect(resolved).toBe(false);

    useTransferStore.getState().markOperationCompleted(operation.operationId);
    await waiting;
    expect(resolved).toBe(true);
  });

  it('waitForPathIdle resolves when the blocking operation is cancelled or fails', async () => {
    useTransferStore.getState().addOperation({
      ...operation,
      kind: 'upload',
      connectionId: 'connection-1',
      paths: ['/remote/file.zip'],
      status: 'running',
    });

    const waiting = waitForPathIdle([
      { connectionId: 'connection-1', paths: ['/remote/file.zip'] },
    ]);
    useTransferStore.getState().markOperationCancelled(operation.operationId);
    await expect(waiting).resolves.toBeUndefined();

    useTransferStore.getState().addOperation({
      ...operation,
      kind: 'upload',
      connectionId: 'connection-1',
      paths: ['/remote/other.zip'],
      status: 'running',
    });
    const waitingOnFailure = waitForPathIdle([
      { connectionId: 'connection-1', paths: ['/remote/other.zip'] },
    ]);
    useTransferStore.getState().markOperationFailed(operation.operationId, 'boom');
    await expect(waitingOnFailure).resolves.toBeUndefined();
  });

  it('waitForPathIdle waits for every scope to become idle', async () => {
    useTransferStore.getState().addOperation({
      ...operation,
      operationId: 'op-source',
      kind: 'download',
      connectionId: 'source',
      paths: ['/shared/report.txt'],
      status: 'running',
    });
    useTransferStore.getState().addOperation({
      ...operation,
      operationId: 'op-destination',
      kind: 'upload',
      connectionId: 'destination',
      paths: ['/shared/report.txt'],
      status: 'running',
    });

    let resolved = false;
    const waiting = waitForPathIdle([
      { connectionId: 'source', paths: ['/shared/report.txt'] },
      { connectionId: 'destination', paths: ['/shared/report.txt'] },
    ]).then(() => {
      resolved = true;
    });

    useTransferStore.getState().markOperationCompleted('op-source');
    await Promise.resolve();
    expect(resolved).toBe(false);

    useTransferStore.getState().markOperationCompleted('op-destination');
    await waiting;
    expect(resolved).toBe(true);
  });
});
