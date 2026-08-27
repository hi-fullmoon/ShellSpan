import type { RunbookDocument, RunbookRisk } from '@/types/runbook';

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
