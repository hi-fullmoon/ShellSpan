import { invoke } from '@tauri-apps/api/core';
import { createLogger } from '@/lib/logger';
import { createOperationId, findOperationId } from '@/lib/operation-id';
import {
  recordInvocationFailed,
  recordInvocationFinished,
  recordInvocationStarted,
  type OperationHistoryInvocationMetadata,
} from '@/lib/operation-history';
import { listen, type EventCallback, type UnlistenFn } from '@tauri-apps/api/event';
import type {
  AuthMethod,
  ClosedEvent,
  ConnectionPreflightRequest,
  ConnectionPreflightResult,
  ConnectionProfile,
  CopyRemotePathRequest,
  KeychainKey,
  KeychainKeyKind,
  CreateRemoteEntryRequest,
  CreateSessionError,
  DownloadProgressEvent,
  HostKeyCheckResult,
  JumpHostConfig,
  KnownHostEntry,
  LocalDirectoryListing,
  LogFileInfo,
  ProfileRow,
  PortForwardRuntime,
  PortForwardStartRequest,
  ProfileSecretKind,
  RemoteConnectionRequest,
  RemoteDirectoryListing,
  RemoteDirectoryRequest,
  RemoteEntryOwners,
  RemoteEntryOwnersRequest,
  RemoteFsError,
  RenameRemotePathRequest,
  DeleteRemotePathRequest,
  SftpBookmarkRow,
  OpenRemoteFileRequest,
  ReadRemoteFileRequest,
  ReadRemoteFileResponse,
  UpdateRemotePermissionsRequest,
  DownloadRemotePathsRequest,
  UploadLocalPathsRequest,
  CopyLocalPathsRequest,
  CopyRemoteToRemoteRequest,
  SessionCreateRequest,
  SessionErrorEvent,
  SessionSummary,
  StatusEvent,
  SystemHealth,
  RemoteHealthSnapshotRequest,
  RemoteHealthSnapshotResult,
  TransferBatchResult,
  UploadProgressEvent,
} from '@/types';
import type {
  AiChatMessage,
  AiConversation,
  AiProviderConfig,
  AiSessionFile,
  AiSessionMeta,
  AiStartRequest,
} from '@/types/ai';
import {
  decodeAgentActionResultV1,
  decodeAgentRunSnapshotV1,
  decodeAgentStartResultV1,
} from '@/lib/agent-protocol';
import type {
  AgentActionRequestV1,
  AgentActionResultV1,
  AgentEventV1,
  AgentGetSnapshotRequestV1,
  AgentRunSnapshotV1,
  AgentSendMessageRequestV1,
  AgentStartRequestV1,
  AgentStartResultV1,
} from '@/types/agent';

const logger = createLogger('ipc');
const DIRECTORY_REQUEST_SUPERSEDED_MESSAGE = 'remote directory request superseded';
const REMOTE_FILE_READ_CANCELLED_MESSAGE = 'remote file read cancelled';

function isSupersededDirectoryRequest(cmd: string, error: unknown): boolean {
  if (cmd !== 'list_remote_directory' && cmd !== 'resolve_remote_entry_owners') {
    return false;
  }
  const parsed = parseRemoteFsError(error);
  return parsed?.type === 'Other'
    && parsed.payload.message === DIRECTORY_REQUEST_SUPERSEDED_MESSAGE;
}

function isCancelledRemoteFileRead(cmd: string, error: unknown): boolean {
  if (cmd !== 'open_remote_file' && cmd !== 'preview_remote_file') {
    return false;
  }
  const parsed = parseRemoteFsError(error);
  return parsed?.type === 'Other'
    && parsed.payload.message === REMOTE_FILE_READ_CANCELLED_MESSAGE;
}

async function invokeLogged<T>(
  cmd: string,
  args?: Record<string, unknown>,
  historyMetadata?: OperationHistoryInvocationMetadata,
): Promise<T> {
  const operationId = findOperationId(args) ?? createOperationId(cmd);
  logger.debug(`invoke ${cmd} started operation_id=${operationId}`);
  const history = await recordInvocationStarted(cmd, args, operationId, historyMetadata);
  try {
    const result = await invoke<T>(cmd, args);
    logger.debug(`invoke ${cmd} completed operation_id=${operationId}`);
    await recordInvocationFinished(history, result);
    return result;
  } catch (error) {
    if (isSupersededDirectoryRequest(cmd, error)) {
      logger.debug(`invoke ${cmd} superseded operation_id=${operationId}`);
      throw error;
    }
    if (isCancelledRemoteFileRead(cmd, error)) {
      logger.debug(`invoke ${cmd} cancelled operation_id=${operationId}`);
      throw error;
    }
    logger.error(`invoke ${cmd} failed operation_id=${operationId}`, error);
    await recordInvocationFailed(history, error);
    throw error;
  }
}

type TerminalHotPathCommand =
  | 'write_session'
  | 'set_session_output_paused'
  | 'resize_session';

/**
 * Dispatch transient terminal data/control directly to Tauri. These commands
 * are intentionally excluded from operation history and their callers already
 * provide contextual error handling. Returning invoke's promise unchanged also
 * avoids adding logging and async bookkeeping to each interactive event.
 */
function invokeTerminalHotPath<T>(
  cmd: TerminalHotPathCommand,
  args: Record<string, unknown>,
): Promise<T> {
  return invoke<T>(cmd, args);
}

type AgentControlCommand =
  | 'agent_start'
  | 'agent_get_snapshot'
  | 'agent_pause'
  | 'agent_resume'
  | 'agent_stop'
  | 'agent_send_message';

/**
 * Agent requests stay out of generic operation history because the start
 * envelope may contain a redacted terminal snapshot. The backend Agent journal
 * remains the authority for run/action audit state.
 */
function invokeAgentControl<T>(
  command: AgentControlCommand,
  request: object,
): Promise<T> {
  return invoke<T>(command, { request });
}

export function parseRemoteFsError(error: unknown): RemoteFsError | null {
  if (typeof error !== 'object' || error === null) {
    return null;
  }

  const payload = (error as { type?: string; payload?: unknown }).type
    ? error
    : (() => {
        const message = (error as { message?: string }).message;
        if (!message) return null;
        try {
          return JSON.parse(message);
        } catch {
          return null;
        }
      })();

  if (
    payload &&
    typeof payload === 'object' &&
    'type' in payload &&
    (payload.type === 'HostKeyUnknown' ||
      payload.type === 'HostKeyMismatch' ||
      payload.type === 'Other')
  ) {
    return payload as RemoteFsError;
  }

  return null;
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

export function invokeWriteSession(sessionId: string, data: string): Promise<void> {
  return invokeTerminalHotPath('write_session', { sessionId, data });
}

export async function invokeGetSessionStatus(sessionId: string): Promise<StatusEvent> {
  return invokeLogged<StatusEvent>('get_session_status', { sessionId });
}

export async function invokeMarkSessionReady(sessionId: string): Promise<void> {
  return invokeLogged('mark_session_ready', { sessionId });
}

export function invokeSetSessionOutputPaused(
  sessionId: string,
  paused: boolean,
): Promise<void> {
  return invokeTerminalHotPath('set_session_output_paused', { sessionId, paused });
}

export function invokeResizeSession(
  sessionId: string,
  cols: number,
  rows: number,
): Promise<void> {
  return invokeTerminalHotPath('resize_session', { sessionId, cols, rows });
}

export async function invokeCloseSession(sessionId: string): Promise<void> {
  return invokeLogged('close_session', { sessionId });
}

export async function invokeListAiModels(provider: AiProviderConfig): Promise<string[]> {
  return invokeLogged<string[]>('ai_list_models', { provider });
}

export async function invokeStartAiRequest(request: AiStartRequest): Promise<void> {
  return invokeLogged('ai_start_request', { request });
}

export async function invokeCancelAiRequest(requestId: string): Promise<void> {
  return invokeLogged('ai_cancel_request', { requestId });
}

export async function invokeAgentStart(
  request: AgentStartRequestV1,
): Promise<AgentStartResultV1> {
  return decodeAgentStartResultV1(await invokeAgentControl('agent_start', request));
}

export async function invokeAgentGetSnapshot(
  request: AgentGetSnapshotRequestV1,
): Promise<AgentRunSnapshotV1> {
  return decodeAgentRunSnapshotV1(await invokeAgentControl('agent_get_snapshot', request));
}

async function invokeAgentAction(
  command: 'agent_pause' | 'agent_resume' | 'agent_stop',
  request: AgentActionRequestV1,
): Promise<AgentActionResultV1> {
  return decodeAgentActionResultV1(await invokeAgentControl(command, request));
}

export function invokeAgentPause(
  request: AgentActionRequestV1,
): Promise<AgentActionResultV1> {
  return invokeAgentAction('agent_pause', request);
}

export function invokeAgentResume(
  request: AgentActionRequestV1,
): Promise<AgentActionResultV1> {
  return invokeAgentAction('agent_resume', request);
}

export function invokeAgentStop(
  request: AgentActionRequestV1,
): Promise<AgentActionResultV1> {
  return invokeAgentAction('agent_stop', request);
}

export async function invokeAgentSendMessage(
  request: AgentSendMessageRequestV1,
): Promise<AgentActionResultV1> {
  return decodeAgentActionResultV1(await invokeAgentControl('agent_send_message', request));
}

export async function listenToAgentEvents(
  callback: (event: AgentEventV1 | unknown) => void,
): Promise<UnlistenFn> {
  return listen<unknown>('agent-event', (event) => callback(event.payload));
}

export async function invokeOpenUrl(url: string): Promise<void> {
  return invokeLogged('open_url', { url });
}

export async function invokeListRemoteDirectory(
  request: RemoteDirectoryRequest,
): Promise<RemoteDirectoryListing> {
  return invokeLogged('list_remote_directory', { request });
}

export async function invokeSupersedeRemoteDirectoryRequest(
  requestKey: string,
  requestId: number,
): Promise<void> {
  return invokeLogged('supersede_remote_directory_request', { requestKey, requestId });
}

export async function invokeResolveRemoteEntryOwners(
  request: RemoteEntryOwnersRequest,
): Promise<RemoteEntryOwners> {
  return invokeLogged('resolve_remote_entry_owners', { request });
}

export async function invokeWarmRemoteConnection(
  request: RemoteConnectionRequest,
): Promise<void> {
  return invokeLogged('warm_remote_connection', { request });
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

export async function invokeCopyRemotePath(
  request: CopyRemotePathRequest,
): Promise<void> {
  return invokeLogged('copy_remote_path', { request });
}

export async function invokeUploadLocalPaths(
  request: UploadLocalPathsRequest,
): Promise<TransferBatchResult> {
  return invokeLogged('upload_local_paths', { request });
}

export async function invokeCopyLocalPaths(
  request: CopyLocalPathsRequest,
): Promise<void> {
  return invokeLogged('copy_local_paths', { request });
}

export async function invokeRenameLocalPath(path: string, newName: string): Promise<void> {
  return invokeLogged('rename_local_path', { path, newName });
}

export async function invokeTrashLocalPaths(paths: string[]): Promise<void> {
  return invokeLogged('trash_local_paths', { paths });
}

export async function invokePasteLocalPaths(
  sourcePaths: string[],
  destinationDirectory: string,
  copySuffix: string,
): Promise<string[]> {
  return invokeLogged('paste_local_paths', { sourcePaths, destinationDirectory, copySuffix });
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
): Promise<TransferBatchResult> {
  return invokeLogged('download_remote_paths', { request });
}

export async function invokeCancelDownload(operationId: string): Promise<void> {
  return invokeLogged('cancel_download', { operationId });
}

export async function invokeDisconnectSftp(
  request: RemoteConnectionRequest,
): Promise<void> {
  return invokeLogged('disconnect_sftp', { request });
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

export async function invokeCancelRemoteFileRead(operationId: string): Promise<void> {
  return invokeLogged('cancel_remote_file_read', { operationId });
}

export async function invokePreviewLocalFile(
  path: string,
): Promise<ReadRemoteFileResponse> {
  return invokeLogged('preview_local_file', { path });
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

export async function invokePreflightConnection(
  request: ConnectionPreflightRequest,
): Promise<ConnectionPreflightResult> {
  return invokeLogged('preflight_connection', { request });
}

export async function invokeCancelConnectionPreflight(operationId: string): Promise<void> {
  return invokeLogged('cancel_connection_preflight', { operationId });
}

export async function invokeTrustHost(
  host: string,
  port: number,
  expectedFingerprint: string,
): Promise<void> {
  return invokeLogged('trust_host', {
    request: { host, port, expectedFingerprint },
  });
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

function toBackendKeychainKind(kind: KeychainKeyKind): string {
  return kind === 'keyFile' ? 'keyfile' : kind;
}

function fromBackendKeychainKind(kind: string): KeychainKeyKind {
  if (kind === 'keyfile') return 'keyFile';
  if (kind === 'password') return 'password';
  throw new Error(`unknown key credential kind: ${kind}`);
}

export async function invokeStoreKeyCredential(
  key: Omit<KeychainKey, 'createdAt' | 'updatedAt'>,
): Promise<void> {
  return invokeLogged('store_key_credential', {
    request: { ...key, kind: toBackendKeychainKind(key.kind) },
  });
}

export async function invokeListKeyCredentials(): Promise<{ id: string; label: string; keyType: string; kind: KeychainKeyKind; service: string }[]> {
  const credentials = await invokeLogged<Array<{ id: string; label: string; keyType: string; kind: string; service: string }>>('list_key_credentials');
  return credentials.map((credential) => ({
    ...credential,
    kind: fromBackendKeychainKind(credential.kind),
  }));
}

export async function invokeRetrieveKeyCredential(
  id: string,
): Promise<KeychainKey | undefined> {
  const result = await invokeLogged<KeychainKey | null>('retrieve_key_credential', { id });
  return result ?? undefined;
}

export async function invokeDeleteKeyCredential(id: string): Promise<string[]> {
  return invokeLogged<string[]>('delete_key_credential', { id });
}

export async function invokeStoreProfilePassword(
  profileId: string,
  password: string,
): Promise<void> {
  return invokeLogged('store_profile_password', { profileId, password });
}

export async function invokeRetrieveProfilePassword(profileId: string): Promise<string | undefined> {
  const result = await invokeLogged<string | null>('retrieve_profile_password', { profileId });
  return result ?? undefined;
}

export async function invokeDeleteProfilePassword(profileId: string): Promise<void> {
  return invokeLogged('delete_profile_password', { profileId });
}

export async function invokeStoreProfileSecret(
  profileId: string,
  kind: ProfileSecretKind,
  value: string,
): Promise<void> {
  return invokeLogged('store_profile_secret', { profileId, kind, value });
}

export async function invokeRetrieveProfileSecret(
  profileId: string,
  kind: ProfileSecretKind,
): Promise<string | undefined> {
  const result = await invokeLogged<string | null>('retrieve_profile_secret', { profileId, kind });
  return result ?? undefined;
}

export async function invokeDeleteProfileSecrets(profileId: string): Promise<void> {
  return invokeLogged('delete_profile_secrets', { profileId });
}

export async function invokeDeleteProfileSecret(
  profileId: string,
  kind: ProfileSecretKind,
): Promise<void> {
  return invokeLogged('delete_profile_secret', { profileId, kind });
}

export async function invokeReadTextFile(path: string): Promise<string> {
  return invokeLogged<string>('read_text_file', { path });
}

export function buildRemoteConnectionRequest(
  profile: ConnectionProfile,
): RemoteConnectionRequest {
  return {
    profileId: profile.id,
    host: profile.host,
    port: profile.port,
    username: profile.username,
    authMethod: mapAuthMethodForBackend(profile.authMethod),
    password: profile.password,
    keychainKeyId: profile.authMethod === 'key' ? profile.keychainKeyId : undefined,
    privateKeyData: profile.privateKeyData,
    passphrase: profile.passphrase,
    jumpHost: profile.jumpHost ? mapJumpHostAuthMethod(profile.jumpHost) : undefined,
  };
}

export function buildSessionCreateRequest(
  profile: ConnectionProfile,
  cols: number,
  rows: number,
): SessionCreateRequest {
  return {
    operationId: createOperationId('ssh-connect'),
    profileId: profile.id,
    name: profile.name,
    host: profile.host,
    port: profile.port,
    username: profile.username,
    authMethod: mapAuthMethodForBackend(profile.authMethod),
    password: profile.password,
    keychainKeyId: profile.authMethod === 'key' ? profile.keychainKeyId : undefined,
    privateKeyData: profile.privateKeyData,
    passphrase: profile.passphrase,
    terminalCols: cols,
    terminalRows: rows,
    jumpHost: profile.jumpHost ? mapJumpHostAuthMethod(profile.jumpHost) : undefined,
  };
}

function mapAuthMethodForBackend(authMethod: AuthMethod): AuthMethod {
  if (authMethod === 'password') return 'password';
  return 'key';
}

function mapJumpHostAuthMethod(jumpHost: JumpHostConfig): JumpHostConfig {
  return {
    ...jumpHost,
    authMethod: mapAuthMethodForBackend(jumpHost.authMethod),
    keychainKeyId: jumpHost.authMethod === 'key' ? jumpHost.keychainKeyId : undefined,
    privateKeyData: jumpHost.privateKeyData,
  };
}

export async function listenToSshData(
  sessionId: string,
  callback: EventCallback<string>,
): Promise<UnlistenFn> {
  return listen<string>(`ssh-data:${sessionId}`, (event) => {
    callback(event);
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

export async function listenToSessionError(
  callback: EventCallback<SessionErrorEvent>,
): Promise<UnlistenFn> {
  return listen<SessionErrorEvent>('ssh-session-error', (event) => {
    callback(event);
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

// --- Database commands ---

export async function invokeListProfiles(): Promise<ProfileRow[]> {
  return invokeLogged<ProfileRow[]>('list_profiles');
}

export async function invokeAddProfile(profile: ProfileRow): Promise<void> {
  return invokeLogged('add_profile', { profile });
}

export async function invokeUpdateProfile(id: string, profile: ProfileRow): Promise<void> {
  return invokeLogged('update_profile', { id, profile });
}

export async function invokeRemoveProfile(id: string): Promise<void> {
  return invokeLogged('remove_profile', { id });
}

export async function invokeLoadPreferences(): Promise<[string, string][]> {
  return invokeLogged<[string, string][]>('load_preferences');
}

export async function invokeSavePreferences(
  entries: [string, string][],
): Promise<void> {
  return invokeLogged('save_preferences', { entries });
}

export async function invokeListRecentProfiles(): Promise<string[]> {
  return invokeLogged<string[]>('list_recent_profiles');
}

export async function invokeTouchRecentProfile(profileId: string): Promise<void> {
  return invokeLogged('touch_recent_profile', { profileId });
}

export async function invokeRemoveRecentProfile(profileId: string): Promise<void> {
  return invokeLogged('remove_recent_profile', { profileId });
}

export async function invokeListSftpBookmarks(
  host: string,
  port: number,
  username: string,
): Promise<SftpBookmarkRow[]> {
  return invokeLogged<SftpBookmarkRow[]>('list_sftp_bookmarks', { host, port, username });
}

export async function invokeAddSftpBookmark(
  bookmark: SftpBookmarkRow,
): Promise<void> {
  return invokeLogged('add_sftp_bookmark', { bookmark });
}

export async function invokeRemoveSftpBookmark(id: string): Promise<void> {
  return invokeLogged('remove_sftp_bookmark', { id });
}

export async function invokeLoadTerminalWorkspace(): Promise<string | null> {
  return invokeLogged<string | null>('load_terminal_workspace');
}

export async function invokeSaveTerminalWorkspace(sessionsJson: string): Promise<void> {
  return invokeLogged('save_terminal_workspace', { sessionsJson });
}

export async function invokeClearTerminalWorkspace(): Promise<void> {
  return invokeLogged('clear_terminal_workspace');
}

export async function invokeStartPortForward(
  request: PortForwardStartRequest,
): Promise<PortForwardRuntime> {
  return invokeLogged<PortForwardRuntime>('start_port_forward', { request });
}

export async function invokeStopPortForward(operationId: string): Promise<PortForwardRuntime> {
  return invokeLogged<PortForwardRuntime>('stop_port_forward', { operationId });
}

export async function invokeStopAllPortForwards(): Promise<PortForwardRuntime[]> {
  return invokeLogged<PortForwardRuntime[]>('stop_all_port_forwards');
}

export async function invokeListPortForwards(): Promise<PortForwardRuntime[]> {
  return invokeLogged<PortForwardRuntime[]>('list_port_forwards');
}

export async function invokeLoadSftpWorkspace(): Promise<string | null> {
  return invokeLogged<string | null>('load_sftp_workspace');
}

export async function invokeSaveSftpWorkspace(workspaceJson: string): Promise<void> {
  return invokeLogged('save_sftp_workspace', { workspaceJson });
}

export async function invokeClearSftpWorkspace(): Promise<void> {
  return invokeLogged('clear_sftp_workspace');
}

export async function invokeCreateAiSession(meta: AiSessionMeta): Promise<void> {
  return invokeLogged('create_ai_session', { meta });
}

export async function invokeAppendAiSessionMessage(
  conversationId: string,
  startedAt: string,
  message: AiChatMessage,
): Promise<void> {
  return invokeLogged('append_ai_session_message', {
    conversationId,
    startedAt,
    timestamp: new Date().toISOString(),
    message,
  });
}

export async function invokeClearAiSessionLane(
  conversationId: string,
  startedAt: string,
  lane: 'conversation' | 'command',
): Promise<void> {
  return invokeLogged('clear_ai_session_lane', {
    conversationId,
    startedAt,
    timestamp: new Date().toISOString(),
    lane,
  });
}

export async function invokeArchiveAiSession(
  conversationId: string,
  startedAt: string,
): Promise<void> {
  return invokeLogged('archive_ai_session', {
    conversationId,
    startedAt,
    timestamp: new Date().toISOString(),
  });
}

export async function invokeListAiSessions(): Promise<AiConversation[]> {
  return invokeLogged<AiConversation[]>('list_ai_sessions');
}

export async function invokeLoadAiSession(
  conversationId: string,
  startedAt: string,
): Promise<AiSessionFile | null> {
  return invokeLogged<AiSessionFile | null>('load_ai_session', {
    conversationId,
    startedAt,
  });
}

export async function invokeGetSystemHealth(): Promise<SystemHealth> {
  return invokeLogged<SystemHealth>('get_system_health');
}

export async function invokeCollectRemoteHealthSnapshot(
  request: RemoteHealthSnapshotRequest,
): Promise<RemoteHealthSnapshotResult> {
  return invokeLogged<RemoteHealthSnapshotResult>('collect_remote_health_snapshot', { request });
}

export async function invokeCancelRemoteHealthSnapshot(operationId: string): Promise<void> {
  return invokeLogged('cancel_remote_health_snapshot', { operationId });
}
