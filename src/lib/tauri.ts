import { invoke } from '@tauri-apps/api/core';
import { listen, type EventCallback, type UnlistenFn } from '@tauri-apps/api/event';
import type {
  AuthMethod,
  ClosedEvent,
  ConnectionProfile,
  CopyRemotePathRequest,
  CreateRemoteEntryRequest,
  CreateSessionError,
  DataEvent,
  DeleteProgressEvent,
  DownloadProgressEvent,
  HostKeyCheckResult,
  JumpHostConfig,
  KnownHostEntry,
  LocalDirectoryListing,
  LogFileInfo,
  RemoteConnectionRequest,
  RemoteDirectoryListing,
  RemoteDirectoryRequest,
  RenameRemotePathRequest,
  DeleteRemotePathRequest,
  RestoreRemotePathRequest,
  TrashRemotePathRequest,
  TrashedRemotePath,
  OpenRemoteFileRequest,
  ReadRemoteFileRequest,
  ReadRemoteFileResponse,
  UpdateRemotePermissionsRequest,
  DownloadRemotePathsRequest,
  UploadLocalPathsRequest,
  CopyLocalPathsRequest,
  CopyRemoteToRemoteRequest,
  SessionCreateRequest,
  SessionSummary,
  StatusEvent,
  UploadProgressEvent,
} from '@/types';

export async function invokeCreateSession(
  request: SessionCreateRequest,
): Promise<SessionSummary> {
  return invoke<SessionSummary>('create_session', { request }).catch((error) => {
    throw error as CreateSessionError;
  });
}

export async function invokeCreateLocalSession(
  cols = 120,
  rows = 30,
): Promise<SessionSummary> {
  return invoke<SessionSummary>('create_local_session', { cols, rows });
}

export async function invokeWriteSession(sessionId: string, data: string): Promise<void> {
  return invoke('write_session', { sessionId, data });
}

export async function invokeResizeSession(
  sessionId: string,
  cols: number,
  rows: number,
): Promise<void> {
  return invoke('resize_session', { sessionId, cols, rows });
}

export async function invokeCloseSession(sessionId: string): Promise<void> {
  return invoke('close_session', { sessionId });
}

export async function invokeListRemoteDirectory(
  request: RemoteDirectoryRequest,
): Promise<RemoteDirectoryListing> {
  return invoke('list_remote_directory', { request });
}

export async function invokeCreateRemoteEntry(
  request: CreateRemoteEntryRequest,
): Promise<void> {
  return invoke('create_remote_entry', { request });
}

export async function invokeRenameRemotePath(
  request: RenameRemotePathRequest,
): Promise<void> {
  return invoke('rename_remote_path', { request });
}

export async function invokeDeleteRemotePath(
  request: DeleteRemotePathRequest,
): Promise<void> {
  return invoke('delete_remote_path', { request });
}

export async function invokeTrashRemotePath(
  request: TrashRemotePathRequest,
): Promise<TrashedRemotePath> {
  return invoke('trash_remote_path', { request });
}

export async function invokeRestoreRemotePath(
  request: RestoreRemotePathRequest,
): Promise<void> {
  return invoke('restore_remote_path', { request });
}

export async function invokeCopyRemotePath(
  request: CopyRemotePathRequest,
): Promise<void> {
  return invoke('copy_remote_path', { request });
}

export async function invokeUploadLocalPaths(
  request: UploadLocalPathsRequest,
): Promise<void> {
  return invoke('upload_local_paths', { request });
}

export async function invokeCopyLocalPaths(
  request: CopyLocalPathsRequest,
): Promise<void> {
  return invoke('copy_local_paths', { request });
}

export async function invokeCopyRemoteToRemote(
  request: CopyRemoteToRemoteRequest,
): Promise<void> {
  return invoke('copy_remote_to_remote', { request });
}

export async function invokeCancelUpload(operationId: string): Promise<void> {
  return invoke('cancel_upload', { operationId });
}

export async function invokeCancelDelete(operationId: string): Promise<void> {
  return invoke('cancel_delete', { operationId });
}

export async function invokeDownloadRemotePaths(
  request: DownloadRemotePathsRequest,
): Promise<void> {
  return invoke('download_remote_paths', { request });
}

export async function invokeCancelDownload(operationId: string): Promise<void> {
  return invoke('cancel_download', { operationId });
}

export async function invokeOpenRemoteFile(
  request: OpenRemoteFileRequest,
): Promise<void> {
  return invoke('open_remote_file', { request });
}

export async function invokePreviewRemoteFile(
  request: ReadRemoteFileRequest,
): Promise<ReadRemoteFileResponse> {
  return invoke('preview_remote_file', { request });
}

export async function invokeUpdateRemotePermissions(
  request: UpdateRemotePermissionsRequest,
): Promise<void> {
  return invoke('update_remote_permissions', { request });
}

export async function invokeCheckHostKey(
  host: string,
  port: number,
): Promise<HostKeyCheckResult> {
  const result = await invoke<HostKeyCheckResult>('check_host_key', {
    request: { host, port },
  });

  // Older backends serialized NotFound with rename_all = "lowercase".
  if ((result.status as string) === 'notfound') {
    return { ...result, status: 'notFound' };
  }
  return result;
}

export async function invokeTrustHost(host: string, port: number): Promise<void> {
  return invoke('trust_host', { request: { host, port } });
}

export async function invokeListKnownHosts(): Promise<KnownHostEntry[]> {
  return invoke('list_known_hosts');
}

export async function invokeRemoveKnownHost(
  host: string,
  port: number,
): Promise<void> {
  return invoke('remove_known_host', { host, port });
}

export async function invokeListLogFiles(): Promise<LogFileInfo[]> {
  return invoke('list_log_files');
}

export async function invokeReadLogFile(name: string): Promise<string> {
  return invoke('read_log_file', { name });
}

export async function invokeExportLogFile(
  name: string,
  content: string,
): Promise<string | null> {
  return invoke('export_log_file', { name, content });
}

export async function invokeListLocalDirectory(
  path: string,
): Promise<LocalDirectoryListing> {
  return invoke('list_local_directory', { path });
}

export async function invokePickLocalFiles(): Promise<string[]> {
  return invoke('pick_local_files');
}

export async function invokePickLocalFolder(title?: string): Promise<string[]> {
  return invoke('pick_local_folder', { title });
}

export async function invokePickPrivateKeyFile(): Promise<string | null> {
  return invoke('pick_private_key_file');
}

export async function invokeOpenPath(path: string): Promise<void> {
  return invoke('open_path', { path });
}

export async function invokeStorePassword(
  profileId: string,
  password: string,
): Promise<void> {
  return invoke('store_password', { profileId, password });
}

export async function invokeRetrievePassword(
  profileId: string,
): Promise<string | null> {
  return invoke('retrieve_password', { profileId });
}

export async function invokeRemovePassword(profileId: string): Promise<void> {
  return invoke('remove_password', { profileId });
}

export async function invokeListCachedCredentialProfileIds(): Promise<string[]> {
  return invoke('list_cached_credential_profile_ids');
}

export async function invokeClearCredentialCache(): Promise<void> {
  return invoke('clear_credential_cache');
}

export function buildRemoteConnectionRequest(
  profile: ConnectionProfile,
): RemoteConnectionRequest {
  return {
    host: profile.host,
    port: profile.port,
    username: profile.username,
    authMethod: profile.authMethod,
    password: profile.password,
    privateKeyPath: profile.privateKeyPath,
    passphrase: profile.passphrase,
    jumpHost: profile.jumpHost,
  };
}

export function buildSessionCreateRequest(
  profile: ConnectionProfile,
  cols: number,
  rows: number,
): SessionCreateRequest {
  return {
    name: profile.name,
    host: profile.host,
    port: profile.port,
    username: profile.username,
    authMethod: profile.authMethod,
    password: profile.password,
    privateKeyPath: profile.privateKeyPath,
    passphrase: profile.passphrase,
    terminalCols: cols,
    terminalRows: rows,
    jumpHost: profile.jumpHost,
  };
}

export async function listenToSshData(
  sessionId: string,
  callback: EventCallback<DataEvent>,
): Promise<UnlistenFn> {
  return listen<DataEvent>('ssh-data', (event) => {
    if (event.payload.sessionId === sessionId) {
      callback(event);
    }
  });
}

export async function listenToSshStatus(
  sessionId: string,
  callback: EventCallback<StatusEvent>,
): Promise<UnlistenFn> {
  return listen<StatusEvent>('ssh-status', (event) => {
    if (event.payload.sessionId === sessionId) {
      callback(event);
    }
  });
}

export async function listenToSshClosed(
  sessionId: string,
  callback: EventCallback<ClosedEvent>,
): Promise<UnlistenFn> {
  return listen<ClosedEvent>('ssh-closed', (event) => {
    if (event.payload.sessionId === sessionId) {
      callback(event);
    }
  });
}

export async function listenToUploadProgress(
  operationId: string,
  callback: EventCallback<UploadProgressEvent>,
): Promise<UnlistenFn> {
  return listen<UploadProgressEvent>('upload-progress', (event) => {
    if (event.payload.operationId === operationId) {
      callback(event);
    }
  });
}

export async function listenToDownloadProgress(
  operationId: string,
  callback: EventCallback<DownloadProgressEvent>,
): Promise<UnlistenFn> {
  return listen<DownloadProgressEvent>('download-progress', (event) => {
    if (event.payload.operationId === operationId) {
      callback(event);
    }
  });
}

export function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export async function invokeRequestAppRestart(): Promise<void> {
  return invoke('request_app_restart');
}
