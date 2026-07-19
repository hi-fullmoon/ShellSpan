import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  hasActivePathOperation,
  useTransferStore,
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
});
