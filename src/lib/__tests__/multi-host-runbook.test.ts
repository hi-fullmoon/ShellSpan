import { describe, expect, it } from 'vitest';
import type { ConnectionProfile } from '@/types';
import type { MultiHostRunbookDispatch, MultiHostRunbookTask } from '@/types/multi-host-runbook';
import type { RunbookStepExecutionResult } from '@/types/runbook';
import {
  activeMultiHostRunbookBatch,
  applyMultiHostRunbookResult,
  approveMultiHostRunbookHost,
  canRetryMultiHostRunbookHost,
  createMultiHostRunbookTask,
  planMultiHostRunbookDispatches,
  requestCancelMultiHostRunbookHost,
  retryMultiHostRunbookHosts,
  selectMultiHostProfilesByTag,
  summarizeMultiHostRunbookTask,
} from '@/lib/multi-host-runbook';

const RUNBOOK = JSON.stringify({
  schemaVersion: 1,
  id: 'multi-service',
  name: 'Multi-host service update',
  description: 'Verify and update one service on isolated targets.',
  evidenceMaxAgeSeconds: 30,
  variables: [{
    name: 'SERVICE',
    description: 'Service name',
    required: true,
    default: 'nginx',
  }],
  prechecks: [{
    id: 'preflight',
    description: 'Read-only service preflight',
    command: 'systemctl status {{SERVICE}}',
    expected: { exitCode: 0 },
    timeoutSeconds: 10,
  }],
  steps: [{
    id: 'reload',
    description: 'Reload the service',
    command: 'sudo systemctl reload {{SERVICE}}',
    risk: 'stateChange',
    impact: 'Reloads one service on exactly one reviewed host.',
    rollback: 'Restart the previous service configuration on the same reviewed host.',
    expected: { exitCode: 0 },
    timeoutSeconds: 20,
    safeToRetry: true,
  }],
});

function profile(index: number, tags = ['production']): ConnectionProfile {
  return {
    id: `profile-${index}`,
    name: `host-${index}`,
    host: `host-${index}.example.test`,
    port: 22,
    username: 'operator',
    authMethod: 'password',
    tags,
    createdAt: index,
    updatedAt: index,
  };
}

function createTask(
  profiles: ConnectionProfile[],
  concurrencyLimit = 2,
  batchSize = 2,
  sourceText = RUNBOOK,
  now = 1_000,
): MultiHostRunbookTask {
  return createMultiHostRunbookTask({
    id: 'multi-task-1',
    sourceText,
    variableValues: { SERVICE: 'nginx' },
    profiles,
    selectedTag: 'production',
    concurrencyLimit,
    batchSize,
    now,
    createRunId: (profileId) => `run:${profileId}`,
  });
}

let operationSequence = 0;
function plan(task: MultiHostRunbookTask, now = 1_000) {
  return planMultiHostRunbookDispatches(
    task,
    (profileId, itemId) => `operation:${profileId}:${itemId}:${operationSequence += 1}`,
    now,
  );
}

function result(
  dispatch: MultiHostRunbookDispatch,
  status: RunbookStepExecutionResult['status'] = 'success',
  output = `${dispatch.profileId}-output`,
  now = 1_100,
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
    startedAt: now - 50,
    completedAt: now,
    source: {
      kind: 'sshRunbook',
      profileId: dispatch.profileId,
      host: dispatch.target.host,
      port: dispatch.target.port,
      username: dispatch.target.username,
    },
    exitCode: status === 'success' ? 0 : 1,
    expectedMatched: status === 'success',
    stdout: output,
    error: status === 'success' ? undefined : `${dispatch.profileId}-${status}`,
  };
}

function finishPreflights(task: MultiHostRunbookTask, now = 1_100): MultiHostRunbookTask {
  const scheduled = plan(task, now - 100);
  return scheduled.dispatches.reduce(
    (current, dispatch) => applyMultiHostRunbookResult(current, dispatch.profileId, result(dispatch, 'success', `${dispatch.profileId}-preflight`, now), now),
    scheduled.task,
  );
}

function finishTwoHostTask(
  profiles: ConnectionProfile[],
  secondStatus: RunbookStepExecutionResult['status'] = 'failed',
): MultiHostRunbookTask {
  let task = finishPreflights(createTask(profiles), 1_100);
  task = approveMultiHostRunbookHost(task, profiles[0].id, 1_200);
  task = approveMultiHostRunbookHost(task, profiles[1].id, 1_200);
  const scheduled = plan(task, 1_200);
  task = applyMultiHostRunbookResult(
    scheduled.task,
    scheduled.dispatches[0].profileId,
    result(scheduled.dispatches[0], 'success', 'first-step-output', 1_300),
    1_300,
  );
  task = applyMultiHostRunbookResult(
    task,
    scheduled.dispatches[1].profileId,
    result(scheduled.dispatches[1], secondStatus, 'second-step-output', 1_300),
    1_300,
  );
  return task;
}

describe('multi-host Runbook target selection and scheduling', () => {
  it('selects frozen targets by normalized connection tag and rejects an empty target set', () => {
    const profiles = [profile(1, [' Production ']), profile(2, ['staging']), profile(3, ['PRODUCTION'])];
    expect(selectMultiHostProfilesByTag(profiles, 'production').map((entry) => entry.id))
      .toEqual(['profile-1', 'profile-3']);
    expect(() => createTask(profiles, 1, 1)).not.toThrow();
    expect(() => createMultiHostRunbookTask({
      id: 'empty',
      sourceText: RUNBOOK,
      variableValues: {},
      profiles,
      selectedTag: 'missing',
      concurrencyLimit: 1,
      batchSize: 1,
      createRunId: () => 'unused',
    })).toThrow('selected connection tag has no targets');
  });

  it('enforces concurrency and batch boundaries', () => {
    const profiles = [profile(1), profile(2), profile(3), profile(4)];
    let task = createTask(profiles, 2, 2);
    const firstBatch = plan(task);
    expect(firstBatch.dispatches.map((dispatch) => dispatch.profileId)).toEqual(['profile-1', 'profile-2']);
    expect(new Set(firstBatch.dispatches.map((dispatch) => dispatch.operationId)).size).toBe(2);
    expect(firstBatch.task.hosts.filter((host) => host.activeOperationId)).toHaveLength(2);

    task = firstBatch.dispatches.reduce(
      (current, dispatch) => applyMultiHostRunbookResult(current, dispatch.profileId, result(dispatch), 1_100),
      firstBatch.task,
    );
    expect(activeMultiHostRunbookBatch(task)).toBe(1);
    expect(approveMultiHostRunbookHost(task, 'profile-1', 1_200)).toBe(task);
    const secondPreflightBatch = plan(task, 1_100);
    expect(secondPreflightBatch.dispatches.map((dispatch) => dispatch.profileId))
      .toEqual(['profile-3', 'profile-4']);
    task = secondPreflightBatch.dispatches.reduce(
      (current, dispatch) => applyMultiHostRunbookResult(current, dispatch.profileId, result(dispatch), 1_150),
      secondPreflightBatch.task,
    );
    expect(activeMultiHostRunbookBatch(task)).toBe(0);
    expect(plan(task, 1_150).dispatches).toHaveLength(0);

    task = approveMultiHostRunbookHost(task, 'profile-1', 1_200);
    task = approveMultiHostRunbookHost(task, 'profile-2', 1_200);
    const actions = plan(task, 1_200);
    expect(actions.dispatches).toHaveLength(2);
    task = actions.dispatches.reduce(
      (current, dispatch) => applyMultiHostRunbookResult(current, dispatch.profileId, result(dispatch), 1_300),
      actions.task,
    );
    expect(activeMultiHostRunbookBatch(task)).toBe(1);
    expect(plan(task, 1_300).dispatches).toHaveLength(0);
    task = approveMultiHostRunbookHost(task, 'profile-3', 1_300);
    task = approveMultiHostRunbookHost(task, 'profile-4', 1_300);
    expect(plan(task, 1_300).dispatches.map((dispatch) => dispatch.profileId))
      .toEqual(['profile-3', 'profile-4']);
  });

  it('rejects invalid concurrency and batch configuration', () => {
    const profiles = [profile(1), profile(2)];
    expect(() => createTask(profiles, 0, 2)).toThrow('concurrencyLimit');
    expect(() => createTask(profiles, 9, 9)).toThrow('concurrencyLimit');
    expect(() => createTask(profiles, 2, 1)).toThrow('cannot exceed batchSize');
    expect(() => createTask(profiles, 1, 51)).toThrow('batchSize');
  });

  it('opens only the failed host circuit and never schedules its later steps', () => {
    const profiles = [profile(1), profile(2)];
    const scheduled = plan(createTask(profiles));
    let task = applyMultiHostRunbookResult(
      scheduled.task,
      'profile-1',
      result(scheduled.dispatches[0], 'failed'),
      1_100,
    );
    task = applyMultiHostRunbookResult(
      task,
      'profile-2',
      result(scheduled.dispatches[1], 'success'),
      1_100,
    );
    expect(task.hosts.find((host) => host.target.profileId === 'profile-1')).toMatchObject({
      status: 'failed',
      circuitOpen: true,
    });
    expect(task.hosts.find((host) => host.target.profileId === 'profile-2')?.status).toBe('awaitingApproval');
    expect(plan(task, 1_200).dispatches).toHaveLength(0);
  });
});

describe('multi-host Runbook safety and recovery', () => {
  it('keeps a nonzero exit successful when the Runbook adapter matched reviewed expectations', () => {
    const expectedNonzero = RUNBOOK.replace(
      '"expected":{"exitCode":0}',
      '"expected":{"exitCode":7}',
    );
    const scheduled = plan(createTask([profile(1)], 1, 1, expectedNonzero));
    const adapted = result(scheduled.dispatches[0], 'success', 'expected-nonzero');
    adapted.exitCode = 7;
    adapted.expectedMatched = true;

    const task = applyMultiHostRunbookResult(
      scheduled.task,
      'profile-1',
      adapted,
      1_100,
    );
    expect(task.hosts[0]).toMatchObject({ status: 'awaitingApproval', circuitOpen: false });
    expect(task.hosts[0].run.items[0].evidence).toMatchObject({
      exitCode: 7,
      stdout: 'expected-nonzero',
    });
  });

  it('keeps cancellation and timeout scoped to the exact host operation', () => {
    const profiles = [profile(1), profile(2)];
    const scheduled = plan(createTask(profiles));
    let task = requestCancelMultiHostRunbookHost(scheduled.task, 'profile-1');
    expect(task.hosts[0].status).toBe('cancelling');
    expect(task.hosts[1].status).toBe('preflighting');
    task = applyMultiHostRunbookResult(
      task,
      'profile-1',
      result(scheduled.dispatches[0], 'cancelled'),
      1_100,
    );
    task = applyMultiHostRunbookResult(
      task,
      'profile-2',
      result(scheduled.dispatches[1], 'timedOut'),
      1_100,
    );
    expect(task.hosts.map((host) => host.status)).toEqual(['cancelled', 'timedOut']);
    expect(summarizeMultiHostRunbookTask(task).outcome).toBe('failed');

    const queued = requestCancelMultiHostRunbookHost(createTask([profile(3)], 1, 1), 'profile-3');
    expect(queued.hosts[0]).toMatchObject({ status: 'cancelled', circuitOpen: true });

    const lateScheduled = plan(createTask([profile(4)], 1, 1));
    const cancelling = requestCancelMultiHostRunbookHost(lateScheduled.task, 'profile-4');
    const lateSuccess = applyMultiHostRunbookResult(
      cancelling,
      'profile-4',
      result(lateScheduled.dispatches[0], 'success'),
      1_100,
    );
    expect(lateSuccess.hosts[0]).toMatchObject({ status: 'cancelled', circuitOpen: true });
    expect(lateSuccess.hosts[0].run.items[0].status).toBe('completed');
  });

  it('requires fresh per-host preflight evidence at approval time', () => {
    const profiles = [profile(1)];
    let task = finishPreflights(createTask(profiles, 1, 1), 1_100);
    task = approveMultiHostRunbookHost(task, 'profile-1', 31_100);
    expect(task.hosts[0]).toMatchObject({
      status: 'staleEvidence',
      circuitOpen: true,
      failure: { kind: 'staleEvidence', safeToRetry: true },
    });
    expect(plan(task, 31_100).dispatches).toHaveLength(0);
  });

  it('presents partial success as a first-class terminal outcome', () => {
    const task = finishTwoHostTask([profile(1), profile(2)]);
    expect(task.hosts.map((host) => host.status)).toEqual(['succeeded', 'failed']);
    expect(summarizeMultiHostRunbookTask(task)).toMatchObject({
      succeeded: 1,
      failed: 1,
      outcome: 'partialSuccess',
    });
  });

  it('retries only explicitly failed, safe hosts from fresh preflight under the same batch policy', () => {
    const profiles = [profile(1), profile(2)];
    const partial = finishTwoHostTask(profiles);
    expect(canRetryMultiHostRunbookHost(partial, 'profile-1', profiles)).toBe(false);
    expect(canRetryMultiHostRunbookHost(partial, 'profile-2', profiles)).toBe(true);
    expect(retryMultiHostRunbookHosts(partial, ['profile-1'], profiles)).toBe(partial);

    const retried = retryMultiHostRunbookHosts(partial, ['profile-2'], profiles, 2_000);
    expect(retried.hosts[0]).toBe(partial.hosts[0]);
    expect(retried.hosts[1]).toMatchObject({
      attempt: 2,
      batchIndex: 0,
      status: 'queuedPreflight',
      circuitOpen: false,
    });
    expect(retried.hosts[1].run.items[0]).toMatchObject({ status: 'awaitingApproval', evidence: undefined });
    expect(retried.hosts[1].run.items[1]).toMatchObject({ status: 'queued', evidence: undefined });
    expect(plan(retried, 2_000).dispatches.map((dispatch) => dispatch.profileId)).toEqual(['profile-2']);

    const retagged = [{ ...profiles[1], tags: ['staging'] }, profiles[0]];
    expect(canRetryMultiHostRunbookHost(partial, 'profile-2', retagged)).toBe(false);
    const changedTarget = profiles.map((entry) => entry.id === 'profile-2' ? { ...entry, host: 'replacement.test' } : entry);
    expect(canRetryMultiHostRunbookHost(partial, 'profile-2', changedTarget)).toBe(false);
  });

  it('does not retry a host whose failed modification is not declared safe', () => {
    const unsafeRunbook = RUNBOOK.replace('"safeToRetry":true', '"safeToRetry":false');
    const profiles = [profile(1)];
    let task = finishPreflights(createTask(profiles, 1, 1, unsafeRunbook), 1_100);
    task = approveMultiHostRunbookHost(task, 'profile-1', 1_200);
    const scheduled = plan(task, 1_200);
    task = applyMultiHostRunbookResult(
      scheduled.task,
      'profile-1',
      result(scheduled.dispatches[0], 'timedOut'),
      1_300,
    );
    expect(task.hosts[0].failure?.safeToRetry).toBe(false);
    expect(retryMultiHostRunbookHosts(task, ['profile-1'], profiles)).toBe(task);
  });

  it('discards mismatched result identity and never stores its output', () => {
    const scheduled = plan(createTask([profile(1)], 1, 1));
    const poisoned = result(scheduled.dispatches[0], 'success', 'POISONED-OUTPUT');
    poisoned.source.host = 'wrong-host.example.test';
    const task = applyMultiHostRunbookResult(scheduled.task, 'profile-1', poisoned, 1_100);
    expect(task.hosts[0]).toMatchObject({
      status: 'identityMismatch',
      circuitOpen: true,
      failure: { kind: 'identityMismatch' },
    });
    expect(task.hosts[0].run.items.every((item) => item.evidence?.stdout !== 'POISONED-OUTPUT')).toBe(true);
  });

  it('isolates variable snapshots, commands, evidence, exit codes and output per host', () => {
    const profiles = [profile(1), profile(2)];
    const scheduled = plan(createTask(profiles));
    expect(scheduled.task.hosts[0].variableValues).not.toBe(scheduled.task.hosts[1].variableValues);
    scheduled.task.hosts[0].variableValues.SERVICE = 'changed-locally';
    expect(scheduled.task.hosts[1].variableValues.SERVICE).toBe('nginx');

    let task = applyMultiHostRunbookResult(
      scheduled.task,
      'profile-1',
      result(scheduled.dispatches[0], 'success', 'alpha-only'),
      1_100,
    );
    task = applyMultiHostRunbookResult(
      task,
      'profile-2',
      result(scheduled.dispatches[1], 'success', 'bravo-only'),
      1_100,
    );
    const alphaEvidence = task.hosts[0].run.items[0].evidence;
    const bravoEvidence = task.hosts[1].run.items[0].evidence;
    expect(alphaEvidence).toMatchObject({ profileId: 'profile-1', exitCode: 0, stdout: 'alpha-only' });
    expect(bravoEvidence).toMatchObject({ profileId: 'profile-2', exitCode: 0, stdout: 'bravo-only' });
    expect(alphaEvidence?.stdout).not.toContain('bravo');
    expect(bravoEvidence?.stdout).not.toContain('alpha');
    expect(task.hosts[0].run.items[0].commandPreview).toBe(task.hosts[1].run.items[0].commandPreview);
  });
});
