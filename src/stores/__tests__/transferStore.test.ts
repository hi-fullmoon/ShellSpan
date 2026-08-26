import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cancelQueuedPathOperationsForOwner,
  countActiveTransfersForOwners,
  hasActivePathOperation,
  isTransferComplete,
  runPathOperation,
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
      errorCategory: 'unknown',
    });

    await useTransferStore.getState().retryOperation(operation.operationId);

    expect(retry).toHaveBeenCalledOnce();
    expect(useTransferStore.getState().operations[0]).toMatchObject({
      status: 'running',
      error: undefined,
      errorCategory: undefined,
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

  it('queues a retry behind an active operation on the same path', async () => {
    const retry = vi.fn().mockResolvedValue(undefined);
    useTransferStore.getState().addOperation({
      ...operation,
      operationId: 'retry-target',
      connectionId: 'connection-1',
      paths: ['/remote/file.txt'],
      status: 'failed',
      retry,
    });
    useTransferStore.getState().addOperation({
      ...operation,
      operationId: 'blocking-transfer',
      connectionId: 'connection-1',
      paths: ['/remote/file.txt'],
      status: 'running',
    });

    const retrying = useTransferStore.getState().retryOperation('retry-target');
    await Promise.resolve();
    expect(retry).not.toHaveBeenCalled();

    useTransferStore.getState().markOperationCompleted('blocking-transfer');
    await retrying;
    expect(retry).toHaveBeenCalledOnce();
    expect(
      useTransferStore.getState().operations.find(
        (item) => item.operationId === 'retry-target',
      )?.status,
    ).toBe('running');
  });

  it('does not run a queued retry after its transfer row is discarded', async () => {
    const retry = vi.fn().mockResolvedValue(undefined);
    useTransferStore.getState().addOperation({
      ...operation,
      operationId: 'retry-target',
      connectionId: 'connection-1',
      paths: ['/remote/file.txt'],
      status: 'failed',
      retry,
    });
    useTransferStore.getState().addOperation({
      ...operation,
      operationId: 'blocking-transfer',
      connectionId: 'connection-1',
      paths: ['/remote/file.txt'],
      status: 'running',
    });

    const retrying = useTransferStore.getState().retryOperation('retry-target');
    await Promise.resolve();
    useTransferStore.getState().removeOperation('retry-target');
    useTransferStore.getState().markOperationCompleted('blocking-transfer');
    await retrying;

    expect(retry).not.toHaveBeenCalled();
    expect(
      useTransferStore.getState().operations.some(
        (item) => item.operationId === 'retry-target',
      ),
    ).toBe(false);
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

  it('does not publish duplicate progress snapshots or change path occupancy', () => {
    useTransferStore.getState().addOperation(operation);
    const revision = useTransferStore.getState().pathOccupancyRevision;
    const listener = vi.fn();
    const unsubscribe = useTransferStore.subscribe(listener);

    useTransferStore.getState().updateUpload({
      operationId: operation.operationId,
      currentPath: operation.currentPath,
      totalBytes: operation.totalBytes,
      uploadedBytes: operation.processedBytes,
      totalSteps: operation.totalSteps,
      completedSteps: operation.completedSteps,
    });

    expect(listener).not.toHaveBeenCalled();
    expect(useTransferStore.getState().pathOccupancyRevision).toBe(revision);
    unsubscribe();
  });

  it('updates only the matching operation for progress snapshots', () => {
    useTransferStore.getState().addOperation(operation);
    useTransferStore.getState().addOperation({
      ...operation,
      operationId: 'upload-2',
      currentPath: '/tmp/other.png',
    });
    const untouched = useTransferStore.getState().operations[0];
    const revision = useTransferStore.getState().pathOccupancyRevision;

    useTransferStore.getState().updateUpload({
      operationId: operation.operationId,
      currentPath: operation.currentPath,
      totalBytes: 100,
      uploadedBytes: 40,
      totalSteps: 1,
      completedSteps: 0,
    });

    expect(useTransferStore.getState().operations[0]).toBe(untouched);
    expect(useTransferStore.getState().operations[1]?.processedBytes).toBe(40);
    expect(useTransferStore.getState().pathOccupancyRevision).toBe(revision);
  });

  it('releases path occupancy when final progress completes a transfer', () => {
    useTransferStore.getState().addOperation({
      ...operation,
      connectionId: 'connection-1',
      paths: ['/remote/archive.zip'],
      status: 'running',
    });
    const revision = useTransferStore.getState().pathOccupancyRevision;

    useTransferStore.getState().updateUpload({
      operationId: operation.operationId,
      currentPath: operation.currentPath,
      totalBytes: 100,
      uploadedBytes: 100,
      totalSteps: 1,
      completedSteps: 1,
    });

    expect(hasActivePathOperation('connection-1', ['/remote/archive.zip'])).toBe(false);
    expect(useTransferStore.getState().pathOccupancyRevision).toBe(revision + 1);
  });

  it('does not clear a running delete when its discovered counters temporarily match', () => {
    useTransferStore.getState().addOperation({
      ...operation,
      operationId: 'delete-1',
      kind: 'delete',
      totalSteps: 2,
      completedSteps: 2,
      status: 'running',
    });
    const revision = useTransferStore.getState().pathOccupancyRevision;

    useTransferStore.getState().clearCompleted();

    expect(useTransferStore.getState().operations).toHaveLength(1);
    expect(useTransferStore.getState().operations[0]).toMatchObject({
      operationId: 'delete-1',
      status: 'running',
    });
    expect(useTransferStore.getState().pathOccupancyRevision).toBe(revision);
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

  it('counts only active transfers owned by tabs being closed', () => {
    useTransferStore.setState({ operations: [
      { ...operation, operationId: 'active-a', ownerId: 'tab-a', status: 'running' },
      { ...operation, operationId: 'done-a', ownerId: 'tab-a', status: 'completed' },
      { ...operation, operationId: 'active-b', ownerId: 'tab-b', status: 'pending' },
    ] });

    expect(countActiveTransfersForOwners(['tab-a'])).toBe(1);
    expect(countActiveTransfersForOwners(['tab-a', 'tab-b'])).toBe(2);
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

  it('waitForPathIdle preserves counter-based completion semantics', async () => {
    useTransferStore.getState().addOperation({
      ...operation,
      connectionId: 'connection-1',
      paths: ['/remote/archive.zip'],
      status: 'running',
    });
    const waiting = waitForPathIdle([
      { connectionId: 'connection-1', paths: ['/remote/archive.zip'] },
    ]);

    useTransferStore.getState().updateUpload({
      operationId: operation.operationId,
      currentPath: operation.currentPath,
      totalBytes: 100,
      uploadedBytes: 100,
      totalSteps: 1,
      completedSteps: 1,
    });

    await expect(waiting).resolves.toBeUndefined();
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

  it('serializes overlapping path tasks even when both are queued while idle', async () => {
    const scopes = [{ connectionId: 'connection-1', paths: ['/remote/file.txt'] }];
    const started: string[] = [];
    let finishFirst!: () => void;
    let finishSecond!: () => void;
    const firstGate = new Promise<void>((resolve) => { finishFirst = resolve; });
    const secondGate = new Promise<void>((resolve) => { finishSecond = resolve; });

    const first = runPathOperation(scopes, async () => {
      started.push('first');
      await firstGate;
    });
    const second = runPathOperation(scopes, async () => {
      started.push('second');
      await secondGate;
    });

    await Promise.resolve();
    expect(started).toEqual(['first']);

    finishFirst();
    await first;
    await Promise.resolve();
    await Promise.resolve();
    expect(started).toEqual(['first', 'second']);

    finishSecond();
    await second;
  });

  it('releases competing path tasks one at a time after an active transfer finishes', async () => {
    useTransferStore.getState().addOperation({
      ...operation,
      operationId: 'blocking-transfer',
      connectionId: 'connection-1',
      paths: ['/remote/file.txt'],
      status: 'running',
    });
    const scopes = [{ connectionId: 'connection-1', paths: ['/remote/file.txt'] }];
    const started: string[] = [];
    let finishFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { finishFirst = resolve; });

    const first = runPathOperation(scopes, async () => {
      started.push('first');
      await firstGate;
    });
    const second = runPathOperation(scopes, async () => {
      started.push('second');
    });

    useTransferStore.getState().markOperationCompleted('blocking-transfer');
    await Promise.resolve();
    expect(started).toEqual(['first']);

    finishFirst();
    await first;
    await second;
    expect(started).toEqual(['first', 'second']);
  });

  it('cancels an unstarted path task when its owner closes', async () => {
    useTransferStore.getState().addOperation({
      ...operation,
      operationId: 'blocking-transfer',
      connectionId: 'connection-1',
      paths: ['/remote/file.txt'],
      status: 'running',
    });
    const task = vi.fn().mockResolvedValue(undefined);
    const queued = runPathOperation(
      [{ connectionId: 'connection-1', paths: ['/remote/file.txt'] }],
      task,
      { ownerId: 'tab-1' },
    );

    cancelQueuedPathOperationsForOwner('tab-1');
    useTransferStore.getState().markOperationCompleted('blocking-transfer');
    await queued;

    expect(task).not.toHaveBeenCalled();
  });

  it('rejects path tasks submitted after their owner has already closed', async () => {
    const task = vi.fn().mockResolvedValue(undefined);
    cancelQueuedPathOperationsForOwner('closed-tab');

    await runPathOperation(
      [{ connectionId: 'connection-1', paths: ['/remote/file.txt'] }],
      task,
      { ownerId: 'closed-tab' },
    );

    expect(task).not.toHaveBeenCalled();
  });
});
