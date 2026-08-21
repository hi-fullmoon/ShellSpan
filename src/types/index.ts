export type ThemeMode = 'light' | 'dark' | 'system';
export type Locale = 'zh-CN' | 'en-US';
export type AppSection = 'workbench' | 'terminal' | 'sftp';
export type TerminalFontFamily = 'system' | 'menlo' | 'monaco' | 'consolas' | 'courierNew';
export type TerminalCursorStyle = 'block' | 'underline' | 'bar';
export type TerminalColorScheme = 'app' | 'oneDark' | 'solarizedDark' | 'light';
export type TerminalBellStyle = 'none' | 'sound';
export type TerminalRightClickBehavior = 'paste' | 'copyPaste' | 'none';
export type SftpConflictPolicy = 'ask' | 'overwrite' | 'skip';
export type WorkbenchTab = 'connections' | 'knownHosts' | 'keychain' | 'monitor' | 'logs' | 'settings';
export type LogSource = 'frontend' | 'backend';
export type ShortcutAction =
  | 'openWorkbench'
  | 'openTerminal'
  | 'openSftp'
  | 'openSettings'
  | 'newTerminalTab'
  | 'closeTerminalTab'
  | 'nextTerminalTab'
  | 'previousTerminalTab'
  | 'findTerminal'
  | 'newSftpConnection'
  | 'terminalLeader'
  | 'terminalFocusLeft'
  | 'terminalFocusDown'
  | 'terminalFocusUp'
  | 'terminalFocusRight'
  | 'terminalSplitRight'
  | 'terminalSplitDown'
  | 'terminalClosePane';
export type ShortcutBindings = Record<ShortcutAction, string>;
export type AuthMethod = 'password' | 'key';
export type KeychainKeyKind = 'password' | 'keyFile';
/** Per-profile secrets stored in the OS keychain besides the main password. */
export type ProfileSecretKind = 'passphrase' | 'jump-password' | 'jump-passphrase';
export type RemoteFileKind = 'directory' | 'file' | 'symlink' | 'other';
export type SessionStatus = 'connecting' | 'connected' | 'disconnected' | 'error';
export type ClosedReasonKind =
  | 'local_close'
  | 'controller_dropped'
  | 'remote_exit'
  | 'transport_disconnect'
  | 'error';

export interface KeychainKey {
  id: string;
  label: string;
  kind: KeychainKeyKind;
  privateKey?: string;
  publicKey?: string;
  keyType?: string;
  createdAt: number;
  updatedAt: number;
}

export interface JumpHostConfig {
  host: string;
  port: number;
  username: string;
  authMethod: AuthMethod;
  password?: string;
  keychainKeyId?: string;
  privateKeyData?: string;
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
  keychainKeyId?: string;
  privateKeyData?: string;
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
  keychainKeyId?: string;
  privateKeyData?: string;
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
  keychainKeyId?: string;
  privateKeyData?: string;
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

export interface StatusEvent {
  sessionId: string;
  status: SessionStatus;
  message?: string;
}

export interface ClosedEvent {
  sessionId: string;
  /** Host identity carried by the backend so the disconnect is labeled even if the store record is gone. */
  identity?: {
    title: string;
    host: string;
    port: number;
    username: string;
  };
  reason?: string;
  reasonKind: ClosedReasonKind;
  retryable: boolean;
}

/** A non-local terminal disconnect captured by the monitor for history. */
export interface DisconnectEvent {
  sessionId: string;
  title?: string;
  host?: string;
  port?: number;
  username?: string;
  reasonKind: ClosedReasonKind;
  reason?: string;
  retryable: boolean;
  at: number;
}

export interface SessionErrorEventHostKeyUnknown {
  type: 'HostKeyUnknown';
  payload: {
    sessionId: string;
    host: string;
    port: number;
    fingerprint?: string;
  };
}

export interface SessionErrorEventHostKeyMismatch {
  type: 'HostKeyMismatch';
  payload: {
    sessionId: string;
    host: string;
    port: number;
  };
}

export type SessionErrorEvent =
  | SessionErrorEventHostKeyUnknown
  | SessionErrorEventHostKeyMismatch;

export interface RemoteFsErrorHostKeyUnknown {
  type: 'HostKeyUnknown';
  payload: {
    host: string;
    port: number;
    fingerprint?: string;
  };
}

export interface RemoteFsErrorHostKeyMismatch {
  type: 'HostKeyMismatch';
  payload: {
    host: string;
    port: number;
  };
}

export interface RemoteFsErrorOther {
  type: 'Other';
  payload: {
    message: string;
  };
}

export type RemoteFsError =
  | RemoteFsErrorHostKeyUnknown
  | RemoteFsErrorHostKeyMismatch
  | RemoteFsErrorOther;

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

export interface RemoteEntryOwnersRequest extends RemoteConnectionRequest {
  ownerIds: number[];
  groupIds: number[];
}

export interface RemoteEntryOwners {
  ownerNames: Record<number, string>;
  groupNames: Record<number, string>;
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
  paths: string[];
  operationId: string;
}

export interface CopyRemotePathRequest extends RemoteConnectionRequest {
  sourcePath: string;
  destinationDirectory: string;
  operationId: string;
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
  conflictPolicies: UploadConflictPolicy[];
  operationId: string;
}

export interface UploadLocalPathsRequest extends RemoteConnectionRequest {
  destinationDirectory: string;
  localPaths: string[];
  conflictPolicies: UploadConflictPolicy[];
  operationId: string;
}

export type TransferItemStatus = 'completed' | 'failed' | 'skipped';

export interface TransferItemResult {
  sourcePath: string;
  destinationPath?: string;
  status: TransferItemStatus;
  error?: string;
}

export interface TransferBatchResult {
  items: TransferItemResult[];
}

export interface CopyLocalPathsRequest {
  sourcePaths: string[];
  destinationDirectory: string;
  conflictPolicies: UploadConflictPolicy[];
  operationId: string;
}

export interface RemoteCopyProgressEvent {
  operationId: string;
  currentPath?: string;
  totalBytes: number;
  copiedBytes: number;
  totalSteps: number;
  completedSteps: number;
}

export interface CopyRemoteToRemoteRequest {
  sourceConnection: RemoteConnectionRequest;
  destinationConnection: RemoteConnectionRequest;
  sourcePaths: string[];
  destinationDirectory: string;
  conflictPolicies: UploadConflictPolicy[];
  operationId: string;
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

// --- Database row types ---

export interface ProfileRow {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  authMethod: AuthMethod;
  keychainKeyId?: string;
  jumpHostConfig?: string; // JSON serialized JumpHostConfig
  createdAt: number;
  updatedAt: number;
}

export interface SftpBookmarkRow {
  id: string;
  host: string;
  port: number;
  username: string;
  path: string;
  side: 'local' | 'remote';
  label?: string;
  createdAt: number;
}

// --- System health monitor types ---

export type HealthStatus = 'ok' | 'warning' | 'error';

export interface AppProcessInfo {
  pid: number;
  rssBytes: number;
  vszBytes: number;
  cpuPercent: number;
  threads?: number;
  uptimeSecs: number;
}

export interface SystemInfo {
  totalMemoryBytes: number;
  usedMemoryBytes: number;
  freeMemoryBytes: number;
  memoryUsagePercent: number;
  totalSwapBytes: number;
  usedSwapBytes: number;
  freeSwapBytes: number;
  cpuPercent: number;
}

export interface DiskInfo {
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
  usagePercent: number;
  mountPoint: string;
  name?: string;
}

export interface AppInfo {
  version: string;
  platform: string;
  arch: string;
}

export interface SystemHealth {
  app: AppProcessInfo;
  system: SystemInfo;
  disk: DiskInfo;
  appInfo: AppInfo;
}
