import { invoke } from '@tauri-apps/api/core';
import { classifyError } from '@/lib/error';
import { createLogger } from '@/lib/logger';
import { createOperationId } from '@/lib/operation-id';
import { t } from '@/locales';
import { useToastStore } from '@/stores/toastStore';
import type {
  OperationEvidenceReference,
  OperationHistoryAction,
  OperationHistoryCategory,
  OperationHistoryErrorCategory,
  OperationHistoryEvent,
  OperationHistoryEventKind,
  OperationHistoryFilter,
  OperationHistoryPage,
  OperationHistoryRisk,
  OperationHistorySettings,
  OperationHistoryStatus,
  OperationHistoryTarget,
  OperationHistoryTask,
  RecordOperationEventRequest,
} from '@/types/operation-history';

const logger = createLogger('operation-history');
const WRITE_WARNING_COOLDOWN_MS = 60_000;
let lastWriteWarningAt = 0;

interface InvocationHistoryContext {
  taskId: string;
  operationId: string;
  runId?: string;
  category: OperationHistoryCategory;
  action: OperationHistoryAction;
  risk: OperationHistoryRisk;
  subjectId?: string;
  targets: OperationHistoryTarget[];
  evidence: OperationEvidenceReference[];
  startedAt: number;
  cancelRequest: boolean;
  approved: boolean;
  commandPreview?: string;
  itemCount?: number;
}

export interface OperationHistoryInvocationMetadata {
  taskId?: string;
  commandPreview?: string;
}

interface InvocationHistoryDescriptor {
  category: OperationHistoryCategory;
  action: OperationHistoryAction;
  risk: OperationHistoryRisk;
  request: Record<string, unknown>;
  taskId?: string;
  subjectId?: string;
  targets?: OperationHistoryTarget[];
  evidence?: OperationEvidenceReference[];
  cancelRequest?: boolean;
  approved?: boolean;
  itemCount?: number;
}

function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function requestValue(args: Record<string, unknown> | undefined): Record<string, unknown> {
  return objectValue(args?.request) ?? args ?? {};
}

function remoteTarget(value: unknown): OperationHistoryTarget | undefined {
  const connection = objectValue(value);
  const host = stringValue(connection?.host);
  const port = numberValue(connection?.port);
  const username = stringValue(connection?.username);
  if (!host || port === undefined || !username) return undefined;
  return {
    kind: 'remote',
    profileId: stringValue(connection?.profileId),
    host,
    port,
    username,
    sessionId: stringValue(connection?.sessionId),
    identityFingerprint: stringValue(connection?.identityFingerprint),
  };
}

function remoteEndpointTarget(value: unknown): OperationHistoryTarget | undefined {
  const endpoint = objectValue(value);
  const host = stringValue(endpoint?.host);
  const port = numberValue(endpoint?.port);
  if (!host || port === undefined) return undefined;
  return { kind: 'remote', host, port };
}

function targetsFromRequest(request: Record<string, unknown>): OperationHistoryTarget[] {
  const candidates = [
    request,
    request.connection,
    request.sourceConnection,
    request.destinationConnection,
  ];
  const targets = candidates
    .map(remoteTarget)
    .filter((target): target is OperationHistoryTarget => target !== undefined);
  const profileId = stringValue(request.profileId);
  if (profileId && targets[0] && !targets[0].profileId) {
    targets[0] = { ...targets[0], profileId };
  }
  return targets.filter((target, index) => targets.findIndex((candidate) =>
    candidate.profileId === target.profileId
    && candidate.host === target.host
    && candidate.port === target.port
    && candidate.username === target.username,
  ) === index);
}

function localTarget(sessionId?: string): OperationHistoryTarget {
  return { kind: 'local', sessionId };
}

function countItems(request: Record<string, unknown>): number | undefined {
  for (const key of ['paths', 'localPaths', 'remotePaths', 'sourcePaths']) {
    const value = request[key];
    if (Array.isArray(value)) return value.length;
  }
  return undefined;
}

function evidenceFromRequest(request: Record<string, unknown>): OperationEvidenceReference[] {
  if (!Array.isArray(request.evidenceReferences)) return [];
  return request.evidenceReferences.flatMap((value) => {
    const entry = objectValue(value);
    const operationId = stringValue(entry?.operationId);
    const kind = stringValue(entry?.kind);
    if (
      !operationId
      || !kind
      || !['approval', 'connectionPreflight', 'healthSnapshot', 'runbookStep', 'transferResult', 'operation'].includes(kind)
    ) return [];
    return [{
      operationId,
      kind: kind as OperationEvidenceReference['kind'],
      observedAt: numberValue(entry?.observedAt),
      digest: stringValue(entry?.digest),
    }];
  });
}

function descriptorFor(
  command: string,
  args: Record<string, unknown> | undefined,
): InvocationHistoryDescriptor | undefined {
  const request = requestValue(args);
  const targets = targetsFromRequest(request);
  const endpointTarget = remoteEndpointTarget(request);
  const operationId = stringValue(request.operationId) ?? stringValue(args?.operationId);
  const common = { request, targets, itemCount: countItems(request) };
  switch (command) {
    case 'create_session':
      return { ...common, category: 'terminal', action: 'connectRemoteSession', risk: 'readOnly' };
    case 'create_local_session':
      return { ...common, category: 'terminal', action: 'connectLocalSession', risk: 'readOnly', targets: [localTarget()] };
    case 'close_session':
      return {
        ...common,
        category: 'terminal',
        action: 'closeSession',
        risk: 'readOnly',
        taskId: operationId,
        targets: [localTarget(stringValue(args?.sessionId))],
      };
    case 'preflight_connection':
      return { ...common, category: 'connection', action: 'connectionPreflight', risk: 'readOnly' };
    case 'cancel_connection_preflight':
      return { ...common, category: 'connection', action: 'connectionPreflight', risk: 'readOnly', taskId: operationId, cancelRequest: true };
    case 'trust_host':
      return {
        ...common,
        category: 'connection',
        action: 'trustHostKey',
        risk: 'stateChange',
        targets: endpointTarget ? [endpointTarget] : [],
        approved: true,
      };
    case 'remove_known_host':
      return {
        ...common,
        category: 'connection',
        action: 'removeKnownHost',
        risk: 'destructive',
        targets: endpointTarget ? [endpointTarget] : [],
      };
    case 'warm_remote_connection':
      return { ...common, category: 'sftp', action: 'connectSftp', risk: 'readOnly' };
    case 'disconnect_sftp':
      return { ...common, category: 'sftp', action: 'disconnectSftp', risk: 'readOnly' };
    case 'create_remote_entry':
      return { ...common, category: 'sftp', action: 'createRemoteEntry', risk: 'stateChange' };
    case 'rename_remote_path':
      return { ...common, category: 'sftp', action: 'renameRemotePath', risk: 'stateChange' };
    case 'delete_remote_path':
      return { ...common, category: 'sftp', action: 'deleteRemotePath', risk: 'destructive' };
    case 'cancel_delete':
      return { ...common, category: 'sftp', action: 'deleteRemotePath', risk: 'destructive', taskId: operationId, cancelRequest: true };
    case 'copy_remote_path':
      return { ...common, category: 'sftp', action: 'copyRemotePath', risk: 'stateChange' };
    case 'copy_remote_to_remote':
      return { ...common, category: 'sftp', action: 'copyRemoteToRemote', risk: 'stateChange' };
    case 'cancel_remote_copy':
      return { ...common, category: 'sftp', action: 'copyRemoteToRemote', risk: 'stateChange', taskId: operationId, cancelRequest: true };
    case 'upload_local_paths':
      return { ...common, category: 'sftp', action: 'uploadFiles', risk: 'stateChange' };
    case 'cancel_upload':
      return { ...common, category: 'sftp', action: 'uploadFiles', risk: 'stateChange', taskId: operationId, cancelRequest: true };
    case 'download_remote_paths':
      return { ...common, category: 'sftp', action: 'downloadFiles', risk: 'stateChange' };
    case 'cancel_download':
      return { ...common, category: 'sftp', action: 'downloadFiles', risk: 'stateChange', taskId: operationId, cancelRequest: true };
    case 'update_remote_permissions':
      return { ...common, category: 'sftp', action: 'updateRemotePermissions', risk: 'stateChange' };
    case 'copy_local_paths':
      return { ...common, category: 'localFile', action: 'copyLocalPaths', risk: 'stateChange', targets: [localTarget()] };
    case 'rename_local_path':
      return { ...common, category: 'localFile', action: 'renameLocalPath', risk: 'stateChange', targets: [localTarget()] };
    case 'paste_local_paths':
      return { ...common, category: 'localFile', action: 'pasteLocalPaths', risk: 'stateChange', targets: [localTarget()] };
    case 'trash_local_paths':
      return { ...common, category: 'localFile', action: 'trashLocalPaths', risk: 'destructive', targets: [localTarget()] };
    case 'start_port_forward':
      return { ...common, category: 'portForward', action: 'startPortForward', risk: 'stateChange', subjectId: stringValue(objectValue(request.forward)?.id) };
    case 'stop_port_forward':
      return { ...common, category: 'portForward', action: 'stopPortForward', risk: 'stateChange', taskId: operationId };
    case 'stop_all_port_forwards':
      return { ...common, category: 'portForward', action: 'stopAllPortForwards', risk: 'stateChange' };
    case 'collect_remote_health_snapshot':
      return {
        ...common,
        category: 'remoteHealth',
        action: 'collectRemoteHealth',
        risk: 'readOnly',
        approved: request.authorized === true,
      };
    case 'cancel_remote_health_snapshot':
      return { ...common, category: 'remoteHealth', action: 'collectRemoteHealth', risk: 'readOnly', taskId: operationId, cancelRequest: true };
    case 'execute_runbook_step':
      return {
        ...common,
        category: 'runbook',
        action: 'executeRunbookStep',
        risk: (stringValue(request.approvedRisk) as OperationHistoryRisk | undefined) ?? 'readOnly',
        taskId: stringValue(request.runId),
        subjectId: stringValue(request.itemId),
        evidence: evidenceFromRequest(request),
        approved: request.authorized === true,
      };
    case 'cancel_runbook_step':
      return { ...common, category: 'runbook', action: 'executeRunbookStep', risk: 'readOnly', taskId: operationId, cancelRequest: true };
    default:
      return undefined;
  }
}

function newEvent(
  context: InvocationHistoryContext,
  eventKind: OperationHistoryEventKind,
  status: OperationHistoryStatus,
  overrides: Partial<RecordOperationEventRequest> = {},
): RecordOperationEventRequest {
  return {
    eventId: createOperationId('history-event'),
    taskId: context.taskId,
    operationId: context.operationId,
    occurredAt: Date.now(),
    category: context.category,
    action: context.action,
    eventKind,
    status,
    risk: context.risk,
    subjectId: context.subjectId,
    targets: context.targets,
    commandPreview: context.commandPreview,
    evidence: context.evidence,
    itemCount: context.itemCount,
    ...overrides,
  };
}

function warnWriteFailure(error: unknown): void {
  logger.warn('Operation history write failed; controlled operation continued', error);
  const now = Date.now();
  if (now - lastWriteWarningAt < WRITE_WARNING_COOLDOWN_MS) return;
  lastWriteWarningAt = now;
  useToastStore.getState().addToast(t('operationHistory.writeFailed'), 'error', 8_000);
}

export async function recordOperationHistoryEvent(
  request: RecordOperationEventRequest,
): Promise<void> {
  if (!isTauriRuntime()) return;
  try {
    await invoke('record_operation_event', { request });
  } catch (error) {
    warnWriteFailure(error);
  }
}

export function recordOperationHistoryTransition(
  request: Omit<RecordOperationEventRequest, 'eventId' | 'occurredAt' | 'targets' | 'evidence'> & {
    targets?: OperationHistoryTarget[];
    evidence?: OperationEvidenceReference[];
  },
): Promise<void> {
  return recordOperationHistoryEvent({
    ...request,
    eventId: createOperationId('history-event'),
    occurredAt: Date.now(),
    targets: request.targets ?? [],
    evidence: request.evidence ?? [],
  });
}

export async function recordInvocationStarted(
  command: string,
  args: Record<string, unknown> | undefined,
  fallbackOperationId: string,
  metadata?: OperationHistoryInvocationMetadata,
): Promise<InvocationHistoryContext | undefined> {
  const descriptor = descriptorFor(command, args);
  if (!descriptor) return undefined;
  const requestOperationId = stringValue(descriptor.request.operationId)
    ?? stringValue(args?.operationId)
    ?? fallbackOperationId;
  const reviewedCommand = stringValue(metadata?.commandPreview);
  const context: InvocationHistoryContext = {
    taskId: stringValue(metadata?.taskId) ?? descriptor.taskId ?? requestOperationId,
    operationId: requestOperationId,
    runId: stringValue(descriptor.request.runId),
    category: descriptor.category,
    action: descriptor.action,
    risk: descriptor.risk,
    subjectId: descriptor.subjectId,
    targets: descriptor.targets ?? [],
    evidence: descriptor.evidence ?? [],
    startedAt: Date.now(),
    cancelRequest: descriptor.cancelRequest ?? false,
    approved: descriptor.approved ?? false,
    commandPreview: reviewedCommand,
    itemCount: descriptor.itemCount,
  };
  if (context.cancelRequest) {
    await recordOperationHistoryEvent(newEvent(context, 'cancelRequested', 'cancelling'));
    return context;
  }
  await recordOperationHistoryEvent(newEvent(context, 'started', 'running'));
  if (context.approved) {
    await recordOperationHistoryEvent(newEvent(context, 'approved', 'running', {
      evidence: [{
        operationId: context.operationId,
        kind: 'approval',
        observedAt: Date.now(),
      }, ...context.evidence],
    }));
  }
  return context;
}

function statusFromResult(
  context: InvocationHistoryContext,
  result: unknown,
): OperationHistoryStatus {
  if (context.cancelRequest) return 'cancelling';
  const record = objectValue(result);
  const rawStatus = stringValue(record?.status);
  if (context.category === 'runbook') {
    const source = objectValue(record?.source);
    if (
      stringValue(record?.operationId) !== context.operationId
      || (context.runId && stringValue(record?.runId) !== context.runId)
      || (context.targets[0]?.profileId && stringValue(record?.profileId) !== context.targets[0].profileId)
      || (context.targets[0]?.host && stringValue(source?.host) !== context.targets[0].host)
      || (context.targets[0]?.port && numberValue(source?.port) !== context.targets[0].port)
      || (context.targets[0]?.username && stringValue(source?.username) !== context.targets[0].username)
      || stringValue(record?.risk) !== context.risk
      || (context.commandPreview && stringValue(record?.commandPreview) !== context.commandPreview)
    ) return 'identityMismatch';
  }
  if (context.category === 'remoteHealth') {
    const source = objectValue(record?.source);
    if (
      stringValue(record?.operationId) !== context.operationId
      || (context.targets[0]?.profileId && stringValue(record?.profileId) !== context.targets[0].profileId)
      || (context.targets[0]?.host && stringValue(source?.host) !== context.targets[0].host)
      || (context.targets[0]?.port && numberValue(source?.port) !== context.targets[0].port)
      || (context.targets[0]?.username && stringValue(source?.username) !== context.targets[0].username)
    ) return 'identityMismatch';
  }
  const statusMap: Partial<Record<string, OperationHistoryStatus>> = {
    success: 'succeeded',
    succeeded: 'succeeded',
    completed: 'succeeded',
    passed: 'succeeded',
    running: 'succeeded',
    starting: 'succeeded',
    stopped: 'stopped',
    stopping: 'stopped',
    failed: 'failed',
    cancelled: 'cancelled',
    timedOut: 'timedOut',
    timeout: 'timedOut',
    identityMismatch: 'identityMismatch',
    unauthorized: 'unauthorized',
    rejected: 'rejected',
    skipped: 'skipped',
    paused: 'paused',
    attention: 'partialSuccess',
    partialSuccess: 'partialSuccess',
  };
  if (rawStatus && statusMap[rawStatus]) return statusMap[rawStatus];
  if (Array.isArray(record?.items)) {
    const statuses = record.items.map((item) => stringValue(objectValue(item)?.status));
    const completed = statuses.filter((status) => status === 'completed').length;
    const failed = statuses.filter((status) => status === 'failed').length;
    const skipped = statuses.filter((status) => status === 'skipped').length;
    if (failed === statuses.length && failed > 0) return 'failed';
    if (failed > 0 || skipped > 0) return completed > 0 ? 'partialSuccess' : 'failed';
  }
  return 'succeeded';
}

function targetsFromResult(context: InvocationHistoryContext, result: unknown): OperationHistoryTarget[] {
  const record = objectValue(result);
  const source = objectValue(record?.source);
  const target = remoteTarget(source ?? record);
  if (target) {
    const profileId = stringValue(record?.profileId) ?? target.profileId;
    return [{ ...target, profileId }];
  }
  if (context.category === 'portForward' && record) {
    const profileId = stringValue(record.profileId);
    if (profileId && context.targets[0]) return [{ ...context.targets[0], profileId }];
  }
  return context.targets;
}

function errorForStatus(status: OperationHistoryStatus): OperationHistoryErrorCategory | undefined {
  if (status === 'identityMismatch') return 'identityMismatch';
  if (status === 'timedOut') return 'timeout';
  if (status === 'cancelled') return 'cancelled';
  if (status === 'failed' || status === 'unauthorized') return 'unknown';
  return undefined;
}

export async function recordInvocationFinished(
  context: InvocationHistoryContext | undefined,
  result: unknown,
): Promise<void> {
  if (!context) return;
  const status = statusFromResult(context, result);
  const record = objectValue(result);
  const items = Array.isArray(record?.items) ? record.items : undefined;
  const commandPreview = context.category === 'runbook'
    ? context.commandPreview ?? stringValue(record?.commandPreview)
    : undefined;
  await recordOperationHistoryEvent(newEvent(
    context,
    ['failed', 'timedOut', 'identityMismatch', 'unauthorized'].includes(status) ? 'failed' : 'completed',
    status,
    {
      occurredAt: numberValue(record?.completedAt) ?? Date.now(),
      targets: targetsFromResult(context, result),
      commandPreview,
      errorCategory: errorForStatus(status),
      itemCount: items?.length ?? context.itemCount,
      exitCode: numberValue(record?.exitCode),
    },
  ));
}

function historyError(error: unknown): {
  status: OperationHistoryStatus;
  category: OperationHistoryErrorCategory;
} {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  if (normalized.includes('identity mismatch')) {
    return { status: 'identityMismatch', category: 'identityMismatch' };
  }
  if (normalized.includes('stale evidence')) {
    return { status: 'failed', category: 'staleEvidence' };
  }
  if (normalized.includes('target changed')) {
    return { status: 'failed', category: 'targetChanged' };
  }
  if (normalized.includes('credential') && normalized.includes('missing')) {
    return { status: 'failed', category: 'credentialUnavailable' };
  }
  const classification = classifyError(error);
  const categoryMap: Record<typeof classification.category, OperationHistoryErrorCategory> = {
    authentication: 'authentication',
    timeout: 'timeout',
    network: 'network',
    permission: 'permission',
    'not-found': 'notFound',
    conflict: 'conflict',
    storage: 'storage',
    'host-key': 'hostKey',
    cancelled: 'cancelled',
    unknown: 'unknown',
  };
  return {
    status: classification.category === 'cancelled'
      ? 'cancelled'
      : classification.category === 'timeout'
        ? 'timedOut'
        : 'failed',
    category: categoryMap[classification.category],
  };
}

export async function recordInvocationFailed(
  context: InvocationHistoryContext | undefined,
  error: unknown,
): Promise<void> {
  if (!context) return;
  const failure = historyError(error);
  await recordOperationHistoryEvent(newEvent(context, 'failed', failure.status, {
    errorCategory: failure.category,
  }));
}

export async function listOperationHistory(
  filter: OperationHistoryFilter,
  limit = 100,
): Promise<OperationHistoryPage> {
  return invoke<OperationHistoryPage>('list_operation_history', {
    request: { filter, limit },
  });
}

export async function getOperationHistorySettings(): Promise<OperationHistorySettings> {
  return invoke<OperationHistorySettings>('get_operation_history_settings');
}

export async function setOperationHistoryRetention(retentionDays: number): Promise<number> {
  return invoke<number>('set_operation_history_retention', { retentionDays });
}

export async function clearOperationHistory(): Promise<number> {
  return invoke<number>('clear_operation_history');
}

export async function exportOperationHistory(
  format: 'markdown' | 'json',
  filter: OperationHistoryFilter,
): Promise<string | null> {
  return invoke<string | null>('export_operation_history', {
    request: { format, filter },
  });
}

export function groupOperationHistory(events: OperationHistoryEvent[]): OperationHistoryTask[] {
  const groups = new Map<string, OperationHistoryEvent[]>();
  for (const event of events) {
    const group = groups.get(event.taskId) ?? [];
    group.push(event);
    groups.set(event.taskId, group);
  }
  return Array.from(groups, ([taskId, taskEvents]) => {
    const sorted = [...taskEvents].sort((left, right) => left.occurredAt - right.occurredAt);
    return {
      taskId,
      events: sorted,
      latest: sorted[sorted.length - 1],
      startedAt: sorted[0].occurredAt,
    };
  }).sort((left, right) => right.latest.occurredAt - left.latest.occurredAt);
}

export const operationHistoryTestApi = {
  descriptorFor,
  historyError,
  statusFromResult,
};
