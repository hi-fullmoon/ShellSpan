import type {
  RunbookRun,
  RunbookRunItemKind,
  RunbookRisk,
  RunbookTarget,
} from '@/types/runbook';

export interface MultiHostRunbookConfig {
  concurrencyLimit: number;
  batchSize: number;
}

export type MultiHostRunbookHostStatus =
  | 'queuedPreflight'
  | 'preflighting'
  | 'awaitingApproval'
  | 'queuedStep'
  | 'runningStep'
  | 'cancelling'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'timedOut'
  | 'staleEvidence'
  | 'identityMismatch';

export type MultiHostRunbookFailureKind =
  | 'failed'
  | 'cancelled'
  | 'timedOut'
  | 'staleEvidence'
  | 'identityMismatch'
  | 'targetChanged'
  | 'credentialUnavailable';

export interface MultiHostRunbookFailure {
  kind: MultiHostRunbookFailureKind;
  message: string;
  itemId?: string;
  operationId?: string;
  safeToRetry: boolean;
}

export interface MultiHostRunbookHost {
  target: RunbookTarget;
  batchIndex: number;
  attempt: number;
  status: MultiHostRunbookHostStatus;
  circuitOpen: boolean;
  run: RunbookRun;
  variableValues: Record<string, string>;
  approvedItemId?: string;
  activeOperationId?: string;
  failure?: MultiHostRunbookFailure;
}

export interface MultiHostRunbookTask {
  id: string;
  runbookId: string;
  sourceDigest: string;
  sourceText: string;
  selectedTag: string;
  createdAt: number;
  config: MultiHostRunbookConfig;
  hosts: MultiHostRunbookHost[];
  cancellationRequested: boolean;
}

export type MultiHostRunbookOutcome =
  | 'preflighting'
  | 'awaitingApproval'
  | 'running'
  | 'succeeded'
  | 'partialSuccess'
  | 'failed'
  | 'cancelled';

export interface MultiHostRunbookSummary {
  total: number;
  succeeded: number;
  failed: number;
  cancelled: number;
  timedOut: number;
  staleEvidence: number;
  identityMismatch: number;
  pending: number;
  outcome: MultiHostRunbookOutcome;
}

export interface MultiHostRunbookDispatch {
  profileId: string;
  operationId: string;
  runId: string;
  runbookId: string;
  sourceDigest: string;
  runbookText: string;
  itemId: string;
  itemKind: RunbookRunItemKind;
  risk: RunbookRisk;
  commandPreview: string;
  timeoutMs: number;
  variableValues: Record<string, string>;
  target: RunbookTarget;
}
