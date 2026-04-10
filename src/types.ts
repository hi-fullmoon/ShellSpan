export type AuthMethod = "password" | "key";
export type SessionStatus = "connecting" | "connected" | "disconnected" | "error";

export interface ConnectionProfile {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  authMethod: AuthMethod;
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
