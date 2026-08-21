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
const retryingOperationIds = new Set<string>();

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
    if (retryingOperationIds.has(operationId)) return;
    const operation = useTransferStore
      .getState()
      .operations.find((item) => item.operationId === operationId);
    if (!operation?.retry) return;
    retryingOperationIds.add(operationId);

    const scopes = operation.pathScopes ??
      (operation.connectionId && operation.paths
        ? [{ connectionId: operation.connectionId, paths: operation.paths }]
        : []);
    const retry = async () => {
      useTransferStore.getState().markOperationRunning(operationId);
      await operation.retry?.();
    };
    try {
      if (scopes.length > 0) {
        await runPathOperation(scopes, retry);
      } else {
        await retry();
      }
    } catch (error) {
      useTransferStore.getState().markOperationFailed(
        operationId,
        getLocalizedErrorMessage(error),
      );
    } finally {
      retryingOperationIds.delete(operationId);
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

interface QueuedPathOperation {
  sequence: number;
  scopes: PathOperationScope[];
  task: () => Promise<unknown> | unknown;
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  granted: boolean;
}

let nextPathOperationSequence = 0;
const queuedPathOperations: QueuedPathOperation[] = [];
let drainingPathOperations = false;

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

function pathScopesOverlap(
  left: PathOperationScope[],
  right: PathOperationScope[],
): boolean {
  return left.some((leftScope) =>
    right.some((rightScope) =>
      leftScope.connectionId === rightScope.connectionId &&
      leftScope.paths.some((leftPath) =>
        rightScope.paths.some((rightPath) => pathsOverlap(leftPath, rightPath)),
      ),
    ),
  );
}

function canGrantPathOperation(request: QueuedPathOperation): boolean {
  const operations = useTransferStore.getState().operations;
  if (request.scopes.some((scope) => scopeHasActiveOperation(scope, operations))) {
    return false;
  }

  return !queuedPathOperations.some(
    (other) =>
      other !== request &&
      (other.granted || other.sequence < request.sequence) &&
      pathScopesOverlap(other.scopes, request.scopes),
  );
}

function drainPathOperations(): void {
  if (drainingPathOperations) return;
  drainingPathOperations = true;
  try {
    for (const request of queuedPathOperations) {
      if (request.granted || !canGrantPathOperation(request)) continue;
      request.granted = true;
      Promise.resolve()
        .then(request.task)
        .then(request.resolve, request.reject)
        .finally(() => {
          const index = queuedPathOperations.indexOf(request);
          if (index >= 0) queuedPathOperations.splice(index, 1);
          drainPathOperations();
        });
    }
  } finally {
    drainingPathOperations = false;
  }
}

// Active transfer state is one of the conditions that can release the head of
// the path queue. The subscription is module-scoped so callers do not need to
// keep a React component mounted while they wait.
useTransferStore.subscribe(drainPathOperations);

/**
 * Runs a task while owning all supplied path scopes. Overlapping tasks are
 * granted in FIFO order; unrelated scopes may run concurrently. Ownership is
 * acquired atomically before the task callback starts, closing the race where
 * multiple waiters observe the same idle transition and all proceed.
 */
export function runPathOperation<T>(
  scopes: PathOperationScope[],
  task: () => Promise<T> | T,
  onQueued?: () => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const request: QueuedPathOperation = {
      sequence: nextPathOperationSequence++,
      scopes,
      task,
      resolve: (value) => resolve(value as T),
      reject,
      granted: false,
    };
    queuedPathOperations.push(request);
    if (!canGrantPathOperation(request)) {
      onQueued?.();
    }
    drainPathOperations();
  });
}

/**
 * Resolves once no active transfer overlaps any of the given scopes. This is a
 * notification primitive only; callers that will start an operation must use
 * runPathOperation so the idle check and path ownership are atomic.
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
