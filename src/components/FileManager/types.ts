import type { RemoteFileEntry, RemoteFileKind } from '../../types';

export type EntryDialogMode = 'newFile' | 'newDirectory' | 'rename';
export type CreateEntryDialogMode = Exclude<EntryDialogMode, 'rename'>;
export type MenuTarget = 'blank' | 'entry' | 'toolbar';
export type UploadConflictAction = 'overwrite' | 'skip' | 'cancel';
export type UploadConflictPolicy = 'overwrite' | 'skip' | 'fail';

export interface EntryDialogState {
  mode: EntryDialogMode;
  value: string;
}

export interface ClipboardState {
  sourcePath: string;
  sourceName: string;
  kind: RemoteFileKind;
}

export interface PendingDeleteState {
  path: string;
  name: string;
  kind: RemoteFileKind;
}

export interface PropertiesState {
  entry: RemoteFileEntry;
  directoryPath: string;
}

export interface PermissionEditState {
  entry: RemoteFileEntry;
  value: string;
}

export interface UploadConflictItem {
  localPath: string;
  targetName: string;
  existingKind: RemoteFileKind;
}

export interface PendingUploadConflictState {
  conflict: UploadConflictItem;
  remainingConflicts: number;
  applyToRemaining: boolean;
}

export type OperationLogType = 'upload' | 'download' | 'delete' | 'rename' | 'create' | 'permission' | 'copy';
export type OperationLogStatus = 'running' | 'completed' | 'failed' | 'cancelled';

export interface OperationLogEntry {
  id: string;
  type: OperationLogType;
  status: OperationLogStatus;
  message: string;
  timestamp: number;
  operationId?: string;
}
