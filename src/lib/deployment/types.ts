export type DeploymentJsonPrimitive = string | number | boolean | null;
export type DeploymentJsonValue =
  | DeploymentJsonPrimitive
  | readonly DeploymentJsonValue[]
  | { readonly [key: string]: DeploymentJsonValue };
export type DeploymentJsonObject = {
  readonly [key: string]: DeploymentJsonValue;
};

export type Sha256Digest = `sha256:${string}`;
export type DeploymentArtifactReference =
  `deployment-artifact:${Sha256Digest}`;

export type DeploymentPortType =
  | 'source.snapshot'
  | 'artifact.bundle'
  | 'target.snapshot'
  | 'release.candidate'
  | 'transfer.receipt'
  | 'release.receipt'
  | 'activation.receipt'
  | 'verification.evidence'
  | 'control.approval'
  | 'scalar.string'
  | 'scalar.boolean'
  | 'scalar.integer';

export type DeploymentEffectClass =
  | 'pure'
  | 'localRead'
  | 'localBuild'
  | 'remoteRead'
  | 'control'
  | 'remoteWrite'
  | 'serviceControl'
  | 'trafficSwitch'
  | 'cleanup'
  | 'finalizer';

export type DeploymentExecutionDomain = 'local' | 'target' | 'nativeUi';
export type DeploymentRiskLevel = 'low' | 'medium' | 'high' | 'critical';

export interface DeploymentPortBinding {
  fromNodeId: string;
  fromPort: string;
}

export interface DeploymentNodeRetryPolicy {
  maxAttempts: number;
  initialBackoffSeconds: number;
  maxBackoffSeconds: number;
}

export type DeploymentScalarValue = string | number | boolean;

export type DeploymentNodeCondition =
  | {
      op: 'equals';
      input: DeploymentPortBinding;
      value: DeploymentScalarValue;
    }
  | {
      op: 'in';
      input: DeploymentPortBinding;
      values: readonly DeploymentScalarValue[];
    }
  | { op: 'exists'; input: DeploymentPortBinding };

export interface DeploymentWorkflowTarget {
  id: string;
  connectionProfileId: string;
  remoteRoot: string;
}

export interface DeploymentWorkflowParameter {
  id: string;
  displayName: string;
  type: 'string' | 'boolean' | 'integer';
  required: boolean;
  defaultValue?: DeploymentScalarValue;
}

export interface DeploymentWorkflowNode {
  id: string;
  type: string;
  typeVersion: number;
  displayName: string;
  inputs: Readonly<Record<string, DeploymentPortBinding>>;
  config: DeploymentJsonObject;
  timeoutSeconds: number;
  retry: DeploymentNodeRetryPolicy;
  runWhen: 'allSucceeded' | 'anyFailed' | 'always';
  condition?: DeploymentNodeCondition;
}

export interface DeploymentWorkflowPolicy {
  failFast: true;
  maxParallelLocalNodes: number;
  releasesToKeep: number;
  automaticRestore: boolean;
}

export interface DeploymentWorkflowDefinition {
  schemaVersion: 3;
  targets: readonly DeploymentWorkflowTarget[];
  parameters: readonly DeploymentWorkflowParameter[];
  nodes: readonly DeploymentWorkflowNode[];
  outputs: Readonly<Record<string, DeploymentPortBinding>>;
  policy: DeploymentWorkflowPolicy;
}

export interface DeploymentWorkflowNodeLayout {
  x: number;
  y: number;
  collapsed?: boolean;
}

export interface DeploymentWorkflowLayoutGroup {
  id: string;
  title: string;
  nodeIds: readonly string[];
}

export interface DeploymentWorkflowLayout {
  schemaVersion: 1;
  nodes: Readonly<Record<string, DeploymentWorkflowNodeLayout>>;
  groups: readonly DeploymentWorkflowLayoutGroup[];
  viewport?: { x: number; y: number; zoom: number };
}

export type DeploymentArtifactRole =
  | 'application'
  | 'deployment-config'
  | 'metadata'
  | 'sbom'
  | 'signature'
  | 'auxiliary';

export interface DeploymentArtifactDescriptor {
  name: string;
  role: DeploymentArtifactRole;
  mediaType: string;
  digest: Sha256Digest;
  size: number;
  platform?: {
    os?: string;
    architecture?: string;
    variant?: string;
  };
  annotations: Readonly<Record<string, string>>;
}

export interface DeploymentArtifactBundleManifest {
  schemaVersion: 2;
  artifactType: string;
  source: {
    revision: string;
    dirty: boolean;
    snapshotDigest: Sha256Digest;
  };
  components: readonly DeploymentArtifactDescriptor[];
  producer: {
    nodeType: string;
    nodeTypeVersion: number;
    configDigest: Sha256Digest;
  };
  annotations: Readonly<Record<string, string>>;
}

export interface DeploymentArtifactHandle {
  artifactReference: DeploymentArtifactReference;
  manifestDigest: Sha256Digest;
  contentDigest: Sha256Digest;
}

export type DeploymentNodeCategory =
  | 'source'
  | 'build'
  | 'artifact'
  | 'target'
  | 'release'
  | 'control'
  | 'transfer'
  | 'runtime'
  | 'deploy'
  | 'verify'
  | 'proxy'
  | 'finalize';

export type DeploymentNodeCapability =
  | 'sourceSnapshot'
  | 'packageManager'
  | 'dockerBuildx'
  | 'ssh'
  | 'sftp'
  | 'atomicSymlink'
  | 'dockerRuntime'
  | 'dockerCompose'
  | 'httpProbe'
  | 'nginx'
  | 'notification';

export interface DeploymentNodePortSpec {
  name: string;
  portType: DeploymentPortType;
  required: boolean;
  artifactTypes?: readonly string[];
}

export interface DeploymentNodeCompensationSpec {
  kind: string;
  fixedActions: readonly string[];
}

export type DeploymentNodeConfigFieldKind =
  | 'string'
  | 'integer'
  | 'boolean'
  | 'select'
  | 'stringList'
  | 'integerList';

export interface DeploymentNodeConfigOption {
  value: string;
  labelKey: string;
}

export interface DeploymentNodeConfigFieldSpec {
  name: string;
  labelKey: string;
  descriptionKey: string;
  kind: DeploymentNodeConfigFieldKind;
  required: boolean;
  options?: readonly DeploymentNodeConfigOption[];
  minimum?: number;
  maximum?: number;
}

export interface DeploymentNodeConfigSchema {
  schemaVersion: 1;
  fields: readonly DeploymentNodeConfigFieldSpec[];
}

export interface DeploymentNodeTypeSpec {
  typeName: string;
  typeVersion: number;
  displayNameKey: string;
  descriptionKey: string;
  category: DeploymentNodeCategory;
  inputs: readonly DeploymentNodePortSpec[];
  outputs: readonly DeploymentNodePortSpec[];
  executionDomain: DeploymentExecutionDomain;
  effectClass: DeploymentEffectClass;
  capabilities: readonly DeploymentNodeCapability[];
  configSchemaVersion: number;
  configSchema: DeploymentNodeConfigSchema;
  defaultConfig: DeploymentJsonObject;
  riskLevel: DeploymentRiskLevel;
  fixedActions: readonly string[];
  compensation?: DeploymentNodeCompensationSpec;
  retryable: boolean;
}

export interface DeploymentNodeTypeCatalog {
  schemaVersion: 1;
  nodes: readonly DeploymentNodeTypeSpec[];
}

export interface DeploymentCompiledNodePlan {
  nodeId: string;
  displayName: string;
  nodeType: string;
  nodeTypeVersion: number;
  executionDomain: DeploymentExecutionDomain;
  effectClass: DeploymentEffectClass;
  targetId?: string;
  configDigest: Sha256Digest;
  inputDigest: Sha256Digest;
  timeoutSeconds: number;
  retry: DeploymentNodeRetryPolicy;
  fixedActions: readonly string[];
}

export interface DeploymentPlanRiskEntry {
  nodeId: string;
  level: DeploymentRiskLevel;
  effectClass: DeploymentEffectClass;
  summaryKey: string;
}

export interface DeploymentPlannedCompensation {
  nodeId: string;
  compensationKind: string;
  fixedActions: readonly string[];
}

export interface DeploymentCompiledRunPlanDraft {
  schemaVersion: 1;
  definitionDigest: Sha256Digest;
  planDigest: Sha256Digest;
  topologyLayers: readonly (readonly string[])[];
  targetEffectLanes: Readonly<Record<string, readonly string[]>>;
  nodes: readonly DeploymentCompiledNodePlan[];
  risks: {
    highestLevel: DeploymentRiskLevel;
    entries: readonly DeploymentPlanRiskEntry[];
  };
  compensations: readonly DeploymentPlannedCompensation[];
  policy: DeploymentWorkflowPolicy;
}

export interface DeploymentFrozenSourceSnapshot {
  sourceRef: string;
  revision: string;
  dirty: boolean;
  snapshotDigest: Sha256Digest;
  metadataDigest: Sha256Digest;
}

export interface DeploymentFrozenTargetIdentity {
  targetId: string;
  connectionProfileId: string;
  profileRevision: number;
  hostIdentityDigest: Sha256Digest;
  remoteRoot: string;
  capabilitiesDigest: Sha256Digest;
}

export interface DeploymentFrozenReleaseIdentity {
  releaseId: string;
  artifactContentDigest: Sha256Digest;
  layoutDigest: Sha256Digest;
}

export interface DeploymentImmutableRunPlan {
  schemaVersion: 1;
  workflowId: string;
  workflowRevision: number;
  runId: string;
  operationKind: 'deploy' | 'rollback';
  triggerKind: 'manual' | 'agent' | 'quickAction' | 'recovery';
  definitionDigest: Sha256Digest;
  parameters: Readonly<Record<string, DeploymentScalarValue>>;
  source: DeploymentFrozenSourceSnapshot;
  target: DeploymentFrozenTargetIdentity;
  artifacts: readonly DeploymentArtifactHandle[];
  currentRelease?: DeploymentFrozenReleaseIdentity;
  previousRelease?: DeploymentFrozenReleaseIdentity;
  targetRelease: DeploymentFrozenReleaseIdentity;
  executorVersions: Readonly<Record<string, string>>;
  compiled: DeploymentCompiledRunPlanDraft;
  preparedAt: number;
  expiresAt: number;
  planDigest: Sha256Digest;
}

export type DeploymentWorkflowValidationCode =
  | 'INVALID_JSON'
  | 'JSON_TOO_LARGE'
  | 'UNSUPPORTED_SCHEMA_VERSION'
  | 'LIMIT_EXCEEDED'
  | 'INVALID_IDENTIFIER'
  | 'DUPLICATE_IDENTIFIER'
  | 'INVALID_PATH'
  | 'INVALID_POLICY'
  | 'UNKNOWN_NODE_TYPE'
  | 'UNSUPPORTED_NODE_VERSION'
  | 'INVALID_NODE_CONFIG'
  | 'DANGEROUS_CONFIG'
  | 'INVALID_RETRY'
  | 'INVALID_RUN_CONDITION'
  | 'MISSING_INPUT'
  | 'UNKNOWN_INPUT_PORT'
  | 'UNKNOWN_OUTPUT_PORT'
  | 'DANGLING_BINDING'
  | 'PORT_TYPE_MISMATCH'
  | 'ARTIFACT_TYPE_MISMATCH'
  | 'INVALID_CONDITION'
  | 'CYCLE_DETECTED'
  | 'UNREACHABLE_NODE'
  | 'MISSING_ARTIFACT_PRODUCER'
  | 'MISSING_APPROVAL'
  | 'APPROVAL_BYPASS'
  | 'MISSING_DEPLOYMENT'
  | 'MISSING_VERIFICATION'
  | 'VERIFICATION_NOT_COVERED'
  | 'UNKNOWN_TARGET'
  | 'TARGET_MISMATCH'
  | 'CAPABILITY_NOT_COVERED'
  | 'CROSS_TARGET_EFFECTS'
  | 'COMPENSATION_NOT_COVERED'
  | 'INVALID_ARTIFACT';

export interface DeploymentWorkflowValidationError {
  code: DeploymentWorkflowValidationCode;
  message: string;
  path?: string;
  nodeId?: string;
}

export interface DeploymentEffectReceipt {
  schemaVersion: 1;
  receiptType: string;
  operationId: string;
  runId: string;
  nodeId: string;
  attempt: number;
  targetId: string;
  planDigest: Sha256Digest;
  payloadDigest: Sha256Digest;
}

export interface DeploymentVerificationEvidence {
  schemaVersion: 1;
  evidenceType: string;
  runId: string;
  nodeId: string;
  targetId: string;
  planDigest: Sha256Digest;
  observedAt: number;
  outcome: string;
  payloadDigest: Sha256Digest;
}

export type DeploymentNodeAttemptStatus =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'canceled'
  | 'stateUnknown'
  | 'compensated';

export interface DeploymentNodeAttempt {
  schemaVersion: 1;
  runId: string;
  nodeId: string;
  attempt: number;
  idempotencyKey: string;
  status: DeploymentNodeAttemptStatus;
  startedAt?: number;
  finishedAt?: number;
  failureCategory?: string;
}

export interface DeploymentCompensationRecord {
  schemaVersion: 1;
  runId: string;
  nodeId: string;
  compensationKind: string;
  idempotencyKey: string;
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'stateUnknown';
  receipt?: DeploymentEffectReceipt;
}

export interface DeploymentWorkflowCapabilities {
  schemaVersion: 1;
  admissionsEnabled: boolean;
  defaultEnabled: true;
  flagName: 'SHELLSPAN_DEPLOYMENT_WORKFLOW';
  source: 'defaultEnabled' | 'environment' | 'invalidEnvironment';
  readOnlyAvailable: true;
  cancelRecoveryAuditAvailable: true;
  coordinatorAvailable: boolean;
}

export interface DeploymentWorkflowValidationResult {
  valid: boolean;
  errors: readonly DeploymentWorkflowValidationError[];
  compiled?: DeploymentCompiledRunPlanDraft;
}

export interface CreateDeploymentWorkflowInput {
  name: string;
  definition: DeploymentWorkflowDefinition;
  layout?: DeploymentWorkflowLayout;
  enabled: boolean;
}

export interface CreateStaticSiteDeploymentWorkflowInput {
  name: string;
  connectionProfileId: string;
  remoteRoot: string;
  enabled: boolean;
}

export interface UpdateDeploymentWorkflowInput {
  name: string;
  definition: DeploymentWorkflowDefinition;
  enabled: boolean;
}

export interface UpdateDeploymentWorkflowLayoutInput {
  layout: DeploymentWorkflowLayout;
}

export interface DeploymentWorkflowRecord {
  id: string;
  name: string;
  enabled: boolean;
  archived: boolean;
  revision: number;
  definitionDigest: Sha256Digest;
  definition: DeploymentWorkflowDefinition;
  layoutRevision: number;
  layout?: DeploymentWorkflowLayout;
  createdAt: number;
  updatedAt: number;
}

export interface DeploymentWorkflowPage {
  items: readonly DeploymentWorkflowRecord[];
  nextCursor: string | null;
}

export interface DeploymentWorkflowLayoutRecord {
  workflowId: string;
  layoutRevision: number;
  layoutDigest: Sha256Digest;
  layout: DeploymentWorkflowLayout;
  createdAt: number;
}

export interface PrepareDeploymentRunInput {
  workflowId: string;
  workflowRevision: number;
  operationKind: 'deploy' | 'rollback';
  triggerKind: 'manual' | 'agent' | 'quickAction' | 'recovery';
  parameters: Readonly<Record<string, DeploymentScalarValue>>;
  rollbackReleaseId?: string;
}

export interface DeploymentRunPlanBindingInput {
  runId: string;
  planDigest: Sha256Digest;
}

export interface DeploymentRunIdInput {
  runId: string;
}

export interface DeploymentPrepareResult {
  runId: string;
  planDigest: Sha256Digest;
  expiresAt: number;
}

export interface DeploymentRunProjection {
  runId: string;
  status: string;
  planDigest: Sha256Digest;
}

export interface DeploymentReconciliationResult {
  runId: string;
  status: string;
  evidenceComplete: boolean;
}

export interface DeploymentAuditExportResult {
  schemaVersion: 3;
  runId: string;
  saved: boolean;
  bytes: number;
  documentSha256: string;
}

export interface DeploymentNodeProgressEvent {
  operationId: string;
  runId: string;
  nodeId: string;
  attempt: number;
  sequence: number;
  phase: 'running' | 'succeeded' | 'failed';
  completed: number;
  total: number;
  unit: 'steps';
  summaryKey: string;
}

export type DeploymentRunNodeStatus =
  | 'pending'
  | 'ready'
  | 'running'
  | 'awaiting_approval'
  | 'succeeded'
  | 'skipped'
  | 'retry_waiting'
  | 'cancel_requested'
  | 'canceled'
  | 'failed'
  | 'state_unknown'
  | 'compensating'
  | 'compensated';

export interface DeploymentRunNodeRecord {
  runId: string;
  nodeId: string;
  nodeType: string;
  nodeTypeVersion: number;
  status: DeploymentRunNodeStatus;
  lastAttempt: number;
  outputSummary?: DeploymentJsonValue;
  startedAt?: number;
  finishedAt?: number;
  updatedAt: number;
}

export interface DeploymentNodeAttemptRecord extends DeploymentNodeAttempt {
  nodeType: string;
  nodeTypeVersion: number;
  executorVersion: string;
  createdAt: number;
  updatedAt: number;
}

export interface DeploymentNodeAttemptPage {
  items: readonly DeploymentNodeAttemptRecord[];
  nextBeforeAttempt: number | null;
}

export interface DeploymentArtifactRetention {
  referenceCount: number;
  leaseCount: number;
  currentRelease: boolean;
  previousRelease: boolean;
  retainedUntil?: number;
  protected: boolean;
}

export interface DeploymentArtifactInspection {
  handle: DeploymentArtifactHandle;
  manifest: DeploymentArtifactBundleManifest;
  componentCount: number;
  totalSize: number;
  retention: DeploymentArtifactRetention;
  references: readonly DeploymentArtifactReferenceRecord[];
}

export interface DeploymentArtifactReferenceRecord {
  workflowId: string | null;
  runId: string | null;
  nodeId: string | null;
  referenceKind: 'run' | 'node' | 'release_current' | 'release_previous' | 'audit';
  ownerId: string;
  leaseActive: boolean;
  retainUntil: number | null;
  createdAt: number;
}

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

export interface DeploymentRunSummary {
  runId: string;
  workflowId: string;
  workflowRevision: number;
  operationKind: 'deploy' | 'rollback';
  triggerKind: 'manual' | 'agent' | 'quickAction' | 'recovery';
  status: DeploymentRunStatus;
  planDigest: Sha256Digest;
  targetRelease: DeploymentFrozenReleaseIdentity;
  artifactReferences: readonly DeploymentArtifactReference[];
  expiresAt: number;
  expired: boolean;
  planDrifted: boolean;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface DeploymentRunPage {
  items: readonly DeploymentRunSummary[];
  nextCursor: string | null;
}

export interface DeploymentApprovalArtifactSummary {
  handle: DeploymentArtifactHandle;
  artifactType: string;
  components: readonly DeploymentArtifactDescriptor[];
  componentCount: number;
  totalSize: number;
}

export interface DeploymentApprovalEffectSummary {
  nodeId: string;
  displayName: string;
  effectClass: DeploymentEffectClass;
  fixedActions: readonly string[];
}

export interface DeploymentApprovalSummary {
  schemaVersion: 1;
  workflowId: string;
  workflowRevision: number;
  definitionDigest: Sha256Digest;
  runId: string;
  operationKind: 'deploy' | 'rollback';
  triggerKind: 'manual' | 'agent' | 'quickAction' | 'recovery';
  parameters: Readonly<Record<string, DeploymentScalarValue>>;
  planDigest: Sha256Digest;
  preparedAt: number;
  expiresAt: number;
  source: DeploymentFrozenSourceSnapshot;
  target: DeploymentFrozenTargetIdentity;
  preflight: DeploymentJsonObject;
  artifacts: readonly DeploymentApprovalArtifactSummary[];
  currentRelease?: DeploymentFrozenReleaseIdentity;
  previousRelease?: DeploymentFrozenReleaseIdentity;
  targetRelease: DeploymentFrozenReleaseIdentity;
  effects: readonly DeploymentApprovalEffectSummary[];
  risks: {
    highestLevel: DeploymentRiskLevel;
    entries: readonly DeploymentPlanRiskEntry[];
  };
  compensations: readonly DeploymentPlannedCompensation[];
  verificationNodes: readonly string[];
  retention: number;
}

export interface DeploymentRunOutputProjection {
  nodeId: string;
  outputName: string;
  outputKind: 'scalar' | 'artifact' | 'receipt' | 'evidence';
  value: DeploymentJsonValue;
  artifactReference: DeploymentArtifactReference | null;
  createdAt: number;
}

export interface DeploymentRunDetail {
  summary: DeploymentRunSummary;
  approvalSummary: DeploymentApprovalSummary | null;
  outputs: readonly DeploymentRunOutputProjection[];
  receipts: readonly DeploymentEffectReceipt[];
}

export interface DeploymentRunEvent {
  runId: string;
  sequence: number;
  nodeId: string | null;
  attempt: number | null;
  eventKind: string;
  status: string | null;
  summaryKey: string;
  payload: DeploymentJsonObject | null;
  recordedAt: number;
}

export interface DeploymentRunEventPage {
  items: readonly DeploymentRunEvent[];
  nextBeforeSequence: number | null;
}

export interface DeploymentReleaseRecord {
  workflowId: string;
  releaseId: string;
  position: 'current' | 'previous';
  artifactReference: DeploymentArtifactReference;
  manifestDigest: Sha256Digest;
  contentDigest: Sha256Digest;
  artifactType: string;
  identity: DeploymentFrozenReleaseIdentity | null;
  sourceRunId: string | null;
  activatedAt: number | null;
  rollbackable: boolean;
}
