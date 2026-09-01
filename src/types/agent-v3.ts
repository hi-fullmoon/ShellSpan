/** Agent Contract v3 types. The M3 runtime remains independently rolled out from v2. */

export const AGENT_V3_TOOL_NAMES = [
  'exec_command',
  'write_stdin',
  'wait_process',
  'kill_process',
  'read_file',
  'list_directory',
  'search_text',
  'apply_patch',
  'transfer_file',
  'host_snapshot',
  'ask_user',
  'update_plan',
] as const;

export type AgentToolNameV3 = (typeof AGENT_V3_TOOL_NAMES)[number];

export const AGENT_V3_TARGET_KINDS = ['local', 'remote', 'process', 'ui', 'task'] as const;
export type AgentTargetKindV3 = (typeof AGENT_V3_TARGET_KINDS)[number];

export const AGENT_V3_EFFECT_KINDS = [
  'none',
  'readOnly',
  'sensitiveRead',
  'stateChange',
  'destructive',
  'externalSideEffect',
] as const;
export type AgentEffectKindV3 = (typeof AGENT_V3_EFFECT_KINDS)[number];

export interface AgentLocalTargetV3 {
  readonly kind: 'local';
  readonly targetId: string;
  readonly sessionId: string;
  readonly cwd?: string;
}

export interface AgentRemoteTargetV3 {
  readonly kind: 'remote';
  readonly targetId: string;
  readonly sessionId: string;
  readonly profileId?: string;
  readonly host: string;
  readonly port: number;
  readonly username: string;
  /** Canonical remote filesystem scope for M2 native file tools. */
  readonly rootPath?: string;
  /** Canonical local filesystem scope used by native SFTP transfers. */
  readonly localRoot?: string;
}

export interface AgentProcessTargetV3 {
  readonly kind: 'process';
  readonly targetId: string;
  readonly ownerTargetId: string;
  readonly processHandle: string;
}

export interface AgentUiTargetV3 {
  readonly kind: 'ui';
  readonly targetId: string;
  readonly surfaceId: string;
}

export interface AgentTaskTargetV3 {
  readonly kind: 'task';
  readonly targetId: string;
  readonly taskId: string;
}

export type AgentToolTargetV3 =
  | AgentLocalTargetV3
  | AgentRemoteTargetV3
  | AgentProcessTargetV3
  | AgentUiTargetV3
  | AgentTaskTargetV3;

export interface AgentRequestV3 {
  readonly contractVersion: 3;
  readonly requestId: string;
  readonly userSessionId: string;
  readonly taskId: string;
  readonly goal: string;
  readonly successCriteria: readonly string[];
  readonly targets: readonly AgentToolTargetV3[];
  readonly permissionMode: 'requestApproval' | 'scopedAutopilot' | 'operator';
  readonly sourceContract: 'v3' | 'v2Compatibility';
}

export interface AgentVerifiedCapabilityClaimsV3 {
  readonly capabilityId: string;
  readonly requestId: string;
  readonly userSessionId: string;
  readonly allowedTools: readonly AgentToolNameV3[];
  readonly allowedEffects: readonly AgentEffectKindV3[];
  readonly targetIds: readonly string[];
  readonly notBeforeUnixMs: number;
  readonly expiresAtUnixMs: number;
  readonly revoked: boolean;
}

/** Fixture/contract shape only. Verified claims are never accepted by an IPC command. */
export type AgentVerifiedCapabilityFixtureV3 = AgentVerifiedCapabilityClaimsV3;

export interface ExecCommandArgumentsV3 {
  readonly command: string;
  readonly explanation: string;
  readonly channel: 'pty' | 'direct';
  readonly cwd?: string;
  readonly timeoutMs?: number;
  readonly background?: boolean;
  readonly elevated?: boolean;
}

export interface WriteStdinArgumentsV3 {
  readonly input: string;
  readonly close?: boolean;
}

export interface WaitProcessArgumentsV3 {
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
}

export interface KillProcessArgumentsV3 {
  readonly signal: 'interrupt' | 'terminate' | 'kill';
  readonly timeoutMs?: number;
}

export interface ReadFileArgumentsV3 {
  readonly path: string;
  readonly encoding: 'utf8' | 'base64' | 'metadataOnly';
  readonly offset?: number;
  readonly maxBytes?: number;
  readonly expectedSha256?: string;
}

export interface ListDirectoryArgumentsV3 {
  readonly path: string;
  readonly cursor?: string;
  readonly pageSize?: number;
  readonly includeHidden?: boolean;
}

export interface SearchTextArgumentsV3 {
  readonly path: string;
  readonly query: string;
  readonly mode: 'content' | 'fileName' | 'both';
  readonly caseSensitive?: boolean;
  readonly globs?: readonly string[];
  readonly maxResults?: number;
  readonly cursor?: string;
}

export interface ApplyPatchArgumentsV3 {
  readonly patch: string;
  readonly preconditions: readonly Readonly<{ path: string; sha256: string }>[];
  readonly dryRun?: boolean;
}

export interface TransferFileArgumentsV3 {
  readonly direction: 'upload' | 'download';
  readonly sourcePath: string;
  readonly destinationPath: string;
  readonly overwrite: boolean;
  readonly expectedSha256?: string;
  readonly destinationSha256?: string;
  readonly maxBytes?: number;
}

export interface HostSnapshotArgumentsV3 {
  readonly sections: readonly ('os' | 'resources' | 'services' | 'network')[];
  readonly includeSensitive?: boolean;
}

export interface AskUserArgumentsV3 {
  readonly prompt: string;
  readonly choices?: readonly Readonly<{ id: string; label: string; description?: string }>[];
  readonly allowFreeText: boolean;
  readonly timeoutMs?: number;
}

export interface UpdatePlanArgumentsV3 {
  readonly planVersion: number;
  readonly explanation?: string;
  readonly steps: readonly Readonly<{
    id: string;
    description: string;
    dependencies: readonly string[];
    targetIds: readonly string[];
    requiredTools: readonly AgentToolNameV3[];
    expectedEffect: AgentEffectKindV3;
    status: 'pending' | 'inProgress' | 'completed' | 'blocked';
    successCriteria: readonly string[];
    rollbackOrCompensation: string;
    evidenceRefs?: readonly string[];
  }>[];
}

export type AgentPlanStepV3 = UpdatePlanArgumentsV3['steps'][number];

export interface AgentPlanV3 {
  readonly version: number;
  readonly explanation?: string;
  readonly steps: readonly AgentPlanStepV3[];
  readonly updatedAtUnixMs: number;
}

export interface AgentFileCheckpointV3 {
  readonly checkpointId: string;
  readonly taskId: string;
  readonly targetId: string;
  readonly targetKind: 'local' | 'remote';
  readonly targetPath: string;
  readonly originalSha256?: string;
  readonly originalByteLength: number;
  readonly createdAtUnixMs: number;
  readonly expiresAtUnixMs: number;
  readonly restoredAtUnixMs?: number;
}

export interface AgentToolArgumentsMapV3 {
  readonly exec_command: ExecCommandArgumentsV3;
  readonly write_stdin: WriteStdinArgumentsV3;
  readonly wait_process: WaitProcessArgumentsV3;
  readonly kill_process: KillProcessArgumentsV3;
  readonly read_file: ReadFileArgumentsV3;
  readonly list_directory: ListDirectoryArgumentsV3;
  readonly search_text: SearchTextArgumentsV3;
  readonly apply_patch: ApplyPatchArgumentsV3;
  readonly transfer_file: TransferFileArgumentsV3;
  readonly host_snapshot: HostSnapshotArgumentsV3;
  readonly ask_user: AskUserArgumentsV3;
  readonly update_plan: UpdatePlanArgumentsV3;
}

export interface AgentToolTargetMapV3 {
  readonly exec_command: AgentLocalTargetV3 | AgentRemoteTargetV3;
  readonly write_stdin: AgentProcessTargetV3;
  readonly wait_process: AgentProcessTargetV3;
  readonly kill_process: AgentProcessTargetV3;
  readonly read_file: AgentLocalTargetV3 | AgentRemoteTargetV3;
  readonly list_directory: AgentLocalTargetV3 | AgentRemoteTargetV3;
  readonly search_text: AgentLocalTargetV3 | AgentRemoteTargetV3;
  readonly apply_patch: AgentLocalTargetV3 | AgentRemoteTargetV3;
  readonly transfer_file: AgentLocalTargetV3 | AgentRemoteTargetV3;
  readonly host_snapshot: AgentLocalTargetV3 | AgentRemoteTargetV3;
  readonly ask_user: AgentUiTargetV3;
  readonly update_plan: AgentTaskTargetV3;
}

export type AgentToolCallV3 = {
  readonly [Tool in AgentToolNameV3]: Readonly<{
    requestId: string;
    callId: string;
    toolName: Tool;
    arguments: AgentToolArgumentsMapV3[Tool];
    target: AgentToolTargetMapV3[Tool];
    capabilityId: string;
  }>;
}[AgentToolNameV3];

export const AGENT_V3_RESULT_STATUSES = [
  'completed',
  'rejected',
  'failed',
  'timedOut',
  'cancelled',
] as const;
export type AgentToolResultStatusV3 = (typeof AGENT_V3_RESULT_STATUSES)[number];

export interface AgentObservedEffectV3 {
  readonly kind: AgentEffectKindV3;
  readonly targetId: string;
  readonly summary: string;
  readonly paths?: readonly string[];
  readonly networkDestinations?: readonly AgentNetworkDestinationV3[];
}

export interface AgentNetworkDestinationV3 {
  readonly protocol: string;
  readonly host: string;
  readonly port: number;
}

export interface AgentArtifactRefV3 {
  readonly artifactId: string;
  readonly kind: 'text' | 'binary' | 'diff' | 'log' | 'report';
  readonly mediaType: string;
  readonly byteLength: number;
  readonly sha256: string;
}

/** Tool-specific result data is validated by the JSON Schema before use. */
export interface AgentToolResultV3 {
  readonly requestId: string;
  readonly callId: string;
  readonly toolName: AgentToolNameV3;
  readonly targetId: string;
  readonly status: AgentToolResultStatusV3;
  readonly summary: string;
  readonly data?: Readonly<Record<string, unknown>>;
  readonly artifacts?: readonly AgentArtifactRefV3[];
  readonly effects?: readonly AgentObservedEffectV3[];
  readonly truncated?: boolean;
}

export interface AgentV3RolloutPolicy {
  readonly stage: 'disabled' | 'contractOnly' | 'runtime';
  readonly contractAvailable: boolean;
  readonly executionContractVersion: 2 | 3;
  readonly rollbackContractVersion: 2;
}

export interface AgentRegisteredToolV3 {
  readonly name: AgentToolNameV3;
  readonly version: string;
  readonly targetKinds: readonly AgentTargetKindV3[];
  readonly effectMode: 'fixed' | 'nativeClassifier';
  readonly allowedEffects: readonly AgentEffectKindV3[];
  readonly idempotency: 'yes' | 'no' | 'conditional';
  readonly cancellable: boolean;
  readonly retryPolicy: 'never' | 'idempotentOnly' | 'reconcileFirst';
  readonly defaultTimeoutMs: number;
  readonly maxOutputBytes: number;
  readonly maxConcurrency: number;
  readonly requiredCapabilities: readonly string[];
  readonly untrustedResultFields: readonly string[];
  readonly implementationState: 'implemented' | 'knownUnavailable';
}

export interface AgentProcessSnapshotV3 {
  readonly processHandle: string;
  readonly targetId: string;
  readonly ownerTargetId: string;
  readonly taskId: string;
  readonly requestId: string;
  readonly channel: 'direct' | 'pty';
  readonly state: 'running' | 'exited' | 'cancelled' | 'timedOut' | 'failed';
  readonly exitCode?: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutBytesRead: number;
  readonly stderrBytesRead: number;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly terminationConfirmed: boolean;
  readonly startedAtUnixMs: number;
  readonly completedAtUnixMs?: number;
  readonly error?: string;
}

export interface AgentTaskSnapshotV3 {
  readonly request: AgentRequestV3;
  readonly state: 'active' | 'needsReconciliation' | 'lost' | 'completed' | 'cancelled';
  readonly sequence: number;
  readonly results: readonly AgentToolResultV3[];
  readonly processes: readonly AgentProcessSnapshotV3[];
  readonly plan?: AgentPlanV3;
  readonly checkpoints: readonly AgentFileCheckpointV3[];
  readonly context: AgentContextSnapshotV3;
  readonly extensions: AgentExtensionSnapshotV3;
  readonly mcpServers: readonly AgentMcpServerSnapshotV3[];
  readonly mcpResults: readonly AgentMcpResultV3[];
  readonly recovery: AgentTaskRecoverySnapshotV3;
  readonly notifications: readonly AgentNotificationV3[];
  readonly createdAtUnixMs: number;
  readonly updatedAtUnixMs: number;
}

export type AgentRecoveryDispositionV3 =
  | 'safeToResume'
  | 'needsReconciliation'
  | 'lost'
  | 'cancelled'
  | 'completed';

export type AgentTaskPhaseV3 =
  | 'planning'
  | 'running'
  | 'waitingApproval'
  | 'waitingExternal'
  | 'verifying'
  | 'reconciliation'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'lost';

export interface AgentRecoveryCallV3 {
  readonly callId: string;
  readonly toolName: string;
  readonly targetId: string;
  readonly effect: AgentEffectKindV3;
  readonly state: 'started' | 'completed' | 'failed' | 'cancelled';
  readonly startedAtUnixMs: number;
  readonly updatedAtUnixMs: number;
  readonly automaticReplayAllowed: false;
}

export interface AgentRecoveredProcessV3 {
  readonly processHandle: string;
  readonly targetId: string;
  readonly ownerTargetId: string;
  readonly channel: string;
  readonly state: string;
  readonly startedAtUnixMs: number;
  readonly updatedAtUnixMs: number;
  readonly recoveryAdvice: string;
}

export interface AgentTaskRecoverySnapshotV3 {
  readonly disposition: AgentRecoveryDispositionV3;
  readonly phase: AgentTaskPhaseV3;
  readonly progressCompleted: number;
  readonly progressTotal: number;
  readonly calls: readonly AgentRecoveryCallV3[];
  readonly processes: readonly AgentRecoveredProcessV3[];
  readonly recoveryAdvice: string;
  readonly requiresHumanAction: boolean;
  readonly requiresSessionRebind: boolean;
  readonly lastFailure?: string;
  readonly lastEffect?: AgentObservedEffectV3;
}

export interface AgentNotificationV3 {
  readonly notificationId: string;
  readonly taskId?: string;
  readonly kind: 'completed' | 'failed' | 'humanActionRequired' | 'operatorExpiring';
  readonly title: string;
  readonly body: string;
  readonly createdAtUnixMs: number;
  readonly delivered: boolean;
}

export interface AgentRecoveryStoreStatusV3 {
  readonly formatVersion: 1;
  readonly loaded: boolean;
  readonly migrated: boolean;
  readonly taskCount: number;
  readonly corruptionRecovered: boolean;
  readonly warning?: string;
}

export interface AgentAuditEventV3 {
  readonly eventId: string;
  readonly action: string;
  readonly taskId?: string;
  readonly targetId?: string;
  readonly toolName?: string;
  readonly effect?: AgentEffectKindV3;
  readonly networkDestinations: readonly AgentNetworkDestinationV3[];
  readonly sensitivePathCount: number;
  readonly grantId?: string;
  readonly purpose?: string;
  readonly expiresAtUnixMs?: number;
  readonly scopeTargetIds?: readonly string[];
  readonly scopeToolNames?: readonly string[];
  readonly scopeEffects?: readonly AgentEffectKindV3[];
  readonly scopePathCount?: number;
  readonly decision: string;
  readonly recordedAtUnixMs: number;
}

export interface AgentOperatorPolicyV3 {
  readonly stage: 'disabled' | 'enabled';
  readonly defaultEnabled: false;
  readonly maximumTtlMs: number;
  readonly grantsSurviveRestart: false;
}

export interface AgentOperatorConfigureRequestV3 {
  readonly taskId: string;
  readonly targetIds: readonly string[];
  readonly toolNames: readonly AgentToolNameV3[];
  readonly effects: readonly AgentEffectKindV3[];
  readonly pathPrefixes?: readonly string[];
  readonly networkDestinations?: readonly AgentNetworkDestinationV3[];
  readonly allowElevation?: boolean;
  readonly ttlMs: number;
}

export interface AgentOperatorGrantV3 {
  readonly grantId: string;
  readonly taskId: string;
  readonly targetIds: readonly string[];
  readonly toolNames: readonly string[];
  readonly effects: readonly AgentEffectKindV3[];
  readonly pathPrefixes: readonly string[];
  readonly networkDestinations: readonly AgentNetworkDestinationV3[];
  readonly allowElevation: boolean;
  readonly issuedAtUnixMs: number;
  readonly expiresAtUnixMs: number;
  readonly revokedAtUnixMs?: number;
  readonly lastUsedAtUnixMs?: number;
}

export interface AgentBrokerAuthorizeRequestV3 {
  readonly taskId: string;
  readonly requestId: string;
  readonly callId: string;
  readonly targetId: string;
  readonly toolName: string;
  readonly kind: 'credential' | 'elevation';
  readonly purpose: 'remoteAuthentication' | 'mcpAuthentication' | 'elevation';
  readonly credentialService?: string;
  readonly credentialId?: string;
  readonly ttlMs: number;
}

export interface AgentBrokerGrantV3 {
  readonly grantId: string;
  readonly taskId: string;
  readonly requestId: string;
  readonly callId: string;
  readonly targetId: string;
  readonly toolName: string;
  readonly kind: 'credential' | 'elevation';
  readonly purpose: 'remoteAuthentication' | 'mcpAuthentication' | 'elevation';
  readonly expiresAtUnixMs: number;
  readonly consumedAtUnixMs?: number;
  readonly revokedAtUnixMs?: number;
  readonly credentialReferencePresent: boolean;
}

export interface AgentAuthorizeCallRequestV3 {
  readonly taskId: string;
  readonly requestId: string;
  readonly callId: string;
  readonly toolName: AgentToolNameV3;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly target: AgentToolTargetV3;
  readonly ttlMs?: number;
}

export interface AgentCapabilityGrantV3 {
  readonly capabilityId: string;
  readonly expiresAtUnixMs: number;
  readonly assessedEffect: AgentObservedEffectV3;
  readonly effectiveArguments: Readonly<Record<string, unknown>>;
  readonly hookDecisions: readonly AgentHookDecisionV3[];
}

export interface AgentCallPreviewV3 {
  readonly toolName: AgentToolNameV3;
  readonly targetId: string;
  readonly summary: string;
  readonly path?: string;
  readonly diff?: string;
}

export type AgentContextLayerV3 = 'workspace' | 'host' | 'session' | 'task';
export type AgentContextSourceKindV3 =
  | 'nativeIdentity'
  | 'userRequest'
  | 'projectInstruction'
  | 'plan'
  | 'toolEvidence'
  | 'compaction';
export type AgentContextTrustV3 = 'native' | 'userProvided' | 'projectScoped' | 'untrustedData';
export type AgentContextSensitivityV3 = 'public' | 'internal' | 'sensitive' | 'secretReference';

export interface AgentContextFragmentV3 {
  readonly fragmentId: string;
  readonly layer: AgentContextLayerV3;
  readonly sourceKind: AgentContextSourceKindV3;
  readonly source: string;
  readonly scope: Readonly<{
    workspaceRoot?: string;
    targetId?: string;
    sessionId?: string;
    taskId: string;
  }>;
  readonly priority: number;
  readonly overrides: readonly string[];
  readonly trust: AgentContextTrustV3;
  readonly sensitivity: AgentContextSensitivityV3;
  readonly instructionEligible: boolean;
  readonly untrusted: boolean;
  readonly byteLength: number;
  readonly estimatedTokens: number;
  readonly preview: string;
  readonly omissionReason?: 'symlinkRejected' | 'sizeLimit' | string;
}

export interface AgentContextArtifactV3 {
  readonly artifactId: string;
  readonly kind: 'structuredCompaction' | 'symbolMap' | 'directoryMap';
  readonly mediaType: string;
  readonly byteLength: number;
  readonly sha256: string;
  readonly createdAtUnixMs: number;
}

export interface AgentContextSnapshotV3 {
  readonly generation: number;
  readonly fragments: readonly AgentContextFragmentV3[];
  readonly artifacts: readonly AgentContextArtifactV3[];
  readonly usage: Readonly<{
    sourceBytes: number;
    modelVisibleBytes: number;
    estimatedInputTokens: number;
    estimatedCostUsd?: number;
    costReason: string;
  }>;
  readonly compactedAtUnixMs?: number;
  readonly compactionReason?: 'manual' | 'budgetPressure' | 'beforeExtension' | string;
}

export interface AgentContextRetrievalRequestV3 {
  readonly taskId: string;
  readonly artifactId: string;
  readonly query?: string;
  readonly maxBytes?: number;
}

export interface AgentContextRetrievalV3 {
  readonly artifactId: string;
  readonly content: string;
  readonly byteLength: number;
  readonly truncated: boolean;
  readonly untrusted: true;
}

export interface AgentSkillCatalogEntryV3 {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly requiredTools: readonly AgentToolNameV3[];
  readonly targets: readonly AgentTargetKindV3[];
  readonly permissions: readonly AgentEffectKindV3[];
  readonly loaded: boolean;
}

export interface AgentLoadedSkillV3 extends AgentSkillCatalogEntryV3 {
  readonly content: string;
  readonly instructionEligible: true;
  readonly grantsPermissions: false;
}

export type AgentHookEventV3 =
  | 'sessionStart'
  | 'sessionEnd'
  | 'userPromptSubmitted'
  | 'beforeTool'
  | 'afterTool'
  | 'toolFailed'
  | 'permissionRequested'
  | 'beforeCompact'
  | 'taskCompleted'
  | 'taskFailed';

export interface AgentHookDecisionV3 {
  readonly hookId: string;
  readonly action: 'allow' | 'deny' | 'modify' | string;
  readonly summary: string;
}

export interface AgentRunbookParameterV3 {
  readonly name: string;
  readonly required: boolean;
  readonly default?: string;
}

export interface AgentRunbookCatalogEntryV3 {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly version: 1;
  readonly parameters: readonly AgentRunbookParameterV3[];
  readonly stepCount: number;
}

export interface AgentExtensionSnapshotV3 {
  readonly generation: number;
  readonly workspaceLoaded: boolean;
  readonly skills: readonly AgentSkillCatalogEntryV3[];
  readonly hooks: readonly string[];
  readonly runbooks: readonly AgentRunbookCatalogEntryV3[];
  readonly recentHookEvents: readonly Readonly<{
    event: AgentHookEventV3;
    taskId: string;
    toolName?: string;
    callId?: string;
    outcome: string;
    recordedAtUnixMs: number;
  }>[];
}

export type AgentMcpToolPolicyV3 = 'disabled' | 'readOnly' | 'externalWrite';
export type AgentMcpServerHealthV3 = 'disabled' | 'configured' | 'connecting' | 'healthy' | 'failed';

export interface AgentMcpServerSnapshotV3 {
  readonly id: string;
  readonly transport: 'stdio';
  readonly enabled: boolean;
  readonly health: AgentMcpServerHealthV3;
  readonly usesNativeCredentials: boolean;
  readonly tools: readonly Readonly<{
    name: string;
    description: string;
    policy: AgentMcpToolPolicyV3;
    schemaLoaded: boolean;
    untrusted: true;
  }>[];
  readonly lastError?: string;
  readonly failureCount: number;
  readonly refreshedAtUnixMs?: number;
}

export interface AgentMcpCallV3 {
  readonly requestId: string;
  readonly callId: string;
  readonly serverId: string;
  readonly toolName: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly targetId: string;
  readonly capabilityId: string;
}

export interface AgentMcpAuthorizeRequestV3 extends Omit<AgentMcpCallV3, 'capabilityId'> {
  readonly taskId: string;
  readonly ttlMs?: number;
}

export interface AgentMcpCapabilityGrantV3 {
  readonly capabilityId: string;
  readonly expiresAtUnixMs: number;
  readonly assessedEffect: 'sensitiveRead' | 'externalSideEffect';
  readonly effectiveArguments: Readonly<Record<string, unknown>>;
  readonly hookDecisions: readonly AgentHookDecisionV3[];
}

export interface AgentMcpResultV3 {
  readonly requestId: string;
  readonly callId: string;
  readonly serverId: string;
  readonly toolName: string;
  readonly targetId: string;
  readonly status: 'completed' | 'failed';
  readonly data: Readonly<Record<string, unknown>>;
  readonly effect: 'sensitiveRead' | 'externalSideEffect';
  readonly untrusted: true;
  readonly truncated: boolean;
}

export interface AgentMcpToolSchemaV3 {
  readonly serverId: string;
  readonly toolName: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly untrusted: true;
}
