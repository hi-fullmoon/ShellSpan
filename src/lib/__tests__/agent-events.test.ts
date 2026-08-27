import { describe, expect, it } from 'vitest';
import { AgentEventCursorV1 } from '@/lib/agent-events';
import type { AgentEventTypeV1, AgentEventV1, AgentRunSnapshotV1 } from '@/types/agent';

function event(sequence: number, type: AgentEventTypeV1 = 'run.stateChanged'): AgentEventV1 {
  return {
    schemaVersion: 1,
    runId: 'run-1',
    sequence,
    occurredAt: sequence,
    type,
    payload: {},
  };
}

function snapshot(lastSequence: number, state: AgentRunSnapshotV1['state'] = 'thinking'): AgentRunSnapshotV1 {
  return {
    schemaVersion: 1,
    runId: 'run-1',
    lastSequence,
    state,
    target: {
      profileId: 'profile-1',
      profileLabel: 'Fixture',
      host: 'fixture.invalid',
      port: 22,
      username: 'fixture',
      authMethod: 'fixture',
      targetDigest: 'fixture-digest',
    },
    provider: {
      providerId: 'provider-1',
      kind: 'openAiCompatible',
      baseUrl: 'https://fixture.invalid',
      model: 'fake',
      capabilities: {
        streaming: false,
        strictJsonSchema: true,
        nativeToolCalling: false,
        usageReporting: false,
        responseContinuation: false,
      },
    },
    policy: {
      mode: 'readOnly',
      policyVersion: 'p1-a-fixture',
      toolRegistryVersion: 'none',
      allowedTools: [],
    },
    budgets: {
      schemaVersion: 1,
      policy: {
        maxRunSeconds: 600,
        maxModelTurns: 12,
        maxToolCalls: 10,
        toolTimeoutSeconds: 15,
        maxConsecutiveInvalidDecisions: 2,
        maxConsecutiveToolFailures: 2,
        maxPendingPlanItems: 6,
        maxSteeringQueueItems: 8,
        maxUserMessageBytes: 4096,
        stdoutCaptureBytes: 65536,
        stderrCaptureBytes: 16384,
        totalReadHardLimitBytes: 8388608,
      },
      usage: {
        elapsedMillis: 0,
        modelTurnsUsed: 0,
        toolCallsUsed: 0,
        consecutiveInvalidDecisions: 0,
        consecutiveToolFailures: 0,
        steeringQueueItems: 0,
      },
    },
    goal: 'Inspect the fixture.',
    plan: [],
    toolCalls: [],
    evidence: [],
    queuedSteeringCount: 0,
  };
}

describe('AgentEventCursorV1', () => {
  it('recovers a remounted panel from the authoritative snapshot', () => {
    const mounted = new AgentEventCursorV1('run-1');
    expect(mounted.installSnapshot(snapshot(5)).lastSequence).toBe(5);
    expect(mounted.accept(event(6)).applied.map((item) => item.sequence)).toEqual([6]);

    const remounted = new AgentEventCursorV1('run-1');
    // Mount subscribes before snapshot. An event arriving in that window is
    // buffered, then removed by the authoritative snapshot sequence.
    expect(remounted.accept(event(7)).status).toBe('gap');
    expect(remounted.installSnapshot(snapshot(7)).lastSequence).toBe(7);
    expect(remounted.accept(event(8)).lastSequence).toBe(8);
  });

  it('blocks across a gap, ignores duplicates, and drains buffered events after resync', () => {
    const cursor = new AgentEventCursorV1('run-1');
    cursor.installSnapshot(snapshot(5));

    expect(cursor.accept(event(7)).status).toBe('gap');
    expect(cursor.resyncRequired).toBe(true);
    expect(cursor.accept(event(7)).status).toBe('duplicate');
    expect(cursor.accept(event(6)).status).toBe('buffered');

    const resynced = cursor.installSnapshot(snapshot(6));
    expect(resynced.applied.map((item) => item.sequence)).toEqual([7]);
    expect(resynced.lastSequence).toBe(7);
    expect(resynced.resyncRequired).toBe(false);
    expect(cursor.accept(event(7)).status).toBe('duplicate');
  });

  it('never lets a late event override an authoritative terminal', () => {
    const cursor = new AgentEventCursorV1('run-1');
    cursor.installSnapshot(snapshot(8));
    expect(cursor.accept(event(9, 'run.terminal')).lastSequence).toBe(9);
    expect(cursor.accept(event(10, 'run.stateChanged')).status).toBe('ignoredTerminal');

    const remounted = new AgentEventCursorV1('run-1');
    remounted.installSnapshot(snapshot(9, 'cancelled'));
    expect(remounted.accept(event(10)).status).toBe('ignoredTerminal');
  });
});
