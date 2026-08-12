import { create } from 'zustand';
import { createLogger } from '@/lib/logger';
import { getLocalizedErrorMessage } from '@/lib/error';
import type {
  DeleteProgressEvent,
  DownloadProgressEvent,
  RemoteCopyProgressEvent,
  UploadProgressEvent,
} from '@/types';

const logger = createLogger('transfer');

export type TransferOperationKind = 'upload' | 'download' | 'delete' | 'remote-copy';

export interface TransferOperation {
  operationId: string;
  kind: TransferOperationKind;
  connectionId?: string;
  paths?: string[];
  pathScopes?: Array<{ connectionId: string; paths: string[] }>;
  currentPath?: string;
  totalBytes: number;
  processedBytes: number;
  totalSteps: number;
  completedSteps: number;
  status?:
    | 'pending'
    | 'running'
    | 'completed'
    | 'failed'
    | 'cancelling'
    | 'cancelled';
  error?: string;
  retry?: () => Promise<void>;
  cancel?: () => Promise<void>;
}

interface TransferState {
  operations: TransferOperation[];
  addOperation: (operation: TransferOperation) => void;
  updateUpload: (event: UploadProgressEvent) => void;
  updateDownload: (event: DownloadProgressEvent) => void;
  updateDelete: (event: DeleteProgressEvent) => void;
  updateRemoteCopy: (event: RemoteCopyProgressEvent) => void;
  removeOperation: (operationId: string) => void;
  markOperationRunning: (operationId: string) => void;
  markOperationFailed: (operationId: string, error: string) => void;
  markOperationCompleted: (operationId: string) => void;
  markOperationCancelled: (operationId: string) => void;
  retryOperation: (operationId: string) => Promise<void>;
  cancelOperation: (operationId: string) => Promise<void>;
  clearCompleted: () => void;
}

export const useTransferStore = create<TransferState>()((set) => ({
  operations: [],
  addOperation: (operation) => {
    logger.info(`Transfer started: ${operation.kind} (${operation.operationId})`);
    set((state) => ({
      operations: state.operations.some(
        (o) => o.operationId === operation.operationId,
      )
        ? state.operations.map((o) =>
            o.operationId === operation.operationId ? { ...o, ...operation } : o,
          )
        : [operation, ...state.operations],
    }));
  },
  updateUpload: (event) =>
    set((state) => ({
      operations: state.operations.map((op) =>
        op.operationId === event.operationId && !isStaleProgressEvent(op)
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
        op.operationId === event.operationId && !isStaleProgressEvent(op)
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
        op.operationId === event.operationId && !isStaleProgressEvent(op)
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
  markOperationFailed: (operationId, error) => {
    logger.error(`Transfer failed: ${operationId}`, error);
    set((state) => ({
      operations: state.operations.map((operation) =>
        operation.operationId === operationId
          ? { ...operation, status: 'failed', error }
          : operation,
      ),
    }));
  },
  updateRemoteCopy: (event) =>
    set((state) => ({
      operations: state.operations.map((op) =>
        op.operationId === event.operationId && !isStaleProgressEvent(op)
          ? {
              ...op,
              currentPath: event.currentPath || op.currentPath,
              totalBytes: event.totalBytes,
              processedBytes: event.copiedBytes,
              totalSteps: event.totalSteps,
              completedSteps: event.completedSteps,
            }
          : op,
      ),
    })),
  markOperationCompleted: (operationId) => {
    logger.info(`Transfer completed: ${operationId}`);
    set((state) => ({
      operations: state.operations.map((operation) =>
        operation.operationId === operationId
          ? {
              ...operation,
              status: 'completed',
              completedSteps: operation.totalSteps,
              processedBytes: operation.totalBytes,
              error: undefined,
            }
          : operation,
      ),
    }));
  },
  markOperationCancelled: (operationId) => {
    logger.info(`Transfer cancelled: ${operationId}`);
    set((state) => ({
      operations: state.operations.map((operation) =>
        operation.operationId === operationId
          ? { ...operation, status: 'cancelled', error: undefined }
          : operation,
      ),
    }));
  },
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
        getLocalizedErrorMessage(error),
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
        getLocalizedErrorMessage(error),
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
  if (operation.status === 'completed') return true;
  if (
    operation.status === 'failed' ||
    operation.status === 'pending' ||
    operation.status === 'cancelling' ||
    operation.status === 'cancelled'
  ) {
    return false;
  }
  // Delete totals grow as entries are discovered, so the counters can match
  // momentarily mid-batch; only the explicit completion status is
  // authoritative for deletes.
  if (operation.kind === 'delete') return false;
  if (operation.totalSteps === 0) return false;
  return operation.completedSteps >= operation.totalSteps;
}

// Backend progress events are delivered asynchronously and can arrive after
// the invoke response already marked the operation complete. A stale event
// must never regress a finished operation, or its paths would stay "busy"
// for hasActivePathOperation forever.
function isStaleProgressEvent(operation: TransferOperation | undefined): boolean {
  return !operation || operation.status === 'completed';
}

export function isTransferActive(operation: TransferOperation): boolean {
  return operation.status !== 'failed' &&
    operation.status !== 'cancelled' &&
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

export interface PathOperationScope {
  connectionId: string;
  paths: string[];
}

function scopeHasActiveOperation(
  scope: PathOperationScope,
  operations: TransferOperation[],
): boolean {
  return operations.some((operation) =>
    isTransferActive(operation) &&
    (
      operation.pathScopes?.some((activeScope) =>
        activeScope.connectionId === scope.connectionId &&
        activeScope.paths.some((activePath) =>
          scope.paths.some((path) => pathsOverlap(activePath, path)),
        ),
      ) ??
      (operation.connectionId === scope.connectionId &&
        operation.paths?.some((activePath) =>
          scope.paths.some((path) => pathsOverlap(activePath, path)),
        ))
    ),
  );
}

export function hasActivePathOperation(
  connectionId: string,
  paths: string[],
  operations = useTransferStore.getState().operations,
): boolean {
  return scopeHasActiveOperation({ connectionId, paths }, operations);
}

/**
 * Resolves once no active operation overlaps any of the given scopes. Used to
 * queue path operations instead of rejecting them while a transfer is busy.
 * The check re-runs on every store change, so competing waiters that lose the
 * race to a newly started operation simply keep waiting.
 */
export function waitForPathIdle(scopes: PathOperationScope[]): Promise<void> {
  const isIdle = () =>
    !scopes.some((scope) =>
      scopeHasActiveOperation(scope, useTransferStore.getState().operations),
    );
  if (isIdle()) return Promise.resolve();
  return new Promise((resolve) => {
    const unsubscribe = useTransferStore.subscribe(() => {
      if (isIdle()) {
        unsubscribe();
        resolve();
      }
    });
  });
}

export function formatTransferProgress(operation: TransferOperation): string {
  if (operation.kind === 'delete') {
    // Delete totals grow rsync-style as entries are discovered; before the
    // first discovery only the removed count is meaningful.
    return operation.totalSteps > 0
      ? `${operation.completedSteps}/${operation.totalSteps}`
      : `${operation.completedSteps}`;
  }
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
