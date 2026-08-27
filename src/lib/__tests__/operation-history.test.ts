import { afterEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

import {
  groupOperationHistory,
  operationHistoryTestApi,
  recordInvocationFinished,
  recordInvocationStarted,
} from '@/lib/operation-history';
import type { OperationHistoryEvent } from '@/types/operation-history';

afterEach(() => {
  invokeMock.mockReset();
  delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

describe('operation history IPC boundary', () => {
  it('excludes interactive terminal input and retains only safe transfer metadata', async () => {
    expect(operationHistoryTestApi.descriptorFor('write_session', {
      sessionId: 'session-1',
      data: 'password=top-secret\r',
    })).toBeUndefined();

    const context = await recordInvocationStarted('upload_local_paths', {
      request: {
        operationId: 'upload-1',
        localPaths: ['C:/secret/customer.txt'],
        destinationDirectory: '/srv/private',
        password: 'top-secret',
        connection: {
          profileId: 'profile-1',
          host: 'example.test',
          port: 22,
          username: 'operator',
          password: 'top-secret',
        },
      },
    }, 'fallback');

    expect(context).toMatchObject({
      taskId: 'upload-1',
      operationId: 'upload-1',
      action: 'uploadFiles',
      itemCount: 1,
      targets: [{
        profileId: 'profile-1',
        host: 'example.test',
        port: 22,
        username: 'operator',
      }],
    });
    expect(JSON.stringify(context)).not.toContain('top-secret');
    expect(JSON.stringify(context)).not.toContain('customer.txt');
    expect(JSON.stringify(context)).not.toContain('/srv/private');
  });

  it('classifies partial transfer results and rejects result identity mismatches', async () => {
    const upload = await recordInvocationStarted('upload_local_paths', {
      request: {
        operationId: 'upload-1',
        localPaths: ['a', 'b'],
        connection: { profileId: 'p1', host: 'a.test', port: 22, username: 'alice' },
      },
    }, 'fallback');
    expect(operationHistoryTestApi.statusFromResult(upload!, {
      items: [{ status: 'completed' }, { status: 'failed', error: 'raw high-sensitive output' }],
    })).toBe('partialSuccess');

    const runbook = await recordInvocationStarted('execute_runbook_step', {
      request: {
        operationId: 'step-1',
        runId: 'run-1',
        profileId: 'p1',
        itemId: 'check',
        approvedRisk: 'readOnly',
        authorized: true,
        connection: { profileId: 'p1', host: 'a.test', port: 22, username: 'alice' },
      },
    }, 'fallback');
    expect(operationHistoryTestApi.statusFromResult(runbook!, {
      operationId: 'step-1',
      runId: 'run-1',
      profileId: 'p2',
      status: 'success',
      source: { host: 'b.test', port: 22, username: 'mallory' },
    })).toBe('identityMismatch');
  });

  it('records reviewed deployments and fails closed on a late target result', async () => {
    const context = await recordInvocationStarted('execute_deployment', {
      request: {
        operationId: 'deployment:history-1',
        profileId: 'profile-1',
        connection: {
          profileId: 'profile-1',
          host: 'deploy.example.test',
          port: 22,
          username: 'operator',
        },
        approval: {
          reviewId: 'deployment-review:history-1',
          documentDigest: 'sha256-v1:document',
          planDigest: 'sha256-v1:plan',
          targetDigest: 'sha256-v1:target',
          approvedRisk: 'stateChange',
          authorized: true,
        },
      },
    }, 'fallback', {
      deploymentIdentity: {
        reviewId: 'deployment-review:history-1',
        documentDigest: 'sha256-v1:document',
        planDigest: 'sha256-v1:plan',
        deploymentId: 'release-1',
        version: '1.0.0',
        targetDigest: 'sha256-v1:target',
      },
    });

    expect(context).toMatchObject({
      taskId: 'deployment:history-1',
      operationId: 'deployment:history-1',
      category: 'deployment',
      action: 'executeDeployment',
      risk: 'stateChange',
      approved: true,
      targets: [{
        profileId: 'profile-1',
        host: 'deploy.example.test',
        port: 22,
        username: 'operator',
        identityFingerprint: 'sha256-v1:target',
      }],
    });

    const result = {
      operationId: 'deployment:history-1',
      reviewId: 'deployment-review:history-1',
      documentDigest: 'sha256-v1:document',
      planDigest: 'sha256-v1:plan',
      deploymentId: 'release-1',
      version: '1.0.0',
      phase: 'succeeded',
      target: {
        profileId: 'profile-1',
        host: 'deploy.example.test',
        port: 22,
        username: 'operator',
        identityDigest: 'sha256-v1:target',
      },
    };
    expect(operationHistoryTestApi.statusFromResult(context!, result)).toBe('succeeded');
    expect(operationHistoryTestApi.statusFromResult(context!, {
      ...result,
      target: { ...result.target, host: 'late.example.test' },
    })).toBe('identityMismatch');
    expect(operationHistoryTestApi.statusFromResult(context!, {
      ...result,
      phase: 'timedOut',
    })).toBe('timedOut');
    expect(operationHistoryTestApi.statusFromResult(context!, {
      ...result,
      planDigest: 'sha256-v1:late-plan',
    })).toBe('identityMismatch');
  });

  it('pins approval to the reviewed command and task before accepting a result', async () => {
    const context = await recordInvocationStarted('execute_runbook_step', {
      request: {
        operationId: 'step-approval-1',
        runId: 'host-run-1',
        profileId: 'p1',
        itemId: 'reload-service',
        approvedRisk: 'stateChange',
        authorized: true,
        connection: { profileId: 'p1', host: 'a.test', port: 22, username: 'alice' },
      },
    }, 'fallback', {
      taskId: 'multi-host-task-1',
      commandPreview: 'systemctl reload nginx',
    });

    expect(context).toMatchObject({
      taskId: 'multi-host-task-1',
      operationId: 'step-approval-1',
      runId: 'host-run-1',
      risk: 'stateChange',
      commandPreview: 'systemctl reload nginx',
      approved: true,
      targets: [{ profileId: 'p1', host: 'a.test', port: 22, username: 'alice' }],
    });

    const result = {
      operationId: 'step-approval-1',
      runId: 'host-run-1',
      profileId: 'p1',
      status: 'success',
      risk: 'stateChange',
      commandPreview: 'systemctl reload nginx',
      source: { host: 'a.test', port: 22, username: 'alice' },
    };
    expect(operationHistoryTestApi.statusFromResult(context!, result)).toBe('succeeded');
    expect(operationHistoryTestApi.statusFromResult(context!, {
      ...result,
      commandPreview: 'systemctl restart nginx',
    })).toBe('identityMismatch');
    expect(operationHistoryTestApi.statusFromResult(context!, {
      ...result,
      risk: 'readOnly',
    })).toBe('identityMismatch');

    const keychainPreview = "curl --password '<keychain://profile/password>' example.test";
    const keychainContext = await recordInvocationStarted('execute_runbook_step', {
      request: {
        operationId: 'step-keychain-1',
        runId: 'host-run-2',
        profileId: 'p1',
        itemId: 'authenticated-check',
        approvedRisk: 'stateChange',
        authorized: true,
        connection: { profileId: 'p1', host: 'a.test', port: 22, username: 'alice' },
      },
    }, 'fallback', { commandPreview: keychainPreview });
    expect(keychainContext?.commandPreview).toBe(keychainPreview);
  });

  it('records the frozen runbook start, approval, completion, and cancellation event sequences', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    });
    invokeMock.mockResolvedValue(undefined);

    const commandPreview = "curl --password '<keychain://profile/password>' example.test";
    const context = await recordInvocationStarted('execute_runbook_step', {
      request: {
        operationId: 'step-events-1',
        runId: 'run-events-1',
        profileId: 'p1',
        itemId: 'authenticated-check',
        approvedRisk: 'stateChange',
        authorized: true,
        runbookText: 'raw runbook must not be retained',
        variableValues: { PASSWORD: 'top-secret' },
        connection: {
          profileId: 'p1',
          host: 'a.test',
          port: 22,
          username: 'alice',
          password: 'top-secret',
        },
      },
    }, 'fallback', { commandPreview });
    await recordInvocationFinished(context, {
      operationId: 'step-events-1',
      runId: 'run-events-1',
      profileId: 'p1',
      status: 'success',
      risk: 'stateChange',
      commandPreview,
      completedAt: 1_250,
      exitCode: 7,
      expectedMatched: true,
      stdout: 'raw output must not be retained',
      source: {
        kind: 'sshRunbook',
        profileId: 'p1',
        host: 'a.test',
        port: 22,
        username: 'alice',
      },
    });

    const executionEvents = invokeMock.mock.calls.map(([, args]) => args.request);
    expect(executionEvents.map((event) => [event.eventKind, event.status])).toEqual([
      ['started', 'running'],
      ['approved', 'running'],
      ['completed', 'succeeded'],
    ]);
    expect(executionEvents[0]).toMatchObject({
      taskId: 'run-events-1',
      operationId: 'step-events-1',
      category: 'runbook',
      action: 'executeRunbookStep',
      risk: 'stateChange',
      subjectId: 'authenticated-check',
      commandPreview,
      targets: [{
        kind: 'remote',
        profileId: 'p1',
        host: 'a.test',
        port: 22,
        username: 'alice',
      }],
    });
    expect(executionEvents[1].evidence).toEqual([
      expect.objectContaining({ operationId: 'step-events-1', kind: 'approval' }),
    ]);
    expect(executionEvents[2]).toMatchObject({
      occurredAt: 1_250,
      exitCode: 7,
      commandPreview,
    });
    const serializedEvents = JSON.stringify(executionEvents);
    expect(serializedEvents).not.toContain('top-secret');
    expect(serializedEvents).not.toContain('raw runbook must not be retained');
    expect(serializedEvents).not.toContain('raw output must not be retained');

    invokeMock.mockClear();
    const cancellation = await recordInvocationStarted('cancel_runbook_step', {
      operationId: 'step-events-1',
    }, 'fallback');
    await recordInvocationFinished(cancellation, undefined);

    const cancellationEvents = invokeMock.mock.calls.map(([, args]) => args.request);
    expect(cancellationEvents.map((event) => [event.eventKind, event.status])).toEqual([
      ['cancelRequested', 'cancelling'],
      ['completed', 'cancelling'],
    ]);
    expect(cancellationEvents[0]).toMatchObject({
      taskId: 'step-events-1',
      operationId: 'step-events-1',
      category: 'runbook',
      action: 'executeRunbookStep',
      risk: 'readOnly',
    });
  });

  it('maps every current runbook terminal result status into operation history', async () => {
    const context = await recordInvocationStarted('execute_runbook_step', {
      request: {
        operationId: 'step-status-1',
        runId: 'run-status-1',
        profileId: 'p1',
        itemId: 'check',
        approvedRisk: 'readOnly',
        authorized: true,
        connection: { profileId: 'p1', host: 'a.test', port: 22, username: 'alice' },
      },
    }, 'fallback');
    const result = {
      operationId: 'step-status-1',
      runId: 'run-status-1',
      profileId: 'p1',
      risk: 'readOnly',
      source: { host: 'a.test', port: 22, username: 'alice' },
    };

    expect(operationHistoryTestApi.statusFromResult(context!, { ...result, status: 'success' }))
      .toBe('succeeded');
    expect(operationHistoryTestApi.statusFromResult(context!, { ...result, status: 'failed' }))
      .toBe('failed');
    expect(operationHistoryTestApi.statusFromResult(context!, { ...result, status: 'cancelled' }))
      .toBe('cancelled');
    expect(operationHistoryTestApi.statusFromResult(context!, { ...result, status: 'timedOut' }))
      .toBe('timedOut');
    expect(operationHistoryTestApi.statusFromResult(context!, { ...result, status: 'unauthorized' }))
      .toBe('unauthorized');
  });

  it('makes cancellation, timeout, stale evidence, and target changes first-class errors', () => {
    expect(operationHistoryTestApi.historyError(new Error('operation cancelled'))).toEqual({
      status: 'cancelled',
      category: 'cancelled',
    });
    expect(operationHistoryTestApi.historyError(new Error('request timed out'))).toEqual({
      status: 'timedOut',
      category: 'timeout',
    });
    expect(operationHistoryTestApi.historyError(new Error('stale evidence'))).toEqual({
      status: 'failed',
      category: 'staleEvidence',
    });
    expect(operationHistoryTestApi.historyError(new Error('target changed'))).toEqual({
      status: 'failed',
      category: 'targetChanged',
    });
  });

  it('records host-key trust changes without requiring credentials', () => {
    expect(operationHistoryTestApi.descriptorFor('trust_host', {
      request: { host: 'example.test', port: 22 },
    })).toMatchObject({
      category: 'connection',
      action: 'trustHostKey',
      risk: 'stateChange',
      approved: true,
      targets: [{ kind: 'remote', host: 'example.test', port: 22 }],
    });
    expect(operationHistoryTestApi.descriptorFor('remove_known_host', {
      host: 'example.test',
      port: 22,
    })).toMatchObject({
      action: 'removeKnownHost',
      risk: 'destructive',
      targets: [{ kind: 'remote', host: 'example.test', port: 22 }],
    });
  });
});

describe('operation history task grouping', () => {
  it('orders each timeline chronologically while listing newest tasks first', () => {
    const event = (eventId: string, taskId: string, occurredAt: number): OperationHistoryEvent => ({
      eventId,
      taskId,
      operationId: eventId,
      occurredAt,
      category: 'runbook',
      action: 'executeRunbookStep',
      eventKind: 'completed',
      status: 'succeeded',
      targets: [],
      evidence: [],
    });
    const groups = groupOperationHistory([
      event('event-2', 'task-a', 2),
      event('event-3', 'task-b', 3),
      event('event-1', 'task-a', 1),
    ]);

    expect(groups.map((group) => group.taskId)).toEqual(['task-b', 'task-a']);
    expect(groups[1].events.map((value) => value.eventId)).toEqual(['event-1', 'event-2']);
  });
});
