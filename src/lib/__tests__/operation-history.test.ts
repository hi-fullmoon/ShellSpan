import { describe, expect, it } from 'vitest';
import {
  groupOperationHistory,
  operationHistoryTestApi,
  recordInvocationStarted,
} from '@/lib/operation-history';
import type { OperationHistoryEvent } from '@/types/operation-history';

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
