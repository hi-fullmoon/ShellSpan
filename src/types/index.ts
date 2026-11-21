export type ThemeMode = 'light' | 'dark' | 'system';
export type Locale = 'zh-CN' | 'en-US';
export type AppSection = 'workbench' | 'terminal' | 'sftp';
export type TerminalFontFamily = 'system' | 'menlo' | 'monaco' | 'consolas' | 'courierNew';
export type TerminalCursorStyle = 'block' | 'underline' | 'bar';
export const TERMINAL_COLOR_SCHEME_IDS = [
  'app',
  'oneDark',
  'solarizedDark',
  'dracula',
  'nord',
  'gruvboxDark',
  'tokyoNight',
  'catppuccinMocha',
  'light',
] as const;
export type TerminalColorScheme = (typeof TERMINAL_COLOR_SCHEME_IDS)[number];
export type TerminalBellStyle = 'none' | 'sound';
export type TerminalOsc52Policy = 'writeOnly' | 'disabled';
export type SftpConflictPolicy = 'ask' | 'overwrite' | 'skip';
export type WorkbenchTab = 'connections' | 'knownHosts' | 'keychain' | 'monitor' | 'logs';
export type SettingsSection = 'appearance' | 'general' | 'terminal' | 'sftp' | 'ai' | 'shortcuts' | 'experimental' | 'feedback';
export type SettingsTarget = 'terminal-title-template';
export type PetdexConnectionStatus =
  | 'disabled'
  | 'checking'
  | 'notDetected'
  | 'connected'
  | 'unreachable'
  | 'unauthorized'
  | 'rejected'
  | 'tokenUnreadable'
  | 'tokenInvalid'
  | 'connectionError';
export type PetdexAction = 'idle' | 'waiting' | 'waving' | 'running' | 'jumping' | 'failed';
export interface PetdexCategories { ssh: boolean; sftp: boolean; ai: boolean }
export type PetdexErrorReason = 'tokenMissing' | 'tokenUnreadable' | 'tokenInvalid'
  | 'transport' | 'unauthorized' | 'rejected';
export interface PetdexDiagnostic {
  revision: number;
  status: PetdexConnectionStatus;
  errorReason: PetdexErrorReason | null;
  targetAction: PetdexAction | null;
  /** Unix milliseconds of HTTP success, not confirmation of visible animation. */
  lastSuccessAt: number | null;
}
export type PetdexPreviewOutcome = 'requested' | 'overridden' | 'failed' | 'disabled';
export type PetdexHealth = 'reachable' | 'unavailable' | 'disabled';
export interface PetdexCheckResult { diagnostic: PetdexDiagnostic; health: PetdexHealth }
export interface PetdexTestResult {
  diagnostic: PetdexDiagnostic;
  preview: PetdexPreviewOutcome;
}
export type LogSource = 'frontend' | 'backend';
export type ShortcutAction =
  | 'openWorkbench'
  | 'openTerminal'
  | 'openSftp'
  | 'openSettings'
  | 'openShortcuts'
  | 'openCommandPalette'
  | 'toggleAiPanel'
  | 'toggleFocusMode'
  | 'newTerminalTab'
  | 'closeTerminalTab'
  | 'switchTerminalTab'
  | 'nextTerminalTab'
  | 'previousTerminalTab'
  | 'findTerminal'
  | 'terminalClearScreen'
  | 'terminalSendToAi'
  | 'newSftpConnection'
  | 'findSftp'
  | 'closeSftpTab'
  | 'switchSftpTab'
  | 'nextSftpTab'
  | 'previousSftpTab'
  | 'sftpRefresh'
  | 'sftpNewFolder'
  | 'sftpToggleHiddenFiles'
  | 'sftpFocusPath'
  | 'sftpParentDirectory'
  | 'sftpOpenTerminalHere'
  | 'terminalLeader'
  | 'terminalFocusLeft'
  | 'terminalFocusDown'
  | 'terminalFocusUp'
  | 'terminalFocusRight'
  | 'terminalSplitRight'
  | 'terminalSplitDown'
  | 'terminalZoomPane'
  | 'terminalEqualizePanes'
  | 'terminalSwapPane'
  | 'terminalPreviousCommand'
  | 'terminalNextCommand'
  | 'terminalToggleBroadcast'
  | 'terminalScrollToBottom'
  | 'terminalClosePane';
export type ShortcutBindings = Record<ShortcutAction, string>;
export type AuthMethod = 'password' | 'key' | 'agent' | 'keyboardInteractive';
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

export type PortForwardKind = 'local' | 'remote' | 'dynamic';
export type PortForwardStartMode = 'manual' | 'auto';
export type PortForwardStatus = 'starting' | 'running' | 'stopping' | 'stopped' | 'failed';
export type PortForwardErrorCategory =
  | 'portInUse'
  | 'hostKey'
  | 'authentication'
  | 'connection'
  | 'invalidConfiguration'
  | 'other';

export type HostConnectionAction = 'terminal' | 'sftp' | 'portForward' | 'overview';

export type HostQuickAction =
  | {
      id: string;
      kind: 'directory';
      label: string;
      path: string;
      target: 'terminal' | 'sftp';
    }
  | {
      id: string;
      kind: 'command';
      label: string;
      command: string;
    }
  | {
      id: string;
      kind: 'connection';
      label: string;
      action: HostConnectionAction;
    };

export interface PortForwardRule {
  id: string;
  name: string;
  kind: PortForwardKind;
  localPort: number;
  remoteHost: string;
  remotePort: number;
  autoStart: boolean;
}

export interface PortForwardRuntime {
  operationId: string;
  profileId: string;
  configId: string;
  name: string;
  kind: PortForwardKind;
  mode: PortForwardStartMode;
  status: PortForwardStatus;
  startedAt?: number;
  stoppedAt?: number;
  bytesSent: number;
  bytesReceived: number;
  lastError?: string;
  errorCategory?: PortForwardErrorCategory;
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
  group?: string;
  tags?: string[];
  favorite?: boolean;
  notes?: string;
  portForwards?: PortForwardRule[];
  quickActions?: HostQuickAction[];
  createdAt: number;
  updatedAt: number;
}

export interface SudoOperation {
  id: string;
  label: string;
  command: string;
}

export interface ProfileSudoPolicy {
  profileBinding: string;
  host: string;
  port: number;
  username: string;
  revision: string | null;
  runner: SudoRunner | null;
  operations: SudoOperation[];
}

export interface SudoRunner {
  port: number;
  username: string;
  hostKeySha256: string;
}

export interface SessionSummary {
  sessionId: string;
  title: string;
  host: string;
  port: number;
  username: string;
  /** Captured from the successful SSH connection request by the IPC adapter. */
  sshRouteKey?: string;
  /** Ephemeral broker-owned identity; omitted while terminal_broker is off. */
  terminalSessionId?: string;
  /** Generation of the currently attached PTY/ConPTY/SSH PTY transport. */
  terminalGeneration?: number;
  /** Backend-reported transport metadata, available even with the broker off. */
  ptyInfo?: SessionPtyInfo;
}

export type LocalTerminalProfile = 'shellSpanBash';

export interface LocalTerminalOptions {
  defaultShellPath?: string;
  defaultShellKind?: 'powerShell7' | 'windowsPowerShell';
  supportsShellSpanBash: boolean;
}

export interface SessionPtyInfo {
  /** Local Windows startup waits for the renderer's initial resize/ready FIFO. */
  deferredStartup?: boolean;
  transportKind: TerminalBrokerTransportKind;
  inputMode?: TerminalBrokerSessionSnapshot['inputMode'];
  nativeDisplayBinding?: TerminalBrokerSessionSnapshot['nativeDisplayBinding'];
  localProfile?: LocalTerminalProfile;
  /** Actual local Windows kernel build, absent for SSH and non-Windows PTYs. */
  windowsBuildNumber?: number;
}

export interface SessionCreateRequest {
  nativeInputProtocol?: 'shellspan.native-input';
  initialDirectory?: string;
  operationId?: string;
  /** Frontend-only audit identity; older backends safely ignore this field. */
  profileId?: string;
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
  /** Ephemeral predecessor transport used for broker generation rollover. */
  replacesSessionId?: string;
}

export type TerminalBrokerTransportKind = 'localPty' | 'windowsConPty' | 'sshPty';
export type TerminalBrokerIntegrationState =
  | 'initializing'
  | 'ready'
  | 'degraded'
  | 'unavailable'
  | 'invalidated';
export type TerminalBrokerSubscriberStatus = 'active' | 'truncated' | 'gap' | 'closed';

export interface TerminalBrokerSubscriberSnapshot {
  status: TerminalBrokerSubscriberStatus;
  throughOutputSequence: number;
  observedFrames: number;
  observedBytes: number;
}

/** Read-only cooperative evidence. Unknown never proves that input was not submitted. */
export interface TerminalCommandObservation {
  submissionIntentDurable: boolean;
  draftCleared: boolean;
  phase: TerminalCommandPhase;
  mayHaveSubmitted: boolean;
  fullInputConfirmed: boolean;
  leaseGeneration: number;
  sourceRevision: number;
  displaySource?: string;
  safeActions: readonly ('query' | 'requestStop')[];
  agentSessionId: string;
  taskId: string;
  operationId: string;
  commandId: string;
  legacyState: 'submitted' | 'running' | 'cancelRequested' | 'completed' | 'cancelled'
    | 'timedOut' | 'takenOver' | 'uncertain' | 'failed';
  /** Legacy state revision; other observation fields can change at the same revision. */
  legacyRevision: number;
  sourceMayBeEnqueued: boolean;
  executionEvidence: 'unknown' | 'startObserved' | 'endObserved';
  noAutoReplay: true;
}

/** Gate facts only; these flags and command evidence never authorize input. */
export interface TerminalInputObservation {
  snapshotSequence: number;
  commandInputPending: boolean;
  nativeRecoveryRequired: boolean;
  nativeClearPending: boolean;
  commandObservationUnavailable: boolean;
  foregroundHandoffActive?: boolean;
  activeCommand?: TerminalCommandObservation;
}

export type TerminalCommandPhase = 'awaitingReady' | 'preparing' | 'typing' | 'inputConfirmed'
  | 'submissionAttempted' | 'running' | 'completed' | 'cancelRequested' | 'cancelled'
  | 'failed' | 'uncertain' | 'recoveryRequired';

export interface TerminalSubmissionIntent {
  version: 1;
  identity: {
    terminalSessionId: string;
    terminalGeneration: number;
    leaseId: string;
    leaseGeneration: number;
    agentSessionId: string;
    taskId: string;
    operationId: string;
    commandId: string;
    sourceRevision: number;
  };
  noAutoReplay: true;
}

export interface TerminalBrokerSessionSnapshot {
  inputMode?: 'native-inline' | 'raw';
  /** Accepted private-channel facts only; never an execution permission. */
  nativePeerProfile?: {
    shell: 'bash' | 'zsh' | 'windowsPowerShell' | 'powerShell7';
    shellVersion?: string;
    editor: 'readline' | 'zle' | 'psReadLine';
    editorVersion?: string;
    editorNumericVersion: number;
    adapterVersion: string;
    verifiedProfileId?: string;
  };
  nativeDisplayBinding?: {
    protocol: 'shellspan.native-input';
    inputMode: 'native-inline';
    oscIdentifier: 1337;
    enterPayload: 'SetUserVar=ShellSpanNativeInput=MQ==';
    exitPayload: 'SetUserVar=ShellSpanNativeInput=MA==';
    /** Backend-verified editor presentation only; never execution authority. */
    unicodeVersion?: '11' | '15-graphemes';
    unicodeScope?: 'session';
    /** Verified editor owns redraw/resize; absent preserves the Bash default. */
    ownedReflowCursorLine?: boolean;
  };
  terminalSessionId: string;
  terminalGeneration: number;
  transportSessionId: string;
  transportKind: TerminalBrokerTransportKind;
  agentPtyOwner?: {
    agentSessionId: string;
    targetId: string;
    sourceTransportSessionId: string;
  };
  geometry: { rows: number; columns: number };
  nextOutputSequence: number;
  nextByteOffset: number;
  integrationState: TerminalBrokerIntegrationState;
  integrationId?: string;
  integrationShell?: 'bash' | 'zsh' | 'windowsPowerShell' | 'powerShell7' | 'unsupported';
  integrationReason?: string;
  integrationEventSequence: number;
  integrationStateRevision: number;
  integrationCapabilities: readonly (
    | 'promptLifecycle'
    | 'commandLifecycle'
    | 'exactCommandLine'
    | 'exitStatus'
    | 'currentDirectory'
    | 'nativeScriptInput'
    | 'nativeJobControl'
  )[];
  promptReady: boolean;
  /** Integration revision of the last confirmed shell prompt or empty native editor. */
  promptReadyRevision?: number;
  currentDirectory?: string;
  activeCommandId?: string;
  /** Absent on older backends; absence and unavailable observations mean unknown. */
  inputObservation?: TerminalInputObservation;
  screenVersion: number;
  lease?: {
    leaseId: string;
    revision: number;
    owner:
      | { kind: 'user'; ownerId: string }
      | {
          kind: 'agent' | 'revoking';
          ownerId: string;
          agentSessionId: string;
          taskId: string;
          operationId: string;
        };
  };
  nextInputSequence: number;
  outputListenerReady: boolean;
  outputPaused: boolean;
  open: boolean;
  closeReason?: 'userClosed' | 'remoteExit' | 'transportDisconnected' | 'replaced' | 'brokerShutdown';
  replayFirstSequence?: number;
  replayFrameCount: number;
  replayByteCount: number;
  captureByteCount: number;
  captureTruncated: boolean;
  subscribers: {
    display: TerminalBrokerSubscriberSnapshot;
    capture: TerminalBrokerSubscriberSnapshot;
    integration: TerminalBrokerSubscriberSnapshot;
    screen: TerminalBrokerSubscriberSnapshot;
  };
}

export interface TerminalBrokerSnapshot {
  rollout: {
    name: 'terminal_broker';
    enabled: boolean;
    defaultEnabled: boolean;
    source: 'default' | 'environment';
    persisted: false;
    mode: 'cooperative';
    rollback: 'disableDependentFlagsThenCloseBrokerGenerations';
  };
  shellIntegrationRollout: TerminalFeatureRolloutDecision & {
    name: 'terminal_shell_integration';
    defaultEnabled: boolean;
  };
  terminalExecuteRollout: TerminalFeatureRolloutDecision & {
    name: 'terminal_execute';
    defaultEnabled: boolean;
  };
  remoteBoundTerminalRollout: TerminalFeatureRolloutDecision & {
    name: 'terminal_remote_bound_terminal';
    defaultEnabled: boolean;
  };
  interactiveToolsRollout: TerminalFeatureRolloutDecision & {
    name: 'terminal_interactive_tools';
    defaultEnabled: boolean;
  };
  remoteInteractiveToolsRollout: TerminalFeatureRolloutDecision & {
    name: 'terminal_remote_interactive_tools';
    defaultEnabled: false;
  };
  counters: {
    integrationReady: number;
    lifecycleMatched: number;
    uncertainty: number;
    timeout: number;
    takeover: number;
    truncation: number;
    backpressure: number;
    transportLatencySamples: number;
    transportLatencyTotalMicros: number;
    transportLatencyMaxMicros: number;
  };
  session?: TerminalBrokerSessionSnapshot;
}

interface TerminalFeatureRolloutDecision {
  enabled: boolean;
  requested: boolean;
  prerequisiteSatisfied: boolean;
  source: 'default' | 'environment';
  persisted: false;
  rollback: string;
}

export interface TerminalIntegrationStateEvent {
  /** Complete read-only command projection; independent of integration-state revision. */
  inputObservation?: TerminalInputObservation;
  sessionId: string;
  terminalSessionId: string;
  terminalGeneration: number;
  integrationStateRevision: number;
  state: TerminalBrokerIntegrationState;
  promptReady: boolean;
  promptReadyRevision?: number;
  currentDirectory?: string;
  shell?: TerminalBrokerSessionSnapshot['integrationShell'];
  reason?: string;
}

export interface TerminalCommandLifecycleEvent {
  sessionId: string;
  terminalSessionId: string;
  terminalGeneration: number;
  commandId: number;
  phase: 'running' | 'completed';
  startedAt: number;
  durationMs?: number;
  exitCode?: number;
  cwd: string;
}

export interface RemoteConnectionRequest {
  /** Frontend-only audit identity; the backend authenticates from the explicit host fields. */
  profileId?: string;
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

export interface PortForwardStartRequest {
  operationId: string;
  profileId: string;
  mode: PortForwardStartMode;
  connection: RemoteConnectionRequest;
  forward: Omit<PortForwardRule, 'autoStart'>;
}

export type ConnectionPreflightStepId =
  | 'dns'
  | 'tcp'
  | 'jumpHostKey'
  | 'jumpAuthentication'
  | 'jumpTunnel'
  | 'hostKey'
  | 'authentication';

export type ConnectionPreflightStepStatus = 'passed' | 'warning' | 'failed' | 'blocked';

export interface ConnectionPreflightStep {
  id: ConnectionPreflightStepId;
  status: ConnectionPreflightStepStatus;
  detail: string;
  host?: string;
  port?: number;
  fingerprint?: string;
  trustable: boolean;
}

export interface ConnectionPreflightResult {
  operationId: string;
  status: 'passed' | 'attention' | 'failed' | 'cancelled';
  checkedAt: number;
  steps: ConnectionPreflightStep[];
}

export interface ConnectionPreflightRequest extends RemoteConnectionRequest {
  operationId: string;
}

export type SandboxMode = 'readOnly' | 'workspaceWrite';

export interface SandboxPolicy {
  mode: SandboxMode;
  workspace: string;
}

export interface ProfileSandbox {
  binding: string;
  policy: SandboxPolicy | null;
}

export type SandboxStep = 'executorProtocol' | 'linux' | 'bubblewrap' | 'sandboxStart'
  | 'workspaceRead' | 'workspaceWrite' | 'outsideWorkspace' | 'processIsolation'
  | 'networkIsolation' | 'sandboxSftp';

export interface SandboxTestResult {
  ssh: ConnectionPreflightResult;
  steps: [SandboxStep, ConnectionPreflightStepStatus][];
  protocolVersion: number | null;
  passed: boolean;
  cancelled: boolean;
  packageMissing: boolean;
  installCommand: string | null;
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

export interface LogCursor {
  identity: string;
  offset: number;
  anchor: number[];
  size: number;
  modifiedAt: string | null;
}

export interface LogChunk {
  content: string;
  cursor: LogCursor;
  reset: boolean;
  size: number;
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
    fingerprint?: string;
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
    fingerprint?: string;
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
    fingerprint?: string;
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
  requestKey: string;
  requestId: number;
}

export interface RemoteEntryOwnersRequest extends RemoteConnectionRequest {
  requestKey: string;
  requestId: number;
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
  operationId: string;
  applicationId?: string;
}

export interface FileOpenApplication {
  id: string;
  name: string;
  icon?: string;
}

export interface SaveFileDestination {
  path: string;
  replaceExisting: boolean;
}

export interface ReadRemoteFileRequest extends RemoteConnectionRequest {
  path: string;
  operationId: string;
}

export interface ReadRemoteFileResponse {
  path: string;
  name: string;
  content: string;
  size: number;
  isText: boolean;
  contentEncoding: 'utf8' | 'base64' | 'none';
  truncated: boolean;
}

export interface UpdateRemotePermissionsRequest
  extends RemoteConnectionRequest {
  path: string;
  permissions: number;
}

export interface DownloadRemotePathsRequest extends RemoteConnectionRequest {
  remotePaths: string[];
  destinationDirectory: string;
  saveDestination?: SaveFileDestination;
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
  organizationJson?: string; // JSON serialized non-secret organization metadata
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

// --- Explicitly authorized, one-shot remote host health snapshots ---

export type RemoteHealthResultStatus =
  | 'success'
  | 'unauthorized'
  | 'cancelled'
  | 'timedOut'
  | 'unsupported'
  | 'failed';

export interface RemoteHealthSource {
  kind: 'sshReadOnly';
  commandSetVersion: string;
  profileId: string;
  host: string;
  port: number;
  username: string;
}

export interface RemoteSystemInfo {
  osFamily: 'linux' | 'macos';
  osVersion?: string;
  hostname: string;
  kernelVersion: string;
  architecture: string;
  cpuCount: number;
  uptimeSecs: number;
}

export interface RemoteHealthSnapshot {
  system: RemoteSystemInfo;
  cpu: {
    usagePercent: number;
  };
  memory: {
    totalBytes: number;
    usedBytes: number;
    availableBytes: number;
    usagePercent: number;
  };
  disk: {
    totalBytes: number;
    usedBytes: number;
    availableBytes: number;
    usagePercent: number;
    mountPoint: string;
  };
  load: {
    oneMinute: number;
    fiveMinutes: number;
    fifteenMinutes: number;
  };
}

export interface RemoteHealthSnapshotRequest {
  operationId: string;
  profileId: string;
  authorized: boolean;
  timeoutMs: number;
  connection: RemoteConnectionRequest;
}

export interface RemoteHealthSnapshotResult {
  operationId: string;
  profileId: string;
  status: RemoteHealthResultStatus;
  checkedAt: number;
  source: RemoteHealthSource;
  snapshot?: RemoteHealthSnapshot;
  error?: string;
}
