import type { RemoteConnectionRequest } from '@/types';
import type { OperationEvidenceReference } from '@/types/operation-history';

export type RunbookRisk = 'readOnly' | 'stateChange' | 'destructive';

export interface RunbookVariable {
  name: string;
  description: string;
  required: boolean;
  default?: string;
  keychainRef?: string;
}

export interface RunbookExpectedResult {
  exitCode: number;
  stdoutContains?: string[];
}

export interface RunbookPrecheck {
  id: string;
  description: string;
  command: string;
  expected: RunbookExpectedResult;
  timeoutSeconds: number;
}

export interface RunbookStep extends RunbookPrecheck {
  risk: RunbookRisk;
  impact: string;
  rollback?: string;
  safeToRetry: boolean;
}

export interface RunbookDocument {
  schemaVersion: 1;
  id: string;
  name: string;
  description: string;
  evidenceMaxAgeSeconds: number;
  variables: RunbookVariable[];
  prechecks: RunbookPrecheck[];
  steps: RunbookStep[];
}

export interface RunbookTarget {
  profileId: string;
  name: string;
  host: string;
  port: number;
  username: string;
}

export type RunbookRunItemKind = 'precheck' | 'step';
export type RunbookRunItemStatus =
  | 'queued'
  | 'awaitingApproval'
  | 'running'
  | 'completed'
  | 'skipped'
  | 'rejected'
  | 'cancelled'
  | 'timedOut'
  | 'failed';

export interface RunbookEvidence {
  operationId: string;
  profileId: string;
  host: string;
  port: number;
  username: string;
  startedAt: number;
  completedAt: number;
  exitCode?: number;
  expectedMatched: boolean;
  stdout?: string;
  stderr?: string;
}

export interface RunbookRunItem {
  id: string;
  kind: RunbookRunItemKind;
  description: string;
  commandPreview: string;
  risk: RunbookRisk;
  impact: string;
  rollback?: string;
  safeToRetry: boolean;
  timeoutSeconds: number;
  status: RunbookRunItemStatus;
  evidence?: RunbookEvidence;
  error?: string;
}

export type RunbookRunPhase =
  | 'awaitingApproval'
  | 'running'
  | 'paused'
  | 'stopped'
  | 'completed'
  | 'cancelled'
  | 'staleEvidence';

export interface RunbookRun {
  id: string;
  runbookId: string;
  sourceDigest: string;
  target: RunbookTarget;
  resolvedVariables: Record<string, string>;
  startedAt: number;
  evidenceMaxAgeSeconds: number;
  phase: RunbookRunPhase;
  items: RunbookRunItem[];
  activeItemId?: string;
  error?: string;
}

export type RunbookStepExecutionStatus =
  | 'success'
  | 'unauthorized'
  | 'cancelled'
  | 'timedOut'
  | 'failed';

export interface RunbookStepExecutionRequest {
  operationId: string;
  runId: string;
  sourceDigest: string;
  runbookText: string;
  itemId: string;
  itemKind: RunbookRunItemKind;
  profileId: string;
  authorized: boolean;
  approvedRisk: RunbookRisk;
  variableValues: Record<string, string>;
  /** Prior, already-redacted evidence references for the local audit timeline. */
  evidenceReferences?: OperationEvidenceReference[];
  timeoutMs: number;
  connection: RemoteConnectionRequest;
}

export interface RunbookStepExecutionResult {
  operationId: string;
  runId: string;
  runbookId: string;
  sourceDigest: string;
  itemId: string;
  itemKind: RunbookRunItemKind;
  profileId: string;
  status: RunbookStepExecutionStatus;
  risk: RunbookRisk;
  commandPreview: string;
  startedAt: number;
  completedAt: number;
  source: {
    kind: 'sshRunbook';
    profileId: string;
    host: string;
    port: number;
    username: string;
  };
  exitCode?: number;
  expectedMatched: boolean;
  stdout?: string;
  stderr?: string;
  error?: string;
}

export interface RunbookFile {
  path: string;
  text: string;
}
