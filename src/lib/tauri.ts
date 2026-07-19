import { invoke } from '@tauri-apps/api/core';
import { createLogger } from '@/lib/logger';
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

const logger = createLogger('ipc');

async function invokeLogged<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(cmd, args);
  } catch (error) {
    logger.error(`invoke ${cmd} failed`, error);
    throw error;
  }
}

export async function invokeCreateSession(
  request: SessionCreateRequest,
): Promise<SessionSummary> {
  return invokeLogged<SessionSummary>('create_session', { request }).catch((error) => {
    throw error as CreateSessionError;
  });
}

export async function invokeCreateLocalSession(
  cols = 120,
  rows = 30,
): Promise<SessionSummary> {
  return invokeLogged<SessionSummary>('create_local_session', { cols, rows });
}

export async function invokeWriteSession(sessionId: string, data: string): Promise<void> {
  return invokeLogged('write_session', { sessionId, data });
}

export async function invokeGetSessionStatus(sessionId: string): Promise<StatusEvent> {
  return invokeLogged<StatusEvent>('get_session_status', { sessionId });
}

export async function invokeResizeSession(
  sessionId: string,
  cols: number,
  rows: number,
): Promise<void> {
  return invokeLogged('resize_session', { sessionId, cols, rows });
}

export async function invokeCloseSession(sessionId: string): Promise<void> {
  return invokeLogged('close_session', { sessionId });
}

export async function invokeListRemoteDirectory(
  request: RemoteDirectoryRequest,
): Promise<RemoteDirectoryListing> {
  return invokeLogged('list_remote_directory', { request });
}

export async function invokeCreateRemoteEntry(
  request: CreateRemoteEntryRequest,
): Promise<void> {
  return invokeLogged('create_remote_entry', { request });
}

export async function invokeRenameRemotePath(
  request: RenameRemotePathRequest,
): Promise<void> {
  return invokeLogged('rename_remote_path', { request });
}

export async function invokeDeleteRemotePath(
  request: DeleteRemotePathRequest,
): Promise<void> {
  return invokeLogged('delete_remote_path', { request });
}

export async function invokeTrashRemotePath(
  request: TrashRemotePathRequest,
): Promise<TrashedRemotePath> {
  return invokeLogged('trash_remote_path', { request });
}

export async function invokeRestoreRemotePath(
  request: RestoreRemotePathRequest,
): Promise<void> {
  return invokeLogged('restore_remote_path', { request });
}

export async function invokeCopyRemotePath(
  request: CopyRemotePathRequest,
): Promise<void> {
  return invokeLogged('copy_remote_path', { request });
}

export async function invokeUploadLocalPaths(
  request: UploadLocalPathsRequest,
): Promise<void> {
  return invokeLogged('upload_local_paths', { request });
}

export async function invokeCopyLocalPaths(
  request: CopyLocalPathsRequest,
): Promise<void> {
  return invokeLogged('copy_local_paths', { request });
}

export async function invokeCopyRemoteToRemote(
  request: CopyRemoteToRemoteRequest,
): Promise<void> {
  return invokeLogged('copy_remote_to_remote', { request });
}

export async function invokeCancelRemoteCopy(operationId: string): Promise<void> {
  return invokeLogged('cancel_remote_copy', { operationId });
}

export async function invokeCancelUpload(operationId: string): Promise<void> {
  return invokeLogged('cancel_upload', { operationId });
}

export async function invokeCancelDelete(operationId: string): Promise<void> {
  return invokeLogged('cancel_delete', { operationId });
}

export async function invokeDownloadRemotePaths(
  request: DownloadRemotePathsRequest,
): Promise<void> {
  return invokeLogged('download_remote_paths', { request });
}

export async function invokeCancelDownload(operationId: string): Promise<void> {
  return invokeLogged('cancel_download', { operationId });
}

export async function invokeOpenRemoteFile(
  request: OpenRemoteFileRequest,
): Promise<void> {
  return invokeLogged('open_remote_file', { request });
}

export async function invokePreviewRemoteFile(
  request: ReadRemoteFileRequest,
): Promise<ReadRemoteFileResponse> {
  return invokeLogged('preview_remote_file', { request });
}

export async function invokeUpdateRemotePermissions(
  request: UpdateRemotePermissionsRequest,
): Promise<void> {
  return invokeLogged('update_remote_permissions', { request });
}

export async function invokeCheckHostKey(
  host: string,
  port: number,
): Promise<HostKeyCheckResult> {
  const result = await invokeLogged<HostKeyCheckResult>('check_host_key', {
    request: { host, port },
  });

  // Older backends serialized NotFound with rename_all = "lowercase".
  if ((result.status as string) === 'notfound') {
    return { ...result, status: 'notFound' };
  }
  return result;
}

export async function invokeTrustHost(host: string, port: number): Promise<void> {
  return invokeLogged('trust_host', { request: { host, port } });
}

export async function invokeListKnownHosts(): Promise<KnownHostEntry[]> {
  return invokeLogged('list_known_hosts');
}

export async function invokeRemoveKnownHost(
  host: string,
  port: number,
): Promise<void> {
  return invokeLogged('remove_known_host', { host, port });
}

export async function invokeListLogFiles(): Promise<LogFileInfo[]> {
  return invokeLogged('list_log_files');
}

export async function invokeReadLogFile(name: string): Promise<string> {
  return invokeLogged('read_log_file', { name });
}

export async function invokeExportLogFile(
  name: string,
  content: string,
): Promise<string | null> {
  return invokeLogged('export_log_file', { name, content });
}

export async function invokeListLocalDirectory(
  path: string,
): Promise<LocalDirectoryListing> {
  return invokeLogged('list_local_directory', { path });
}

export async function invokePickLocalFiles(): Promise<string[]> {
  return invokeLogged('pick_local_files');
}

export async function invokePickLocalFolder(title?: string): Promise<string[]> {
  return invokeLogged('pick_local_folder', { title });
}

export async function invokePickPrivateKeyFile(): Promise<string | null> {
  return invokeLogged('pick_private_key_file');
}

export async function invokeOpenPath(path: string): Promise<void> {
  return invokeLogged('open_path', { path });
}

export async function invokeStorePassword(
  profileId: string,
  password: string,
): Promise<void> {
  return invokeLogged('store_password', { profileId, password });
}

export async function invokeRetrievePassword(
  profileId: string,
): Promise<string | null> {
  return invokeLogged('retrieve_password', { profileId });
}

export async function invokeRemovePassword(profileId: string): Promise<void> {
  return invokeLogged('remove_password', { profileId });
}

export async function invokeListCachedCredentialProfileIds(): Promise<string[]> {
  return invokeLogged('list_cached_credential_profile_ids');
}

export async function invokeClearCredentialCache(): Promise<void> {
  return invokeLogged('clear_credential_cache');
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
  return invokeLogged('request_app_restart');
}
