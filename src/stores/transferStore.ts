import { create } from 'zustand';
import type {
  DeleteProgressEvent,
  DownloadProgressEvent,
  UploadProgressEvent,
} from '@/types';

export type TransferOperationKind = 'upload' | 'download' | 'delete';

export interface TransferOperation {
  operationId: string;
  kind: TransferOperationKind;
  currentPath?: string;
  totalBytes: number;
  processedBytes: number;
  totalSteps: number;
  completedSteps: number;
}

interface TransferState {
  operations: TransferOperation[];
  addOperation: (operation: TransferOperation) => void;
  updateUpload: (event: UploadProgressEvent) => void;
  updateDownload: (event: DownloadProgressEvent) => void;
  updateDelete: (event: DeleteProgressEvent) => void;
  removeOperation: (operationId: string) => void;
  clearCompleted: () => void;
}

export const useTransferStore = create<TransferState>()((set) => ({
  operations: [],
  addOperation: (operation) =>
    set((state) => ({
      operations: state.operations.some(
        (o) => o.operationId === operation.operationId,
      )
        ? state.operations
        : [...state.operations, operation],
    })),
  updateUpload: (event) =>
    set((state) => ({
      operations: state.operations.map((op) =>
        op.operationId === event.operationId
          ? {
              ...op,
              currentPath: event.currentPath,
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
              currentPath: event.currentPath,
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
              currentPath: event.currentPath,
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
  clearCompleted: () =>
    set((state) => ({
      operations: state.operations.filter(
        (o) => o.totalSteps === 0 || o.completedSteps < o.totalSteps,
      ),
    })),
}));

export function isTransferComplete(operation: TransferOperation): boolean {
  if (operation.totalSteps === 0) return false;
  return operation.completedSteps >= operation.totalSteps;
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
