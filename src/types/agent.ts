export const AGENT_PERMISSION_MODES = [
  'requestApproval',
  'autoApproveReadOnly',
  'fullAccess',
] as const;

export type AgentPermissionMode = (typeof AGENT_PERMISSION_MODES)[number];

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
  readonly task: 'generateCommand';
  readonly automaticExecution: false;
  readonly assistantTextExecution: 'forbidden';
  readonly reason: AgentSafeFallbackReason;
}

export interface AgentContractStatus {
  readonly contractVersion: 1;
  readonly featureEnabled: boolean;
  readonly agentAvailable: boolean;
  readonly defaultPermissionMode: 'requestApproval';
  readonly providerCapability: AgentProviderCapabilityEvidence;
  readonly fallback?: AgentSafeFallback;
}
