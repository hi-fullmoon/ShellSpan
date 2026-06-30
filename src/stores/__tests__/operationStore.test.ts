import { describe, expect, it, beforeEach } from 'vitest';
import { useOperationStore, selectOverallProgress } from '../operationStore';

describe('operationStore', () => {
  beforeEach(() => {
    useOperationStore.setState({ operations: [], expanded: false });
  });

  it('starts an operation', () => {
    const item = useOperationStore.getState().startOperation({
      id: 'op-1',
      type: 'upload',
      title: 'Upload file.txt',
    });

    expect(item.id).toBe('op-1');
    expect(item.status).toBe('running');
    expect(useOperationStore.getState().operations).toHaveLength(1);
  });

  it('updates progress of a running operation', () => {
    const { startOperation, updateOperation } = useOperationStore.getState();
    startOperation({ id: 'op-1', type: 'upload', title: 'Upload' });
    updateOperation('op-1', { progress: 50, totalText: '5 / 10 MB' });

    const op = useOperationStore.getState().operations[0];
    expect(op?.progress).toBe(50);
    expect(op?.totalText).toBe('5 / 10 MB');
  });

  it('ignores progress updates when operation is not running', () => {
    const { startOperation, updateOperation, setOperationStatus } = useOperationStore.getState();
    startOperation({ id: 'op-1', type: 'upload', title: 'Upload' });
    setOperationStatus('op-1', 'completed');
    updateOperation('op-1', { progress: 99 });

    expect(useOperationStore.getState().operations[0]?.progress).toBe(100);
  });

  it('sets completed status and clamps progress to 100', () => {
    const { startOperation, setOperationStatus } = useOperationStore.getState();
    startOperation({ id: 'op-1', type: 'upload', title: 'Upload', progress: 80 });
    setOperationStatus('op-1', 'completed');

    const op = useOperationStore.getState().operations[0];
    expect(op?.status).toBe('completed');
    expect(op?.progress).toBe(100);
  });

  it('sets failed status with error message', () => {
    const { startOperation, setOperationStatus } = useOperationStore.getState();
    startOperation({ id: 'op-1', type: 'download', title: 'Download' });
    setOperationStatus('op-1', 'failed', 'network error');

    const op = useOperationStore.getState().operations[0];
    expect(op?.status).toBe('failed');
    expect(op?.errorMessage).toBe('network error');
  });

  it('removes a single operation', () => {
    const { startOperation, removeOperation } = useOperationStore.getState();
    startOperation({ id: 'op-1', type: 'upload', title: 'Upload' });
    removeOperation('op-1');

    expect(useOperationStore.getState().operations).toHaveLength(0);
  });

  it('clears only completed or failed operations', () => {
    const { startOperation, setOperationStatus, clearCompleted } = useOperationStore.getState();
    startOperation({ id: 'op-1', type: 'upload', title: 'A' });
    startOperation({ id: 'op-2', type: 'download', title: 'B' });
    startOperation({ id: 'op-3', type: 'delete', title: 'C' });
    setOperationStatus('op-1', 'completed');
    setOperationStatus('op-2', 'failed');
    setOperationStatus('op-3', 'cancelled');

    clearCompleted();

    expect(useOperationStore.getState().operations).toHaveLength(0);
  });

  it('keeps running and cancelling operations when clearing completed', () => {
    const { startOperation, setCancelling, setOperationStatus, clearCompleted } = useOperationStore.getState();
    startOperation({ id: 'op-1', type: 'upload', title: 'A' });
    startOperation({ id: 'op-2', type: 'download', title: 'B' });
    setCancelling('op-2');
    setOperationStatus('op-1', 'completed');

    clearCompleted();

    const ids = useOperationStore.getState().operations.map((op) => op.id);
    expect(ids).toEqual(['op-2']);
  });

  it('calculates overall progress of active operations', () => {
    const { startOperation } = useOperationStore.getState();
    startOperation({ id: 'op-1', type: 'upload', title: 'A', progress: 50 });
    startOperation({ id: 'op-2', type: 'download', title: 'B', progress: 100 });

    expect(selectOverallProgress(useOperationStore.getState().operations)).toBe(75);
  });
});
