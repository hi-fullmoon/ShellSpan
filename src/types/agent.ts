import type { AiMessageInput, AiProviderConfig } from './ai';

export const AGENT_PERMISSION_MODES = [
  'requestApproval',
  'autoApproveReadOnly',
  'fullAccess',
] as const;

export type AgentPermissionMode = (typeof AGENT_PERMISSION_MODES)[number];

export const AGENT_ROLLOUT_STAGES = [
  'disabled',
  'internal',
  'preview',
  'stable',
] as const;

export type AgentRolloutStage = (typeof AGENT_ROLLOUT_STAGES)[number];

export interface AgentRolloutPolicy {
  readonly stage: AgentRolloutStage;
  readonly featureEnabled: boolean;
  readonly defaultAgentEnabled: boolean;
  readonly defaultPermissionMode: 'requestApproval';
  readonly availablePermissionModes: readonly AgentPermissionMode[];
  readonly collectLocalDiagnostics: boolean;
}

export const AGENT_RISKS = ['readOnly', 'stateChange', 'destructive'] as const;

export type AgentRisk = (typeof AGENT_RISKS)[number];

export type AgentRiskClassification =
  | Readonly<{ status: 'classified'; risk: AgentRisk }>
  | Readonly<{ status: 'unknown' }>;

export type AgentApprovalDecisionReason =
  | 'unclassifiedRisk'
  | 'modeRequiresApproval'
  | 'readOnlyAutoApproved'
  | 'riskRequiresApproval'
  | 'fullAccess';

export interface AgentApprovalDecision {
  readonly requiresApproval: boolean;
  readonly reason: AgentApprovalDecisionReason;
}

export type AgentCommandRiskReason =
  | 'destructivePattern'
  | 'readOnlyAllowlist'
  | 'compoundReadOnlyAllowlist'
  | 'unrecognizedStateChange';

export interface AgentCommandRiskAssessment {
  readonly risk: AgentRisk;
  readonly reason: AgentCommandRiskReason;
}

export interface AgentTargetSnapshot {
  readonly kind: 'remote' | 'local';
  readonly sessionId: string;
  readonly profileId?: string;
  readonly host: string;
  readonly port: number;
  readonly username: string;
}

export interface AgentRequest {
  readonly requestId: string;
  readonly task: 'agent';
  readonly target: AgentTargetSnapshot;
  readonly permissionMode: AgentPermissionMode;
}

export interface AgentStartRequest {
  readonly request: AgentRequest;
  readonly provider: AiProviderConfig;
  readonly messages: AiMessageInput[];
}

export interface RunTerminalCommandArguments {
  readonly command: string;
  readonly explanation: string;
}

export interface AgentToolCall extends RunTerminalCommandArguments {
  readonly requestId: string;
  readonly callId: string;
  readonly name: 'run_terminal_command';
  readonly target: AgentTargetSnapshot;
}

export const AGENT_TOOL_RESULT_STATUSES = [
  'completed',
  'rejected',
  'failed',
  'timedOut',
  'cancelled',
] as const;

export type AgentToolResultStatus = (typeof AGENT_TOOL_RESULT_STATUSES)[number];

export interface AgentToolResult {
  readonly requestId: string;
  readonly callId: string;
  readonly status: AgentToolResultStatus;
  readonly exitCode?: number;
  readonly output: string;
}

export type AgentToolApprovalStatus =
  | 'pending'
  | 'awaitingApproval'
  | 'running'
  | AgentToolResultStatus;

export interface AgentApprovalReference {
  readonly requestId: string;
  readonly callId: string;
  readonly approvalId: string;
}

export interface AgentToolApprovalSnapshot {
  readonly toolCall: AgentToolCall;
  readonly permissionMode: AgentPermissionMode;
  readonly riskAssessment: AgentCommandRiskAssessment;
  readonly decision: AgentApprovalDecision;
  readonly status: AgentToolApprovalStatus;
  readonly recoveredFromStatus?: 'pending' | 'awaitingApproval' | 'running';
  readonly approval?: AgentApprovalReference;
  readonly result?: AgentToolResult;
}

export type AgentRunPhase =
  | 'analyzing'
  | 'preparingCommand'
  | 'awaitingApproval'
  | 'executing'
  | 'readingResult'
  | 'verifying'
  | 'completed'
  | 'partial'
  | 'incomplete';

export type AgentRunStatus =
  | 'running'
  | 'completed'
  | 'partial'
  | 'incomplete'
  | 'cancelled'
  | 'failed';

export interface AgentRunRecord {
  readonly requestId: string;
  readonly conversationId: string;
  readonly conversationStartedAt: string;
  readonly goal: string;
  readonly providerId: string;
  readonly target: Readonly<AgentTargetSnapshot>;
  readonly targetTitle: string;
  readonly permissionMode: AgentPermissionMode;
  readonly rolloutStage: AgentRolloutStage;
  readonly toolCallIds: readonly string[];
  readonly phase: AgentRunPhase;
  readonly status: AgentRunStatus;
  readonly stopRequested: boolean;
  readonly fallback?: AgentSafeFallback;
  readonly error?: string;
  readonly maxToolSteps?: number;
  readonly toolResultTimeoutMs?: number;
  readonly stepLimitReached?: boolean;
}

export interface AgentChatMessage {
  readonly id: string;
  readonly requestId: string;
  readonly conversationId?: string;
  readonly role: 'user' | 'assistant';
  readonly content: string;
  readonly status: 'streaming' | 'completed' | 'cancelled' | 'failed';
  readonly providerId: string;
  readonly target: Readonly<AgentTargetSnapshot>;
  readonly toolCallIds: readonly string[];
}

export interface PersistedAgentRunState {
  readonly run: AgentRunRecord;
  readonly messages: readonly AgentChatMessage[];
  readonly tools: readonly AgentToolApprovalSnapshot[];
}

export const AGENT_TOOL_CALLING_SUPPORT = ['supported', 'unsupported', 'unknown'] as const;
export type AgentToolCallingSupport = (typeof AGENT_TOOL_CALLING_SUPPORT)[number];

export const AGENT_CAPABILITY_SOURCES = [
  'openAiResponses',
  'chatCompletionsProbe',
  'ollamaModelMetadata',
] as const;
export type AgentProviderCapabilitySource = (typeof AGENT_CAPABILITY_SOURCES)[number];

export interface AgentProviderCapabilityEvidence {
  readonly support: AgentToolCallingSupport;
  readonly source: AgentProviderCapabilitySource;
}

export type AgentSafeFallbackReason =
  | 'featureDisabled'
  | 'toolCallingUnsupported'
  | 'toolCallingUnverified';

export interface AgentSafeFallback {
  readonly task: 'ask';
  readonly automaticExecution: false;
  readonly assistantTextExecution: 'forbidden';
  readonly reason: AgentSafeFallbackReason;
}

export interface AgentContractStatus {
  readonly contractVersion: 2;
  readonly featureEnabled: boolean;
  readonly agentAvailable: boolean;
  readonly defaultPermissionMode: 'requestApproval';
  readonly providerCapability: AgentProviderCapabilityEvidence;
  readonly fallback?: AgentSafeFallback;
}

export const AGENT_STREAM_EVENT_TYPES = [
  'started',
  'capabilityDetected',
  'safeFallback',
  'textDelta',
  'toolCall',
  'toolResultAccepted',
  'toolResultTimedOut',
  'stepLimitReached',
  'completed',
  'cancelled',
  'error',
] as const;

export type AgentStreamEvent =
  | Readonly<{
      type: 'started';
      requestId: string;
      target: AgentTargetSnapshot;
      maxToolSteps: number;
      toolResultTimeoutMs: number;
    }>
  | Readonly<{
      type: 'capabilityDetected';
      requestId: string;
      capability: AgentProviderCapabilityEvidence;
    }>
  | Readonly<{
      type: 'safeFallback';
      requestId: string;
      fallback: AgentSafeFallback;
    }>
  | Readonly<{ type: 'textDelta'; requestId: string; turn: number; text: string }>
  | Readonly<{ type: 'toolCall'; requestId: string; step: number; toolCall: AgentToolCall }>
  | Readonly<{
      type: 'toolResultAccepted';
      requestId: string;
      step: number;
      callId: string;
      status: AgentToolResultStatus;
    }>
  | Readonly<{
      type: 'toolResultTimedOut';
      requestId: string;
      step: number;
      callId: string;
    }>
  | Readonly<{
      type: 'stepLimitReached';
      requestId: string;
      maxToolSteps: number;
    }>
  | Readonly<{
      type: 'completed';
      requestId: string;
      toolSteps: number;
      fallback: boolean;
    }>
  | Readonly<{ type: 'cancelled'; requestId: string }>
  | Readonly<{ type: 'error'; requestId: string; message: string }>;
