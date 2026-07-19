export type ThemeMode = 'light' | 'dark' | 'system';
export type Locale = 'zh-CN' | 'en-US';
export type AppSection = 'workbench' | 'terminal' | 'sftp';
export type WorkbenchTab = 'connections' | 'knownHosts' | 'credentials' | 'logs' | 'settings';
export type AuthMethod = 'password' | 'key';
export type RemoteFileKind = 'directory' | 'file' | 'symlink' | 'other';
export type SessionStatus = 'connecting' | 'connected' | 'disconnected' | 'error';
export type ClosedReasonKind =
  | 'local_close'
  | 'controller_dropped'
  | 'remote_exit'
  | 'transport_disconnect'
  | 'error';

export interface JumpHostConfig {
  host: string;
  port: number;
  username: string;
  authMethod: AuthMethod;
  password?: string;
  privateKeyPath?: string;
  passphrase?: string;
}

export interface ConnectionProfile {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  authMethod: AuthMethod;
  password?: string;
  passwordStored?: boolean;
  privateKeyPath?: string;
  passphrase?: string;
  jumpHost?: JumpHostConfig;
  createdAt: number;
  updatedAt: number;
}

export interface SessionSummary {
  sessionId: string;
  title: string;
  host: string;
  port: number;
  username: string;
}

export interface SessionCreateRequest {
  name: string;
  host: string;
  port: number;
  username: string;
  authMethod: AuthMethod;
  password?: string;
  privateKeyPath?: string;
  passphrase?: string;
  terminalCols: number;
  terminalRows: number;
  jumpHost?: JumpHostConfig;
}

export interface RemoteConnectionRequest {
  host: string;
  port: number;
  username: string;
  authMethod: AuthMethod;
  password?: string;
  privateKeyPath?: string;
  passphrase?: string;
  jumpHost?: JumpHostConfig;
}

export interface RemoteFileEntry {
  path: string;
  name: string;
  kind: RemoteFileKind;
  size?: number;
  modifiedAt?: number;
  permissions?: number;
  ownerUid?: number;
  groupGid?: number;
  ownerName?: string;
  groupName?: string;
}

export interface LocalFileEntry {
  path: string;
  name: string;
  kind: RemoteFileKind;
  size?: number;
  modifiedAt?: number;
}

export interface RemoteDirectoryListing {
  path: string;
  parentPath?: string;
  entries: RemoteFileEntry[];
}

export interface LocalDirectoryListing {
  path: string;
  parentPath?: string;
  entries: LocalFileEntry[];
}

export interface KnownHostEntry {
  host: string;
  port: number;
  fingerprint: string;
  keyType: string;
}

export interface LogFileInfo {
  name: string;
  size: number;
  modifiedAt: number;
}

export interface HostKeyCheckResult {
  status: 'match' | 'mismatch' | 'notFound' | 'failure';
  fingerprint?: string;
  message?: string;
}

export interface CreateSessionErrorHostKeyUnknown {
  type: 'HostKeyUnknown';
  payload: {
    host: string;
    port: number;
    fingerprint?: string;
  };
}

export interface CreateSessionErrorHostKeyMismatch {
  type: 'HostKeyMismatch';
  payload: {
    host: string;
    port: number;
  };
}

export interface CreateSessionErrorOther {
  type: 'Other';
  payload: {
    message: string;
  };
}

export type CreateSessionError =
  | CreateSessionErrorHostKeyUnknown
  | CreateSessionErrorHostKeyMismatch
  | CreateSessionErrorOther;

export interface DataEvent {
  sessionId: string;
  chunk: string;
}

export interface StatusEvent {
  sessionId: string;
  status: SessionStatus;
  message?: string;
}

export interface ClosedEvent {
  sessionId: string;
  reason?: string;
  reasonKind: ClosedReasonKind;
  retryable: boolean;
}

export interface UploadProgressEvent {
  operationId: string;
  currentPath?: string;
  totalBytes: number;
  uploadedBytes: number;
  totalSteps: number;
  completedSteps: number;
}

export interface DownloadProgressEvent {
  operationId: string;
  currentPath?: string;
  totalBytes: number;
  downloadedBytes: number;
  totalSteps: number;
  completedSteps: number;
}

export interface DeleteProgressEvent {
  operationId: string;
  currentPath?: string;
  totalSteps: number;
  completedSteps: number;
}

export interface RemoteDirectoryRequest extends RemoteConnectionRequest {
  path?: string;
}

export interface CreateRemoteEntryRequest extends RemoteConnectionRequest {
  parentPath: string;
  name: string;
  kind: 'file' | 'directory';
}

export interface RenameRemotePathRequest extends RemoteConnectionRequest {
  path: string;
  newName: string;
}

export interface DeleteRemotePathRequest extends RemoteConnectionRequest {
  path: string;
  operationId: string;
}

export interface TrashRemotePathRequest extends RemoteConnectionRequest {
  path: string;
}

export interface TrashedRemotePath {
  originalPath: string;
  trashPath: string;
}

export interface RestoreRemotePathRequest extends RemoteConnectionRequest {
  originalPath: string;
  trashPath: string;
}

export interface CopyRemotePathRequest extends RemoteConnectionRequest {
  sourcePath: string;
  destinationDirectory: string;
}

export interface OpenRemoteFileRequest extends RemoteConnectionRequest {
  path: string;
}

export interface ReadRemoteFileRequest extends RemoteConnectionRequest {
  path: string;
}

export interface ReadRemoteFileResponse {
  path: string;
  name: string;
  content: string;
  size: number;
  isText: boolean;
}

export interface UpdateRemotePermissionsRequest
  extends RemoteConnectionRequest {
  path: string;
  permissions: number;
}

export interface DownloadRemotePathsRequest extends RemoteConnectionRequest {
  remotePaths: string[];
  destinationDirectory: string;
  operationId: string;
}

export interface UploadLocalPathsRequest extends RemoteConnectionRequest {
  destinationDirectory: string;
  localPaths: string[];
  conflictPolicies: UploadConflictPolicy[];
  operationId: string;
}

export interface CopyLocalPathsRequest {
  sourcePaths: string[];
  destinationDirectory: string;
  conflictPolicies: UploadConflictPolicy[];
  operationId: string;
}

export interface CopyRemoteToRemoteRequest {
  sourceConnection: RemoteConnectionRequest;
  destinationConnection: RemoteConnectionRequest;
  sourcePaths: string[];
  destinationDirectory: string;
  conflictPolicies: UploadConflictPolicy[];
}

export type UploadConflictPolicy = 'overwrite' | 'replace' | 'skip' | 'fail';

export type UpdateStatus =
  | 'idle'
  | 'checking'
  | 'no_update'
  | 'update_available'
  | 'downloading'
  | 'downloaded'
  | 'error';

export interface UpdateVersionInfo {
  latestVersion?: string;
  downloadedVersion?: string;
}
