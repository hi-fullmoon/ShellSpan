import type { RunbookDocument, RunbookRisk } from '@/types/runbook';
import type { RemoteConnectionRequest } from '@/types';

export type DeploymentRunbookSchemaVersion = 2;
export type DeploymentArtifactKind = 'file' | 'archive';
export type DeploymentArchiveFormat = 'tar' | 'tarGz' | 'zip';
export type DeploymentServiceActionKind = 'start' | 'restart' | 'reload';

export interface DeploymentIdentityV2 {
  id: string;
  applicationId: string;
  environment: string;
  version: string;
}

export interface DeploymentArtifactUnpackV2 {
  format: DeploymentArchiveFormat;
  destinationPath: string;
  stripComponents: number;
}

export interface DeploymentArtifactV2 {
  id: string;
  description: string;
  kind: DeploymentArtifactKind;
  sourceUri: string;
  sha256: string;
  targetPath: string;
  sizeBytes?: number;
  credentialRef?: string;
  unpack?: DeploymentArtifactUnpackV2;
}

export interface DeploymentReleaseV2 {
  rootDirectory: string;
  releasesDirectory: string;
  releaseDirectory: string;
  activeSymlink: string;
  activationStrategy: 'atomicSymlinkSwap';
}

export interface DeploymentServiceV2 {
  id: string;
  manager: 'systemd';
  unit: string;
}

export interface DeploymentServiceActionV2 {
  id: string;
  serviceId: string;
  action: DeploymentServiceActionKind;
  risk: RunbookRisk;
  timeoutSeconds: number;
}

interface DeploymentHealthCheckBaseV2 {
  id: string;
  timeoutSeconds: number;
  attempts: number;
  intervalSeconds: number;
}

export interface DeploymentHttpHealthCheckV2 extends DeploymentHealthCheckBaseV2 {
  kind: 'http';
  url: string;
  expectedStatus: number;
}

export interface DeploymentServiceHealthCheckV2 extends DeploymentHealthCheckBaseV2 {
  kind: 'service';
  serviceId: string;
  expectedState: 'active';
}

export type DeploymentHealthCheckV2 =
  | DeploymentHttpHealthCheckV2
  | DeploymentServiceHealthCheckV2;

export interface DeploymentVerificationV2 {
  checks: DeploymentHealthCheckV2[];
}

export interface DeploymentRollbackV2 {
  strategy: 'reactivatePreviousRelease';
  serviceActions: DeploymentServiceActionV2[];
  verificationCheckIds: string[];
}

export interface DeploymentSecretReferenceV2 {
  id: string;
  keychainRef: string;
}

export interface DeploymentApprovalPolicyV2 {
  deployment: 'explicit';
  rollback: 'separate';
  destructive: 'doubleConfirmation';
  targetBinding: 'frozenProfile';
}

export interface DeploymentSecurityV2 {
  declaredRisk: RunbookRisk;
  allowPrivilegeEscalation: boolean;
  approval: DeploymentApprovalPolicyV2;
  secretRefs: DeploymentSecretReferenceV2[];
}

export interface DeploymentRunbookDocumentV2 {
  schemaVersion: DeploymentRunbookSchemaVersion;
  kind: 'deployment';
  id: string;
  name: string;
  description: string;
  deployment: DeploymentIdentityV2;
  artifacts: DeploymentArtifactV2[];
  release: DeploymentReleaseV2;
  services: DeploymentServiceV2[];
  serviceActions: DeploymentServiceActionV2[];
  verification: DeploymentVerificationV2;
  rollback: DeploymentRollbackV2;
  security: DeploymentSecurityV2;
}

export type VersionedRunbookDocument = RunbookDocument | DeploymentRunbookDocumentV2;

export interface DeploymentExecutionPolicyV2 {
  artifactTimeoutSeconds: number;
  maxArtifactBytes: number;
  maxExpandedBytes: number;
  maxArchiveEntries: number;
  totalTimeoutSeconds: number;
}

export interface DeploymentFrozenJumpHostIdentityV2 {
  host: string;
  port: number;
  username: string;
  authMethod: string;
}

export interface DeploymentFrozenTargetIdentityV2 {
  profileId: string;
  host: string;
  port: number;
  username: string;
  authMethod: string;
  jumpHost?: DeploymentFrozenJumpHostIdentityV2;
  identityDigest: string;
}

export type DeploymentExecutionActionKindV2 =
  | 'inspectRelease'
  | 'createRelease'
  | 'stageArtifact'
  | 'verifyArtifact'
  | 'activateRelease'
  | 'serviceAction'
  | 'httpHealthCheck'
  | 'serviceHealthCheck';

export interface DeploymentExecutionActionV2 {
  actionId: string;
  kind: DeploymentExecutionActionKindV2;
  target: string;
  normalizedParameters: string;
  parametersDigest: string;
  risk: RunbookRisk;
  mutating: boolean;
  timeoutSeconds: number;
}

export interface DeploymentArtifactDigestBindingV2 {
  artifactId: string;
  sha256: string;
  targetPath: string;
}

export interface DeploymentExecutionReviewRequestV2 {
  operationId: string;
  runbookText: string;
  profileId: string;
  connection: RemoteConnectionRequest;
  policy: DeploymentExecutionPolicyV2;
}

export interface DeploymentExecutionReviewV2 {
  schemaVersion: 2;
  reviewId: string;
  operationId: string;
  normalizedRunbookText: string;
  documentDigest: string;
  planDigest: string;
  deploymentId: string;
  applicationId: string;
  environment: string;
  version: string;
  artifactDigests: DeploymentArtifactDigestBindingV2[];
  declaredRisk: RunbookRisk;
  target: DeploymentFrozenTargetIdentityV2;
  policy: DeploymentExecutionPolicyV2;
  actions: DeploymentExecutionActionV2[];
  reviewedAt: number;
  expiresAt: number;
}

export interface DeploymentExecutionApprovalV2 {
  reviewId: string;
  operationId: string;
  documentDigest: string;
  planDigest: string;
  targetDigest: string;
  approvedRisk: RunbookRisk;
  authorized: boolean;
  destructiveConfirmed: boolean;
}

export interface DeploymentExecutionRequestV2 {
  operationId: string;
  runbookText: string;
  profileId: string;
  connection: RemoteConnectionRequest;
  approval: DeploymentExecutionApprovalV2;
}

export type DeploymentExecutionPhaseV2 =
  | 'pending'
  | 'preparingArtifacts'
  | 'inspectingTarget'
  | 'creatingRelease'
  | 'stagingArtifacts'
  | 'activatingRelease'
  | 'applyingServices'
  | 'verifying'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'timedOut'
  | 'identityMismatch'
  | 'unauthorized';

export type DeploymentExecutionActionStatusV2 =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'timedOut'
  | 'identityMismatch';

export interface DeploymentExecutionActionResultV2 extends DeploymentExecutionActionV2 {
  childOperationId: string;
  status: DeploymentExecutionActionStatusV2;
  startedAt?: number;
  completedAt?: number;
  exitCode?: number;
  output?: string;
  error?: string;
}

export interface DeploymentHealthCheckResultV2 {
  checkId: string;
  kind: 'http' | 'service';
  status: 'passed' | 'failed' | 'cancelled' | 'timedOut';
  attemptsUsed: number;
  observedStatus?: number;
  observedState?: string;
  error?: string;
}

export interface DeploymentRollbackSnapshotV2 {
  strategy: 'reactivatePreviousRelease';
  previousRelease?: string;
  newRelease: string;
  releasesDirectory: string;
  activeSymlink: string;
  activationChanged: boolean;
  capturedAt?: number;
}

export interface DeploymentExecutionResultV2 {
  schemaVersion: 2;
  operationId: string;
  reviewId: string;
  documentDigest: string;
  planDigest: string;
  deploymentId: string;
  version: string;
  target: DeploymentFrozenTargetIdentityV2;
  phase: DeploymentExecutionPhaseV2;
  startedAt: number;
  completedAt: number;
  actions: DeploymentExecutionActionResultV2[];
  healthChecks: DeploymentHealthCheckResultV2[];
  rollbackSnapshot: DeploymentRollbackSnapshotV2;
  errorCategory?: string;
  error?: string;
}

export type RollbackExecutionActionKindV2 =
  | 'inspectReactivation'
  | 'reactivatePreviousRelease'
  | 'serviceAction'
  | 'httpHealthCheck'
  | 'serviceHealthCheck';

export interface RollbackExecutionActionV2 {
  actionId: string;
  kind: RollbackExecutionActionKindV2;
  target: string;
  normalizedParameters: string;
  parametersDigest: string;
  risk: RunbookRisk;
  mutating: boolean;
  timeoutSeconds: number;
}

export interface RollbackExecutionReviewRequestV2 {
  operationId: string;
  sourceOperationId: string;
  profileId: string;
  connection: RemoteConnectionRequest;
  totalTimeoutSeconds: number;
}

export interface RollbackExecutionReviewV2 {
  schemaVersion: 2;
  reviewId: string;
  operationId: string;
  sourceOperationId: string;
  sourceReviewId: string;
  sourcePhase: string;
  documentDigest: string;
  planDigest: string;
  deploymentId: string;
  applicationId: string;
  environment: string;
  version: string;
  currentRelease: string;
  previousRelease: string;
  releasesDirectory: string;
  activeSymlink: string;
  snapshotCapturedAt: number;
  declaredRisk: RunbookRisk;
  target: DeploymentFrozenTargetIdentityV2;
  totalTimeoutSeconds: number;
  actions: RollbackExecutionActionV2[];
  reviewedAt: number;
  expiresAt: number;
}

export interface RollbackExecutionApprovalV2 {
  reviewId: string;
  operationId: string;
  sourceOperationId: string;
  documentDigest: string;
  planDigest: string;
  targetDigest: string;
  currentRelease: string;
  previousRelease: string;
  approvedRisk: RunbookRisk;
  authorized: boolean;
  destructiveConfirmed: boolean;
}

export interface RollbackExecutionRequestV2 {
  operationId: string;
  profileId: string;
  connection: RemoteConnectionRequest;
  approval: RollbackExecutionApprovalV2;
}

export type RollbackExecutionPhaseV2 =
  | 'pending'
  | 'inspectingTarget'
  | 'reactivatingPreviousRelease'
  | 'applyingServices'
  | 'verifying'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'timedOut'
  | 'identityMismatch'
  | 'unauthorized';

export interface RollbackExecutionActionResultV2 extends RollbackExecutionActionV2 {
  childOperationId: string;
  status: DeploymentExecutionActionStatusV2;
  startedAt?: number;
  completedAt?: number;
  exitCode?: number;
  output?: string;
  error?: string;
}

export interface RollbackHealthEvidenceV2 {
  checkId: string;
  kind: 'http' | 'service';
  status: 'passed' | 'failed' | 'cancelled' | 'timedOut';
  attemptsUsed: number;
  observedStatus?: number;
  observedState?: string;
  error?: string;
}

export interface RollbackReactivationResultV2 {
  currentRelease: string;
  previousRelease: string;
  releasesDirectory: string;
  activeSymlink: string;
  activationChanged: boolean;
  changedAt?: number;
}

export interface RollbackExecutionResultV2 {
  schemaVersion: 2;
  operationId: string;
  reviewId: string;
  sourceOperationId: string;
  documentDigest: string;
  planDigest: string;
  deploymentId: string;
  version: string;
  target: DeploymentFrozenTargetIdentityV2;
  phase: RollbackExecutionPhaseV2;
  startedAt: number;
  completedAt: number;
  actions: RollbackExecutionActionResultV2[];
  healthEvidence: RollbackHealthEvidenceV2[];
  reactivation: RollbackReactivationResultV2;
  errorCategory?: string;
  error?: string;
}

export interface DeploymentOperationListRequestV2 {
  operationKind?: 'deployment' | 'rollback' | 'cleanup';
  targetDigest?: string;
  recoveryRequired?: boolean;
  limit?: number;
}

export interface DeploymentOperationSummaryV2 {
  operationId: string;
  reviewId: string;
  operationKind: 'deployment' | 'rollback' | 'cleanup';
  sourceOperationId?: string;
  documentDigest: string;
  planDigest: string;
  targetDigest: string;
  deploymentId: string;
  applicationId: string;
  environment: string;
  version: string;
  phase: DeploymentExecutionPhaseV2 | RollbackExecutionPhaseV2 | 'interrupted';
  terminal: boolean;
  recoveryRequired: boolean;
  startedAt: number;
  completedAt?: number;
  errorCategory?: string;
  error?: string;
}

export interface DeploymentOperationDetailV2 extends DeploymentOperationSummaryV2 {
  review: DeploymentExecutionReviewV2 | RollbackExecutionReviewV2 | DeploymentReleaseCleanupReviewV2 | Record<string, unknown>;
  result?: DeploymentExecutionResultV2 | RollbackExecutionResultV2 | Record<string, unknown>;
  actions: Array<Record<string, unknown>>;
  healthEvidence: Array<Record<string, unknown>>;
}

export interface DeploymentReleaseCleanupCandidateV2 {
  candidateId: string;
  targetDigest: string;
  releasePath: string;
  releasesDirectory: string;
  activeSymlink: string;
  deploymentId: string;
  applicationId: string;
  environment: string;
  version: string;
  sourceOperationId: string;
  lastVerifiedAt: number;
}

export interface DeploymentReleaseCleanupReviewRequestV2 {
  operationId: string;
  candidateId: string;
  profileId: string;
  connection: RemoteConnectionRequest;
}

export interface DeploymentReleaseCleanupReviewV2 {
  schemaVersion: 2;
  reviewId: string;
  operationId: string;
  candidateId: string;
  sourceOperationId: string;
  deploymentId: string;
  applicationId: string;
  environment: string;
  version: string;
  releasePath: string;
  releasesDirectory: string;
  activeSymlink: string;
  target: DeploymentFrozenTargetIdentityV2;
  declaredRisk: 'destructive';
  documentDigest: string;
  planDigest: string;
  action: {
    actionId: 'cleanup-action-0';
    kind: 'removeRelease';
    target: string;
    normalizedParameters: string;
    parametersDigest: string;
    risk: 'destructive';
    mutating: true;
  };
  executableInPhase: false;
  reviewedAt: number;
  expiresAt: number;
}
