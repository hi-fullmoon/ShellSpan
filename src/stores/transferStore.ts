import { create } from 'zustand';
import type {
  DeleteProgressEvent,
  DownloadProgressEvent,
  UploadProgressEvent,
} from '@/types';

export type TransferOperationKind = 'upload' | 'download' | 'delete' | 'remote-copy';

export interface TransferOperation {
  operationId: string;
  kind: TransferOperationKind;
  connectionId?: string;
  paths?: string[];
  currentPath?: string;
  totalBytes: number;
  processedBytes: number;
  totalSteps: number;
  completedSteps: number;
  status?:
    | 'pending'
    | 'running'
    | 'failed'
    | 'cancelling'
    | 'cancelled'
    | 'restoring'
    | 'restored';
  error?: string;
  retry?: () => Promise<void>;
  cancel?: () => Promise<void>;
  undo?: () => Promise<void>;
}

interface TransferState {
  operations: TransferOperation[];
  addOperation: (operation: TransferOperation) => void;
  updateUpload: (event: UploadProgressEvent) => void;
  updateDownload: (event: DownloadProgressEvent) => void;
  updateDelete: (event: DeleteProgressEvent) => void;
  removeOperation: (operationId: string) => void;
  markOperationRunning: (operationId: string) => void;
  markOperationFailed: (operationId: string, error: string) => void;
  markOperationCompleted: (operationId: string) => void;
  markOperationCancelled: (operationId: string) => void;
  retryOperation: (operationId: string) => Promise<void>;
  cancelOperation: (operationId: string) => Promise<void>;
  setOperationUndo: (operationId: string, undo: () => Promise<void>) => void;
  undoOperation: (operationId: string) => Promise<void>;
  clearCompleted: () => void;
}

export const useTransferStore = create<TransferState>()((set) => ({
  operations: [],
  addOperation: (operation) =>
    set((state) => ({
      operations: state.operations.some(
        (o) => o.operationId === operation.operationId,
      )
        ? state.operations.map((o) =>
            o.operationId === operation.operationId ? { ...o, ...operation } : o,
          )
        : [operation, ...state.operations],
    })),
  updateUpload: (event) =>
    set((state) => ({
      operations: state.operations.map((op) =>
        op.operationId === event.operationId
          ? {
              ...op,
              currentPath: event.currentPath || op.currentPath,
              totalBytes: event.totalBytes,
              processedBytes: event.uploadedBytes,
              totalSteps: event.totalSteps,
              completedSteps: event.completedSteps,
            }
          : op,
      ),
    })),
  updateDownload: (event) =>
    set((state) => ({
      operations: state.operations.map((op) =>
        op.operationId === event.operationId
          ? {
              ...op,
              currentPath: event.currentPath || op.currentPath,
              totalBytes: event.totalBytes,
              processedBytes: event.downloadedBytes,
              totalSteps: event.totalSteps,
              completedSteps: event.completedSteps,
            }
          : op,
      ),
    })),
  updateDelete: (event) =>
    set((state) => ({
      operations: state.operations.map((op) =>
        op.operationId === event.operationId
          ? {
              ...op,
              currentPath: event.currentPath || op.currentPath,
              totalSteps: event.totalSteps,
              completedSteps: event.completedSteps,
            }
          : op,
      ),
    })),
  removeOperation: (operationId) =>
    set((state) => ({
      operations: state.operations.filter(
        (o) => o.operationId !== operationId,
      ),
    })),
  markOperationRunning: (operationId) =>
    set((state) => ({
      operations: state.operations.map((operation) =>
        operation.operationId === operationId
          ? { ...operation, status: 'running', error: undefined }
          : operation,
      ),
    })),
  markOperationFailed: (operationId, error) =>
    set((state) => ({
      operations: state.operations.map((operation) =>
        operation.operationId === operationId
          ? { ...operation, status: 'failed', error }
          : operation,
      ),
    })),
  markOperationCompleted: (operationId) =>
    set((state) => ({
      operations: state.operations.map((operation) =>
        operation.operationId === operationId
          ? {
              ...operation,
              status: 'running',
              completedSteps: operation.totalSteps,
              processedBytes: operation.totalBytes,
              error: undefined,
            }
          : operation,
      ),
    })),
  markOperationCancelled: (operationId) =>
    set((state) => ({
      operations: state.operations.map((operation) =>
        operation.operationId === operationId
          ? { ...operation, status: 'cancelled', error: undefined }
          : operation,
      ),
    })),
  retryOperation: async (operationId) => {
    const operation = useTransferStore
      .getState()
      .operations.find((item) => item.operationId === operationId);
    if (!operation?.retry) return;

    useTransferStore.getState().markOperationRunning(operationId);
    try {
      await operation.retry();
    } catch (error) {
      useTransferStore.getState().markOperationFailed(
        operationId,
        error instanceof Error ? error.message : String(error),
      );
    }
  },
  cancelOperation: async (operationId) => {
    const operation = useTransferStore
      .getState()
      .operations.find((item) => item.operationId === operationId);
    if (!operation?.cancel) return;

    set((state) => ({
      operations: state.operations.map((item) =>
        item.operationId === operationId
          ? { ...item, status: 'cancelling', error: undefined }
          : item,
      ),
    }));
    try {
      await operation.cancel();
      // The backend cancellation request only flips a flag. Keep the operation in
      // `cancelling` until the running command observes it and exits.
    } catch (error) {
      useTransferStore.getState().markOperationFailed(
        operationId,
        error instanceof Error ? error.message : String(error),
      );
    }
  },
  setOperationUndo: (operationId, undo) =>
    set((state) => ({
      operations: state.operations.map((operation) =>
        operation.operationId === operationId
          ? { ...operation, undo }
          : operation,
      ),
    })),
  undoOperation: async (operationId) => {
    const operation = useTransferStore
      .getState()
      .operations.find((item) => item.operationId === operationId);
    if (!operation?.undo) return;

    set((state) => ({
      operations: state.operations.map((item) =>
        item.operationId === operationId
          ? { ...item, status: 'restoring', error: undefined }
          : item,
      ),
    }));
    try {
      await operation.undo();
      set((state) => ({
        operations: state.operations.map((item) =>
          item.operationId === operationId
            ? { ...item, status: 'restored', undo: undefined }
            : item,
        ),
      }));
    } catch (error) {
      useTransferStore.getState().markOperationFailed(
        operationId,
        error instanceof Error ? error.message : String(error),
      );
    }
  },
  clearCompleted: () =>
    set((state) => ({
      operations: state.operations.filter(
        (o) => o.totalSteps === 0 || o.completedSteps < o.totalSteps,
      ),
    })),
}));

export function isTransferComplete(operation: TransferOperation): boolean {
  if (
    operation.status === 'failed' ||
    operation.status === 'pending' ||
    operation.status === 'cancelling' ||
    operation.status === 'cancelled' ||
    operation.status === 'restoring' ||
    operation.status === 'restored'
  ) {
    return false;
  }
  if (operation.totalSteps === 0) return false;
  return operation.completedSteps >= operation.totalSteps;
}

export function isTransferActive(operation: TransferOperation): boolean {
  return operation.status !== 'failed' &&
    operation.status !== 'cancelled' &&
    operation.status !== 'restored' &&
    !isTransferComplete(operation);
}

function normalizeRemotePath(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '');
  return normalized || '/';
}

function pathsOverlap(left: string, right: string): boolean {
  const a = normalizeRemotePath(left);
  const b = normalizeRemotePath(right);
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

export function hasActivePathOperation(
  connectionId: string,
  paths: string[],
  operations = useTransferStore.getState().operations,
): boolean {
  return operations.some((operation) =>
    operation.connectionId === connectionId &&
    operation.paths?.some((activePath) =>
      paths.some((path) => pathsOverlap(activePath, path)),
    ) &&
    isTransferActive(operation),
  );
}

export function formatTransferProgress(operation: TransferOperation): string {
  if (operation.totalSteps > 0) {
    return `${operation.completedSteps}/${operation.totalSteps}`;
  }
  if (operation.totalBytes > 0) {
    const percent = Math.round(
      (operation.processedBytes / operation.totalBytes) * 100,
    );
    return `${percent}%`;
  }
  return '...';
}
