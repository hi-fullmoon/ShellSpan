import { invoke } from '@tauri-apps/api/core';
import { createLogger } from '@/lib/logger';
import { createOperationId, findOperationId } from '@/lib/operation-id';
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
  AiSessionLocator,
  AiSessionMeta,
  AiStartRequest,
} from '@/types/ai';
import type {
  AgentContractStatus,
  AgentProviderCapabilityEvidence,
  AgentRolloutPolicy,
  AgentStartRequest,
  PersistedAgentStateEnvelope,
  AgentStreamEvent,
  AgentToolResult,
} from '@/types/agent';
import type {
  AgentAuthorizeCallRequestV3,
  AgentCallPreviewV3,
  AgentCapabilityGrantV3,
  AgentContextRetrievalRequestV3,
  AgentContextRetrievalV3,
  AgentContextSnapshotV3,
  AgentExtensionSnapshotV3,
  AgentFileCheckpointV3,
  AgentLoadedSkillV3,
  AgentMcpAuthorizeRequestV3,
  AgentMcpCallV3,
  AgentMcpCapabilityGrantV3,
  AgentMcpResultV3,
  AgentMcpServerSnapshotV3,
  AgentMcpToolSchemaV3,
  AgentPlanV3,
  AgentRegisteredToolV3,
  AgentRequestV3,
  AgentTaskSnapshotV3,
  AgentToolCallV3,
  AgentToolResultV3,
  AgentV3RolloutPolicy,
  AgentAuditEventV3,
  AgentBrokerAuthorizeRequestV3,
  AgentBrokerGrantV3,
  AgentNotificationV3,
  AgentOperatorConfigureRequestV3,
  AgentOperatorGrantV3,
  AgentOperatorPolicyV3,
  AgentRecoveryStoreStatusV3,
} from '@/types/agent-v3';

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
): Promise<T> {
  const operationId = findOperationId(args) ?? createOperationId(cmd);
  logger.debug(`invoke ${cmd} started operation_id=${operationId}`);
  try {
    const result = await invoke<T>(cmd, args);
    logger.debug(`invoke ${cmd} completed operation_id=${operationId}`);
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
    throw error;
  }
}

type TerminalHotPathCommand =
  | 'write_session'
  | 'set_session_output_paused'
  | 'resize_session';

/**
 * Dispatch transient terminal data/control directly to Tauri. These commands
 * bypass higher-level logging because their callers already provide contextual
 * error handling. Returning invoke's promise unchanged also
 * avoids adding logging and async bookkeeping to each interactive event.
 */
function invokeTerminalHotPath<T>(
  cmd: TerminalHotPathCommand,
  args: Record<string, unknown>,
): Promise<T> {
  return invoke<T>(cmd, args);
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

export async function invokeAgentContractStatus(
  providerKind: AiProviderConfig['kind'],
  evidence?: AgentProviderCapabilityEvidence,
): Promise<AgentContractStatus> {
  return invokeLogged<AgentContractStatus>('agent_contract_status', {
    providerKind,
    evidence,
  });
}

export async function invokeAgentRolloutPolicy(): Promise<AgentRolloutPolicy> {
  return invokeLogged<AgentRolloutPolicy>('agent_rollout_policy');
}

export async function invokeSetAgentEnabled(enabled: boolean): Promise<boolean> {
  return invokeLogged<boolean>('agent_set_enabled', { enabled });
}

export async function invokeDetectAgentProviderCapability(
  provider: AiProviderConfig,
): Promise<AgentProviderCapabilityEvidence> {
  return invokeLogged<AgentProviderCapabilityEvidence>('agent_detect_provider_capability', {
    provider,
  });
}

export async function invokeStartAgentRequest(request: AgentStartRequest): Promise<void> {
  return invokeLogged('agent_start_request', { request });
}

export async function invokeSubmitAgentToolResult(result: AgentToolResult): Promise<void> {
  return invokeLogged('agent_submit_tool_result', { result });
}

export async function invokeCancelAgentRequest(requestId: string): Promise<void> {
  return invokeLogged('agent_cancel_request', { requestId });
}

export async function invokeAppendAiSessionAgentState(
  conversationId: string,
  startedAt: string,
  state: PersistedAgentStateEnvelope,
): Promise<void> {
  return invokeLogged('append_ai_session_agent_state', {
    conversationId,
    startedAt,
    timestamp: new Date().toISOString(),
    state,
  });
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

export async function listenToAgentStream(
  callback: EventCallback<AgentStreamEvent>,
): Promise<UnlistenFn> {
  return listen<AgentStreamEvent>('agent-stream', (event) => {
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
  lane: 'conversation' | 'command' | 'agent',
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
  reason: 'terminal_closed' | 'new_conversation' = 'terminal_closed',
): Promise<void> {
  return invokeLogged('archive_ai_session', {
    conversationId,
    startedAt,
    timestamp: new Date().toISOString(),
    reason,
  });
}

export async function invokeDeleteAiSessions(sessions: AiSessionLocator[]): Promise<number> {
  return invokeLogged<number>('delete_ai_sessions', { sessions });
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

// --- Agent Contract v3 M2 runtime commands ---

export async function invokeAgentV3RolloutPolicy(): Promise<AgentV3RolloutPolicy> {
  return invokeLogged<AgentV3RolloutPolicy>('agent_v3_rollout_policy');
}

export async function invokeAgentV3ListTools(): Promise<AgentRegisteredToolV3[]> {
  return invokeLogged<AgentRegisteredToolV3[]>('agent_v3_list_tools');
}

export async function invokeAgentV3RegisterTask(
  request: AgentRequestV3,
): Promise<AgentTaskSnapshotV3> {
  return invokeLogged<AgentTaskSnapshotV3>('agent_v3_register_task', { request });
}

export async function invokeAgentV3AuthorizeCall(
  request: AgentAuthorizeCallRequestV3,
): Promise<AgentCapabilityGrantV3> {
  return invokeLogged<AgentCapabilityGrantV3>('agent_v3_authorize_call', { request });
}

export async function invokeAgentV3PreviewCall(
  request: AgentAuthorizeCallRequestV3,
): Promise<AgentCallPreviewV3> {
  return invokeLogged<AgentCallPreviewV3>('agent_v3_preview_call', { request });
}

export async function invokeAgentV3RevokeCapability(capabilityId: string): Promise<void> {
  return invokeLogged('agent_v3_revoke_capability', { capabilityId });
}

export async function invokeAgentV3ExecuteTool(
  taskId: string,
  call: AgentToolCallV3,
): Promise<AgentToolResultV3> {
  return invokeLogged<AgentToolResultV3>('agent_v3_execute_tool', { taskId, call });
}

export async function invokeAgentV3GetTask(taskId: string): Promise<AgentTaskSnapshotV3> {
  return invokeLogged<AgentTaskSnapshotV3>('agent_v3_get_task', { taskId });
}

export async function invokeAgentV3ListTasks(): Promise<AgentTaskSnapshotV3[]> {
  return invokeLogged<AgentTaskSnapshotV3[]>('agent_v3_list_tasks');
}

export async function invokeAgentV3RecoveryStatus(): Promise<AgentRecoveryStoreStatusV3> {
  return invokeLogged<AgentRecoveryStoreStatusV3>('agent_v3_recovery_status');
}

export async function invokeAgentV3ListNotifications(): Promise<AgentNotificationV3[]> {
  return invokeLogged<AgentNotificationV3[]>('agent_v3_list_notifications');
}

export async function invokeAgentV3ListAuditEvents(): Promise<AgentAuditEventV3[]> {
  return invokeLogged<AgentAuditEventV3[]>('agent_v3_list_audit_events');
}

export async function invokeAgentV3OperatorPolicy(): Promise<AgentOperatorPolicyV3> {
  return invokeLogged<AgentOperatorPolicyV3>('agent_v3_operator_policy');
}

export async function invokeAgentV3ConfigureOperator(
  request: AgentOperatorConfigureRequestV3,
): Promise<AgentOperatorGrantV3> {
  return invokeLogged<AgentOperatorGrantV3>('agent_v3_configure_operator', { request });
}

export async function invokeAgentV3ListOperatorGrants(): Promise<AgentOperatorGrantV3[]> {
  return invokeLogged<AgentOperatorGrantV3[]>('agent_v3_list_operator_grants');
}

export async function invokeAgentV3RevokeOperator(
  grantId: string,
): Promise<AgentOperatorGrantV3> {
  return invokeLogged<AgentOperatorGrantV3>('agent_v3_revoke_operator', { grantId });
}

export async function invokeAgentV3AuthorizeBroker(
  request: AgentBrokerAuthorizeRequestV3,
): Promise<AgentBrokerGrantV3> {
  return invokeLogged<AgentBrokerGrantV3>('agent_v3_authorize_broker', { request });
}

export async function invokeAgentV3ListBrokerGrants(): Promise<AgentBrokerGrantV3[]> {
  return invokeLogged<AgentBrokerGrantV3[]>('agent_v3_list_broker_grants');
}

export async function invokeAgentV3RevokeBroker(
  grantId: string,
): Promise<AgentBrokerGrantV3> {
  return invokeLogged<AgentBrokerGrantV3>('agent_v3_revoke_broker', { grantId });
}

export async function invokeAgentV3ReconcileTask(
  taskId: string,
  continueTask: boolean,
): Promise<AgentTaskSnapshotV3> {
  return invokeLogged<AgentTaskSnapshotV3>('agent_v3_reconcile_task', {
    taskId,
    continueTask,
  });
}

export async function invokeAgentV3RebindRecoverySession(
  taskId: string,
  replacementSessionId: string,
): Promise<AgentTaskSnapshotV3> {
  return invokeLogged<AgentTaskSnapshotV3>('agent_v3_rebind_recovery_session', {
    taskId,
    replacementSessionId,
  });
}

export async function invokeAgentV3CancelTask(taskId: string): Promise<void> {
  return invokeLogged('agent_v3_cancel_task', { taskId });
}

export async function invokeAgentV3RestoreCheckpoint(
  taskId: string,
  checkpointId: string,
): Promise<AgentFileCheckpointV3> {
  return invokeLogged<AgentFileCheckpointV3>('agent_v3_restore_checkpoint', {
    taskId,
    checkpointId,
  });
}

// --- Agent Contract v3 M3 context and extension commands ---

export async function invokeAgentV3RefreshContext(
  taskId: string,
): Promise<AgentContextSnapshotV3> {
  return invokeLogged<AgentContextSnapshotV3>('agent_v3_refresh_context', { taskId });
}

export async function invokeAgentV3CompactContext(
  taskId: string,
  reason: 'manual' | 'budgetPressure' | 'beforeExtension',
): Promise<AgentContextSnapshotV3> {
  return invokeLogged<AgentContextSnapshotV3>('agent_v3_compact_context', { taskId, reason });
}

export async function invokeAgentV3RetrieveContext(
  request: AgentContextRetrievalRequestV3,
): Promise<AgentContextRetrievalV3> {
  return invokeLogged<AgentContextRetrievalV3>('agent_v3_retrieve_context', { request });
}

export async function invokeAgentV3RefreshExtensions(
  taskId: string,
): Promise<AgentExtensionSnapshotV3> {
  return invokeLogged<AgentExtensionSnapshotV3>('agent_v3_refresh_extensions', { taskId });
}

export async function invokeAgentV3LoadSkill(request: {
  readonly taskId: string;
  readonly skillId: string;
  readonly targetId: string;
}): Promise<AgentLoadedSkillV3> {
  return invokeLogged<AgentLoadedSkillV3>('agent_v3_load_skill', { request });
}

export async function invokeAgentV3InstantiateRunbook(request: {
  readonly taskId: string;
  readonly runbookId: string;
  readonly targetId: string;
  readonly parameters?: Readonly<Record<string, string>>;
}): Promise<AgentPlanV3> {
  return invokeLogged<AgentPlanV3>('agent_v3_instantiate_runbook', { request });
}

export async function invokeAgentV3ListMcpServers(
  taskId: string,
): Promise<AgentMcpServerSnapshotV3[]> {
  return invokeLogged<AgentMcpServerSnapshotV3[]>('agent_v3_list_mcp_servers', { taskId });
}

export async function invokeAgentV3SetMcpEnabled(
  taskId: string,
  serverId: string,
  enabled: boolean,
): Promise<AgentMcpServerSnapshotV3[]> {
  return invokeLogged<AgentMcpServerSnapshotV3[]>('agent_v3_set_mcp_enabled', {
    request: { taskId, serverId, enabled },
  });
}

export async function invokeAgentV3RefreshMcpServer(
  taskId: string,
  serverId: string,
): Promise<AgentMcpServerSnapshotV3> {
  return invokeLogged<AgentMcpServerSnapshotV3>('agent_v3_refresh_mcp_server', {
    taskId,
    serverId,
  });
}

export async function invokeAgentV3GetMcpToolSchema(
  taskId: string,
  serverId: string,
  toolName: string,
): Promise<AgentMcpToolSchemaV3> {
  return invokeLogged<AgentMcpToolSchemaV3>('agent_v3_get_mcp_tool_schema', {
    request: { taskId, serverId, toolName },
  });
}

export async function invokeAgentV3AuthorizeMcpCall(
  request: AgentMcpAuthorizeRequestV3,
): Promise<AgentMcpCapabilityGrantV3> {
  return invokeLogged<AgentMcpCapabilityGrantV3>('agent_v3_authorize_mcp_call', { request });
}

export async function invokeAgentV3ExecuteMcpCall(
  taskId: string,
  call: AgentMcpCallV3,
): Promise<AgentMcpResultV3> {
  return invokeLogged<AgentMcpResultV3>('agent_v3_execute_mcp_call', { taskId, call });
}
