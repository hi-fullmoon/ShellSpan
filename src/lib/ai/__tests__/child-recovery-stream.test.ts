import { expect, it, vi } from 'vitest';
import { copyFile, mkdtemp, readFile, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentSessionCommittedClient, type AgentSessionStreamTransport } from '../agent-session-client';
import { agentSessionView } from '../agent-session-adapter';
import { latestFailureRecovery } from '../failure-recovery';
import runningSnapshotJson from '@/test/fixtures/child-failure-recovery/running-snapshot.json';
import {
  childAdmittedEvents, childAdmittedSnapshot, childFailureEvents, childFailureRecordedAt, childFailureSnapshot,
} from '@/test/fixtures/child-recovery-recording';
import type { AgentSessionEvent, AgentSessionSnapshot } from '@/types/agent-session';

it.each(['live', 'reconciliation'])('refreshes native child eligibility on %s failure and clears terminal state on the recorded recovery event', async mode => {
  vi.useFakeTimers();
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
    if (mode === 'live') for (const event of events.slice(beforeCount)) listener?.(event);
    else await vi.advanceTimersByTimeAsync(5_000);
    const failed = await client.settled();
    expect(failed.hasTerminalEvent).toBe(true);
    expect(latestFailureRecovery(agentSessionView(failed), childFailureRecordedAt)).toMatchObject({ kind: 'retry', turnId: 'failure-turn' });

    snapshot = childAdmittedSnapshot;
    events = childAdmittedEvents;
    if (mode === 'live') for (const event of events.slice(childFailureEvents.length)) listener?.(event);
    else await vi.advanceTimersByTimeAsync(5_000);
    const admitted = await client.settled();
    expect(admitted.hasTerminalEvent).toBe(false);
    const view = agentSessionView(admitted);
    expect(view.snapshot.value.ended).toBe(false);
    expect(view.inbox).toHaveLength(1);
    expect(view.committedOperationIds).toContain('child-retry-failure-turn');
    expect(latestFailureRecovery(view, childFailureRecordedAt)).toBeNull();
  } finally {
    client.disconnect();
    vi.useRealTimers();
  }
});

it.each(['live', 'reconciliation'])('retries failed child snapshot reads after %s boundaries without new events', async mode => {
  vi.useFakeTimers();
  const directory = await mkdtemp(join(tmpdir(), 'shellspan-child-snapshot-'));
  const snapshotPath = join(directory, 'snapshot.json');
  const recording = resolve(dirname(fileURLToPath(import.meta.url)), '../../../test/fixtures/child-failure-recovery');
  await copyFile(join(recording, 'running-snapshot.json'), snapshotPath);
  const initial = runningSnapshotJson as unknown as AgentSessionSnapshot;
  let events: readonly AgentSessionEvent[] = childFailureEvents.slice(0, initial.eventCount);
  let listener: ((event: AgentSessionEvent) => void) | undefined;
  let snapshotReads = 0;
  const transport: AgentSessionStreamTransport = {
    // Use recorded native snapshots and real filesystem read failures rather than
    // replacing production client methods or fabricating recovery eligibility.
    snapshot: async () => {
      snapshotReads++;
      return JSON.parse(await readFile(snapshotPath, 'utf8')) as AgentSessionSnapshot;
    },
    committedEvents: async ({ afterSeq, limit }) => {
      const remaining = events.filter(event => afterSeq === undefined || event.seq > afterSeq);
      const page = remaining.slice(0, limit);
      return { events: page, ...(remaining.length > page.length ? { nextCursor: page[page.length - 1].seq + 1 } : {}) };
    },
    subscribe: async callback => { listener = callback; return () => { listener = undefined; }; },
  };
  const client = new AgentSessionCommittedClient(initial.header.sessionId, transport);
  try {
    await client.connect();
    for (const stage of [
      { events: childFailureEvents, snapshot: childFailureSnapshot, file: 'failed-snapshot.json', ended: true },
      { events: childAdmittedEvents, snapshot: childAdmittedSnapshot, file: 'admitted-snapshot.json', ended: false },
    ]) {
      const previousCount = events.length;
      const previousSnapshot = client.state().snapshot;
      await unlink(snapshotPath);
      events = stage.events;
      if (mode === 'live') for (const event of events.slice(previousCount)) listener?.(event);
      else await vi.advanceTimersByTimeAsync(5_000);
      await expect(client.settled()).rejects.toThrow('ENOENT');
      expect(client.state().events).toEqual(stage.events);
      expect(client.state().snapshot).toBe(previousSnapshot);
      const attempts = snapshotReads;
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(client.settled()).rejects.toThrow('ENOENT');
      expect(snapshotReads).toBe(attempts + 1);

      await copyFile(join(recording, stage.file), snapshotPath);
      await vi.advanceTimersByTimeAsync(2_000);
      const recovered = await client.settled();
      expect(recovered.syncError).toBeUndefined();
      expect(recovered.syncRecovery).toBeUndefined();
      expect(recovered.snapshot).toEqual(stage.snapshot);
      expect(recovered.events).toEqual(stage.events);
      expect(recovered.hasTerminalEvent).toBe(stage.ended);
      const recovery = latestFailureRecovery(agentSessionView(recovered), childFailureRecordedAt);
      if (stage.ended) expect(recovery).toMatchObject({ kind: 'retry', turnId: 'failure-turn' });
      else expect(recovery).toBeNull();
    }
  } finally {
    client.disconnect();
    vi.useRealTimers();
    await rm(directory, { recursive: true, force: true });
  }
});
