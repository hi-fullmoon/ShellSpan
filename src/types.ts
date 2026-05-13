export type AuthMethod = 'password' | 'key';
export type PortForwardKind = 'local' | 'remote';
export type SessionStatus = 'connecting' | 'connected' | 'disconnected' | 'error';
export type ThemePreference = 'dark' | 'light' | 'system';
export type LocalePreference = 'zh-CN' | 'en-US';
export type TerminalTheme = 'default' | 'dracula' | 'solarized-dark' | 'solarized-light' | 'one-dark' | 'monokai';
export type CursorStyle = 'block' | 'line' | 'bar';
export type ShortcutAction =
  | 'closeDialog'
  | 'newConnection'
  | 'openSettings'
  | 'closeSession'
  | 'nextTab'
  | 'prevTab'
  | 'togglePrimarySidebar'
  | 'toggleSecondarySidebar';

export interface AppPreferences {
  theme: ThemePreference;
  locale: LocalePreference;
  terminalFontSize: number;
  terminalLineHeight: number;
  terminalTheme: TerminalTheme;
  cursorStyle: CursorStyle;
  cursorBlink: boolean;
  copyOnSelect: boolean;
  showFileManager: boolean;
  showSidebar: boolean;
  autoReconnect: boolean;
  startupUpdateCheck: boolean;
  historyLimit: number;
  keyboardShortcuts?: Partial<Record<ShortcutAction, string>>;
}

export interface ConnectionGroup {
  id: string;
  name: string;
  color?: string;
}

export interface ConnectionProfile {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  authMethod: AuthMethod;
  pinned?: boolean;
  favorite?: boolean;
  rememberPassword?: boolean;
  password?: string;
  privateKeyPath?: string;
  passphrase?: string;
  jumpHost?: JumpHostConfig;
  portForwards?: PortForwardConfig[];
  bookmarks?: string[];
  color?: string;
  groupId?: string;
}

export interface SessionSummary {
  sessionId: string;
  title: string;
  host: string;
  port: number;
  username: string;
}

export interface JumpHostConfig {
  host: string;
  port: number;
  username: string;
  authMethod: AuthMethod;
  password?: string;
  privateKeyPath?: string;
  passphrase?: string;
}

export interface PortForwardConfig {
  kind: PortForwardKind;
  localPort: number;
  remoteHost: string;
  remotePort: number;
}

export interface SessionState extends SessionSummary {
  profile: ConnectionProfile;
  status: SessionStatus;
  note?: string;
  createdAt: number;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface SshStatusEvent {
  sessionId: string;
  status: SessionStatus;
  message?: string;
}

export interface SshDataEvent {
  sessionId: string;
  chunk: string;
}

export interface SshClosedEvent {
  sessionId: string;
  reason?: string;
  reasonKind: 'local_close' | 'controller_dropped' | 'remote_exit' | 'transport_disconnect' | 'error';
  retryable: boolean;
}

export interface HostKeyCheckResponse {
  status: 'match' | 'mismatch' | 'notFound' | 'failure';
  fingerprint?: string;
  message?: string;
}

export interface UploadProgressEvent {
  operationId: string;
  currentPath?: string;
  totalBytes: number;
  uploadedBytes: number;
  totalSteps: number;
  completedSteps: number;
}

export interface UploadProgressState extends UploadProgressEvent {
  cancelling?: boolean;
}

export interface DeleteProgressEvent {
  operationId: string;
  currentPath?: string;
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

export interface DownloadProgressState extends DownloadProgressEvent {
  cancelling?: boolean;
}

export type RemoteFileKind = 'directory' | 'file' | 'symlink' | 'other';

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

export interface RemoteDirectoryListing {
  path: string;
  parentPath?: string;
  entries: RemoteFileEntry[];
}

export interface RemoteFileContent {
  path: string;
  name: string;
  content: string;
  size: number;
  isText: boolean;
}

export type UpdatePhase = 'idle' | 'checking' | 'update_available' | 'downloading' | 'downloaded' | 'no_update' | 'error';

export interface UpdateVersionMetadata {
  currentVersion?: string;
  latestVersion?: string;
  downloadedVersion?: string;
}

export interface UpdateState {
  phase: UpdatePhase;
  version?: UpdateVersionMetadata;
  error?: string;
}

export interface CommandSnippet {
  id: string;
  name: string;
  command: string;
}

export type UpdateAction =
  | { type: 'checkStarted' }
  | { type: 'noUpdateFound' }
  | { type: 'updateFound'; payload: { latestVersion: string } }
  | { type: 'downloadStarted' }
  | { type: 'downloadCompleted'; payload: { downloadedVersion: string } }
  | { type: 'downloadFailed'; payload: { message: string } }
  | { type: 'reset' };
