export type AgentSchemaVersionV1 = 1;

export type AgentRunStateV1 =
  | 'created'
  | 'collectingContext'
  | 'thinking'
  | 'validatingTool'
  | 'executingTool'
  | 'observing'
  | 'awaitingUser'
  | 'pausing'
  | 'paused'
  | 'cancelling'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'blocked';

export type AgentToolCallStateV1 =
  | 'proposed'
  | 'validating'
  | 'executing'
  | 'completed'
  | 'failed'
  | 'timedOut'
  | 'cancelled'
  | 'denied';

export interface AgentBudgetRequestV1 {
  maxRunSeconds?: number;
  maxModelTurns?: number;
  maxToolCalls?: number;
  toolTimeoutSeconds?: number;
  maxConsecutiveInvalidDecisions?: number;
  maxConsecutiveToolFailures?: number;
  maxPendingPlanItems?: number;
  maxSteeringQueueItems?: number;
  maxUserMessageBytes?: number;
  stdoutCaptureBytes?: number;
  stderrCaptureBytes?: number;
  totalReadHardLimitBytes?: number;
}

export interface AgentBudgetPolicyV1 {
  maxRunSeconds: number;
  maxModelTurns: number;
  maxToolCalls: number;
  toolTimeoutSeconds: number;
  maxConsecutiveInvalidDecisions: number;
  maxConsecutiveToolFailures: number;
  maxPendingPlanItems: number;
  maxSteeringQueueItems: number;
  maxUserMessageBytes: number;
  stdoutCaptureBytes: number;
  stderrCaptureBytes: number;
  totalReadHardLimitBytes: number;
}

export interface AgentBudgetUsageV1 {
  elapsedMillis: number;
  modelTurnsUsed: number;
  toolCallsUsed: number;
  consecutiveInvalidDecisions: number;
  consecutiveToolFailures: number;
  steeringQueueItems: number;
}

export interface AgentBudgetSnapshotV1 {
  schemaVersion: AgentSchemaVersionV1;
  policy: AgentBudgetPolicyV1;
  usage: AgentBudgetUsageV1;
}

export interface AgentTerminalContextV1 {
  sessionId: string;
  capturedAt: number;
  label: string;
  redactedText: string;
  truncated: boolean;
}

export interface AgentStartRequestV1 {
  schemaVersion: AgentSchemaVersionV1;
  clientRequestId: string;
  goal: string;
  profileId: string;
  providerId: string;
  terminalContext?: AgentTerminalContextV1;
  requestedBudgets?: AgentBudgetRequestV1;
}

export type AgentPlanItemStatusV1 = 'pending' | 'active' | 'completed' | 'skipped';

export interface AgentPlanItemV1 {
  id: string;
  title: string;
  status: AgentPlanItemStatusV1;
}

export interface AgentPlanUpdateV1 {
  items: AgentPlanItemV1[];
}

export type HostInspectFieldV1 =
  | 'os'
  | 'kernel'
  | 'architecture'
  | 'identity'
  | 'uptime'
  | 'capabilities';

export interface HostInspectArgsV1 {
  include: HostInspectFieldV1[];
}

export interface ShellExecReadOnlyArgsV1 {
  program: string;
  args: string[];
  timeoutSeconds?: number;
}

export type AgentReportOutcomeV1 = 'resolved' | 'diagnosed' | 'inconclusive' | 'blocked';
export type AgentFindingConfidenceV1 = 'verified' | 'likely' | 'uncertain';

export interface AgentFinalReportFindingV1 {
  title: string;
  detail: string;
  confidence: AgentFindingConfidenceV1;
  evidenceIds: string[];
}

export interface AgentNextActionV1 {
  title: string;
  requiresChange: boolean;
}

export interface AgentFinalReportV1 {
  outcome: AgentReportOutcomeV1;
  summary: string;
  findings: AgentFinalReportFindingV1[];
  changes: [];
  warnings: string[];
  nextActions: AgentNextActionV1[];
}

interface AgentDecisionBaseV1 {
  schemaVersion: AgentSchemaVersionV1;
  rationale: string;
  plan: AgentPlanUpdateV1;
}

export type AgentDecisionV1 =
  | (AgentDecisionBaseV1 & {
      kind: 'toolCall';
      tool: 'host.inspect';
      arguments: HostInspectArgsV1;
      purpose: string;
      successCriteria: string;
    })
  | (AgentDecisionBaseV1 & {
      kind: 'toolCall';
      tool: 'shell.execReadOnly';
      arguments: ShellExecReadOnlyArgsV1;
      purpose: string;
      successCriteria: string;
    })
  | (AgentDecisionBaseV1 & {
      kind: 'askUser';
      question: string;
    })
  | (AgentDecisionBaseV1 & {
      kind: 'final';
      report: AgentFinalReportV1;
    });

export type AgentProviderKindV1 = 'ollama' | 'openAi' | 'openAiCompatible';

export interface AgentProviderCapabilitiesV1 {
  streaming: boolean;
  strictJsonSchema: boolean;
  nativeToolCalling: boolean;
  usageReporting: boolean;
  responseContinuation: boolean;
}

export interface AgentProviderBindingV1 {
  providerId: string;
  kind: AgentProviderKindV1;
  baseUrl: string;
  model: string;
  capabilities: AgentProviderCapabilitiesV1;
}

export interface AgentJumpTargetSummaryV1 {
  host: string;
  port: number;
  username: string;
  authMethod: string;
}

export interface AgentTargetBindingV1 {
  profileId: string;
  profileLabel: string;
  host: string;
  port: number;
  username: string;
  authMethod: string;
  jumpHost?: AgentJumpTargetSummaryV1;
  targetDigest: string;
}

export type AgentToolNameV1 = 'host.inspect' | 'shell.execReadOnly';

export interface AgentPolicySnapshotV1 {
  mode: 'readOnly';
  policyVersion: string;
  toolRegistryVersion: string;
  allowedTools: AgentToolNameV1[];
}

export type AgentEvidenceSourceV1 =
  | 'terminalSnapshot'
  | 'host.inspect'
  | 'shell.execReadOnly';

export interface AgentEvidenceV1 {
  evidenceId: string;
  runId: string;
  targetDigest: string;
  source: AgentEvidenceSourceV1;
  toolCallId?: string;
  observedAt: number;
  summary: string;
  stdoutExcerpt?: string;
  stderrExcerpt?: string;
  exitCode?: number;
  truncated: boolean;
  observationDigest: string;
}

export type AgentToolResultStatusV1 =
  | 'completed'
  | 'failed'
  | 'timedOut'
  | 'cancelled'
  | 'denied';

export interface AgentToolExecutionResultV1 {
  schemaVersion: AgentSchemaVersionV1;
  runId: string;
  toolCallId: string;
  status: AgentToolResultStatusV1;
  startedAt: number;
  completedAt: number;
  exitCode?: number;
  stdoutExcerpt: string;
  stderrExcerpt: string;
  stdoutBytesCaptured: number;
  stderrBytesCaptured: number;
  stdoutBytesRead: number;
  stderrBytesRead: number;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  error?: AgentPublicErrorV1;
}

export interface AgentToolCallSnapshotV1 {
  toolCallId: string;
  state: AgentToolCallStateV1;
  tool: AgentToolNameV1;
  arguments: HostInspectArgsV1 | ShellExecReadOnlyArgsV1;
  rationale: string;
  purpose: string;
  successCriteria: string;
  proposedAt: number;
  operationId?: string;
  commandPreview?: string;
  result?: AgentToolExecutionResultV1;
  evidenceIds: string[];
}

export interface AgentQuestionV1 {
  questionId: string;
  question: string;
  askedAt: number;
}

export type AgentPublicErrorCategoryV1 =
  | 'agentBusy'
  | 'targetUnavailable'
  | 'providerIncompatible'
  | 'providerUnavailable'
  | 'providerProtocol'
  | 'toolDenied'
  | 'toolFailed'
  | 'budgetExceeded'
  | 'cancelled'
  | 'internal';

export interface AgentPublicErrorV1 {
  schemaVersion: AgentSchemaVersionV1;
  category: AgentPublicErrorCategoryV1;
  message: string;
  retryable: boolean;
  suggestion?: string;
}

export type AgentEventTypeV1 =
  | 'run.created'
  | 'run.stateChanged'
  | 'plan.updated'
  | 'model.started'
  | 'model.completed'
  | 'tool.proposed'
  | 'tool.stateChanged'
  | 'evidence.created'
  | 'budget.updated'
  | 'user.messageAccepted'
  | 'run.reportCreated'
  | 'run.warning'
  | 'run.terminal';

export interface AgentEventV1 {
  schemaVersion: AgentSchemaVersionV1;
  runId: string;
  sequence: number;
  occurredAt: number;
  type: AgentEventTypeV1;
  payload: unknown;
}

export interface AgentRunSnapshotV1 {
  schemaVersion: AgentSchemaVersionV1;
  runId: string;
  lastSequence: number;
  state: AgentRunStateV1;
  target: AgentTargetBindingV1;
  provider: AgentProviderBindingV1;
  policy: AgentPolicySnapshotV1;
  budgets: AgentBudgetSnapshotV1;
  goal: string;
  plan: AgentPlanItemV1[];
  toolCalls: AgentToolCallSnapshotV1[];
  evidence: AgentEvidenceV1[];
  pendingQuestion?: AgentQuestionV1;
  queuedSteeringCount: number;
  report?: AgentFinalReportV1;
  error?: AgentPublicErrorV1;
}
