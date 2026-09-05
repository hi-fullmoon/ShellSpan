import { describe, expect, it } from 'vitest';

import {
  AgentSessionCommittedClient,
  type AgentSessionStreamTransport,
} from '@/lib/ai/agent-session-client';
import { agentSessionSteerFixture, sessionEvent } from '@/test/fixtures/agent-session';
import type {
  AgentSessionEvent,
  AgentSessionSnapshot,
} from '@/types/agent-session';

function snapshot(ended = false): AgentSessionSnapshot {
  return {
    header: {
      sessionId: 'session-fixture',
      taskId: 'task-fixture',
      goal: 'test reconnect',
      createdAtUnixMs: 1,
    },
    status: ended ? 'completed' : 'running',
    ended,
    archived: false,
    eventCount: 0,
    surface: { generation: 0, messages: [] },
    inbox: { nextTurn: [], nextStep: [] },
    task: { evidence: [] },
    recovery: {
      kind: ended ? 'terminal' : 'idle',
      status: 'none',
      summary: 'fixture',
      lastCommittedSeq: 0,
    },
  };
}

function transport(initial: AgentSessionEvent[], ended = false): AgentSessionStreamTransport & {
  publish(event: AgentSessionEvent): void;
  replace(events: AgentSessionEvent[]): void;
} {
  let events = [...initial];
  let listener: ((event: AgentSessionEvent) => void) | undefined;
  return {
    snapshot: async () => snapshot(ended),
    committedEvents: async ({ afterSeq, limit }) => {
      const page = events.filter((event) => afterSeq === undefined || event.seq > afterSeq).slice(0, limit);
      return {
        events: page,
        nextCursor: page.length < events.length
          ? (page[page.length - 1]?.seq ?? 0) + 1
          : undefined,
      };
    },
    subscribe: async (callback) => {
      listener = callback;
      return () => { listener = undefined; };
    },
    publish: (event) => listener?.(event),
    replace: (value) => { events = [...value]; },
  };
}

const created = sessionEvent(0, {
  type: 'session/created',
  data: { taskId: 'task-fixture', goal: 'test reconnect' },
});

describe('AgentSessionCommittedClient', () => {
  it('can connect after a missing-session probe and releases the failed subscription', async () => {
    const source = transport([created]);
    let exists = false;
    let subscriptions = 0;
    let releases = 0;
    const client = new AgentSessionCommittedClient('session-fixture', {
      ...source,
      snapshot: async () => { if (!exists) throw new Error('Agent session was not found'); return snapshot(); },
      subscribe: async listener => {
        subscriptions++;
        const release = await source.subscribe(listener);
        return () => { releases++; release(); };
      },
    });
    await expect(client.connect()).rejects.toThrow('Agent session was not found');
    expect(releases).toBe(1);
    exists = true;
    const connected = await client.connect();
    expect(connected.snapshot).toEqual(snapshot());
    expect(connected.events).toEqual([created]);
    expect(subscriptions).toBe(2);
    client.disconnect();
  });

  it('subscribes before backfill and deduplicates an event observed on both paths', async () => {
    const source = transport([created]);
    const client = new AgentSessionCommittedClient('session-fixture', source);
    const connected = await client.connect();
    source.publish(created);
    const state = await client.settled();
    expect(connected.events).toEqual([created]);
    expect(state.events).toEqual([created]);
  });

  it('fills a live sequence gap with afterSeq before publishing the later event', async () => {
    const running = sessionEvent(1, {
      type: 'agent/status',
      data: { status: 'running' },
    });
    const turn = sessionEvent(2, { type: 'turn/start', turnId: 'turn-1' });
    const source = transport([created]);
    const client = new AgentSessionCommittedClient('session-fixture', source);
    await client.connect();
    source.replace([created, running, turn]);
    source.publish(turn);
    expect((await client.settled()).events.map((event) => event.seq)).toEqual([0, 1, 2]);
  });

  it('falls back to snapshot plus full replay when incremental backfill stays gapped', async () => {
    const running = sessionEvent(1, {
      type: 'agent/status',
      data: { status: 'running' },
    });
    const turn = sessionEvent(2, { type: 'turn/start', turnId: 'turn-1' });
    let listener: ((event: AgentSessionEvent) => void) | undefined;
    let snapshots = 0;
    const source: AgentSessionStreamTransport = {
      snapshot: async () => {
        snapshots += 1;
        return snapshot();
      },
      committedEvents: async ({ afterSeq }) => ({
        events: afterSeq === undefined
          ? (snapshots === 1 ? [created] : [created, running, turn])
          : [turn],
      }),
      subscribe: async (callback) => {
        listener = callback;
        return () => { listener = undefined; };
      },
    };
    const client = new AgentSessionCommittedClient('session-fixture', source);
    await client.connect();
    listener?.(turn);
    const state = await client.settled();
    expect(snapshots).toBe(2);
    expect(state.events.map((event) => event.seq)).toEqual([0, 1, 2]);
  });

  it('reconnects from the last committed sequence without replaying terminal semantics', async () => {
    const ended = sessionEvent(1, {
      type: 'session/ended',
      data: { status: 'completed' },
    });
    const source = transport([created]);
    const client = new AgentSessionCommittedClient('session-fixture', source);
    await client.connect();
    source.replace([created, ended]);
    await client.reconnect();
    const state = await client.settled();
    expect(state.events.map((event) => event.seq)).toEqual([0, 1]);
    expect(state.hasTerminalEvent).toBe(true);
  });

  it('does not invent a terminal event from an ended snapshot', async () => {
    const source = transport([created], true);
    const client = new AgentSessionCommittedClient('session-fixture', source);
    const state = await client.connect();
    expect(state.snapshot?.ended).toBe(true);
    expect(state.hasTerminalEvent).toBe(false);
  });

  it('rejects a live pre-v4 envelope without appending it', async () => {
    const source = transport([created]);
    const client = new AgentSessionCommittedClient('session-fixture', source);
    await client.connect();
    source.publish({ ...created, seq: 1, version: 3 } as unknown as AgentSessionEvent);
    await expect(client.settled()).rejects.toThrow(
      'Committed Agent event has an incompatible identity or version',
    );
    expect(client.state().events).toEqual([created]);
  });
});


it('parses a live steer mutation after filling a sequence gap, and reproduces it on cold replay', async () => {
  const source = transport([...agentSessionSteerFixture.slice(0, 5)]);
  const client = new AgentSessionCommittedClient('session-fixture', source);
  await client.connect();
  source.replace([...agentSessionSteerFixture]);
  source.publish(agentSessionSteerFixture[10]);
  expect((await client.settled()).events).toEqual(agentSessionSteerFixture);
  client.disconnect();
  const cold = new AgentSessionCommittedClient('session-fixture', source);
  expect((await cold.connect()).events).toEqual(agentSessionSteerFixture);
  cold.disconnect();
});

it.each([
  { itemId: '', previousRevision: 1, clientOperationId: 'operation' },
  { itemId: 'item', previousRevision: 0, clientOperationId: 'operation' },
  { itemId: 'item', previousRevision: 1, clientOperationId: '' },
])('rejects malformed steer event data without appending it: %j', async (data) => {
  const source = transport([created]);
  const client = new AgentSessionCommittedClient('session-fixture', source);
  await client.connect();
  source.publish(sessionEvent(1, { type: 'agent/inbox/item_steered', data }));
  await expect(client.settled()).rejects.toThrow('invalid mutation identity');
  expect(client.state().events).toEqual([created]);
  client.disconnect();
});
