export const AGENT_SESSION_EVENT_VERSION = 4 as const;
export type AgentSessionEventVersion = typeof AGENT_SESSION_EVENT_VERSION;

export function isSupportedAgentSessionEventVersion(
  version: number,
): version is AgentSessionEventVersion {
  return version === AGENT_SESSION_EVENT_VERSION;
}

export type AgentSessionRuntimeStatus =
  | 'idle'
  | 'running'
  | 'waiting'
  | 'cancelled'
  | 'completed'
  | 'failed';

export type AgentSessionToolStatus =
  | 'pending'
  | 'awaitingApproval'
  | 'running'
  | 'completed'
  | 'rejected'
  | 'failed'
  | 'timedOut'
  | 'cancelled';

export type AgentSessionEffect =
  | 'none'
  | 'readOnly'
  | 'sensitiveRead'
  | 'stateChange'
  | 'destructive'
  | 'externalSideEffect'
  | 'unknown';

export type AgentSessionPermissionMode = 'requestApproval' | 'scopedAutopilot' | 'operator';

export type AgentSessionInboxLane = 'nextTurn' | 'nextStep';
export type AgentSessionInboxOperation = 'enqueued' | 'claimed' | 'discarded';

export type AgentSessionProvenanceKind =
  | 'user'
  | 'runtime'
  | 'plugin'
  | 'skill-catalog'
  | 'agent-instructions'
  | 'skill-invocation'
  | 'session-reference'
  | 'form';

export interface AgentSessionMessageSource {
  readonly kind: AgentSessionProvenanceKind;
  readonly label: string;
  readonly producerId: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface AgentSessionInboxMessage {
  readonly messageId: string;
  readonly clientSubmissionId?: string;
  readonly content: string;
  readonly source: AgentSessionMessageSource;
}

export interface AgentSessionTarget {
  readonly kind: 'local' | 'remote';
  readonly targetId: string;
  readonly sessionId: string;
  readonly label?: string;
  readonly profileId?: string;
  readonly host?: string;
  readonly port?: number;
  readonly username?: string;
  readonly cwd?: string;
  readonly rootPath?: string;
  readonly localRoot?: string;
}

export interface AgentCapabilityScope {
  readonly toolNames: readonly string[];
  readonly effects: readonly AgentSessionEffect[];
  readonly targetIds: readonly string[];
}

export type AgentSubagentRole = 'general' | 'explorer' | 'diagnostician' | 'operator' | 'verifier' | 'reviewer';

export type AgentSubagentInheritance =
  | Readonly<{ mode: 'blank' }>
  | Readonly<{ mode: 'safePrefix'; parentThroughSeq?: number }>;

export interface AgentSubagentBudget {
  readonly maxStepsPerTurn: number;
  readonly maxTurns: number;
  readonly maxToolCalls: number;
  readonly maxTokens: number;
  readonly timeoutMs: number;
}

export interface AgentSubagentModel {
  readonly providerId: string;
  readonly providerKind: 'ollama' | 'openAi' | 'openAiCompatible';
  readonly baseUrl: string;
  readonly model: string;
  readonly reasoningEffort?: string;
  readonly requiresApiKey: boolean;
}

export interface AgentSubagentSession {
  readonly descriptorId: string;
  readonly parentTaskId: string;
  readonly role: AgentSubagentRole;
  readonly continuable: boolean;
  readonly depth: number;
  readonly inheritance: AgentSubagentInheritance;
  readonly capabilityScope: AgentCapabilityScope;
  readonly targetScope: readonly AgentSessionTarget[];
  readonly budget: AgentSubagentBudget;
  readonly provider: AgentSubagentModel;
}

export interface AgentSessionRecordedToolCall {
  readonly callId: string;
  readonly providerCallId?: string;
  readonly name: string;
  readonly nativeName?: string;
  readonly arguments: unknown;
  readonly title?: string;
  readonly effect?: AgentSessionEffect;
  readonly target?: AgentSessionTarget;
}

export interface AgentSessionTokenUsage {
  /** Provider-reported input tokens that were not read from cache. Missing means unknown. */
  readonly uncachedInputTokens?: number;
  /** Provider-reported input tokens served from cache. Missing means unknown. */
  readonly cacheReadTokens?: number;
  /** Provider-reported input tokens written to cache. Missing means unknown. */
  readonly cacheWriteTokens?: number;
  /** Provider-reported generated output tokens. Missing means unknown. */
  readonly outputTokens?: number;
  /** Provider-reported reasoning tokens. Missing means unknown. */
  readonly reasoningTokens?: number;
  /** Provider-reported total tokens. Missing means unknown. */
  readonly totalTokens?: number;
}

export type AgentSessionStopReason =
  | 'stop'
  | 'toolCalls'
  | 'length'
  | 'contentFilter'
  | 'cancelled'
  | 'error'
  | 'other';

export type AgentSessionRequestReason =
  | 'initial'
  | 'retry'
  | 'toolContinuation'
  | 'recovery';

export interface AgentSessionRequestSeries {
  readonly seriesId: string;
  readonly requestIndex: number;
  readonly startsSeries: boolean;
}

export interface AgentSessionRequestToolSchema {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: unknown;
}

export interface AgentSessionToolCallDelta {
  readonly index: number;
  readonly callId?: string;
  readonly nameDelta?: string;
  readonly argumentsDelta?: string;
}

export type AgentSessionAssistantContentBlock =
  | Readonly<{ type: 'text'; text: string }>
  | Readonly<{ type: 'reasoning'; text: string; providerItem?: unknown }>
  | Readonly<{ type: 'toolCall'; call: AgentSessionRecordedToolCall }>;

export interface AgentSessionPlanStep {
  readonly id: string;
  readonly title: string;
  readonly status: 'pending' | 'inProgress' | 'completed' | 'blocked' | 'failed';
  readonly detail?: string;
  readonly evidenceRefs?: readonly string[];
}

export interface AgentSessionRecoveryState {
  readonly status: 'none' | 'available' | 'required' | 'reconciling' | 'completed';
  readonly summary?: string;
}

export type AgentRecoveryCheckpointKind =
  | 'idle'
  | 'openModelRequest'
  | 'waitingApproval'
  | 'authorizedBeforeExecute'
  | 'executionInFlight'
  | 'toolResultCommitted'
  | 'compactionInFlight'
  | 'artifactIntegrity'
  | 'cancelled'
  | 'terminal';

export interface AgentRecoveryCheckpoint {
  readonly kind: AgentRecoveryCheckpointKind;
  readonly status: AgentSessionRecoveryState['status'];
  readonly summary: string;
  readonly lastCommittedSeq: number;
  readonly turnId?: string;
  readonly stepId?: string;
  readonly requestId?: string;
  readonly callId?: string;
  readonly effect?: AgentSessionEffect;
  readonly idempotency?: 'yes' | 'no' | 'conditional';
}

export interface AgentSessionFleetTargetState {
  readonly targetId: string;
  readonly taskId: string;
  readonly goal: string;
  readonly wave: number;
  readonly state: string;
  readonly childSessionIds?: readonly string[];
  readonly evidenceRefs?: readonly string[];
  readonly recovery?: string;
}

export interface AgentSessionFleetState {
  readonly fleetId?: string;
  readonly status?: string;
  readonly wave: number;
  readonly totalWaves: number;
  readonly targetsCompleted: number;
  readonly targetsTotal: number;
  readonly canarySize?: number;
  readonly waveSize?: number;
  readonly failureThreshold?: number;
  readonly failures?: number;
  readonly targets?: readonly AgentSessionFleetTargetState[];
}

interface AgentSessionEventBase {
  readonly version: AgentSessionEventVersion;
  readonly sessionId: string;
  readonly seq: number;
  readonly timeUnixMs: number;
  readonly turnId?: string;
  readonly stepId?: string;
}

type AgentSessionEventWithData<Type extends string, Data> = AgentSessionEventBase & Readonly<{
  type: Type;
  data: Readonly<Data>;
}>;

type AgentSessionEventWithoutData<Type extends string> = AgentSessionEventBase & Readonly<{
  type: Type;
  data?: never;
}>;

/**
 * Canonical UI wire contract for the append-only Agent Session Event Log.
 * The envelope deliberately matches the Rust serde representation so fixtures,
 * durable replay, and live events all use the same v4 data model.
 */
export type AgentSessionEvent =
  | AgentSessionEventWithData<'session/created', {
      taskId: string;
      goal: string;
      parentSessionId?: string;
      target?: AgentSessionTarget;
      permissionMode?: AgentSessionPermissionMode;
      successCriteria?: readonly string[];
      capabilityScope?: AgentCapabilityScope;
      subagent?: AgentSubagentSession;
    }>
  | AgentSessionEventWithData<'agent/created', {
      agentId: string;
      parentAgentId?: string;
    }>
  | AgentSessionEventWithData<'agent/status', {
      status: AgentSessionRuntimeStatus;
      reason?: string;
    }>
  | AgentSessionEventWithData<'session/ended', {
      status: Extract<AgentSessionRuntimeStatus, 'cancelled' | 'completed' | 'failed'>;
      reason?: string;
    }>
  | AgentSessionEventWithData<'agent/inbox/spliced', {
      operation: AgentSessionInboxOperation;
      lane: AgentSessionInboxLane;
      messages: readonly AgentSessionInboxMessage[];
    }>
  | AgentSessionEventWithData<'agent/inbox/item_updated', {
      itemId: string;
      lane: AgentSessionInboxLane;
      content: string;
      previousRevision: number;
      clientOperationId: string;
    }>
  | AgentSessionEventWithData<'agent/inbox/item_removed', {
      itemId: string;
      lane: AgentSessionInboxLane;
      previousRevision: number;
      clientOperationId: string;
    }>
  | AgentSessionEventWithData<'agent/inbox/reordered', {
      lane: AgentSessionInboxLane;
      orderedItemIds: readonly string[];
      previousRevision: number;
      clientOperationId: string;
    }>
  | AgentSessionEventWithData<'session/renamed', {
      title: string;
      previousRevision: number;
      clientOperationId: string;
    }>
  | AgentSessionEventWithoutData<'turn/start'>
  | AgentSessionEventWithData<'turn/end', { reason: string }>
  | AgentSessionEventWithoutData<'step/start'>
  | AgentSessionEventWithData<'step/end', { reason: string }>
  | AgentSessionEventWithData<'user/message', { message: AgentSessionInboxMessage }>
  | AgentSessionEventWithData<'assistant/chunk', {
      requestId: string;
      textDelta?: string;
      reasoningDelta?: string;
      toolCallDelta?: AgentSessionToolCallDelta;
      usage?: AgentSessionTokenUsage;
    }>
  | AgentSessionEventWithData<'assistant/message', {
      messageId: string;
      content: readonly AgentSessionAssistantContentBlock[];
      usage: AgentSessionTokenUsage;
      stopReason: AgentSessionStopReason;
      interrupted: boolean;
    }>
  | AgentSessionEventWithData<'request/header', {
      requestId: string;
      providerId: string;
      model: string;
      reasoningEffort?: string;
      reason: AgentSessionRequestReason;
      series: AgentSessionRequestSeries;
      systemPrompt: string;
      toolSchemas: readonly AgentSessionRequestToolSchema[];
      attempt: number;
    }>
  | AgentSessionEventWithData<'request/context', {
      requestId: string;
      inputTokens?: number;
      contextWindow?: number;
      systemTokens?: number;
      toolSchemaTokens?: number;
      messageTokens?: number;
      surfaceGeneration: number;
      limited?: boolean;
      omittedMessages?: number;
    }>
  | AgentSessionEventWithData<'request/retry', {
      requestId: string;
      previousRequestId?: string;
      attempt: number;
      reason: string;
    }>
  | AgentSessionEventWithData<'request/usage', {
      requestId: string;
      usage: AgentSessionTokenUsage;
      finishReason: AgentSessionStopReason;
    }>
  | AgentSessionEventWithData<'tool/call', { call: AgentSessionRecordedToolCall }>
  | AgentSessionEventWithData<'tool/approval', {
      requestId: string;
      callId: string;
      approvalId?: string;
      status: 'requested' | 'approved' | 'rejected' | 'expired' | 'cancelled';
      risk?: AgentSessionEffect;
      reason?: string;
      expiresAtUnixMs?: number;
      prompt?: string;
    }>
  | AgentSessionEventWithData<'tool/execution', {
      callId: string;
      status: 'dispatched';
      idempotency: 'yes' | 'no' | 'conditional';
    }>
  | AgentSessionEventWithData<'tool/result', {
      callId: string;
      name: string;
      status: Extract<AgentSessionToolStatus, 'completed' | 'rejected' | 'failed' | 'timedOut' | 'cancelled'>;
      summary: string;
      data?: unknown;
      durationMs?: number;
      evidenceRefs?: readonly string[];
    }>
  | AgentSessionEventWithData<'context/artifact', {
      artifactId: string;
      kind: string;
      title: string;
      sizeBytes?: number;
      mediaType?: string;
      sha256?: string;
      sensitivity?: 'internal' | 'sensitiveRedacted';
    }>
  | AgentSessionEventWithData<'compaction/start', { reason: string }>
  | AgentSessionEventWithData<'compaction/summary', {
      summary: string;
      replacedThroughSeq: number;
      surfaceGeneration: number;
    }>
  | AgentSessionEventWithData<'compaction/end', {
      surfaceGeneration: number;
      replacedThroughSeq: number;
      status: 'completed' | 'failed';
    }>
  | AgentSessionEventWithData<'subagent/descriptor', {
      descriptorId: string;
      childSessionId: string;
      parentSessionId: string;
      parentTaskId: string;
      role: AgentSubagentRole;
      continuable: boolean;
      depth: number;
      inheritance: AgentSubagentInheritance;
      capabilityScope: AgentCapabilityScope;
      targetScope: readonly AgentSessionTarget[];
      budget: AgentSubagentBudget;
    }>
  | AgentSessionEventWithData<'subagent/message', {
      descriptorId: string;
      childSessionId: string;
      direction: 'inbound' | 'outbound';
      route: 'steer' | 'followup' | 'inject' | 'toolResult';
      summary: string;
    }>
  | AgentSessionEventWithData<'subagent/settled', {
      descriptorId: string;
      settlementId: string;
      childSessionId: string;
      status: AgentSessionRuntimeStatus;
      summary: string;
      evidenceRefs?: readonly string[];
    }>
  | AgentSessionEventWithData<'subagent/detached', {
      descriptorId: string;
      childSessionId: string;
      reason: string;
    }>
  | AgentSessionEventWithData<'task/linked', { taskId: string; goal?: string }>
  | AgentSessionEventWithData<'task/plan', {
      version: number;
      steps: readonly AgentSessionPlanStep[];
    }>
  | AgentSessionEventWithData<'task/state', {
      status: string;
      phase?: string;
      progress?: number;
      recovery?: AgentSessionRecoveryState;
      fleet?: AgentSessionFleetState;
    }>
  | AgentSessionEventWithData<'task/evidence', {
      evidenceId: string;
      kind: string;
      summary: string;
    }>;

export type AgentModelSurfaceMessage =
  | Readonly<{
      role: 'user';
      messageId: string;
      content: string;
      source: AgentSessionMessageSource;
    }>
  | Readonly<{
      role: 'assistant';
      messageId: string;
      content: readonly AgentSessionAssistantContentBlock[];
      interrupted: boolean;
    }>
  | Readonly<{
      role: 'tool';
      callId: string;
      name: string;
      status: Extract<
        AgentSessionToolStatus,
        'completed' | 'rejected' | 'failed' | 'timedOut' | 'cancelled'
      >;
      content: string;
    }>;

export interface AgentModelSurfaceSnapshot {
  readonly generation: number;
  readonly replacedThroughSeq?: number;
  readonly messages: readonly AgentModelSurfaceMessage[];
}

export interface AgentTaskEvidenceProjection {
  readonly evidenceId: string;
  readonly kind: string;
  readonly summary: string;
  readonly recordedAtSeq: number;
}

export interface AgentTaskProjection {
  readonly taskId?: string;
  readonly goal?: string;
  readonly status?: string;
  readonly phase?: string;
  readonly progress?: number;
  readonly plan?: Readonly<{
    version: number;
    steps: readonly AgentSessionPlanStep[];
  }>;
  readonly recovery?: AgentSessionRecoveryState;
  readonly fleet?: AgentSessionFleetState;
  readonly evidence: readonly AgentTaskEvidenceProjection[];
}

export interface AgentSessionHeader {
  readonly sessionId: string;
  readonly taskId: string;
  readonly goal: string;
  readonly title?: string;
  readonly parentSessionId?: string;
  readonly target?: AgentSessionTarget;
  readonly permissionMode?: AgentSessionPermissionMode;
  readonly successCriteria?: readonly string[];
  readonly capabilityScope?: AgentCapabilityScope;
  readonly subagent?: AgentSubagentSession;
  readonly createdAtUnixMs: number;
}

export interface AgentSessionSnapshot {
  readonly header: AgentSessionHeader;
  readonly status: AgentSessionRuntimeStatus;
  readonly ended: boolean;
  readonly archived: boolean;
  readonly eventCount: number;
  readonly surface: AgentModelSurfaceSnapshot;
  readonly inbox: Readonly<{
    nextTurn: readonly AgentSessionInboxMessage[];
    nextStep: readonly AgentSessionInboxMessage[];
  }>;
  readonly task: AgentTaskProjection;
  readonly recovery: AgentRecoveryCheckpoint;
}

export interface AgentSessionListItem {
  readonly header: AgentSessionHeader;
  readonly status: AgentSessionRuntimeStatus;
  readonly ended: boolean;
  readonly archived: boolean;
  readonly eventCount: number;
  readonly pendingTurns: number;
  readonly pendingStepMessages: number;
}

export interface AgentSessionRecoveryNotice {
  readonly fileName: string;
  readonly action: 'badTailDiscarded' | 'corruptLogQuarantined';
  readonly reason: string;
  readonly evidenceFileName: string;
  readonly recordedAtUnixMs: number;
}

export interface AgentSessionListPage {
  readonly sessions: readonly AgentSessionListItem[];
  readonly nextCursor?: string;
  readonly recoveryNotices: readonly AgentSessionRecoveryNotice[];
}

export interface AgentSessionEventPage {
  readonly events: readonly AgentSessionEvent[];
  readonly nextCursor?: number;
}

export interface CreateAgentSessionRequest {
  readonly sessionId: string;
  readonly taskId: string;
  readonly goal: string;
  readonly parentSessionId?: string;
  readonly target?: AgentSessionTarget;
  readonly permissionMode?: AgentSessionPermissionMode;
  readonly successCriteria?: readonly string[];
  readonly capabilityScope?: AgentCapabilityScope;
  readonly subagent?: AgentSubagentSession;
}

export interface AgentSessionListRequest {
  readonly cursor?: string;
  readonly limit: number;
}

export interface AgentSessionEventsRequest {
  readonly sessionId: string;
  readonly cursor?: number;
  readonly limit: number;
}

export interface AgentCommittedEventsRequest {
  readonly sessionId: string;
  readonly afterSeq?: number;
  readonly limit: number;
}

export interface AgentArtifactRequest {
  readonly sessionId: string;
  readonly artifactId: string;
  readonly maxBytes: number;
}

export interface AgentArtifactMetadata {
  readonly artifactId: string;
  readonly kind: string;
  readonly title: string;
  readonly mediaType: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly sensitivity: 'internal' | 'sensitiveRedacted';
  readonly createdAtUnixMs: number;
}

export interface AgentArtifactResponse {
  readonly metadata: AgentArtifactMetadata;
  readonly bodyBase64: string;
  readonly truncated: boolean;
}

export type AgentRecoveryReconcileOutcome =
  | 'probe'
  | 'confirmedApplied'
  | 'confirmedNotApplied'
  | 'unknown';

export interface AgentRecoveryReconcileInput {
  readonly sessionId: string;
  readonly outcome: AgentRecoveryReconcileOutcome;
  readonly evidence: string;
}

export interface AgentSessionMessageInput {
  readonly sessionId: string;
  readonly messageId: string;
  readonly clientSubmissionId?: string;
  readonly content: string;
}

export type AgentInboxMutation =
  | Readonly<{ type: 'update'; itemId: string; content: string }>
  | Readonly<{ type: 'remove'; itemId: string }>
  | Readonly<{
      type: 'reorder';
      lane: AgentSessionInboxLane;
      orderedItemIds: readonly string[];
    }>;

export interface AgentInboxMutationInput {
  readonly sessionId: string;
  readonly expectedRevision: number;
  readonly clientOperationId: string;
  readonly mutation: AgentInboxMutation;
}

export interface AgentSessionRenameInput {
  readonly sessionId: string;
  readonly expectedRevision: number;
  readonly clientOperationId: string;
  readonly title: string;
}

export interface AgentRuntimeInjectionInput extends AgentSessionMessageInput {
  readonly label: string;
}

export interface AgentRuntimeStartInput {
  readonly sessionId: string;
  readonly provider: import('./ai').AiProviderConfig;
}

export interface AgentSessionIdInput {
  readonly sessionId: string;
}

export interface AgentRuntimeToolDecisionInput {
  readonly sessionId: string;
  readonly turnId: string;
  readonly stepId: string;
  readonly requestId: string;
  readonly callId: string;
  readonly approvalId: string;
}

export interface AgentSubagentSpawnRequest {
  readonly parentSessionId: string;
  readonly goal: string;
  readonly role: AgentSubagentRole;
  readonly inheritanceMode: 'blank' | 'safePrefix';
  readonly targetIds: readonly string[];
  readonly budget?: AgentSubagentBudget;
  readonly continuable?: boolean;
}

export interface AgentChildInputRequest {
  readonly parentSessionId: string;
  readonly childSessionId: string;
  readonly content: string;
}

export interface AgentChildRequest {
  readonly parentSessionId: string;
  readonly childSessionId: string;
}

export interface AgentChildInspection {
  readonly snapshot: AgentSessionSnapshot;
  readonly resident: boolean;
  readonly descendantSessionIds: readonly string[];
  readonly toolCalls: number;
  readonly totalTokens: number;
  readonly lastSummary?: string;
}

export interface AgentFleetTargetRequest {
  readonly targetId: string;
  readonly goal: string;
}

export interface AgentFleetPlanRequest {
  readonly parentSessionId: string;
  readonly targets: readonly AgentFleetTargetRequest[];
  readonly canarySize: number;
  readonly waveSize: number;
  readonly failureThreshold: number;
}

export interface AgentFleetControlRequest {
  readonly parentSessionId: string;
  readonly fleetId: string;
}

export interface AgentFleetReconcileRequest extends AgentFleetControlRequest {
  readonly targetId: string;
  readonly evidence: string;
}

export interface AgentFleetInspection {
  readonly fleet: AgentSessionFleetState;
  readonly failureThreshold: number;
  readonly failures: number;
}

export interface AgentActivityRequest {
  readonly requestId: string;
  readonly providerId: string;
  readonly model: string;
  readonly reasoningEffort?: string;
  readonly reason: AgentSessionRequestReason;
  readonly series: AgentSessionRequestSeries;
  readonly systemPrompt: string;
  readonly toolSchemas: readonly AgentSessionRequestToolSchema[];
  readonly attempt: number;
  readonly startedAt: number;
  readonly firstReasoningAt?: number;
  readonly firstTextAt?: number;
  readonly completedAt?: number;
  readonly interruptedAt?: number;
  readonly ttftMs?: number;
  readonly reasoningDurationMs?: number;
  readonly llmDurationMs?: number;
  readonly inputTokens?: number;
  readonly contextWindow?: number;
  readonly surfaceGeneration: number;
  readonly usage?: AgentSessionTokenUsage;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
  readonly finishReason?: AgentSessionStopReason;
  readonly retryReason?: string;
}

export interface AgentActivityTool {
  readonly callId: string;
  readonly name: string;
  readonly title: string;
  readonly status: AgentSessionToolStatus;
  readonly effect: AgentSessionEffect;
  readonly durationMs?: number;
}

export interface AgentActivityStep {
  readonly id: string;
  readonly index: number;
  readonly status: AgentSessionRuntimeStatus;
  readonly startedAt?: number;
  readonly endedAt?: number;
  readonly durationMs?: number;
  readonly endReason?: string;
  readonly requests: readonly AgentActivityRequest[];
  readonly tools: readonly AgentActivityTool[];
}

export interface AgentActivityTurn {
  readonly id: string;
  readonly index: number;
  readonly status: AgentSessionRuntimeStatus;
  readonly startedAt?: number;
  readonly endedAt?: number;
  readonly durationMs?: number;
  readonly endReason?: string;
  readonly steps: readonly AgentActivityStep[];
}

export interface AgentActivityContext {
  readonly inputTokens?: number;
  readonly contextWindow?: number;
  readonly surfaceGeneration: number;
  readonly compactionCount: number;
  readonly artifacts: readonly Readonly<{
    artifactId: string;
    kind: string;
    title: string;
    sizeBytes?: number;
    mediaType?: string;
    sha256?: string;
    sensitivity?: 'internal' | 'sensitiveRedacted';
  }>[];
}

export interface AgentActivityAgent {
  readonly sessionId: string;
  readonly agentId?: string;
  readonly parentSessionId?: string;
  readonly descriptorId?: string;
  readonly role: string;
  readonly continuable: boolean;
  readonly depth?: number;
  readonly inheritance?: AgentSubagentInheritance;
  readonly capabilityScope?: AgentCapabilityScope;
  readonly targetScope?: readonly AgentSessionTarget[];
  readonly budget?: AgentSubagentBudget;
  readonly detached?: boolean;
  readonly status: AgentSessionRuntimeStatus;
  readonly summary?: string;
}

export type AgentActivityNodeKind =
  | 'session'
  | 'agent'
  | 'inbox'
  | 'turn'
  | 'step'
  | 'request'
  | 'requestContext'
  | 'requestUsage'
  | 'assistantStream'
  | 'assistantMessage'
  | 'tool'
  | 'approval'
  | 'retry'
  | 'artifact'
  | 'compaction'
  | 'subagent'
  | 'task'
  | 'evidence'
  | 'error'
  | 'cancellation'
  | 'unknown';

export type AgentActivityNodeStatus =
  | AgentSessionRuntimeStatus
  | AgentSessionToolStatus
  | 'started'
  | 'updated'
  | 'info'
  | 'interrupted'
  | 'unknown';

/** Stable, ordered audit row derived from one committed event window. */
export interface AgentActivityNode {
  readonly key: string;
  readonly kind: AgentActivityNodeKind;
  readonly sessionId: string;
  readonly turnId: string | null;
  readonly stepId: string | null;
  readonly requestId: string | null;
  readonly firstSeq: number;
  readonly lastSeq: number;
  readonly timestamp: string;
  readonly status: AgentActivityNodeStatus;
  readonly label: string;
  readonly detail: string | null;
  readonly eventTypes: readonly string[];
  readonly eventSeqs: readonly number[];
  readonly records: readonly Readonly<{
    type: string;
    seq: number;
    timeUnixMs: number;
    data: unknown;
  }>[];
  readonly data: unknown;
}

export interface AgentActivityProjection {
  readonly sessionId?: string;
  readonly status: AgentSessionRuntimeStatus;
  readonly statusReason?: string;
  readonly turns: readonly AgentActivityTurn[];
  readonly plan?: Readonly<{
    version: number;
    steps: readonly AgentSessionPlanStep[];
  }>;
  readonly context: AgentActivityContext;
  readonly agents: readonly AgentActivityAgent[];
  readonly recovery: AgentSessionRecoveryState;
  readonly fleet?: AgentSessionFleetState;
  readonly evidenceCount: number;
  readonly nodes: readonly AgentActivityNode[];
}
