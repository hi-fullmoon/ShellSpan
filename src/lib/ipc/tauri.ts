import { Channel, invoke } from '@tauri-apps/api/core';
import type { NativePromptOriginObservation } from '@/lib/terminal/native-prompt-origin';
import type { PetdexCategories, PetdexDiagnostic, PetdexTestResult, PetdexCheckResult } from '@/types';
import { createLogger } from '@/lib/logger';
import { modelDefinitionOf } from '@/lib/ai/provider-contract';
import type { AiLocalFileReference } from '@/lib/ai/file-reference';
import { sshRouteKey } from '@/lib/connections/ssh-route';
import { createOperationId, findOperationId } from '@/lib/operation-id';
import { listen, type EventCallback, type UnlistenFn } from '@tauri-apps/api/event';
import { getCurrentWindow, type DragDropEvent } from '@tauri-apps/api/window';

export function listenToWindowDragDrop(callback: (payload: DragDropEvent) => void): Promise<UnlistenFn> {
  return getCurrentWindow().onDragDropEvent(({ payload }) => callback(payload));
}

export type TerminalRecordingFormat = 'plain-log' | 'asciinema-v2';
export type TerminalExportFormat = 'text' | 'ansi';

export interface TerminalRecordingStatus {
  path: string;
  active: boolean;
  droppedFrames: number;
}

export function invokeExportTerminalBuffer(format: TerminalExportFormat, content: string): Promise<string | null> {
  return invoke('export_terminal_buffer', { format, content });
}

export function invokeStartTerminalRecording(
  sessionId: string, format: TerminalRecordingFormat, cols: number, rows: number,
): Promise<TerminalRecordingStatus | null> {
  return invoke('start_terminal_recording', { sessionId, format, cols, rows });
}

export function invokeStopTerminalRecording(sessionId: string): Promise<TerminalRecordingStatus | null> {
  return invoke('stop_terminal_recording', { sessionId });
}

export function invokeGetTerminalRecordingStatus(sessionId: string): Promise<TerminalRecordingStatus | null> {
  return invoke('get_terminal_recording_status', { sessionId });
}

export interface SshInteractiveAuthPrompt {
  operationId: string;
  promptId: string;
  host: string;
  username: string;
  instructions: string;
  prompts: Array<{ text: string; echo: boolean }>;
}

export function listenToSshInteractiveAuthPrompt(callback: EventCallback<SshInteractiveAuthPrompt>): Promise<UnlistenFn> {
  return listen('ssh-interactive-auth-prompt', callback);
}

export function listenToSshInteractiveAuthClosed(callback: EventCallback<string>): Promise<UnlistenFn> {
  return listen('ssh-interactive-auth-closed', callback);
}

export function invokeRespondToSshInteractiveAuth(
  operationId: string, promptId: string, answers: string[] | null,
): Promise<void> {
  return invoke('respond_to_ssh_interactive_auth', { operationId, promptId, answers });
}

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
  HostKeyCheckResult,
  JumpHostConfig,
  KnownHostEntry,
  LocalDirectoryListing,
  LocalTerminalOptions,
  LocalTerminalProfile,
  LogChunk,
  LogCursor,
  LogFileInfo,
  ProfileRow,
  ProfileSudoPolicy,
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
  FileOpenApplication,
  SaveFileDestination,
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
  TerminalBrokerSnapshot,
  TerminalSubmissionIntent,
  TerminalIntegrationStateEvent,
  TerminalCommandLifecycleEvent,
  RemoteHealthSnapshotRequest,
  RemoteHealthSnapshotResult,
  TransferBatchResult,
} from '@/types';
import type { AiProviderConnectionConfig } from '@/types/ai';
import type {
  AgentArtifactRequest,
  AgentArtifactResponse,
  AgentChildInputRequest,
  AgentChildRequest,
  AgentCommittedEventsRequest,
  AgentInboxMutationInput,
  AgentRecoveryCheckpoint,
  AgentRuntimeStartInput,
  AgentRuntimeToolDecisionInput,
  AgentSessionEvent,
  AgentSessionEventPage,
  AgentSessionEventsRequest,
  AgentSessionIdInput,
  AgentSessionListPage,
  AgentSessionListRequest,
  AgentSessionMessageInput,
  AgentSessionRenameInput,
  AgentSessionSnapshot,
  AgentSubagentSpawnRequest,
  AgentTerminalLeaseControlInput,
  AgentTerminalLeaseEvent,
  CreateAgentSessionRequest,
  LiveTerminalManualHandoff,
  TerminalDisplayBinding,
  TerminalDisplayFrame,
  TerminalDisplaySnapshot,
} from '@/types/agent-session';

const logger = createLogger('ipc');

export const invokePetdexConfigure = (configuration: import('@/lib/petdex/messages').PetdexSettings) =>
  invoke<import('@/lib/petdex/messages').PetdexConfigurationResult>('petdex_configure', { configuration });
export const invokePetdexMessageDiagnostic = () =>
  invoke<import('@/lib/petdex/messages').PetdexMessageDiagnostic>('petdex_message_diagnostic');
export const invokePetdexTestMessage = () =>
  invoke<import('@/lib/petdex/messages').PetdexMessageTestResult>('petdex_test_message');

export const invokePetdexSetEnabled = (enabled: boolean, categories?: PetdexCategories): Promise<PetdexDiagnostic> =>
  invoke<PetdexDiagnostic>('petdex_set_enabled', categories ? { enabled, categories } : { enabled });
export const invokePetdexGetStatus = (): Promise<PetdexDiagnostic> =>
  invoke<PetdexDiagnostic>('petdex_get_status');
export const invokePetdexCheckHealth = (): Promise<PetdexCheckResult> =>
  invoke<PetdexCheckResult>('petdex_check_health');
export const invokePetdexTestConnection = (): Promise<PetdexTestResult> =>
  invoke<PetdexTestResult>('petdex_test_connection');
export const listenPetdexStatus = (callback: (snapshot: PetdexDiagnostic) => void): Promise<UnlistenFn> =>
  listen<PetdexDiagnostic>('petdex-status', (event) => callback(event.payload));
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
  options?: { logLifecycle?: boolean },
): Promise<T> {
  const operationId = findOperationId(args) ?? createOperationId(cmd);
  if (options?.logLifecycle !== false) {
    logger.debug(`invoke ${cmd} started operation_id=${operationId}`);
  }
  try {
    const result = await invoke<T>(cmd, args);
    if (options?.logLifecycle !== false) {
      logger.debug(`invoke ${cmd} completed operation_id=${operationId}`);
    }
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
  | 'respond_terminal_prompt_origin'
  | 'write_session'
  | 'write_session_bytes'
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
  nativeInputProtocol: 'shellspan.native-input' | null = 'shellspan.native-input',
  onStarted?: (sessionId: string) => void,
): Promise<SessionSummary> {
  const wireRequest={...request};
  if(nativeInputProtocol) wireRequest.nativeInputProtocol=nativeInputProtocol;
  else delete wireRequest.nativeInputProtocol;
  const connectionStarted = onStarted ? new Channel<string>(onStarted) : undefined;
  try {
    const summary = await invokeLogged<SessionSummary>('create_session', { request: wireRequest, ...(connectionStarted ? { connectionStarted } : {}) });
    return { ...summary, sshRouteKey: sshRouteKey(wireRequest) };
  } catch (error) {
    throw error as CreateSessionError;
  }
}

export async function invokeCreateLocalSession(
  cols = 120,
  rows = 30,
  replacesSessionId?: string,
  nativeInputProtocol: 'shellspan.native-input' | null = 'shellspan.native-input',
  localProfile?: LocalTerminalProfile,
): Promise<SessionSummary> {
  return invokeLogged<SessionSummary>('create_local_session', {
    cols,
    rows,
    ...(nativeInputProtocol ? { nativeInputProtocol } : {}),
    ...(replacesSessionId ? { replacesSessionId } : {}),
    ...(localProfile ? { localProfile } : {}),
  });
}

export async function invokeOpenLocalSandboxTerminal(
  agentSessionId: string,
  cols = 120,
  rows = 30,
  replacesSessionId?: string,
): Promise<SessionSummary> {
  return invokeLogged<SessionSummary>('open_local_sandbox_terminal', {
    agentSessionId,
    cols,
    rows,
    ...(replacesSessionId ? { replacesSessionId } : {}),
  });
}

export function invokeGetLocalTerminalOptions(): Promise<LocalTerminalOptions> {
  return invokeLogged<LocalTerminalOptions>('get_local_terminal_options');
}

export async function invokeGetTerminalBrokerSnapshot(
  sessionId?: string,
): Promise<TerminalBrokerSnapshot> {
  // Includes source-free input observations; this read never acknowledges readiness
  // or grants execution authority. Missing observations from older backends are unknown.
  return invokeLogged<TerminalBrokerSnapshot>('get_terminal_broker_snapshot', {
    ...(sessionId ? { sessionId } : {}),
  });
}

export function invokeGetTerminalSubmissionRecovery(agentSessionId: string): Promise<TerminalSubmissionIntent[]> {
  return invokeLogged<TerminalSubmissionIntent[]>('get_terminal_submission_recovery', { agentSessionId });
}

export interface TerminalAcceptanceRawOutput {
  readonly dataStoreIdentifier: readonly number[] | null;
  readonly terminalSessionId: string;
  readonly terminalGeneration: number;
  readonly transportSessionId: string;
  readonly open: boolean;
  readonly completeFromStart: boolean;
  readonly capturedBytes: readonly number[];
  readonly captureTruncated: boolean;
  readonly captureCompleteFromStart: boolean;
  readonly capturedFrameCount: number;
  readonly capturedByteCount: number;
  readonly nextOutputSequence: number;
  readonly nextByteOffset: number;
  readonly frames: readonly {
    readonly protocolVersion: number;
    readonly terminalSessionId: string;
    readonly terminalGeneration: number;
    readonly type: string;
    readonly sequence: number;
    readonly byteOffset: number;
    readonly bytes: readonly number[];
  }[];
}

/** Explicit debug acceptance only; never input, readiness or execution authority. */
export function invokeGetTerminalAcceptanceRawOutput(sessionId: string): Promise<TerminalAcceptanceRawOutput> {
  return invokeLogged<TerminalAcceptanceRawOutput>('get_terminal_acceptance_raw_output', { sessionId });
}

export interface TerminalAcceptanceRawFrameEvent {
  readonly transportSessionId: string;
  readonly frame: TerminalAcceptanceRawOutput['frames'][number];
}

/** Explicit acceptance only. Register before creating the owned terminal. */
export function listenToTerminalAcceptanceRawOutput(callback: EventCallback<TerminalAcceptanceRawFrameEvent>): Promise<UnlistenFn> {
  return listen<TerminalAcceptanceRawFrameEvent>('terminal-acceptance-raw-output', callback);
}

/** Real local reader bytes, independently of Broker generation acceptance. */
export interface TerminalAcceptanceWireEvent {
  readonly transportSessionId: string;
  readonly terminalSessionId: string | null;
  readonly terminalGeneration: number | null;
  readonly frame: {
    readonly protocolVersion: 1;
    readonly type: 'transportRead';
    readonly sequence: number;
    readonly byteOffset: number;
    readonly bytes: readonly number[];
  };
}

/** Debug observation only; never a native command, lease or settlement receipt. */
export interface TerminalAcceptanceWireFinalized {
  readonly transportSessionId: string;
  readonly terminalSessionId: string | null;
  readonly terminalGeneration: number | null;
  readonly frameCount: number;
  readonly byteCount: number;
  readonly nextSequence: number;
  readonly deliveryFailed: boolean;
  readonly authority: 'observation-only';
  readonly worker: {
    readonly readerStopped: boolean;
    readonly childWaiterFinished: boolean;
    readonly inputStopped: boolean;
    readonly timedOut: boolean;
    readonly closedByUser: boolean;
    readonly controllerDropped: boolean;
  };
}

export function listenToTerminalAcceptanceWireOutput(callback: EventCallback<TerminalAcceptanceWireEvent>): Promise<UnlistenFn> {
  return listen<TerminalAcceptanceWireEvent>('terminal-acceptance-wire-output', callback);
}

export function listenToTerminalAcceptanceWireFinalized(callback: EventCallback<TerminalAcceptanceWireFinalized>): Promise<UnlistenFn> {
  return listen<TerminalAcceptanceWireFinalized>('terminal-acceptance-wire-finalized', callback);
}

export interface TerminalAcceptanceRawPreparation {
  readonly requestId: string;
  readonly invocationOrigin: string;
  readonly stage: string;
  readonly source: string;
  readonly background: boolean;
  readonly rejection: string | null;
  readonly unexpectedPreparationAbandoned: boolean;
  readonly headerBefore: AgentSessionSnapshot['header'];
  readonly sessionAfter: AgentSessionSnapshot;
  readonly brokerBefore: TerminalBrokerSnapshot;
  readonly brokerAfter: TerminalBrokerSnapshot;
  readonly recoveryBefore: readonly TerminalSubmissionIntent[];
  readonly recoveryAfter: readonly TerminalSubmissionIntent[];
  readonly effectPath: string;
  readonly effectBefore: boolean;
  readonly effectAfter: boolean;
}

/** Explicit isolated debug entrance to production preparation; never executes. */
export function invokePrepareTerminalAcceptanceRawCommand(agentSessionId: string, background: boolean): Promise<TerminalAcceptanceRawPreparation> {
  return invokeLogged('prepare_terminal_acceptance_raw_command', { agentSessionId, background });
}

export type TerminalAcceptanceSourceKind = 'effect' | 'running' | 'manual-running' | 'syntax-error' | 'unsupported-input' | 'parent-shell' | 'complex-source'
  | 'exact-byte-boundary' | 'oversized-byte-boundary' | 'long-input' | 'paced-input' | 'transport-read'
  | 'job-launch' | 'job-wait' | 'job-stop' | 'file-write' | 'file-read' | 'file-run'
  | 'sandbox-gate' | 'sandbox-init' | 'sandbox-exit' | 'sandbox-exit-125' | 'sandbox-cancel' | 'sandbox-timeout' | 'sandbox-restart'
  | 'sandbox-before' | 'sandbox-after' | 'sandbox-reviewed-read' | 'sandbox-reviewed-list'
  | 'sandbox-cancel-before-launch' | 'sandbox-descendant'
  | 'sandbox-operator-write' | 'sandbox-operator-outside-read';

export interface TerminalAcceptanceSubmission {
  readonly invocationOrigin: string;
  readonly callId: string;
  readonly sourceKind: TerminalAcceptanceSourceKind;
  readonly source: string;
  readonly settlement: 'Completed' | 'Waiting' | 'Cancelled';
  readonly session: AgentSessionSnapshot;
  readonly modelAvailability: string | null;
}

/** Explicit isolated debug entrance; the installed policy and tool pipeline run. */
export function invokeRunTerminalAcceptanceCommand(agentSessionId: string, callId: string, sourceKind: TerminalAcceptanceSourceKind, toolArgument?: string): Promise<TerminalAcceptanceSubmission> {
  return invokeLogged('run_terminal_acceptance_command', { agentSessionId, callId, sourceKind, toolArgument });
}

/** Production approval decision without waking a model driver afterwards. */
export function invokeDecideTerminalAcceptanceCommand(input: AgentRuntimeToolDecisionInput, approve: boolean): Promise<Pick<TerminalAcceptanceSubmission, 'session' | 'modelAvailability'>> {
  return invokeLogged('decide_terminal_acceptance_command', { input, approve });
}

export interface TerminalAcceptanceInputLease {
  readonly operationId: string;
  readonly stage: string;
  readonly released: boolean;
  readonly brokerBefore: TerminalBrokerSnapshot;
  readonly brokerAfter: TerminalBrokerSnapshot;
  readonly modelCalls: number;
  readonly agentSourceWrites: number;
}

/** Isolated macOS debug acceptance only; uses the real production lease manager. */
export function invokeControlTerminalAcceptanceInputLease(agentSessionId: string, release: boolean): Promise<TerminalAcceptanceInputLease> {
  return invokeLogged('control_terminal_acceptance_input_lease', { agentSessionId, release });
}

export function invokeWriteSession(sessionId: string, data: string): Promise<void> {
  return invokeTerminalHotPath('write_session', { sessionId, data });
}

export interface TerminalPromptOriginRequest {
  readonly sessionId: string;
  readonly terminalSessionId: string;
  readonly terminalGeneration: number;
  readonly requestId: string;
  readonly requestIndex: number;
  readonly timeoutMs: number;
  readonly geometry: {readonly columns: number; readonly rows: number; readonly cursorX: number; readonly cursorY: number};
}

export function invokeRespondTerminalPromptOrigin(
  request: TerminalPromptOriginRequest,
  observation: NativePromptOriginObservation,
): Promise<void> {
  return invokeTerminalHotPath('respond_terminal_prompt_origin', {
    response: {request, cellWidths: observation.cellWidths, wrapPending: observation.wrapPending},
  });
}

export function listenToTerminalPromptOrigin(
  callback: EventCallback<TerminalPromptOriginRequest>,
): Promise<UnlistenFn> {
  return listen<TerminalPromptOriginRequest>('terminal-prompt-origin-request', callback);
}

export function invokeWriteSessionBytes(sessionId: string, bytes: Uint8Array): Promise<void> {
  return invokeTerminalHotPath('write_session_bytes', {
    sessionId,
    bytes: Array.from(bytes),
  });
}

export async function invokeGetSessionStatus(sessionId: string): Promise<StatusEvent> {
  return invokeLogged<StatusEvent>('get_session_status', { sessionId });
}

export function invokeGetTerminalDisplaySnapshot(sessionId: string, binding: TerminalDisplayBinding): Promise<TerminalDisplaySnapshot> {
  return invokeLogged('get_terminal_display_snapshot', { sessionId, ...binding });
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

export function invokeCancelPendingSshConnection(sessionId: string): Promise<boolean> {
  return invokeLogged<boolean>('cancel_pending_ssh_connection', { sessionId });
}

export async function invokeCloseSession(sessionId: string): Promise<void> {
  return invokeLogged('close_session', { sessionId });
}

export async function invokeListAiModels(provider: AiProviderConnectionConfig): Promise<import('@/lib/ai/provider-contract').DiscoveredModel[]> {
  return invokeLogged<import('@/lib/ai/provider-contract').DiscoveredModel[]>('ai_list_models', { provider });
}

export async function invokeAiSetupModelDefinition(
  config: AiProviderConnectionConfig,
): Promise<import('@/lib/ai/provider-contract').ModelDefinition> {
  const { apiKey: _apiKey, ...provider } = config;
  try {
    const model = await invoke<import('@/lib/ai/provider-contract').ResolvedModel>('ai_resolve_model', { provider });
    return modelDefinitionOf(model);
  } catch (reason) {
    if (!(reason instanceof Error ? reason.message : String(reason)).includes('UNKNOWN_MODEL')) throw reason;
    return invoke<import('@/lib/ai/provider-contract').ModelDefinition>('ai_model_declaration_template', { provider });
  }
}

export async function invokeTestAiConnection(
  provider: AiProviderConnectionConfig,
  signal: AbortSignal,
): Promise<import('@/types/ai').AiConnectionTestResult> {
  type Result = import('@/types/ai').AiConnectionTestResult;
  if (signal.aborted) return { type: 'failed', kind: 'cancelled' };
  const onResult = new Channel<Result>();
  let requestId: string | undefined;
  let complete!: (result: Result) => void;
  const completion = new Promise<Result>((resolve) => { complete = resolve; });
  onResult.onmessage = complete;
  const cancelRequest = (): void => {
    if (requestId) {
      void invoke('ai_cancel_connection_test', { requestId }).catch(() => undefined);
    }
  };
  const cancel = (): void => {
    cancelRequest();
    complete({ type: 'failed', kind: 'cancelled' });
  };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    // This command carries a transient key. Only the backend's credential-free result
    // is exposed; do not log the command arguments or arbitrary provider bodies.
    requestId = await invoke<string>('ai_test_connection', { provider, onResult });
    if (signal.aborted) cancel();
    return await completion;
  } finally {
    signal.removeEventListener('abort', cancel);
  }
}

export function invokeListAiRoutes(): Promise<import('@/types/ai').RouteSnapshot> {
  return invokeLogged('ai_list_routes');
}
export function invokeGetAiRouteApiKey(routeId: string): Promise<string> {
  return invokeLogged('ai_get_route_api_key', { routeId });
}
export function invokeSaveAiRoutes(input: { routes: import('@/types/ai').ProviderRoute[]; defaultSelection?: import('@/types/ai').ModelSelection; expectedRevision: number; secrets?: Record<string,string> }): Promise<import('@/types/ai').RouteSnapshot> {
  return invokeLogged('ai_save_routes', { input });
}
export function invokeListAiRouteModels(routeId: string): Promise<{revision:number;models:import('@/lib/ai/provider-contract').ResolvedModel[]}> {
  return invokeLogged('ai_list_route_models', { routeId });
}
export function invokeResolveAiSelection(selection: import('@/types/ai').ModelSelection, expectedRevision: number): Promise<import('@/lib/ai/provider-contract').ResolvedModel> {
  return invokeLogged('ai_resolve_selection', { input: { selection, expectedRevision } });
}
export async function invokeCreateAgentRuntimeSession(
  request: CreateAgentSessionRequest,
): Promise<AgentSessionSnapshot> {
  return invokeLogged<AgentSessionSnapshot>('agent_runtime_create_session', { request });
}

export function invokeContinueAgentRuntimeOnTarget(request: CreateAgentSessionRequest): Promise<AgentSessionSnapshot> {
  return invokeLogged<AgentSessionSnapshot>('agent_runtime_continue_on_target', { request });
}

export function invokeReconnectAgentTerminal(input: { sessionId: string; previousSessionId: string; terminalSessionId: string }): Promise<AgentSessionSnapshot> {
  return invokeLogged<AgentSessionSnapshot>('agent_runtime_reconnect_terminal', { input });
}

export async function invokeStartAgentRuntime(
  input: AgentRuntimeStartInput,
): Promise<AgentSessionSnapshot> {
  return invokeLogged<AgentSessionSnapshot>('agent_runtime_start', { input });
}

export async function invokeSelectAgentRuntimeModel(input: { sessionId: string; selection: import('@/types/ai').ModelSelection }): Promise<AgentSessionSnapshot> {
  return invokeLogged<AgentSessionSnapshot>('agent_runtime_select_model', { input });
}

export async function invokeSetAgentRuntimePermission(input: {
  sessionId: string;
  mode: import('@/types/agent-session').AgentSessionPermissionMode;
}): Promise<AgentSessionSnapshot> {
  return invokeLogged<AgentSessionSnapshot>('agent_runtime_set_permission', { input });
}

export async function invokeSetAgentRuntimeExecutionSurface(input: {
  sessionId: string;
  surface: import('@/types/agent-session').AgentExecutionSurface;
}): Promise<AgentSessionSnapshot> {
  return invokeLogged<AgentSessionSnapshot>('agent_runtime_set_execution_surface', { input });
}

export async function invokeBindAgentProjectRoot(input: {
  sessionId: string;
  root: string;
}): Promise<AgentSessionSnapshot> {
  return invokeLogged<AgentSessionSnapshot>('agent_runtime_bind_project_root', { input });
}

export async function invokeSpawnAgentRuntimeSubagent(
  request: AgentSubagentSpawnRequest,
): Promise<AgentSessionSnapshot> {
  return invokeLogged<AgentSessionSnapshot>('agent_runtime_spawn_subagent', { request });
}

export async function invokeSendAgentRuntimeChildInput(
  request: AgentChildInputRequest,
): Promise<AgentSessionSnapshot> {
  return invokeLogged<AgentSessionSnapshot>('agent_runtime_send_child_input', { request });
}

export async function invokeCancelAgentRuntimeChild(
  request: AgentChildRequest,
): Promise<AgentSessionSnapshot> {
  return invokeLogged<AgentSessionSnapshot>('agent_runtime_cancel_child_agent', { request });
}

export async function invokeAgentRuntimeFollowup(
  input: AgentSessionMessageInput,
): Promise<AgentSessionSnapshot> {
  return invokeLogged<AgentSessionSnapshot>('agent_runtime_followup', { input });
}

// Upload bytes must never enter diagnostic request logging.
export async function invokePrepareAgentImages(images: readonly import('@/types/agent-image').AgentImageUpload[]) {
  return invoke<import('@/types/agent-image').AgentImageUpload[]>('agent_runtime_prepare_images', { images });
}
export async function invokeSubmitAgentImages(input: { sessionId: string; clientOperationId: string; content: string; lane: 'nextTurn' | 'nextStep'; images: readonly import('@/types/agent-image').AgentImageUpload[]; terminalContext?: import('@/types/agent-session').AgentTerminalContextSnapshot; paused?: boolean; targetTurnId?: string }) {
  const { paused, targetTurnId, ...message } = input;
  return invoke<AgentSessionSnapshot>('agent_runtime_submit_images', { input: message, paused, targetTurnId });
}
export async function invokeCancelAgentImageSubmission(input: { sessionId: string; clientOperationId: string }) {
  return invoke<boolean>('agent_runtime_cancel_image_submission', { input });
}
export async function invokeAgentImagePreview(input: { sessionId: string; sha256: string }) {
  return invoke<string>('agent_runtime_image_preview', { input });
}

export async function invokeAgentRuntimeSteer(
  input: AgentSessionMessageInput,
): Promise<AgentSessionSnapshot> {
  return invokeLogged<AgentSessionSnapshot>('agent_runtime_steer', { input });
}

export async function invokeMutateAgentRuntimeInbox(
  input: AgentInboxMutationInput,
): Promise<AgentSessionSnapshot> {
  return invokeLogged<AgentSessionSnapshot>('agent_runtime_mutate_inbox', { input });
}

export async function invokeRenameAgentRuntimeSession(
  input: AgentSessionRenameInput,
): Promise<AgentSessionSnapshot> {
  return invokeLogged<AgentSessionSnapshot>('agent_runtime_rename_session', { input });
}

export async function invokeCancelAgentRuntime(
  input: AgentSessionIdInput,
): Promise<AgentSessionSnapshot> {
  return invokeLogged<AgentSessionSnapshot>('agent_runtime_cancel', { input });
}

export async function invokeInterruptAgentRuntime(input: AgentSessionIdInput): Promise<AgentSessionSnapshot> {
  return invokeLogged<AgentSessionSnapshot>('agent_runtime_interrupt', { input });
}

export async function invokeResumeAgentRuntime(input: AgentSessionIdInput): Promise<AgentSessionSnapshot> {
  return invokeLogged<AgentSessionSnapshot>('agent_runtime_resume', { input });
}

export async function invokeRetryAgentModel(input: { sessionId: string; turnId: string }): Promise<AgentSessionSnapshot> {
  return invokeLogged<AgentSessionSnapshot>('agent_runtime_retry_model', { input });
}

export async function invokeApproveAgentRuntimeTool(
  input: AgentRuntimeToolDecisionInput,
): Promise<AgentSessionSnapshot> {
  return invokeLogged<AgentSessionSnapshot>('agent_runtime_approve_tool', { input });
}

export async function invokeRejectAgentRuntimeTool(
  input: AgentRuntimeToolDecisionInput,
): Promise<AgentSessionSnapshot> {
  return invokeLogged<AgentSessionSnapshot>('agent_runtime_reject_tool', { input });
}

export async function invokeGetPendingAgentRuntimeApprovalArguments(
  input: AgentRuntimeToolDecisionInput,
): Promise<unknown | null> {
  return invokeLogged<unknown | null>('agent_runtime_get_pending_approval_arguments', { input });
}

export async function invokeGetAgentRuntimeSession(
  input: AgentSessionIdInput,
): Promise<AgentSessionSnapshot> {
  return invokeLogged<AgentSessionSnapshot>('agent_runtime_get_session', { input });
}

export async function invokeListAgentRuntimeSessions(
  request: AgentSessionListRequest,
): Promise<AgentSessionListPage> {
  return invokeLogged<AgentSessionListPage>('agent_runtime_list_sessions', { request });
}

export async function invokeGetAgentRuntimeEvents(
  request: AgentSessionEventsRequest,
): Promise<AgentSessionEventPage> {
  return invokeLogged<AgentSessionEventPage>('agent_runtime_get_events', { request });
}

export async function invokeGetCommittedAgentRuntimeEvents(
  request: AgentCommittedEventsRequest,
): Promise<AgentSessionEventPage> {
  return invokeLogged<AgentSessionEventPage>('agent_runtime_get_committed_events', { request });
}

export async function invokeGetAgentRuntimeArtifact(
  request: AgentArtifactRequest,
): Promise<AgentArtifactResponse> {
  return invokeLogged<AgentArtifactResponse>('agent_runtime_get_artifact', { request });
}

export async function invokeArchiveAgentRuntimeSession(
  input: AgentSessionIdInput,
): Promise<AgentSessionSnapshot> {
  return invokeLogged<AgentSessionSnapshot>('agent_runtime_archive_session', { input });
}

export async function invokeGetAgentTerminalOwner(sessionId: string): Promise<string | null> {
  return invokeLogged<string | null>('agent_runtime_terminal_owner', { sessionId });
}

export async function invokeGetTerminalManualHandoffs(): Promise<readonly LiveTerminalManualHandoff[]> {
  return invokeLogged('agent_runtime_terminal_manual_handoffs');
}

export async function invokeAgentTerminalLeaseReady(
  input: AgentTerminalLeaseControlInput,
): Promise<boolean> {
  return invokeLogged<boolean>('agent_runtime_terminal_lease_ready', { input });
}

export async function invokeTakeoverAgentTerminal(
  input: AgentTerminalLeaseControlInput,
): Promise<boolean> {
  return invokeLogged<boolean>('agent_runtime_takeover_terminal', { input });
}

export async function invokeDeleteAgentRuntimeSession(
  input: AgentSessionIdInput,
): Promise<void> {
  return invokeLogged<void>('agent_runtime_delete_session', { input });
}

export async function invokeInspectAgentRuntimeRecovery(
  input: AgentSessionIdInput,
): Promise<AgentRecoveryCheckpoint> {
  return invokeLogged<AgentRecoveryCheckpoint>('agent_runtime_inspect_recovery', { input });
}

export async function invokeResumeAgentRuntimeRecovery(
  input: AgentSessionIdInput,
): Promise<AgentSessionSnapshot> {
  return invokeLogged<AgentSessionSnapshot>('agent_runtime_resume_recovery', { input });
}

export async function invokeOpenUrl(url: string): Promise<void> {
  return invokeLogged('open_url', { url });
}

export type ExistingPathKind = 'file' | 'directory';

export function invokeInspectRemotePath(
  sessionId: string,
  connection: RemoteConnectionRequest,
  path: string,
): Promise<ExistingPathKind | null> {
  return invokeLogged('inspect_remote_path', { sessionId, connection, path }, { logLifecycle: false });
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
): Promise<TransferBatchResult> {
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

export function invokeListFileOpenApplications(name: string, localPath?: string): Promise<FileOpenApplication[]> {
  return invokeLogged('list_file_open_applications', { name, localPath });
}

export function invokeGetFileOpenDefaultIcon(name: string, localPath?: string): Promise<string | null> {
  return invokeLogged('get_file_open_default_icon', { name, localPath });
}

export function invokeOpenLocalFileWithApplication(path: string, applicationId: string): Promise<void> {
  return invokeLogged('open_local_file_with_application', { path, applicationId });
}

export function invokePickPreviewSaveDestination(name: string, title: string, localPath?: string): Promise<SaveFileDestination | null> {
  return invokeLogged('pick_preview_save_destination', { name, title, localPath });
}

export function invokeSaveLocalPreviewFile(path: string, destination: SaveFileDestination): Promise<void> {
  return invokeLogged('save_local_preview_file', { path, destination });
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

/** Attachment bytes must never be included in IPC diagnostic logs. */
export async function invokeReadAiAttachment(path: string): Promise<{ name: string; data: string }> {
  return invoke('read_ai_attachment', { path });
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
  jumpHost?: RemoteConnectionRequest['jumpHost'],
): Promise<void> {
  return invokeLogged('trust_host', {
    request: { host, port, expectedFingerprint, ...(jumpHost && { jumpHost }) },
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
  // Reading the log must not append new entries to the same log.
  return invokeLogged('list_log_files', undefined, { logLifecycle: false });
}

export async function invokeReadLogFile(name: string): Promise<string> {
  return invokeLogged('read_log_file', { name }, { logLifecycle: false });
}

export async function invokeReadLogChunk(
  name: string,
  cursor?: LogCursor,
): Promise<LogChunk> {
  return invokeLogged('read_log_chunk', { name, cursor }, { logLifecycle: false });
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

export function invokeInspectLocalPath(path: string): Promise<ExistingPathKind | null> {
  return invokeLogged('inspect_local_path', { path }, { logLifecycle: false });
}

export async function invokeRevealPath(path: string): Promise<void> {
  return invokeLogged('reveal_path', { path });
}

export type LocalFileApp = 'vsCode' | 'terminal' | 'iterm' | 'xcode' | 'androidStudio' | 'systemPicker';

export function invokeListLocalFileApps(): Promise<LocalFileApp[]> {
  return isTauriRuntime() ? invokeLogged('list_local_file_apps') : Promise.resolve([]);
}

export function invokeOpenLocalFileWith(reference: AiLocalFileReference, app: LocalFileApp): Promise<void> {
  const { path, line, column } = reference;
  return invokeLogged('open_local_file_with', { path, line, column, app });
}

export function invokeSaveLocalFileAs(path: string, title: string): Promise<boolean> {
  return invokeLogged('save_local_file_as', { path, title });
}

export function invokeReadLocalFileText(path: string): Promise<string> {
  return invokeLogged('read_local_file_text', { path });
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

export async function invokeListKeyCredentials(): Promise<{ id: string; label: string; keyType: string; kind: KeychainKeyKind; service: string; publicKey?: string | null; fingerprint?: string | null }[]> {
  const credentials = await invokeLogged<Array<{ id: string; label: string; keyType: string; kind: string; service: string; publicKey?: string | null; fingerprint?: string | null }>>('list_key_credentials');
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
    authMethod: profile.authMethod,
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
  replacesSessionId?: string,
): SessionCreateRequest {
  return {
    operationId: createOperationId('ssh-connect'),
    profileId: profile.id,
    name: profile.name,
    host: profile.host,
    port: profile.port,
    username: profile.username,
    authMethod: profile.authMethod,
    password: profile.password,
    keychainKeyId: profile.authMethod === 'key' ? profile.keychainKeyId : undefined,
    privateKeyData: profile.privateKeyData,
    passphrase: profile.passphrase,
    terminalCols: cols,
    terminalRows: rows,
    jumpHost: profile.jumpHost ? mapJumpHostAuthMethod(profile.jumpHost) : undefined,
    ...(replacesSessionId ? { replacesSessionId } : {}),
  };
}

function mapJumpHostAuthMethod(jumpHost: JumpHostConfig): JumpHostConfig {
  return {
    ...jumpHost,
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

export function listenToTerminalDisplay(sessionId: string, callback: EventCallback<TerminalDisplayFrame>): Promise<UnlistenFn> {
  return listen(`terminal-display:${sessionId}`, callback);
}

export function listenToTerminalClosures(callback: EventCallback<ClosedEvent>): Promise<UnlistenFn> {
  return listen('ssh-closed', callback);
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

export async function listenToAgentRuntimeSession(
  callback: EventCallback<AgentSessionEvent>,
): Promise<UnlistenFn> {
  return listen<AgentSessionEvent>('agent-runtime-session-event', (event) => {
    callback(event);
  });
}

export type AgentSudoPromptEvent =
  | { state: 'requested'; promptId: string; host: string; port: number; username: string; command: string }
  | { state: 'closed'; promptId: string };

export function listenToAgentSudoPrompt(callback: EventCallback<AgentSudoPromptEvent>): Promise<UnlistenFn> {
  return listen<AgentSudoPromptEvent>('agent-sudo-prompt', callback);
}

export function respondToAgentSudoPrompt(promptId: string, password: string | null): Promise<void> {
  // Keep credential data and IPC errors out of the normal lifecycle logger.
  return invoke('agent_runtime_respond_sudo', { promptId, password });
}

export async function listenToAgentTerminalLease(
  callback: EventCallback<AgentTerminalLeaseEvent>,
): Promise<UnlistenFn> {
  return listen<AgentTerminalLeaseEvent>('agent-terminal-lease', (event) => {
    callback(event);
  });
}

export async function listenToAgentToolProgress(
  callback: EventCallback<import('@/types/agent-session').AgentToolProgressEvent>,
): Promise<UnlistenFn> {
  return listen<import('@/types/agent-session').AgentToolProgressEvent>('agent-tool-progress', (event) => {
    callback(event);
  });
}

export async function listenToTerminalIntegrationState(
  callback: EventCallback<TerminalIntegrationStateEvent>,
): Promise<UnlistenFn> {
  return listen<TerminalIntegrationStateEvent>('terminal-integration-state', (event) => {
    callback(event);
  });
}

export function listenToTerminalCommandLifecycle(callback: EventCallback<TerminalCommandLifecycleEvent>): Promise<UnlistenFn> {
  return listen('terminal-command-lifecycle', callback);
}

export function invokeNotifyTerminalCommand(title: string, body: string): Promise<void> {
  return invoke('notify_terminal_command', { title, body });
}

export function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export async function isLocalAgentSandboxPreview(): Promise<boolean> {
  if (!isTauriRuntime()) return false;
  const { getIdentifier } = await import('@tauri-apps/api/app');
  return (await getIdentifier()) === 'com.shellspan.validation.agent-sandbox-preview-keychain';
}

export interface LocalSandboxStatus {
  readonly supported: boolean;
  readonly supportsVisiblePty?: boolean;
  readonly kind?: import('@/types/agent-session').LocalSandboxKind;
  readonly reason?: string;
}

export async function invokeLocalSandboxStatus(): Promise<LocalSandboxStatus> {
  if (!isTauriRuntime()) return { supported: false, supportsVisiblePty: false };
  try {
    return await invoke<LocalSandboxStatus>('agent_runtime_local_sandbox_status');
  } catch {
    return { supported: false, supportsVisiblePty: false };
  }
}

export type SandboxChangeKind = 'added' | 'modified' | 'deleted';

export interface SandboxFileChange {
  readonly path: string;
  readonly kind: SandboxChangeKind;
  readonly conflict: boolean;
  readonly sandboxSize?: number;
  readonly sourceSize?: number;
}

export interface SandboxDiffReport {
  readonly sourceRoot: string;
  readonly changes: readonly SandboxFileChange[];
  readonly totalChanges: number;
  readonly conflictCount: number;
}

export interface SandboxApplyReport {
  readonly applied: readonly string[];
  readonly skippedConflicts: readonly string[];
  readonly errors: readonly string[];
}

export interface SandboxFileDiffPreview {
  readonly path: string;
  readonly isBinary: boolean;
  readonly truncated: boolean;
  readonly unifiedDiff: string;
}

export async function invokeSandboxDiff(sessionId: string): Promise<SandboxDiffReport | null> {
  if (!isTauriRuntime()) return null;
  return invokeLogged<SandboxDiffReport | null>('agent_runtime_sandbox_diff', { sessionId });
}

export async function invokeSandboxFileDiff(
  sessionId: string,
  path: string,
): Promise<SandboxFileDiffPreview> {
  return invokeLogged<SandboxFileDiffPreview>('agent_runtime_sandbox_file_diff', { sessionId, path });
}

export async function invokeSandboxApply(input: {
  sessionId: string;
  paths?: readonly string[];
  allowOverwriteConflicts?: boolean;
}): Promise<SandboxApplyReport> {
  return invokeLogged<SandboxApplyReport>('agent_runtime_sandbox_apply', { input });
}

export interface AgentFileCheckpoint {
  readonly checkpointId: string;
  readonly taskId: string;
  readonly targetId: string;
  readonly targetKind: 'local' | 'remote';
  readonly targetPath: string;
  readonly originalSha256?: string;
  readonly postWriteSha256?: string;
  readonly originalByteLength: number;
  readonly createdAtUnixMs: number;
  readonly expiresAtUnixMs: number;
  readonly restoredAtUnixMs?: number;
}

export interface FileCheckpointDiffPreview {
  readonly checkpointId: string;
  readonly targetPath: string;
  readonly targetKind: 'local' | 'remote';
  readonly existedBefore: boolean;
  readonly currentExists: boolean;
  readonly unchanged: boolean;
  readonly modifiedAfterAgent: boolean;
  readonly isBinary: boolean;
  readonly truncated: boolean;
  readonly unifiedDiff: string;
}

export interface FileCheckpointRestoreResult {
  readonly checkpoint: AgentFileCheckpoint;
  readonly action: 'restored' | 'trashed' | 'removed' | 'unchanged';
}

export interface FileCheckpointBatchFailure {
  readonly checkpointId: string;
  readonly targetPath?: string;
  readonly error: string;
}

export interface FileCheckpointBatchRestoreResult {
  readonly restored: readonly FileCheckpointRestoreResult[];
  readonly conflicts: readonly string[];
  readonly failed: readonly FileCheckpointBatchFailure[];
}

export async function invokeListFileCheckpoints(
  sessionId: string,
): Promise<readonly AgentFileCheckpoint[]> {
  if (!isTauriRuntime()) return [];
  return invokeLogged<AgentFileCheckpoint[]>('agent_runtime_list_file_checkpoints', { sessionId });
}

export async function invokePreviewFileCheckpoint(
  sessionId: string,
  checkpointId: string,
): Promise<FileCheckpointDiffPreview> {
  return invokeLogged<FileCheckpointDiffPreview>('agent_runtime_preview_file_checkpoint', {
    sessionId,
    checkpointId,
  });
}

export async function invokeRestoreFileCheckpoint(
  sessionId: string,
  checkpointId: string,
  allowConflictOverwrite = false,
): Promise<FileCheckpointRestoreResult> {
  return invokeLogged<FileCheckpointRestoreResult>('agent_runtime_restore_file_checkpoint', {
    sessionId,
    checkpointId,
    allowConflictOverwrite,
  });
}

export async function invokeRestoreFileCheckpointsBatch(
  sessionId: string,
  checkpointIds: readonly string[],
  allowConflictOverwrite = false,
): Promise<FileCheckpointBatchRestoreResult> {
  return invokeLogged<FileCheckpointBatchRestoreResult>('agent_runtime_restore_file_checkpoints_batch', {
    sessionId,
    checkpointIds,
    allowConflictOverwrite,
  });
}

export async function invokeRequestAppRestart(): Promise<void> {
  return invokeLogged('request_app_restart');
}

export function invokeAnswerAgentRuntimeQuestion(input: import('@/types/agent-question').AnswerQuestionInput): Promise<AgentSessionSnapshot> {
  return invokeLogged<AgentSessionSnapshot>('agent_runtime_answer_question', { input });
}
export async function invokeListProfiles(): Promise<ProfileRow[]> {
  return invokeLogged<ProfileRow[]>('list_profiles');
}

export function invokeGetProfileSudoPolicy(profileId: string): Promise<ProfileSudoPolicy> {
  return invokeLogged('get_profile_sudo_policy', { profileId });
}

export function invokeGetProfileSandbox(profileId: string): Promise<import('@/types').ProfileSandbox> {
  return invokeLogged('get_profile_sandbox', { profileId });
}

export async function invokeListProfileSandboxModes(): Promise<Record<string, import('@/types').SandboxMode>> {
  if (!isTauriRuntime()) return {};
  return invokeLogged('list_profile_sandbox_modes');
}

export async function invokeSaveProfileSandbox(profileId: string, binding: string, policy: import('@/types').SandboxPolicy | null): Promise<void> {
  await invokeLogged('save_profile_sandbox', { profileId, binding, policy });
  window.dispatchEvent(new CustomEvent('shellspan:connection-sandbox-changed', { detail: profileId }));
}

export function invokeTestProfileSandbox(profileId: string, binding: string, policy: import('@/types').SandboxPolicy, operationId: string): Promise<import('@/types').SandboxTestResult> {
  return invokeLogged('test_profile_sandbox', { profileId, binding, policy, operationId });
}

export function invokeDeployProfileSandbox(
  profileId: string,
  binding: string,
  policy: import('@/types').SandboxPolicy,
  operationId: string,
): Promise<import('@/types').SandboxDeployResult> {
  return invokeLogged('deploy_profile_sandbox', { profileId, binding, policy, operationId });
}

export function invokeSaveProfileSudoPolicy(
  profileId: string,
  input: Pick<ProfileSudoPolicy, 'profileBinding' | 'revision' | 'operations' | 'runner'>,
): Promise<void> {
  return invokeLogged('save_profile_sudo_policy', { profileId, input });
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

export function invokeLoadUiPreferences(): Promise<[string, string][]> {
  return invokeLogged('load_ui_preferences', undefined, { logLifecycle: false });
}
export function invokeSaveUiPreferences(entries: [string, string][]): Promise<void> {
  return invokeLogged('save_ui_preferences', { entries }, { logLifecycle: false });
}
export function invokeReadImageDrafts(input: { keys: readonly string[]; recoveryOwner?: string }): Promise<import('@/lib/ai/image-drafts').ImageDraft[]> {
  return invokeLogged('read_image_drafts', { input }, { logLifecycle: false });
}
export function invokeCommitImageDrafts(input: {
  checks: readonly { owner: string; revision: number }[];
  writes: readonly import('@/lib/ai/image-drafts').ImageDraft[];
  deletes: readonly string[];
}): Promise<void> {
  return invokeLogged('commit_image_drafts', { input }, { logLifecycle: false });
}

export async function invokeSavePreferences(
  entries: [string, string][],
): Promise<void> {
  return invokeLogged('save_preferences', { entries });
}

export async function invokePickProfileAvatar(): Promise<string | null> {
  return invokeLogged<string | null>('pick_profile_avatar');
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

export function invokeListAgentRuntimeSkills(sessionId: string): Promise<import('@/types/agent-skill').SkillUserList> {
  return invokeLogged('agent_runtime_list_skills', { input: { sessionId } });
}

export function invokeResolveAgentRuntimeSkillProposal(
  input: import('@/types/agent-skill').ResolveSkillProposalInput,
): Promise<AgentSessionSnapshot> {
  return invokeLogged<AgentSessionSnapshot>('agent_runtime_resolve_skill_proposal', { input });
}

export function invokeInspectAgentRuntimeSkillTarget(
  input: import('@/types/agent-skill').InspectSkillTargetInput,
): Promise<import('@/types/agent-skill').SkillTargetInspection> {
  return invokeLogged<import('@/types/agent-skill').SkillTargetInspection>('agent_runtime_inspect_skill_target', { input });
}

export function invokeListManagedSkills(): Promise<import('@/types/agent-skill').ManagedSkillCatalog> {
  return invokeLogged<import('@/types/agent-skill').ManagedSkillCatalog>('agent_runtime_list_managed_skills');
}

export function invokeSaveUserSkill(
  input: import('@/types/agent-skill').SaveUserSkillInput,
): Promise<import('@/types/agent-skill').ManagedSkillItem> {
  return invokeLogged<import('@/types/agent-skill').ManagedSkillItem>('agent_runtime_save_user_skill', { input });
}

export function invokeDeleteUserSkill(
  input: import('@/types/agent-skill').DeleteUserSkillInput,
): Promise<void> {
  return invokeLogged<void>('agent_runtime_delete_user_skill', { input });
}

export function invokeOpenUserSkillsDir(): Promise<void> {
  return invokeLogged<void>('agent_runtime_open_user_skills_dir');
}

/** Abort cancels only this query; native work remains bounded if the renderer disappears. */
export async function invokeListAgentFileReferences(sessionId: string, query: string, signal: AbortSignal): Promise<import('@/types/agent-file-reference').FileReferenceList> {
  if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
  const requestId = crypto.randomUUID();
  const cancel = (): void => { void invokeLogged('agent_runtime_cancel_file_references', { input: { sessionId, requestId } }).catch(() => undefined); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    const result = await invokeLogged<import('@/types/agent-file-reference').FileReferenceList>('agent_runtime_list_file_references', { input: { sessionId, requestId, query } });
    if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
    return result;
  } finally { signal.removeEventListener('abort', cancel); }
}
