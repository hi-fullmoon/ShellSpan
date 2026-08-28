import { beforeEach, describe, expect, it } from 'vitest';
import { decodeAgentTerminalSnapshotV1 } from '@/lib/agent-terminal-control';
import {
  makeAgentTerminalSnapshot,
  makePendingTerminalApprovalSnapshot,
  makeTerminalApproval,
} from '@/test/agent-terminal-fixtures';
import { useAgentTerminalStore } from '../agentTerminalStore';

describe('agentTerminalStore', () => {
  beforeEach(() => {
    useAgentTerminalStore.getState().reset();
  });

  it('installs decoded authoritative snapshots and drops backward sequence', () => {
    const current = makeAgentTerminalSnapshot({ lastSequence: 4, leaseRevision: 4 });
    const stale = makeAgentTerminalSnapshot({ lastSequence: 3, leaseRevision: 3 });
    expect(useAgentTerminalStore.getState().installSnapshot(current)).toBe('installed');
    expect(useAgentTerminalStore.getState().installSnapshot(stale)).toBe('stale');
    expect(useAgentTerminalStore.getState().snapshotsByRunId['run-1']).toEqual(current);
  });

  it('allows an equal-sequence reconnect projection but never changes frozen binding', () => {
    expect(useAgentTerminalStore.getState().installSnapshot(
      makeAgentTerminalSnapshot({ controlState: 'disconnected', lastSequence: 4 }),
    )).toBe('installed');
    expect(useAgentTerminalStore.getState().installSnapshot(
      makeAgentTerminalSnapshot({ controlState: 'disconnected', lastSequence: 4, leaseEpoch: 2 }),
    )).toBe('installed');
    expect(useAgentTerminalStore.getState().installSnapshot(
      makeAgentTerminalSnapshot({
        runId: 'run-1',
        sessionId: 'ordinary-session',
        lastSequence: 5,
      }),
    )).toBe('bindingMismatch');
    expect(useAgentTerminalStore.getState().snapshotsByRunId['run-1'].sessionId)
      .toBe('agent-session-1');
  });

  it('rejects unknown fields, inconsistent authority, and fake verification', () => {
    expect(() => decodeAgentTerminalSnapshotV1({
      ...makeAgentTerminalSnapshot(),
      leaseToken: 'must-not-exist',
    })).toThrow(/unknown field/);
    expect(() => decodeAgentTerminalSnapshotV1({
      ...makeAgentTerminalSnapshot(),
      leaseOwner: 'user',
    })).toThrow(/inconsistent/);
    expect(() => decodeAgentTerminalSnapshotV1({
      ...makeAgentTerminalSnapshot(),
      actions: [{
        actionId: 'action-1',
        actionKind: 'terminal.respond',
        actionDigest: 'sha256-v1:action',
        state: 'completed',
        risk: null,
        approvalId: null,
        observationId: null,
        verification: null,
        verified: true,
        proposedAtMs: 1,
        updatedAtMs: 2,
      }],
    })).toThrow(/independent evidence/);
    const pending = makePendingTerminalApprovalSnapshot();
    expect(useAgentTerminalStore.getState().installSnapshot({
      ...pending,
      pendingApproval: makeTerminalApproval(Date.now(), { leaseRevision: 99 }),
    })).toBe('invalid');
    expect(useAgentTerminalStore.getState().installSnapshot({
      ...pending,
      currentObservation: {
        ...pending.currentObservation!,
        captureEpoch: pending.captureEpoch + 1,
      },
    })).toBe('invalid');
    expect(useAgentTerminalStore.getState().installSnapshot({
      ...pending,
      pendingApproval: {
        ...pending.pendingApproval!,
        risk: { ...pending.pendingApproval!.risk, severity: 'critical' },
      },
    })).toBe('invalid');
  });

  it('stores refresh events only as hints and never mutates owner authority', () => {
    const snapshot = makeAgentTerminalSnapshot();
    useAgentTerminalStore.getState().installSnapshot(snapshot);
    useAgentTerminalStore.getState().noteRefreshHint('run-1', 'transport:disconnected');
    expect(useAgentTerminalStore.getState().refreshHintByRunId['run-1'])
      .toBe('transport:disconnected');
    expect(useAgentTerminalStore.getState().snapshotsByRunId['run-1'].leaseOwner)
      .toBe('agent');
  });
});
