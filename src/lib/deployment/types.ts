export const DEPLOYMENT_WORKFLOW_SCHEMA_VERSION = 2 as const;
export const DEPLOYMENT_APPROVAL_SCHEMA_VERSION = 2 as const;

export interface DeploymentRuntimeCapabilities {
  schemaVersion: 1;
  admissionsEnabled: boolean;
  defaultEnabled: boolean;
  flagName: 'SHELLSPAN_DEPLOYMENT_CENTER_V1';
  source: 'default' | 'environment' | 'invalidEnvironment';
  readOnlyRecoveryAvailable: true;
  automaticReleaseCleanup: false;
}

export type DeploymentOperationKind = 'deploy' | 'resume' | 'rollback';

export type DeploymentTriggerKind = 'manual' | 'agent' | 'quick_action' | 'recovery';

export type DeploymentRunStatus =
  | 'planned'
  | 'awaiting_approval'
  | 'approved'
  | 'reconciling'
  | 'in_progress'
  | 'verifying'
  | 'succeeded'
  | 'cancel_requested'
  | 'canceled'
  | 'failed'
  | 'state_unknown';

export type DeploymentEventKind =
  | 'run_created'
  | 'approval_requested'
  | 'approval_granted'
  | 'approval_rejected'
  | 'reconciliation_started'
  | 'reconciliation_completed'
  | 'status_changed'
  | 'cancellation_requested'
  | 'resume_linked'
  | 'rollback_linked'
  | 'run_succeeded'
  | 'run_canceled'
  | 'run_failed';

export type ApprovedDeploymentAction =
  | 'stage_release'
  | 'prepare_release'
  | 'load_image'
  | 'compose_pull'
  | 'compose_config'
  | 'compose_up'
  | 'verify_health'
  | 'validate_nginx'
  | 'reload_nginx'
  | 'reverify_health'
  | 'activate_release'
  | 'automatic_restore'
  | 'restore_release';

export interface DeploymentTarget {
  connectionProfileId: string;
  remoteRoot: string;
}

export interface DockerComposePlan {
  projectName: string;
  files: string[];
  services: string[];
  pullBeforeUp: boolean;
}

export type DeploymentArtifactBuilderKind = 'dockerBuildx';

export type DeploymentArtifactCompression = 'zstd' | 'gzip' | 'none';

export interface DockerBuildxPlan {
  context: string;
  dockerfile: string;
  platform: 'linux/amd64' | 'linux/arm64';
  imageRepository: string;
  compression: DeploymentArtifactCompression;
}

export interface HttpHealthCheck {
  path: string;
  expectedStatus: number;
  timeoutSeconds: number;
}

/**
 * The v1 workflow is intentionally closed over typed Docker Compose inputs.
 * There is no arbitrary command or remote-shell field.
 */
export interface DeploymentWorkflowDefinition {
  schemaVersion: 1 | typeof DEPLOYMENT_WORKFLOW_SCHEMA_VERSION;
  sourceDirectory: string;
  build: DockerBuildxPlan;
  target: DeploymentTarget;
  compose: DockerComposePlan;
  healthCheck: HttpHealthCheck | null;
  reloadNginxAfterHealthy: boolean;
  releasesToKeep: number;
}

export interface DeploymentFrozenSourceRevision {
  revision: string;
  dirty: boolean;
}

export interface DeploymentJumpHostIdentitySnapshot {
  host: string;
  port: number;
  username: string;
  authMethod: 'password' | 'key';
}

export interface DeploymentTargetIdentitySnapshot {
  profileId: string;
  profileUpdatedAt: number;
  host: string;
  port: number;
  username: string;
  authMethod: 'password' | 'key';
  jumpHost: DeploymentJumpHostIdentitySnapshot | null;
}

export interface DeploymentReleaseIdentity {
  releaseId: string;
  artifactDigestSha256: string;
}

export type DeploymentPreflightOutcome = 'passed' | 'warning' | 'blocked';

export interface DeploymentPreflightCheckSummary {
  code: string;
  outcome: DeploymentPreflightOutcome;
  summary: string;
}

export interface DeploymentPreflightSummary {
  checkedAt: number;
  checks: DeploymentPreflightCheckSummary[];
}

export interface DeploymentPreflightRequest {
  operationId: string;
  workflowId: string;
  expectedRevision: number;
  artifactReference: string;
  ttlSeconds: number;
  timeoutMs: number;
}

export type DeploymentPreflightStatus =
  | 'passed'
  | 'blocked'
  | 'cancelled'
  | 'timedOut'
  | 'failed';

export type DeploymentPreflightFailureCategory =
  | 'invalidRequest'
  | 'workflowNotFound'
  | 'revisionConflict'
  | 'workflowDisabled'
  | 'profileNotFound'
  | 'targetChanged'
  | 'artifactInvalid'
  | 'sourceChanged'
  | 'sourceUnavailable'
  | 'sourceOutputLimit'
  | 'credentialUnavailable'
  | 'hostKeyRejected'
  | 'connectionFailed'
  | 'remoteCommandFailed'
  | 'remoteOutputLimit'
  | 'invalidRemoteOutput'
  | 'cancelled'
  | 'timedOut'
  | 'internal';

export interface DeploymentPreflightFailure {
  category: DeploymentPreflightFailureCategory;
  message: string;
}

export interface DeploymentPreflightResult {
  operationId: string;
  workflowId: string;
  workflowRevision: number | null;
  artifactReference: string;
  status: DeploymentPreflightStatus;
  checkedAt: number;
  source: {
    kind: 'gitAndSshReadOnly';
    commandSetVersion: string;
  };
  sourceRevision: DeploymentFrozenSourceRevision | null;
  target: DeploymentTargetIdentitySnapshot | null;
  server: {
    os: string;
    architecture: string;
  } | null;
  remoteRoot: {
    path: string;
    reachable: boolean;
    availableBytes: number;
  } | null;
  tools: {
    docker: boolean;
    compose: boolean;
    flock: boolean;
    curl: boolean;
    nginx: boolean;
    nginxReload: boolean;
    sha256: string | null;
    compression: string | null;
  } | null;
  currentRelease: DeploymentReleaseIdentity | null;
  rollbackReleases: DeploymentReleaseIdentity[];
  checks: DeploymentPreflightCheckSummary[];
  planInput: DeploymentPlanCreateInput | null;
  failure: DeploymentPreflightFailure | null;
}

export interface DeploymentArtifactSourceSnapshotRequest {
  workflowId: string;
  expectedRevision: number;
}

export interface DeploymentArtifactBuildRequest {
  operationId: string;
  workflowId: string;
  expectedRevision: number;
  sourceRevision: DeploymentFrozenSourceRevision;
  builderKind: DeploymentArtifactBuilderKind;
  timeoutMs: number;
}

export type DeploymentArtifactBuildStep =
  | 'validating'
  | 'checkingSource'
  | 'detectingTools'
  | 'buildingImage'
  | 'inspectingImage'
  | 'savingImage'
  | 'compressingArchive'
  | 'writingManifest'
  | 'verifyingArtifact'
  | 'completed';

export interface DeploymentArtifactBuildProgress {
  operationId: string;
  sequence: number;
  step: DeploymentArtifactBuildStep;
  completedBytes: number | null;
  totalBytes: number | null;
  summary: string;
}

export type DeploymentArtifactBuildStatus =
  | 'succeeded'
  | 'cancelled'
  | 'timedOut'
  | 'failed';

export type DeploymentArtifactBuildFailureCategory =
  | 'invalidRequest'
  | 'workflowNotFound'
  | 'revisionConflict'
  | 'workflowDisabled'
  | 'sourceUnavailable'
  | 'sourceChanged'
  | 'sourceDirty'
  | 'pathBoundary'
  | 'dockerUnavailable'
  | 'buildxUnavailable'
  | 'compressorUnavailable'
  | 'buildFailed'
  | 'inspectFailed'
  | 'saveFailed'
  | 'compressionFailed'
  | 'outputLimit'
  | 'cancelled'
  | 'timedOut'
  | 'artifactConflict'
  | 'artifactIo'
  | 'internal';

export interface DeploymentArtifactBuildFailure {
  category: DeploymentArtifactBuildFailureCategory;
  message: string;
}

export interface DeploymentArtifactArchiveManifest {
  fileName: string;
  compression: DeploymentArtifactCompression;
  bytes: number;
  sha256: string;
}

export interface DeploymentArtifactImageManifest {
  repository: string;
  tag: string;
  imageId: string;
}

export interface DeploymentArtifactComposeFileManifest {
  path: string;
  fileName: string;
  bytes: number;
  sha256: string;
}

export interface DeploymentArtifactManifest {
  schemaVersion: 1;
  contentIdentitySha256: string;
  workflowId: string;
  workflowRevision: number;
  sourceRevision: DeploymentFrozenSourceRevision;
  releaseId: string;
  platform: string;
  image: DeploymentArtifactImageManifest;
  archive: DeploymentArtifactArchiveManifest;
  composeFiles: DeploymentArtifactComposeFileManifest[];
  createdAt: number;
  manifestDigestSha256: string;
}

export interface DeploymentArtifactBuildResult {
  operationId: string;
  workflowId: string;
  workflowRevision: number | null;
  builderKind: DeploymentArtifactBuilderKind;
  status: DeploymentArtifactBuildStatus;
  sourceRevision: DeploymentFrozenSourceRevision | null;
  releaseId: string | null;
  artifactDigestSha256: string | null;
  artifactBytes: number | null;
  artifactReference: string | null;
  manifest: DeploymentArtifactManifest | null;
  reused: boolean;
  failure: DeploymentArtifactBuildFailure | null;
}

export interface DeploymentArtifactTransferRequest {
  operationId: string;
  planId: string;
  planDigest: string;
  workflowId: string;
  workflowRevision: number;
  artifactReference: string;
  sourceRevision: DeploymentFrozenSourceRevision;
  target: DeploymentTargetIdentitySnapshot;
  remoteRoot: string;
  releaseId: string;
  releaseDigestSha256: string;
  timeoutMs: number;
}

export type DeploymentArtifactTransferStep =
  | 'revalidate'
  | 'lock'
  | 'stageArchive'
  | 'stageCompose'
  | 'verifyRemote'
  | 'complete';

export interface DeploymentArtifactTransferProgress {
  operationId: string;
  sequence: number;
  step: DeploymentArtifactTransferStep;
  fileId: string | null;
  completedBytes: number | null;
  totalBytes: number | null;
  summary: string;
}

export type DeploymentArtifactTransferStatus =
  | 'succeeded'
  | 'cancelled'
  | 'timedOut'
  | 'failed'
  | 'stateUnknown';

export type DeploymentArtifactTransferFailureCategory =
  | 'invalidRequest'
  | 'planNotFound'
  | 'planDigestMismatch'
  | 'planExpired'
  | 'planNotApproved'
  | 'workflowNotFound'
  | 'revisionConflict'
  | 'workflowDisabled'
  | 'sourceChanged'
  | 'targetChanged'
  | 'artifactInvalid'
  | 'artifactChanged'
  | 'releaseChanged'
  | 'credentialUnavailable'
  | 'hostKeyRejected'
  | 'connectionFailed'
  | 'remotePathUnsafe'
  | 'remoteConflict'
  | 'remotePartialInvalid'
  | 'remoteIo'
  | 'remoteDigestMismatch'
  | 'cancelled'
  | 'timedOut'
  | 'stateUnknown'
  | 'internal';

export interface DeploymentArtifactTransferFailure {
  category: DeploymentArtifactTransferFailureCategory;
  message: string;
}

export interface DeploymentArtifactTransferResult {
  operationId: string;
  planId: string;
  releaseId: string;
  remoteStagingIdentity: string | null;
  transferredBytes: number;
  remoteDigestSha256: string | null;
  status: DeploymentArtifactTransferStatus;
  failure: DeploymentArtifactTransferFailure | null;
  reused: boolean;
  resumed: boolean;
}

/** Frozen Phase 5 input. It consumes an opaque verified staging identity, never a path. */
export interface DeploymentRemoteRunnerRequest {
  operationId: string;
  planId: string;
  planDigest: string;
  runId: string;
  runRevision: number;
  planExpiresAt: number;
  workflowId: string;
  workflowRevision: number;
  artifactReference: string;
  artifactTransferOperationId: string;
  sourceRevision: DeploymentFrozenSourceRevision;
  target: DeploymentTargetIdentitySnapshot;
  remoteRoot: string;
  releaseId: string;
  releaseDigestSha256: string;
  remoteStagingIdentity: string;
  timeoutMs: number;
}

export type DeploymentRemoteRunnerStep =
  | 'revalidate'
  | 'lock'
  | 'prepareRelease'
  | 'loadImage'
  | 'composePull'
  | 'composeConfig'
  | 'composeUp'
  | 'verifyHealth'
  | 'validateNginx'
  | 'reloadNginx'
  | 'reverifyHealth'
  | 'activateRelease'
  | 'restoreRelease'
  | 'recordResult';

export type DeploymentRemoteRunnerStatus =
  | 'running'
  | 'verifying'
  | 'succeeded'
  | 'cancelRequested'
  | 'cancelled'
  | 'rolledBack'
  | 'failed'
  | 'stateUnknown';

export interface DeploymentRemoteRunnerProgress {
  operationId: string;
  sequence: number;
  step: DeploymentRemoteRunnerStep;
  status: DeploymentRemoteRunnerStatus;
  summary: string;
}

export type DeploymentRemoteRunnerFailureCategory =
  | 'invalidRequest'
  | 'planNotFound'
  | 'planDigestMismatch'
  | 'planExpired'
  | 'planNotApproved'
  | 'workflowChanged'
  | 'sourceChanged'
  | 'targetChanged'
  | 'releaseChanged'
  | 'transferNotFound'
  | 'transferMismatch'
  | 'stagingInvalid'
  | 'lockConflict'
  | 'imageLoadFailed'
  | 'imageMismatch'
  | 'releasePrepareFailed'
  | 'composePullFailed'
  | 'composeConfigFailed'
  | 'composeUpFailed'
  | 'healthCheckFailed'
  | 'nginxValidationFailed'
  | 'nginxReloadFailed'
  | 'activationFailed'
  | 'rollbackFailed'
  | 'cancelled'
  | 'timedOut'
  | 'stateUnknown'
  | 'internal';

export interface DeploymentRemoteRunnerResult {
  operationId: string;
  planId: string;
  runId: string;
  releaseId: string;
  status: Exclude<DeploymentRemoteRunnerStatus, 'running' | 'verifying' | 'cancelRequested'>;
  activeRelease: DeploymentReleaseIdentity | null;
  rollbackRelease: DeploymentReleaseIdentity | null;
  reconciliationRequired: boolean;
  failureCategory: DeploymentRemoteRunnerFailureCategory | null;
}

export interface DeploymentFrozenPlanInputs {
  sourceRevision: DeploymentFrozenSourceRevision;
  target: DeploymentTargetIdentitySnapshot;
  currentRelease: DeploymentReleaseIdentity | null;
  targetRelease: DeploymentReleaseIdentity;
  rollbackRelease: DeploymentReleaseIdentity | null;
  preflight: DeploymentPreflightSummary;
}

export interface DeploymentApprovalPlanSummary {
  schemaVersion: 1 | typeof DEPLOYMENT_APPROVAL_SCHEMA_VERSION;
  workflowId: string;
  workflowRevision: number;
  operationKind: DeploymentOperationKind;
  artifactReference?: string;
  frozen: DeploymentFrozenPlanInputs;
  remoteRoot: string;
  composeProject: string;
  composeFiles: string[];
  services: string[];
  actions: ApprovedDeploymentAction[];
  generatedAt: number;
  expiresAt: number;
}

export interface DeploymentPlanCreateInput {
  workflowId: string;
  expectedRevision: number;
  sourceRunId: string | null;
  operationKind: DeploymentOperationKind;
  triggerKind: DeploymentTriggerKind;
  artifactReference: string;
  sourceRevision: DeploymentFrozenSourceRevision;
  target: DeploymentTargetIdentitySnapshot;
  currentRelease: DeploymentReleaseIdentity | null;
  targetRelease: DeploymentReleaseIdentity;
  rollbackRelease: DeploymentReleaseIdentity | null;
  preflight: DeploymentPreflightSummary;
  ttlSeconds: number;
}

export interface DeploymentApprovalRequest {
  planId: string;
  planDigest: string;
  runId: string;
  runRevision: number;
  expiresAt: number;
}

export type DeploymentApprovalDecisionRequest = DeploymentApprovalRequest;

export interface DeploymentRemoteRunnerCancelRequest {
  operationId: string;
  planId: string;
  planDigest: string;
  runId: string;
}

/** Frozen Phase 6 boundary. Startup recovery must reconcile before any effect. */
export interface DeploymentReconciliationRequest {
  operationId: string;
  planId: string;
  planDigest: string;
  runId: string;
  expectedRunRevision: number;
  artifactTransferOperationId: string;
  remoteStagingIdentity: string;
}

/** Frozen Phase 6 read-only startup discovery projection. */
export interface DeploymentStartupRecoveryCandidate {
  runId: string;
  planId: string;
  planDigest: string;
  status: Extract<DeploymentRunStatus, 'in_progress' | 'verifying' | 'cancel_requested' | 'state_unknown'>;
  lastEventSequence: number;
  reconciliationRequired: boolean;
}

export interface DeploymentStartupRecoveryResult {
  schemaVersion: 1;
  candidates: DeploymentStartupRecoveryCandidate[];
}

export interface DeploymentReconciliationBinding {
  candidate: DeploymentStartupRecoveryCandidate;
  artifactTransferOperationId: string;
  remoteStagingIdentity: string;
  reconciliationOperationId: string | null;
}

export type DeploymentReconciliationOutcome =
  | 'targetHealthy'
  | 'rollbackHealthy'
  | 'stillRunning'
  | 'noSideEffects'
  | 'stateUnknown'
  | 'observationStopped';

export interface DeploymentReconciliationEvidence {
  remoteSequence: number | null;
  runnerIdentityVerified: boolean;
  requestIdentityVerified: boolean;
  ledgerVerified: boolean;
  currentReleaseId: string | null;
  previousReleaseId: string | null;
  targetReleaseVerified: boolean;
  rollbackReleaseVerified: boolean;
  composeServicesVerified: boolean;
  healthVerified: boolean;
  sideEffectsStarted: boolean | null;
  approvalReusable: boolean;
}

export interface DeploymentReconciliationResult {
  operationId: string;
  planId: string;
  runId: string;
  status: DeploymentRunStatus;
  outcome: DeploymentReconciliationOutcome;
  reconciliationRequired: boolean;
  evidence: DeploymentReconciliationEvidence;
}

export interface DeploymentStoredPlanRecord {
  planId: string;
  planDigest: string;
  runId: string;
  runRevision: number;
  status: DeploymentRunStatus;
  approvalSummary: DeploymentApprovalPlanSummary;
  createdAt: number;
  expiresAt: number;
}

export interface DeploymentWorkflowRecord {
  id: string;
  name: string;
  connectionProfileId: string;
  revision: number;
  definition: DeploymentWorkflowDefinition;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface DeploymentWorkflowCreate {
  name: string;
  definition: DeploymentWorkflowDefinition;
  enabled: boolean;
}

export interface DeploymentWorkflowUpdate extends DeploymentWorkflowCreate {
  expectedRevision: number;
}

export interface DeploymentRunRecord {
  id: string;
  workflowId: string;
  workflowRevision: number;
  sourceRunId: string | null;
  operationKind: DeploymentOperationKind;
  triggerKind: DeploymentTriggerKind;
  status: DeploymentRunStatus;
  approvalSummary: DeploymentApprovalPlanSummary;
  approvalDigest: string;
  reconciliationRequired: boolean;
  lastEventSequence: number;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface DeploymentRunEvent {
  runId: string;
  sequence: number;
  eventKind: DeploymentEventKind;
  status: DeploymentRunStatus | null;
  summary: string;
  payload: Readonly<Record<string, unknown>> | null;
  recordedAt: number;
}

export interface DeploymentRunPage {
  items: DeploymentRunRecord[];
  nextCursor: string | null;
}

export interface DeploymentRunEventPage {
  items: DeploymentRunEvent[];
  nextBeforeSequence: number | null;
}

export interface DeploymentRunDetail {
  run: DeploymentRunRecord;
  events: DeploymentRunEvent[];
  nextBeforeSequence: number | null;
}

export interface DeploymentAuditExportResult {
  schemaVersion: 1;
  runId: string;
  saved: boolean;
  bytes: number;
  documentSha256: string;
}

export type DeploymentNotificationKind =
  | 'succeeded'
  | 'automaticRestoreCompleted'
  | 'failed'
  | 'userActionRequired';

export interface DeploymentNotificationReceipt {
  runId: string;
  workflowId: string;
  workflowName: string;
  eventSequence: number;
  status: Extract<
    DeploymentRunStatus,
    'awaiting_approval' | 'succeeded' | 'canceled' | 'failed' | 'state_unknown'
  >;
  kind: DeploymentNotificationKind;
  createdAt: number;
}

export interface DeploymentNotificationDisplayRequest {
  runId: string;
  title: string;
  body: string;
  openLabel: string;
}
