import { beforeEach, describe, expect, it } from 'vitest';
import { useAgentStore } from '@/stores/agentStore';
import { makeAgentEvent, makeAgentSnapshot } from '@/test/agent-fixtures';

describe('Agent snapshot projection store', () => {
  beforeEach(() => {
    useAgentStore.getState().reset();
  });

  it('resyncs on contiguous events and gaps without applying untrusted payloads', () => {
    expect(useAgentStore.getState().installSnapshot(makeAgentSnapshot())).toBe(true);

    expect(useAgentStore.getState().acceptEvent(makeAgentEvent(6))).toMatchObject({
      status: 'applied',
      resyncRequired: true,
    });
    expect(useAgentStore.getState().runsById['run-1'].lastSequence).toBe(5);
    expect(useAgentStore.getState().resyncingRunIds['run-1']).toBe(true);

    expect(useAgentStore.getState().acceptEvent(makeAgentEvent(6))).toMatchObject({
      status: 'duplicate',
      resyncRequired: false,
    });
    expect(useAgentStore.getState().resyncingRunIds['run-1']).toBe(true);

    expect(useAgentStore.getState().acceptEvent(makeAgentEvent(8))).toMatchObject({
      status: 'gap',
      resyncRequired: true,
    });
    expect(useAgentStore.getState().acceptEvent(makeAgentEvent(7)).status).toBe('buffered');

    expect(useAgentStore.getState().installSnapshot(makeAgentSnapshot({ lastSequence: 8 }))).toBe(true);
    expect(useAgentStore.getState().lastSequenceByRunId['run-1']).toBe(8);
    expect(useAgentStore.getState().resyncingRunIds['run-1']).toBe(false);
  });

  it('ignores late events after a terminal snapshot', () => {
    expect(useAgentStore.getState().installSnapshot(makeAgentSnapshot({
      lastSequence: 9,
      state: 'cancelled',
    }))).toBe(true);

    expect(useAgentStore.getState().acceptEvent(makeAgentEvent(10))).toMatchObject({
      status: 'ignoredTerminal',
      resyncRequired: false,
    });
    expect(useAgentStore.getState().runsById['run-1'].state).toBe('cancelled');
    expect(useAgentStore.getState().lastSequenceByRunId['run-1']).toBe(9);
  });

  it('rejects frozen target changes and terminal regression', () => {
    expect(useAgentStore.getState().installSnapshot(makeAgentSnapshot())).toBe(true);
    expect(useAgentStore.getState().installSnapshot(makeAgentSnapshot({
      lastSequence: 6,
      target: {
        ...makeAgentSnapshot().target,
        profileId: 'profile-2',
      },
    }))).toBe(false);
    expect(useAgentStore.getState().runsById['run-1'].target.profileId).toBe('profile-1');
    expect(useAgentStore.getState().projectionErrorByRunId['run-1']).toMatch(/frozen/i);

    useAgentStore.getState().reset();
    expect(useAgentStore.getState().installSnapshot(makeAgentSnapshot({ state: 'completed' }))).toBe(true);
    expect(useAgentStore.getState().installSnapshot(makeAgentSnapshot({
      lastSequence: 6,
      state: 'thinking',
    }))).toBe(false);
    expect(useAgentStore.getState().runsById['run-1'].state).toBe('completed');
  });

  it('rejects malformed versions and a second active run', () => {
    expect(useAgentStore.getState().installSnapshot({
      ...makeAgentSnapshot(),
      schemaVersion: 2,
    })).toBe(false);
    expect(useAgentStore.getState().installSnapshot(makeAgentSnapshot())).toBe(true);
    expect(useAgentStore.getState().installSnapshot(makeAgentSnapshot({
      runId: 'run-2',
      target: { ...makeAgentSnapshot().target, targetDigest: 'sha256-v1:other' },
    }))).toBe(false);
    expect(useAgentStore.getState().activeRunId).toBe('run-1');
  });
});
