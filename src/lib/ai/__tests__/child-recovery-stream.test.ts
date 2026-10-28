import { expect, it } from 'vitest';
import { AgentSessionCommittedClient, type AgentSessionStreamTransport } from '../agent-session-client';
import { agentSessionView } from '../agent-session-adapter';
import { latestFailureRecovery } from '../failure-recovery';
import runningSnapshotJson from '@/test/fixtures/child-failure-recovery/running-snapshot.json';
import {
  childAdmittedEvents, childAdmittedSnapshot, childFailureEvents, childFailureRecordedAt, childFailureSnapshot,
} from '@/test/fixtures/child-recovery-recording';
import type { AgentSessionEvent, AgentSessionSnapshot } from '@/types/agent-session';

it('refreshes native child eligibility on live failure and clears terminal state on the recorded recovery event', async () => {
  // Replay actual recorded stages through the production stream client. This
  // transport reads saved events/snapshots and does not fabricate IPC outcomes.
  let snapshot = runningSnapshotJson as unknown as AgentSessionSnapshot;
  let events: readonly AgentSessionEvent[] = childFailureEvents.slice(0, snapshot.eventCount);
  let listener: ((event: AgentSessionEvent) => void) | undefined;
  const transport: AgentSessionStreamTransport = {
    snapshot: async () => snapshot,
    committedEvents: async ({ afterSeq, limit }) => {
      const remaining = events.filter(event => afterSeq === undefined || event.seq > afterSeq);
      const page = remaining.slice(0, limit);
      return { events: page, ...(remaining.length > page.length ? { nextCursor: page[page.length - 1].seq + 1 } : {}) };
    },
    subscribe: async callback => { listener = callback; return () => { listener = undefined; }; },
  };
  const client = new AgentSessionCommittedClient(snapshot.header.sessionId, transport);
  try {
    await client.connect();
    expect(client.state().snapshot?.childFailureRecovery).toBeUndefined();
    const beforeCount = events.length;
    snapshot = childFailureSnapshot;
    events = childFailureEvents;
    for (const event of events.slice(beforeCount)) listener?.(event);
    const failed = await client.settled();
    expect(failed.hasTerminalEvent).toBe(true);
    expect(latestFailureRecovery(agentSessionView(failed), childFailureRecordedAt)).toMatchObject({ kind: 'retry', turnId: 'failure-turn' });

    snapshot = childAdmittedSnapshot;
    events = childAdmittedEvents;
    for (const event of events.slice(childFailureEvents.length)) listener?.(event);
    const admitted = await client.settled();
    expect(admitted.hasTerminalEvent).toBe(false);
    const view = agentSessionView(admitted);
    expect(view.snapshot.value.ended).toBe(false);
    expect(view.inbox).toHaveLength(1);
    expect(view.committedOperationIds).toContain('child-retry-failure-turn');
    expect(latestFailureRecovery(view, childFailureRecordedAt)).toBeNull();
  } finally {
    client.disconnect();
  }
});
