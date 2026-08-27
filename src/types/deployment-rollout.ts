import type { RemoteConnectionRequest } from '@/types';
import type {
  DeploymentExecutionApprovalV2,
  DeploymentExecutionPolicyV2,
  DeploymentExecutionResultV2,
  DeploymentExecutionReviewV2,
  DeploymentFrozenTargetIdentityV2,
} from '@/types/deployment-runbook';

export type DeploymentRolloutSchemaVersion = 2;

export type DeploymentRolloutCanaryV2 =
  | { mode: 'count'; value: number }
  | { mode: 'percentage'; value: number };

export interface DeploymentRolloutPolicyV2 {
  strategy: 'canaryRolling';
  canary: DeploymentRolloutCanaryV2;
  batchSize: number;
  maxParallel: number;
  requireBatchApproval: true;
  minHealthyPercent: number;
  maxFailuresPerBatch: number;
  stopPolicy: 'pause';
  rollbackSuggestion: 'none' | 'successfulTargets';
}

export interface DeploymentRolloutTargetRequestV2 {
  profileId: string;
  environment: string;
  connection: RemoteConnectionRequest;
}

export interface DeploymentRolloutReviewRequestV2 {
  rolloutId: string;
  runbookText: string;
  profileIds: string[];
  targets: DeploymentRolloutTargetRequestV2[];
  policy: DeploymentRolloutPolicyV2;
  deploymentPolicy: DeploymentExecutionPolicyV2;
}

export type DeploymentRolloutBatchKindV2 = 'canary' | 'rolling';

export interface DeploymentRolloutBatchPlanV2 {
  batchIndex: number;
  kind: DeploymentRolloutBatchKindV2;
  profileIds: string[];
  targetIndexes: number[];
  requiredHealthy: number;
  maximumFailures: number;
  approvalRequired: boolean;
  batchDigest: string;
}

export interface DeploymentRolloutReviewedTargetV2 {
  targetIndex: number;
  batchIndex: number;
  profileId: string;
  environment: string;
  operationId: string;
  target: DeploymentFrozenTargetIdentityV2;
  deploymentReview?: DeploymentExecutionReviewV2;
  completedOperationId?: string;
}

export interface DeploymentRolloutReviewV2 {
  schemaVersion: DeploymentRolloutSchemaVersion;
  rolloutId: string;
  reviewId: string;
  recoveryOfReviewId?: string;
  normalizedRunbookText: string;
  documentDigest: string;
  planDigest: string;
  deploymentId: string;
  applicationId: string;
  environment: string;
  version: string;
  declaredRisk: DeploymentExecutionReviewV2['declaredRisk'];
  policy: DeploymentRolloutPolicyV2;
  deploymentPolicy: DeploymentExecutionPolicyV2;
  profileIds: string[];
  targets: DeploymentRolloutReviewedTargetV2[];
  batches: DeploymentRolloutBatchPlanV2[];
  reviewedAt: number;
  expiresAt: number;
}

export interface DeploymentRolloutTargetApprovalV2 extends DeploymentExecutionApprovalV2 {
  profileId: string;
  batchIndex: number;
  targetIndex: number;
}

export interface DeploymentRolloutBatchApprovalV2 {
  rolloutId: string;
  rolloutReviewId: string;
  rolloutPlanDigest: string;
  batchIndex: number;
  batchDigest: string;
  targetApprovals: DeploymentRolloutTargetApprovalV2[];
  authorized: boolean;
  destructiveConfirmed: boolean;
}

export interface DeploymentRolloutTargetConnectionV2 {
  profileId: string;
  connection: RemoteConnectionRequest;
}

export interface DeploymentRolloutStartRequestV2 {
  rolloutId: string;
  reviewId: string;
  planDigest: string;
  batchApproval: DeploymentRolloutBatchApprovalV2;
  connections: DeploymentRolloutTargetConnectionV2[];
}

export interface DeploymentRolloutApproveBatchRequestV2 {
  rolloutId: string;
  reviewId: string;
  planDigest: string;
  batchApproval: DeploymentRolloutBatchApprovalV2;
  connections: DeploymentRolloutTargetConnectionV2[];
}

export interface DeploymentRolloutCancelRequestV2 {
  rolloutId: string;
  reviewId: string;
  planDigest: string;
}

export interface DeploymentRolloutListRequestV2 {
  phase?: DeploymentRolloutPhaseV2;
  recoveryRequired?: boolean;
  limit?: number;
}

export interface DeploymentRolloutRecoverRequestV2 extends DeploymentRolloutReviewRequestV2 {
  sourceReviewId: string;
}

export type DeploymentRolloutPhaseV2 =
  | 'reviewed'
  | 'awaitingCanaryApproval'
  | 'running'
  | 'awaitingBatchApproval'
  | 'paused'
  | 'recoveryRequired'
  | 'succeeded'
  | 'partialSuccess'
  | 'failed'
  | 'cancelled';

export type DeploymentRolloutBatchStatusV2 =
  | 'pending'
  | 'awaitingApproval'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

export type DeploymentRolloutTargetStatusV2 =
  | 'notStarted'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

export type DeploymentRolloutCircuitReasonV2 =
  | 'canaryFailed'
  | 'healthThreshold'
  | 'failureThreshold'
  | 'targetDrift'
  | 'planDrift'
  | 'approvalExpired'
  | 'approvalMismatch'
  | 'parallelLimit'
  | 'recoveryRequired'
  | 'cancelled'
  | 'lateResult';

export interface DeploymentRolloutHealthSummaryV2 {
  total: number;
  healthy: number;
  failed: number;
  healthyPercent: number;
  thresholdMet: boolean;
}

export interface DeploymentRolloutBatchStateV2 extends DeploymentRolloutBatchPlanV2 {
  status: DeploymentRolloutBatchStatusV2;
  approvalReviewId?: string;
  approvalConsumedAt?: number;
  startedAt?: number;
  completedAt?: number;
  health: DeploymentRolloutHealthSummaryV2;
}

export interface DeploymentRolloutTargetStateV2 extends DeploymentRolloutReviewedTargetV2 {
  status: DeploymentRolloutTargetStatusV2;
  result?: DeploymentExecutionResultV2;
  startedAt?: number;
  completedAt?: number;
  recoveryRequired: boolean;
  errorCategory?: string;
  error?: string;
}

export interface DeploymentRolloutRollbackSuggestionV2 {
  profileId: string;
  targetDigest: string;
  sourceOperationId: string;
  reason: 'rolloutCircuitOpen';
  requiresSeparateApproval: true;
}

export interface DeploymentRolloutSummaryV2 {
  rolloutId: string;
  reviewId: string;
  planDigest: string;
  deploymentId: string;
  applicationId: string;
  environment: string;
  version: string;
  phase: DeploymentRolloutPhaseV2;
  currentBatchIndex?: number;
  circuitOpen: boolean;
  circuitReason?: DeploymentRolloutCircuitReasonV2;
  recoveryRequired: boolean;
  totalTargets: number;
  succeededTargets: number;
  failedTargets: number;
  notStartedTargets: number;
  createdAt: number;
  updatedAt: number;
}

export interface DeploymentRolloutDetailV2 extends DeploymentRolloutSummaryV2 {
  review: DeploymentRolloutReviewV2;
  policy: DeploymentRolloutPolicyV2;
  batches: DeploymentRolloutBatchStateV2[];
  targets: DeploymentRolloutTargetStateV2[];
  rollbackSuggestions: DeploymentRolloutRollbackSuggestionV2[];
}

export interface DeploymentRolloutBatchExecutionResultV2 {
  schemaVersion: DeploymentRolloutSchemaVersion;
  rolloutId: string;
  rolloutReviewId: string;
  rolloutPlanDigest: string;
  batchIndex: number;
  batchDigest: string;
  phase: DeploymentRolloutPhaseV2;
  circuitOpen: boolean;
  circuitReason?: DeploymentRolloutCircuitReasonV2;
  targetResults: DeploymentExecutionResultV2[];
  detail: DeploymentRolloutDetailV2;
}
