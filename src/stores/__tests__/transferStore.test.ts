import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useTransferStore, type TransferOperation } from '@/stores/transferStore';

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
});
