import type {
  AgentFindingConfidenceV1,
  AgentPlanItemV1,
  AgentPlanUpdateV1,
  HostInspectArgsV1,
  ShellExecReadOnlyArgsV1,
} from '@/types/agent';

export type AgentSchemaVersionV2 = 2;

export type AgentRunStateV2 =
  | 'created'
  | 'collectingContext'
  | 'thinking'
  | 'validatingTool'
  | 'evaluatingRisk'
  | 'awaitingApproval'
  | 'executingTool'
  | 'executingChange'
  | 'verifyingChange'
  | 'observing'
  | 'awaitingUser'
  | 'pausing'
  | 'paused'
  | 'cancelling'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'blocked';

export type AgentRunTerminalStateV2 = 'completed' | 'failed' | 'cancelled' | 'blocked';
export type AgentRunNonTerminalStateV2 = Exclude<AgentRunStateV2, AgentRunTerminalStateV2>;

export type AgentToolCallStateV2 =
  | 'proposed'
  | 'validating'
  | 'policyEvaluated'
  | 'awaitingApproval'
  | 'approved'
  | 'rejected'
  | 'expired'
  | 'revoked'
  | 'executing'
  | 'awaitingVerification'
  | 'verifying'
  | 'completed'
  | 'partial'
  | 'failed'
  | 'timedOut'
  | 'cancelled'
  | 'unknownEffect'
  | 'denied';

export type AgentToolCallTerminalStateV2 =
  | 'rejected'
  | 'expired'
  | 'revoked'
  | 'completed'
  | 'partial'
  | 'failed'
  | 'timedOut'
  | 'cancelled'
  | 'unknownEffect'
  | 'denied';
export type AgentToolCallNonTerminalStateV2 = Exclude<
  AgentToolCallStateV2,
  AgentToolCallTerminalStateV2
>;

export type AgentApprovalStateV2 =
  | 'pending'
  | 'confirmationPending'
  | 'approved'
  | 'rejected'
  | 'expired'
  | 'revoked'
  | 'consuming'
  | 'consumed';

export type AgentApprovalTerminalStateV2 = 'rejected' | 'expired' | 'revoked' | 'consumed';

export type AgentVerificationStateV2 =
  | 'pending'
  | 'running'
  | 'satisfied'
  | 'failed'
  | 'inconclusive'
  | 'timedOut'
  | 'cancelled';

export type AgentVerificationTerminalStateV2 =
  | 'satisfied'
  | 'failed'
  | 'inconclusive'
  | 'timedOut'
  | 'cancelled';

export type AgentPolicyModeV2 = 'strict' | 'balanced';

export interface AgentTerminalContextV2 {
  sessionId: string;
  capturedAt: number;
  label: string;
  redactedText: string;
  truncated: boolean;
}

export interface AgentBudgetRequestV2 {
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
  maxMutationProposals?: number;
  maxApprovedMutations?: number;
  maxVerificationAttemptsPerChange?: number;
  maxVerificationRuntimeSeconds?: number;
}

export interface AgentBudgetPolicyV2 {
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
  maxMutationProposals: number;
  maxApprovedMutations: number;
  maxPendingApprovals: 1;
  maxVerificationAttemptsPerChange: number;
  maxVerificationRuntimeSeconds: number;
}

export interface AgentBudgetUsageV2 {
  elapsedMillis: number;
  modelTurnsUsed: number;
  toolCallsUsed: number;
  consecutiveInvalidDecisions: number;
  consecutiveToolFailures: number;
  steeringQueueItems: number;
  mutationProposalsUsed: number;
  approvedMutationsUsed: number;
  pendingApprovals: 0 | 1;
}

export interface AgentBudgetSnapshotV2 {
  schemaVersion: AgentSchemaVersionV2;
  policy: AgentBudgetPolicyV2;
  usage: AgentBudgetUsageV2;
}

export interface AgentStartRequestV2 {
  schemaVersion: AgentSchemaVersionV2;
  clientRequestId: string;
  goal: string;
  profileId: string;
  providerId: string;
  requestedPolicyMode: AgentPolicyModeV2;
  terminalContext?: AgentTerminalContextV2;
  requestedBudgets?: AgentBudgetRequestV2;
}

export type AgentToolNameV2 =
  | 'host.inspect'
  | 'shell.execReadOnly'
  | 'service.inspect'
  | 'service.validateConfig'
  | 'service.control';

export type ServiceInspectFieldV2 =
  | 'loadState'
  | 'activeState'
  | 'subState'
  | 'mainPid'
  | 'result';

export interface ServiceInspectArgsV2 {
  manager: 'systemd';
  unit: string;
  include: ServiceInspectFieldV2[];
}

export interface ServiceValidateConfigArgsV2 {
  validator: 'nginx' | 'apache' | 'sshd';
}

export type ServiceControlActionV2 = 'start' | 'reload' | 'restart' | 'stop';

export interface ServiceControlArgsV2 {
  manager: 'systemd';
  unit: string;
  action: ServiceControlActionV2;
  timeoutSeconds?: number;
  verificationHints?: {
    expectedListenerPorts?: number[];
  };
}

export interface AgentResourceRefV2 {
  kind: 'systemdService';
  identity: string;
  targetDigest: string;
}

export type AgentChangeStatusV2 =
  | 'verified'
  | 'unverified'
  | 'failedNoEffect'
  | 'executionSucceededVerificationFailed'
  | 'partialUnexpectedEffect'
  | 'unknownEffect';

export type AgentReportOutcomeV2 =
  | 'resolved'
  | 'diagnosed'
  | 'partial'
  | 'failed'
  | 'blocked'
  | 'inconclusive';

export interface AgentFinalReportFindingV2 {
  title: string;
  detail: string;
  confidence: AgentFindingConfidenceV1;
  evidenceIds: string[];
}

export interface AgentChangeReportV2 {
  changeId: string;
  toolCallId: string;
  approvalId: string;
  resource: AgentResourceRefV2;
  action: string;
  status: AgentChangeStatusV2;
  executionEvidenceIds: string[];
  verificationEvidenceIds: string[];
}

export interface AgentNextActionV2 {
  title: string;
  requiresChange: boolean;
}

export interface AgentFinalReportV2 {
  outcome: AgentReportOutcomeV2;
  summary: string;
  findings: AgentFinalReportFindingV2[];
  changes: AgentChangeReportV2[];
  warnings: string[];
  nextActions: AgentNextActionV2[];
}

interface AgentDecisionBaseV2 {
  schemaVersion: AgentSchemaVersionV2;
  rationale: string;
  plan: AgentPlanUpdateV1;
}

interface AgentReadOnlyToolDecisionBaseV2 extends AgentDecisionBaseV2 {
  kind: 'toolCall';
  purpose: string;
  successCriteria: string;
}

export type AgentDecisionV2 =
  | (AgentReadOnlyToolDecisionBaseV2 & {
      tool: 'host.inspect';
      arguments: HostInspectArgsV1;
    })
  | (AgentReadOnlyToolDecisionBaseV2 & {
      tool: 'shell.execReadOnly';
      arguments: ShellExecReadOnlyArgsV1;
    })
  | (AgentReadOnlyToolDecisionBaseV2 & {
      tool: 'service.inspect';
      arguments: ServiceInspectArgsV2;
    })
  | (AgentReadOnlyToolDecisionBaseV2 & {
      tool: 'service.validateConfig';
      arguments: ServiceValidateConfigArgsV2;
    })
  | (AgentDecisionBaseV2 & {
      kind: 'toolCall';
      tool: 'service.control';
      arguments: ServiceControlArgsV2;
      purpose: string;
      expectedImpact: string;
      rollbackGuidance: string;
      successCriteria: string;
      preconditionEvidenceIds: string[];
      retrySafety: 'never' | 'verifyBeforeRetry';
    })
  | (AgentDecisionBaseV2 & {
      kind: 'askUser';
      question: string;
    })
  | (AgentDecisionBaseV2 & {
      kind: 'final';
      report: AgentFinalReportV2;
    });

export interface AgentRiskFindingV2 {
  code: string;
  message: string;
}

export interface AgentRiskAssessmentV2 {
  riskAssessmentId: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  confidence: 'known' | 'heuristic' | 'unknown';
  dimensions: {
    read: boolean;
    write: boolean;
    delete: boolean;
    privilegeElevation: boolean;
    serviceInterruption: boolean;
    networkChange: boolean;
    credentialAccess: boolean;
    externalNetwork: boolean;
    multiHost: boolean;
  };
  findings: AgentRiskFindingV2[];
  affectedResources: AgentResourceRefV2[];
  verdict:
    | 'autoReadOnly'
    | 'requiresApproval'
    | 'requiresDoubleConfirmation'
    | 'deny';
  policyVersion: string;
  assessmentDigest: string;
}

export interface AgentPolicySnapshotV2 {
  mode: AgentPolicyModeV2;
  policyVersion: string;
  toolRegistryVersion: string;
  allowedTools: AgentToolNameV2[];
  controlledMutationAllowed: boolean;
}

export type AgentProviderKindV2 = 'ollama' | 'openAi' | 'openAiCompatible';

export interface AgentProviderCapabilitiesV2 {
  streaming: boolean;
  strictJsonSchema: boolean;
  nativeToolCalling: boolean;
  usageReporting: boolean;
  responseContinuation: boolean;
}

export interface AgentProviderBindingV2 {
  providerId: string;
  kind: AgentProviderKindV2;
  baseUrl: string;
  model: string;
  capabilities: AgentProviderCapabilitiesV2;
}

export interface AgentJumpTargetSummaryV2 {
  host: string;
  port: number;
  username: string;
  authMethod: string;
}

export interface AgentTargetBindingV2 {
  profileId: string;
  profileLabel: string;
  host: string;
  port: number;
  username: string;
  authMethod: string;
  jumpHost?: AgentJumpTargetSummaryV2;
  targetDigest: string;
}

export interface AgentPublicErrorV2 {
  schemaVersion: AgentSchemaVersionV2;
  category:
    | 'agentBusy'
    | 'targetUnavailable'
    | 'providerIncompatible'
    | 'providerUnavailable'
    | 'providerProtocol'
    | 'toolDenied'
    | 'toolFailed'
    | 'staleEvidence'
    | 'preconditionFailed'
    | 'approvalRequired'
    | 'approvalExpired'
    | 'verificationFailed'
    | 'budgetExceeded'
    | 'cancelled'
    | 'p2Blocked'
    | 'policyUnavailable'
    | 'internal';
  message: string;
  retryable: boolean;
  suggestion?: string;
}

export type AgentToolResultStatusV2 =
  | 'completed'
  | 'partial'
  | 'failed'
  | 'timedOut'
  | 'cancelled'
  | 'unknownEffect'
  | 'denied';

export interface AgentToolExecutionResultV2 {
  schemaVersion: AgentSchemaVersionV2;
  runId: string;
  toolCallId: string;
  status: AgentToolResultStatusV2;
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
  error?: AgentPublicErrorV2;
}

export type AgentEvidenceSourceV2 =
  | 'terminalSnapshot'
  | 'host.inspect'
  | 'shell.execReadOnly'
  | 'service.inspect'
  | 'service.validateConfig'
  | 'service.control'
  | 'service.verify';

export interface AgentEvidenceV2 {
  evidenceId: string;
  runId: string;
  targetDigest: string;
  source: AgentEvidenceSourceV2;
  toolCallId?: string;
  observedAt: number;
  summary: string;
  stdoutExcerpt?: string;
  stderrExcerpt?: string;
  exitCode?: number;
  truncated: boolean;
  observationDigest: string;
}

interface AgentToolCallSnapshotBaseV2 {
  toolCallId: string;
  state: AgentToolCallStateV2;
  rationale: string;
  purpose: string;
  successCriteria: string;
  proposedAt: number;
  operationId?: string;
  commandPreview?: string;
  result?: AgentToolExecutionResultV2;
  evidenceIds: string[];
}

export type AgentToolCallSnapshotV2 =
  | (AgentToolCallSnapshotBaseV2 & { tool: 'host.inspect'; arguments: HostInspectArgsV1 })
  | (AgentToolCallSnapshotBaseV2 & {
      tool: 'shell.execReadOnly';
      arguments: ShellExecReadOnlyArgsV1;
    })
  | (AgentToolCallSnapshotBaseV2 & {
      tool: 'service.inspect';
      arguments: ServiceInspectArgsV2;
    })
  | (AgentToolCallSnapshotBaseV2 & {
      tool: 'service.validateConfig';
      arguments: ServiceValidateConfigArgsV2;
    })
  | (AgentToolCallSnapshotBaseV2 & {
      tool: 'service.control';
      arguments: ServiceControlArgsV2;
      expectedImpact: string;
      rollbackGuidance: string;
      preconditionEvidenceIds: string[];
      retrySafety: 'never' | 'verifyBeforeRetry';
    });

export interface AgentApprovalSnapshotV2 {
  approvalId: string;
  runId: string;
  toolCallId: string;
  toolName: AgentToolNameV2;
  resource?: AgentResourceRefV2;
  riskAssessmentId: string;
  commandPreview: string;
  preconditionEvidenceIds: string[];
  verificationPlanDigest?: string;
  timeoutSeconds: number;
  issuedAt: number;
  expiresAt: number;
  confirmationMode: 'single' | 'double';
  state: AgentApprovalStateV2;
}

export interface AgentChangeSnapshotV2 extends AgentChangeReportV2 {
  operationId?: string;
  recordedAt: number;
}

export interface AgentVerificationSnapshotV2 {
  verificationObligationId: string;
  changeId: string;
  toolCallId: string;
  state: AgentVerificationStateV2;
  verificationPlanDigest: string;
  evidenceIds: string[];
  startedAt?: number;
  completedAt?: number;
}

export interface AgentQuestionV2 {
  questionId: string;
  question: string;
  askedAt: number;
}

export interface AgentRunSnapshotV2 {
  schemaVersion: AgentSchemaVersionV2;
  runId: string;
  lastSequence: number;
  state: AgentRunStateV2;
  target: AgentTargetBindingV2;
  provider: AgentProviderBindingV2;
  policy: AgentPolicySnapshotV2;
  budgets: AgentBudgetSnapshotV2;
  goal: string;
  plan: AgentPlanItemV1[];
  toolCalls: AgentToolCallSnapshotV2[];
  evidence: AgentEvidenceV2[];
  pendingQuestion?: AgentQuestionV2;
  queuedSteeringCount: number;
  report?: AgentFinalReportV2;
  error?: AgentPublicErrorV2;
  pendingApproval?: AgentApprovalSnapshotV2;
  riskAssessments: AgentRiskAssessmentV2[];
  changes: AgentChangeSnapshotV2[];
  verificationObligations: AgentVerificationSnapshotV2[];
}

export type AgentEventTypeV2 =
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
  | 'run.terminal'
  | 'risk.evaluated'
  | 'approval.requested'
  | 'approval.confirmationRequired'
  | 'approval.resolved'
  | 'approval.expired'
  | 'approval.revoked'
  | 'change.executionStarted'
  | 'change.executionCompleted'
  | 'verification.started'
  | 'verification.completed'
  | 'change.recorded';

interface AgentEventEnvelopeV2<TType extends AgentEventTypeV2, TPayload> {
  schemaVersion: AgentSchemaVersionV2;
  runId: string;
  sequence: number;
  occurredAt: number;
  type: TType;
  payload: TPayload;
}

export type AgentEventV2 =
  | AgentEventEnvelopeV2<'run.created', { state: 'created' }>
  | AgentEventEnvelopeV2<
      'run.stateChanged',
      { previousState: AgentRunNonTerminalStateV2; state: AgentRunStateV2; reason?: string }
    >
  | AgentEventEnvelopeV2<'plan.updated', { plan: AgentPlanItemV1[] }>
  | AgentEventEnvelopeV2<'model.started' | 'model.completed', { modelTurn: number }>
  | AgentEventEnvelopeV2<
      'tool.proposed',
      { toolCall: AgentToolCallSnapshotV2 & { state: 'proposed' } }
    >
  | AgentEventEnvelopeV2<
      'tool.stateChanged',
      {
        toolCallId: string;
        previousState: AgentToolCallNonTerminalStateV2;
        state: AgentToolCallStateV2;
      }
    >
  | AgentEventEnvelopeV2<'evidence.created', { evidence: AgentEvidenceV2 }>
  | AgentEventEnvelopeV2<'budget.updated', { budgets: AgentBudgetSnapshotV2 }>
  | AgentEventEnvelopeV2<
      'user.messageAccepted',
      { clientActionId: string; messageKind: 'answer' | 'steering' }
    >
  | AgentEventEnvelopeV2<'run.reportCreated', { report: AgentFinalReportV2 }>
  | AgentEventEnvelopeV2<'run.warning', { code: string; message: string }>
  | AgentEventEnvelopeV2<
      'run.terminal',
      { state: AgentRunTerminalStateV2; error?: AgentPublicErrorV2 }
    >
  | AgentEventEnvelopeV2<
      'risk.evaluated',
      { toolCallId: string; riskAssessment: AgentRiskAssessmentV2 }
    >
  | AgentEventEnvelopeV2<
      'approval.requested',
      { approval: AgentApprovalSnapshotV2 & { state: 'pending' } }
    >
  | AgentEventEnvelopeV2<
      'approval.confirmationRequired',
      { approvalId: string; challengeId: string; expiresAt: number }
    >
  | AgentEventEnvelopeV2<
      'approval.resolved',
      { approvalId: string; state: 'approved' | 'rejected' }
    >
  | AgentEventEnvelopeV2<'approval.expired', { approvalId: string }>
  | AgentEventEnvelopeV2<'approval.revoked', { approvalId: string; reason: string }>
  | AgentEventEnvelopeV2<
      'change.executionStarted' | 'change.executionCompleted' | 'change.recorded',
      { change: AgentChangeSnapshotV2 }
    >
  | AgentEventEnvelopeV2<
      'verification.started',
      { verification: AgentVerificationSnapshotV2 & { state: 'running' } }
    >
  | AgentEventEnvelopeV2<
      'verification.completed',
      {
        verification: AgentVerificationSnapshotV2 & {
          state: AgentVerificationTerminalStateV2;
        };
      }
    >;

export type AgentFoundationStatusV2 =
  | 'verified'
  | 'implemented'
  | 'blocked'
  | 'planned'
  | 'unknown';

export interface AgentP2AdmissionInputV2 {
  p0Status: AgentFoundationStatusV2;
  p1Status: AgentFoundationStatusV2;
  featureEnabled: boolean;
  providerStrictSchemaCompatible: boolean;
  targetCapability: 'posixSystemd' | 'unsupported' | 'unknown';
  controlledMutationPolicy: 'allowed' | 'denied' | 'unavailable';
  operationHistory: 'writable' | 'readOnly' | 'unavailable';
}

export type AgentP2AdmissionErrorCategoryV2 = 'p2Blocked' | 'policyUnavailable';

export interface AgentP2AdmissionErrorV2 {
  category: AgentP2AdmissionErrorCategoryV2;
  reason:
    | 'p0NotVerified'
    | 'p1NotVerified'
    | 'featureDisabled'
    | 'providerIncompatible'
    | 'targetUnsupported'
    | 'targetCapabilityUnknown'
    | 'controlledMutationDenied'
    | 'controlledMutationPolicyUnavailable'
    | 'operationHistoryNotWritable';
}
