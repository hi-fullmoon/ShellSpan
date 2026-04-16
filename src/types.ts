export type AuthMethod = "password" | "key";
export type SessionStatus = "connecting" | "connected" | "disconnected" | "error";

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
}

export interface SessionSummary {
  sessionId: string;
  title: string;
  host: string;
  port: number;
  username: string;
}

export interface SessionState extends SessionSummary {
  profile: ConnectionProfile;
  status: SessionStatus;
  note?: string;
  createdAt: number;
}

export type LogLevel = "debug" | "info" | "warn" | "error";

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

export type RemoteFileKind = "directory" | "file" | "symlink" | "other";

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

export type UpdatePhase =
  | "idle"
  | "checking"
  | "update_available"
  | "downloading"
  | "downloaded"
  | "no_update"
  | "error";

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

export type UpdateAction =
  | { type: "checkStarted" }
  | { type: "noUpdateFound" }
  | { type: "updateFound"; payload: { latestVersion: string } }
  | { type: "downloadStarted" }
  | { type: "downloadCompleted"; payload: { downloadedVersion: string } }
  | { type: "downloadFailed"; payload: { message: string } }
  | { type: "reset" };
