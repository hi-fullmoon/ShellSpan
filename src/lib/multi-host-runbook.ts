import type { ConnectionProfile } from '@/types';
import type {
  MultiHostRunbookDispatch,
  MultiHostRunbookFailureKind,
  MultiHostRunbookHost,
  MultiHostRunbookHostStatus,
  MultiHostRunbookOutcome,
  MultiHostRunbookSummary,
  MultiHostRunbookTask,
} from '@/types/multi-host-runbook';
import type {
  RunbookRun,
  RunbookStepExecutionResult,
  RunbookTarget,
} from '@/types/runbook';
import {
  applyRunbookStepResult,
  areRunbookPrechecksFresh,
  markRunbookItemRunning,
  prepareRunbook,
  retryRunbookWithFreshPrechecks,
  startRunbookRun,
} from '@/lib/runbook';

export const MULTI_HOST_MIN_CONCURRENCY = 1;
export const MULTI_HOST_MAX_CONCURRENCY = 8;
export const MULTI_HOST_MIN_BATCH_SIZE = 1;
export const MULTI_HOST_MAX_BATCH_SIZE = 50;

const TERMINAL_HOST_STATUSES = new Set<MultiHostRunbookHostStatus>([
  'succeeded',
  'failed',
  'cancelled',
  'timedOut',
  'staleEvidence',
  'identityMismatch',
]);

function fail(message: string): never {
  throw new Error(`Multi-host Runbook: ${message}`);
}

function normalizedTag(value: string): string {
  return value.trim().toLocaleLowerCase();
}

export function listMultiHostRunbookTags(profiles: ConnectionProfile[]): string[] {
  const labels = new Map<string, string>();
  for (const profile of profiles) {
    for (const rawTag of profile.tags ?? []) {
      const tag = rawTag.trim();
      if (tag) labels.set(normalizedTag(tag), labels.get(normalizedTag(tag)) ?? tag);
    }
  }
  return [...labels.values()].sort((left, right) => left.localeCompare(right));
}

export function selectMultiHostProfilesByTag(
  profiles: ConnectionProfile[],
  selectedTag: string,
): ConnectionProfile[] {
  const tag = normalizedTag(selectedTag);
  if (!tag) return [];
  return profiles.filter((profile) => (
    (profile.tags ?? []).some((candidate) => normalizedTag(candidate) === tag)
  ));
}

export function profileMatchesRunbookTarget(
  profile: Pick<ConnectionProfile, 'id' | 'host' | 'port' | 'username'>,
  target: RunbookTarget,
): boolean {
  return profile.id === target.profileId
    && profile.host === target.host
    && profile.port === target.port
    && profile.username === target.username;
}

function targetFromProfile(profile: ConnectionProfile): RunbookTarget {
  return {
    profileId: profile.id,
    name: profile.name,
    host: profile.host,
    port: profile.port,
    username: profile.username,
  };
}

function validateConfig(concurrencyLimit: number, batchSize: number): void {
  if (
    !Number.isInteger(concurrencyLimit)
    || concurrencyLimit < MULTI_HOST_MIN_CONCURRENCY
    || concurrencyLimit > MULTI_HOST_MAX_CONCURRENCY
  ) {
    fail(`concurrencyLimit must be an integer from ${MULTI_HOST_MIN_CONCURRENCY} to ${MULTI_HOST_MAX_CONCURRENCY}`);
  }
  if (
    !Number.isInteger(batchSize)
    || batchSize < MULTI_HOST_MIN_BATCH_SIZE
    || batchSize > MULTI_HOST_MAX_BATCH_SIZE
  ) {
    fail(`batchSize must be an integer from ${MULTI_HOST_MIN_BATCH_SIZE} to ${MULTI_HOST_MAX_BATCH_SIZE}`);
  }
  if (concurrencyLimit > batchSize) fail('concurrencyLimit cannot exceed batchSize');
}

export interface CreateMultiHostRunbookTaskOptions {
  id: string;
  sourceText: string;
  variableValues: Record<string, string>;
  profiles: ConnectionProfile[];
  selectedTag: string;
  concurrencyLimit: number;
  batchSize: number;
  now?: number;
  createRunId: (profileId: string) => string;
}

export function createMultiHostRunbookTask({
  id,
  sourceText,
  variableValues,
  profiles,
  selectedTag,
  concurrencyLimit,
  batchSize,
  now = Date.now(),
  createRunId,
}: CreateMultiHostRunbookTaskOptions): MultiHostRunbookTask {
  if (!id.trim()) fail('task identity is required');
  validateConfig(concurrencyLimit, batchSize);
  const targets = selectMultiHostProfilesByTag(profiles, selectedTag);
  if (targets.length === 0) fail('the selected connection tag has no targets');
  const profileIds = new Set<string>();
  for (const profile of targets) {
    if (profileIds.has(profile.id)) fail(`duplicate target profile ${profile.id}`);
    profileIds.add(profile.id);
  }

  let canonicalSourceText = '';
  let sourceDigest = '';
  let runbookId = '';
  const hosts = targets.map((profile, index): MultiHostRunbookHost => {
    const target = targetFromProfile(profile);
    const prepared = prepareRunbook(sourceText, { ...variableValues }, target);
    canonicalSourceText ||= prepared.sourceText;
    sourceDigest ||= prepared.sourceDigest;
    runbookId ||= prepared.document.id;
    const plainVariableValues = Object.fromEntries(prepared.document.variables
      .filter((variable) => !variable.keychainRef && variableValues[variable.name] !== undefined)
      .map((variable) => [variable.name, variableValues[variable.name]]));
    return {
      target: { ...target },
      batchIndex: Math.floor(index / batchSize),
      attempt: 1,
      status: 'queuedPreflight',
      circuitOpen: false,
      run: startRunbookRun(prepared, createRunId(profile.id), now),
      variableValues: { ...plainVariableValues },
    };
  });

  return {
    id,
    runbookId,
    sourceDigest,
    sourceText: canonicalSourceText,
    selectedTag: selectedTag.trim(),
    createdAt: now,
    config: { concurrencyLimit, batchSize },
    hosts,
    cancellationRequested: false,
  };
}

export function isMultiHostRunbookHostTerminal(host: MultiHostRunbookHost): boolean {
  return TERMINAL_HOST_STATUSES.has(host.status);
}

export function isMultiHostRunbookTaskTerminal(task: MultiHostRunbookTask): boolean {
  return task.hosts.every(isMultiHostRunbookHostTerminal);
}

function hostHasPendingPreflight(host: MultiHostRunbookHost): boolean {
  if (host.status === 'queuedPreflight' || host.status === 'preflighting') return true;
  if (host.status !== 'cancelling') return false;
  return host.run.items.find((item) => item.id === host.run.activeItemId)?.kind === 'precheck';
}

export function hasPendingMultiHostRunbookPreflight(task: MultiHostRunbookTask): boolean {
  return task.hosts.some(hostHasPendingPreflight);
}

export function activeMultiHostRunbookBatch(task: MultiHostRunbookTask): number | undefined {
  const preflightHosts = task.hosts.filter(hostHasPendingPreflight);
  const candidates = preflightHosts.length > 0
    ? preflightHosts
    : task.hosts.filter((host) => !isMultiHostRunbookHostTerminal(host));
  return candidates
    .reduce<number | undefined>((lowest, host) => (
      lowest === undefined || host.batchIndex < lowest ? host.batchIndex : lowest
    ), undefined);
}

export function multiHostRunbookBatchCount(task: MultiHostRunbookTask): number {
  return task.hosts.reduce((highest, host) => Math.max(highest, host.batchIndex + 1), 0);
}

function taskOutcome(task: MultiHostRunbookTask): MultiHostRunbookOutcome {
  if (isMultiHostRunbookTaskTerminal(task)) {
    const succeeded = task.hosts.filter((host) => host.status === 'succeeded').length;
    if (succeeded === task.hosts.length) return 'succeeded';
    if (succeeded > 0) return 'partialSuccess';
    if (task.hosts.every((host) => host.status === 'cancelled')) return 'cancelled';
    return 'failed';
  }
  if (hasPendingMultiHostRunbookPreflight(task)) return 'preflighting';
  const activeBatch = activeMultiHostRunbookBatch(task);
  const activeHosts = task.hosts.filter((host) => host.batchIndex === activeBatch);
  if (activeHosts.some((host) => ['runningStep', 'queuedStep', 'cancelling'].includes(host.status))) return 'running';
  return 'awaitingApproval';
}

export function summarizeMultiHostRunbookTask(task: MultiHostRunbookTask): MultiHostRunbookSummary {
  const count = (status: MultiHostRunbookHostStatus): number => (
    task.hosts.filter((host) => host.status === status).length
  );
  return {
    total: task.hosts.length,
    succeeded: count('succeeded'),
    failed: count('failed'),
    cancelled: count('cancelled'),
    timedOut: count('timedOut'),
    staleEvidence: count('staleEvidence'),
    identityMismatch: count('identityMismatch'),
    pending: task.hosts.filter((host) => !isMultiHostRunbookHostTerminal(host)).length,
    outcome: taskOutcome(task),
  };
}

function updateHost(
  task: MultiHostRunbookTask,
  profileId: string,
  update: (host: MultiHostRunbookHost) => MultiHostRunbookHost,
): MultiHostRunbookTask {
  return {
    ...task,
    hosts: task.hosts.map((host) => host.target.profileId === profileId ? update(host) : host),
  };
}

function stopRun(run: RunbookRun, message: string, status: 'failed' | 'cancelled'): RunbookRun {
  return {
    ...run,
    phase: status === 'cancelled' ? 'cancelled' : 'stopped',
    error: message,
    items: run.items.map((item) => item.id === run.activeItemId
      ? { ...item, status, error: message, evidence: undefined }
      : item),
  };
}

function tripCircuit(
  host: MultiHostRunbookHost,
  status: Extract<MultiHostRunbookHostStatus, 'failed' | 'cancelled' | 'timedOut' | 'staleEvidence' | 'identityMismatch'>,
  kind: MultiHostRunbookFailureKind,
  message: string,
  operationId = host.activeOperationId,
): MultiHostRunbookHost {
  const activeItem = host.run.items.find((item) => item.id === host.run.activeItemId);
  const run = status === 'staleEvidence'
    ? { ...host.run, phase: 'staleEvidence' as const, activeItemId: undefined, error: message }
    : stopRun(host.run, message, status === 'cancelled' ? 'cancelled' : 'failed');
  return {
    ...host,
    status,
    circuitOpen: true,
    run,
    approvedItemId: undefined,
    activeOperationId: undefined,
    failure: {
      kind,
      message,
      itemId: activeItem?.id,
      operationId,
      safeToRetry: activeItem?.safeToRetry ?? true,
    },
  };
}

export function failMultiHostRunbookHost(
  task: MultiHostRunbookTask,
  profileId: string,
  kind: Extract<MultiHostRunbookFailureKind, 'targetChanged' | 'credentialUnavailable'>,
  message: string,
): MultiHostRunbookTask {
  return updateHost(task, profileId, (host) => (
    isMultiHostRunbookHostTerminal(host) ? host : tripCircuit(host, 'failed', kind, message)
  ));
}

export function approveMultiHostRunbookHost(
  task: MultiHostRunbookTask,
  profileId: string,
  now = Date.now(),
): MultiHostRunbookTask {
  if (hasPendingMultiHostRunbookPreflight(task)) return task;
  const activeBatch = activeMultiHostRunbookBatch(task);
  return updateHost(task, profileId, (host) => {
    if (
      host.status !== 'awaitingApproval'
      || host.batchIndex !== activeBatch
      || host.circuitOpen
      || task.cancellationRequested
    ) return host;
    const activeItem = host.run.items.find((item) => item.id === host.run.activeItemId);
    if (!activeItem || activeItem.kind !== 'step') {
      return tripCircuit(host, 'identityMismatch', 'identityMismatch', 'Multi-host Runbook action identity is invalid.');
    }
    if (!areRunbookPrechecksFresh(host.run, now)) {
      return tripCircuit(
        host,
        'staleEvidence',
        'staleEvidence',
        'Multi-host Runbook preflight evidence is stale; retry this host from preflight.',
      );
    }
    return { ...host, status: 'queuedStep', approvedItemId: activeItem.id };
  });
}

export function canApproveMultiHostRunbookHost(
  task: MultiHostRunbookTask,
  profileId: string,
): boolean {
  if (hasPendingMultiHostRunbookPreflight(task) || task.cancellationRequested) return false;
  const host = task.hosts.find((entry) => entry.target.profileId === profileId);
  return host?.status === 'awaitingApproval'
    && !host.circuitOpen
    && host.batchIndex === activeMultiHostRunbookBatch(task);
}

export interface PlannedMultiHostRunbookDispatches {
  task: MultiHostRunbookTask;
  dispatches: MultiHostRunbookDispatch[];
}

export function planMultiHostRunbookDispatches(
  task: MultiHostRunbookTask,
  createOperationId: (profileId: string, itemId: string) => string,
  now = Date.now(),
): PlannedMultiHostRunbookDispatches {
  if (task.cancellationRequested || isMultiHostRunbookTaskTerminal(task)) return { task, dispatches: [] };
  const activeBatch = activeMultiHostRunbookBatch(task);
  const preflightPhase = hasPendingMultiHostRunbookPreflight(task);
  const running = task.hosts.filter((host) => host.activeOperationId).length;
  let available = Math.max(0, task.config.concurrencyLimit - running);
  let nextTask = task;
  const dispatches: MultiHostRunbookDispatch[] = [];
  const candidates = task.hosts.filter((host) => (
    host.batchIndex === activeBatch
    && !host.circuitOpen
    && (preflightPhase ? host.status === 'queuedPreflight' : host.status === 'queuedStep')
  ));

  for (const candidate of candidates) {
    if (available === 0) break;
    let host = nextTask.hosts.find((entry) => entry.target.profileId === candidate.target.profileId);
    if (!host) continue;
    const activeItem = host.run.items.find((item) => item.id === host?.run.activeItemId);
    if (!activeItem) {
      nextTask = updateHost(nextTask, host.target.profileId, (entry) => (
        tripCircuit(entry, 'identityMismatch', 'identityMismatch', 'Multi-host Runbook active item is missing.')
      ));
      continue;
    }
    if (host.status === 'queuedPreflight' && activeItem.kind !== 'precheck') {
      nextTask = updateHost(nextTask, host.target.profileId, (entry) => (
        tripCircuit(entry, 'identityMismatch', 'identityMismatch', 'Multi-host Runbook preflight identity is invalid.')
      ));
      continue;
    }
    if (host.status === 'queuedStep') {
      if (activeItem.kind !== 'step' || host.approvedItemId !== activeItem.id) {
        nextTask = updateHost(nextTask, host.target.profileId, (entry) => (
          tripCircuit(entry, 'identityMismatch', 'identityMismatch', 'Multi-host Runbook approval identity is invalid.')
        ));
        continue;
      }
      if (!areRunbookPrechecksFresh(host.run, now)) {
        nextTask = updateHost(nextTask, host.target.profileId, (entry) => tripCircuit(
          entry,
          'staleEvidence',
          'staleEvidence',
          'Multi-host Runbook preflight evidence expired before dispatch.',
        ));
        continue;
      }
    }
    const operationId = createOperationId(host.target.profileId, activeItem.id);
    const runningRun = markRunbookItemRunning(host.run, now);
    if (runningRun.phase !== 'running') {
      nextTask = updateHost(nextTask, host.target.profileId, (entry) => tripCircuit(
        entry,
        'staleEvidence',
        'staleEvidence',
        runningRun.error ?? 'Multi-host Runbook action could not be dispatched safely.',
      ));
      continue;
    }
    host = {
      ...host,
      run: runningRun,
      status: activeItem.kind === 'precheck' ? 'preflighting' : 'runningStep',
      activeOperationId: operationId,
    };
    nextTask = updateHost(nextTask, host.target.profileId, () => host);
    dispatches.push({
      profileId: host.target.profileId,
      operationId,
      runId: host.run.id,
      runbookId: task.runbookId,
      sourceDigest: task.sourceDigest,
      runbookText: task.sourceText,
      itemId: activeItem.id,
      itemKind: activeItem.kind,
      risk: activeItem.risk,
      commandPreview: activeItem.commandPreview,
      timeoutMs: activeItem.timeoutSeconds * 1000,
      variableValues: { ...host.variableValues },
      target: { ...host.target },
    });
    available -= 1;
  }
  return { task: nextTask, dispatches };
}

function resultIdentityMatches(
  host: MultiHostRunbookHost,
  result: RunbookStepExecutionResult,
): boolean {
  const activeItem = host.run.items.find((item) => item.id === host.run.activeItemId);
  return Boolean(activeItem)
    && result.operationId === host.activeOperationId
    && result.runId === host.run.id
    && result.runbookId === host.run.runbookId
    && result.sourceDigest === host.run.sourceDigest
    && result.itemId === activeItem?.id
    && result.itemKind === activeItem?.kind
    && result.risk === activeItem?.risk
    && result.commandPreview === activeItem?.commandPreview
    && result.profileId === host.target.profileId
    && result.source.profileId === host.target.profileId
    && result.source.host === host.target.host
    && result.source.port === host.target.port
    && result.source.username === host.target.username;
}

function hostStatusAfterSuccess(run: RunbookRun): MultiHostRunbookHostStatus {
  if (run.phase === 'completed') return 'succeeded';
  const activeItem = run.items.find((item) => item.id === run.activeItemId);
  return activeItem?.kind === 'precheck' ? 'queuedPreflight' : 'awaitingApproval';
}

export function applyMultiHostRunbookResult(
  task: MultiHostRunbookTask,
  profileId: string,
  result: RunbookStepExecutionResult,
  now = Date.now(),
): MultiHostRunbookTask {
  return updateHost(task, profileId, (host) => {
    if (!host.activeOperationId) return host;
    if (!resultIdentityMatches(host, result)) {
      return tripCircuit(
        host,
        'identityMismatch',
        'identityMismatch',
        'Multi-host Runbook result identity mismatch; untrusted output was discarded.',
        result.operationId,
      );
    }
    const activeItem = host.run.items.find((item) => item.id === host.run.activeItemId);
    const trustedResult = result.status === 'success' && !result.expectedMatched
      ? {
          ...result,
          status: 'failed' as const,
          error: 'Multi-host Runbook successful result did not include matched evidence.',
        }
      : result;
    const run = applyRunbookStepResult(host.run, trustedResult, now);
    if (run.error === 'Runbook result identity mismatch.') {
      return tripCircuit(
        host,
        'identityMismatch',
        'identityMismatch',
        'Multi-host Runbook result identity mismatch; untrusted output was discarded.',
        result.operationId,
      );
    }
    if (trustedResult.status === 'success') {
      const successfulHost: MultiHostRunbookHost = {
        ...host,
        run,
        status: hostStatusAfterSuccess(run),
        circuitOpen: false,
        activeOperationId: undefined,
        approvedItemId: undefined,
        failure: undefined,
      };
      if ((task.cancellationRequested || host.status === 'cancelling') && run.phase !== 'completed') {
        return tripCircuit(
          successfulHost,
          'cancelled',
          'cancelled',
          'Multi-host Runbook host stopped after the in-flight command completed.',
          result.operationId,
        );
      }
      return successfulHost;
    }
    const status: Extract<MultiHostRunbookHostStatus, 'failed' | 'cancelled' | 'timedOut'> =
      trustedResult.status === 'cancelled'
        ? 'cancelled'
        : trustedResult.status === 'timedOut'
          ? 'timedOut'
          : 'failed';
    const kind: MultiHostRunbookFailureKind = trustedResult.status === 'cancelled'
      ? 'cancelled'
      : trustedResult.status === 'timedOut'
        ? 'timedOut'
        : 'failed';
    return {
      ...host,
      run,
      status,
      circuitOpen: true,
      activeOperationId: undefined,
      approvedItemId: undefined,
      failure: {
        kind,
        message: trustedResult.error ?? `Multi-host Runbook host ${status}.`,
        itemId: activeItem?.id,
        operationId: trustedResult.operationId,
        safeToRetry: activeItem?.safeToRetry ?? false,
      },
    };
  });
}

export function createMultiHostSyntheticResult(
  dispatch: MultiHostRunbookDispatch,
  status: Extract<RunbookStepExecutionResult['status'], 'failed' | 'cancelled' | 'timedOut'>,
  error: string,
  now = Date.now(),
): RunbookStepExecutionResult {
  return {
    operationId: dispatch.operationId,
    runId: dispatch.runId,
    runbookId: dispatch.runbookId,
    sourceDigest: dispatch.sourceDigest,
    itemId: dispatch.itemId,
    itemKind: dispatch.itemKind,
    profileId: dispatch.profileId,
    status,
    risk: dispatch.risk,
    commandPreview: dispatch.commandPreview,
    startedAt: now,
    completedAt: now,
    source: {
      kind: 'sshRunbook',
      profileId: dispatch.profileId,
      host: dispatch.target.host,
      port: dispatch.target.port,
      username: dispatch.target.username,
    },
    expectedMatched: false,
    error,
  };
}

export function requestCancelMultiHostRunbookHost(
  task: MultiHostRunbookTask,
  profileId: string,
): MultiHostRunbookTask {
  return updateHost(task, profileId, (host) => {
    if (isMultiHostRunbookHostTerminal(host)) return host;
    if (host.activeOperationId) return { ...host, status: 'cancelling', circuitOpen: true };
    return tripCircuit(host, 'cancelled', 'cancelled', 'Multi-host Runbook host was cancelled.');
  });
}

export function requestCancelMultiHostRunbookTask(task: MultiHostRunbookTask): MultiHostRunbookTask {
  return task.hosts.reduce<MultiHostRunbookTask>(
    (current, host) => requestCancelMultiHostRunbookHost(current, host.target.profileId),
    { ...task, cancellationRequested: true } as MultiHostRunbookTask,
  );
}

export function activeMultiHostRunbookOperationIds(task: MultiHostRunbookTask): string[] {
  return task.hosts.flatMap((host) => host.activeOperationId ? [host.activeOperationId] : []);
}

function currentEligibleTarget(
  task: MultiHostRunbookTask,
  profileId: string,
  currentProfiles: ConnectionProfile[],
): RunbookTarget | undefined {
  const current = selectMultiHostProfilesByTag(currentProfiles, task.selectedTag)
    .find((profile) => profile.id === profileId);
  return current ? targetFromProfile(current) : undefined;
}

function runbookTargetsMatch(left: RunbookTarget, right: RunbookTarget): boolean {
  return left.profileId === right.profileId
    && left.host === right.host
    && left.port === right.port
    && left.username === right.username;
}

export function canRetryMultiHostRunbookHost(
  task: MultiHostRunbookTask,
  profileId: string,
  currentProfiles: ConnectionProfile[],
): boolean {
  if (!isMultiHostRunbookTaskTerminal(task)) return false;
  const host = task.hosts.find((entry) => entry.target.profileId === profileId);
  const current = currentEligibleTarget(task, profileId, currentProfiles);
  return Boolean(
    host?.failure?.safeToRetry
    && current
    && runbookTargetsMatch(current, host.target),
  );
}

export function retryMultiHostRunbookHosts(
  task: MultiHostRunbookTask,
  profileIds: string[],
  currentProfiles: ConnectionProfile[],
  now = Date.now(),
): MultiHostRunbookTask {
  if (!isMultiHostRunbookTaskTerminal(task)) return task;
  const selected = new Set(profileIds);
  let changed = false;
  const hosts = task.hosts.map((host): MultiHostRunbookHost => {
    if (
      !selected.has(host.target.profileId)
      || !canRetryMultiHostRunbookHost(task, host.target.profileId, currentProfiles)
      || !host.failure?.itemId
    ) return host;
    const run = retryRunbookWithFreshPrechecks(host.run, host.failure.itemId, now);
    if (run === host.run) return host;
    changed = true;
    return {
      ...host,
      attempt: host.attempt + 1,
      status: 'queuedPreflight',
      circuitOpen: false,
      run,
      approvedItemId: undefined,
      activeOperationId: undefined,
      failure: undefined,
    };
  });
  return changed ? { ...task, hosts, cancellationRequested: false } : task;
}
