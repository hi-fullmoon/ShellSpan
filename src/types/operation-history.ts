export type OperationHistoryCategory =
  | 'connection'
  | 'terminal'
  | 'sftp'
  | 'localFile'
  | 'portForward'
  | 'remoteHealth'
  | 'runbook'
  | 'deployment'
  | 'multiHost';

export type OperationHistoryAction =
  | 'connectRemoteSession'
  | 'connectLocalSession'
  | 'closeSession'
  | 'connectionPreflight'
  | 'trustHostKey'
  | 'removeKnownHost'
  | 'connectSftp'
  | 'disconnectSftp'
  | 'createRemoteEntry'
  | 'renameRemotePath'
  | 'deleteRemotePath'
  | 'copyRemotePath'
  | 'copyRemoteToRemote'
  | 'uploadFiles'
  | 'downloadFiles'
  | 'updateRemotePermissions'
  | 'copyLocalPaths'
  | 'renameLocalPath'
  | 'pasteLocalPaths'
  | 'trashLocalPaths'
  | 'startPortForward'
  | 'stopPortForward'
  | 'stopAllPortForwards'
  | 'collectRemoteHealth'
  | 'executeRunbookStep'
  | 'executeDeployment'
  | 'executeMultiHostRunbook';

export type OperationHistoryEventKind =
  | 'started'
  | 'approved'
  | 'rejected'
  | 'paused'
  | 'resumed'
  | 'skipped'
  | 'retryRequested'
  | 'cancelRequested'
  | 'completed'
  | 'failed'
  | 'statusChanged'
  | 'evidenceLinked';

export type OperationHistoryStatus =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelling'
  | 'cancelled'
  | 'timedOut'
  | 'partialSuccess'
  | 'identityMismatch'
  | 'unauthorized'
  | 'rejected'
  | 'skipped'
  | 'paused'
  | 'stopped'
  | 'recovered';

export type OperationHistoryRisk = 'readOnly' | 'stateChange' | 'destructive';

export interface OperationHistoryTarget {
  kind: 'local' | 'remote';
  profileId?: string;
  host?: string;
  port?: number;
  username?: string;
  sessionId?: string;
  identityFingerprint?: string;
}

export interface OperationEvidenceReference {
  operationId: string;
  kind:
    | 'approval'
    | 'connectionPreflight'
    | 'healthSnapshot'
    | 'runbookStep'
    | 'transferResult'
    | 'operation';
  observedAt?: number;
  digest?: string;
}

export type OperationHistoryErrorCategory =
  | 'authentication'
  | 'timeout'
  | 'network'
  | 'permission'
  | 'notFound'
  | 'conflict'
  | 'storage'
  | 'hostKey'
  | 'cancelled'
  | 'identityMismatch'
  | 'staleEvidence'
  | 'targetChanged'
  | 'credentialUnavailable'
  | 'unknown';

export interface RecordOperationEventRequest {
  eventId: string;
  taskId: string;
  operationId: string;
  parentOperationId?: string;
  occurredAt: number;
  category: OperationHistoryCategory;
  action: OperationHistoryAction;
  eventKind: OperationHistoryEventKind;
  status: OperationHistoryStatus;
  risk?: OperationHistoryRisk;
  subjectId?: string;
  targets: OperationHistoryTarget[];
  commandPreview?: string;
  evidence: OperationEvidenceReference[];
  errorCategory?: OperationHistoryErrorCategory;
  retryOfOperationId?: string;
  itemCount?: number;
  byteCount?: number;
  exitCode?: number;
  batchIndex?: number;
  batchTotal?: number;
  concurrencyLimit?: number;
}

export interface OperationHistoryEvent extends RecordOperationEventRequest {}

export interface OperationHistoryFilter {
  category?: OperationHistoryCategory;
  status?: OperationHistoryStatus;
  profileId?: string;
  search?: string;
  from?: number;
  to?: number;
}

export interface OperationHistoryPage {
  events: OperationHistoryEvent[];
  totalTasks: number;
  truncated: boolean;
}

export interface OperationHistorySettings {
  retentionDays: number;
  defaultLocalOnly: true;
}

export interface OperationHistoryTask {
  taskId: string;
  events: OperationHistoryEvent[];
  latest: OperationHistoryEvent;
  startedAt: number;
}
