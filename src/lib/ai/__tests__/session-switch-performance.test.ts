import { expect, it } from 'vitest';
import { CommittedEventBuffer } from '../committed-event-buffer';
import { agentSessionView, createAgentSessionViewProjector } from '../agent-session-adapter';
import { taskTokenBudgetEvidence } from '@/test/fixtures/task-token-budget';

it('reuses nonempty publications and preserves them when committed events append', () => {
  const buffer = new CommittedEventBuffer();
  const { events } = taskTokenBudgetEvidence;
  expect(events.length).toBeGreaterThan(1);
  const split = Math.floor(events.length / 2);
  for (const event of events.slice(0, split)) buffer.append(event);
  const first = buffer.snapshot();
  expect(first).toEqual(events.slice(0, split));
  expect(buffer.snapshot()).toBe(first);
  for (const event of events.slice(split)) buffer.append(event);
  const appended = buffer.snapshot();
  expect(appended).not.toBe(first);
  expect(appended).toEqual(events);
  expect(first).toEqual(events.slice(0, split));
  expect(buffer.snapshot()).toBe(appended);
  expect(buffer.length).toBe(events.length);
  expect(buffer.last).toBe(events[events.length - 1]);
  expect(buffer.get(0)).toBe(events[0]);
});

it('invalidates a full replay even at the same length without mutating old publications', () => {
  const buffer = new CommittedEventBuffer();
  const { events } = taskTokenBudgetEvidence;
  for (const event of events) buffer.append(event);
  const first = buffer.snapshot();
  buffer.clear();
  expect(buffer.length).toBe(0);
  expect(buffer.last).toBeUndefined();
  expect(buffer.get(0)).toBeUndefined();
  expect(buffer.snapshot()).toEqual([]);
  expect(first).toEqual(events);

  // Reuse the exact objects: clearing, rather than event identity or length,
  // must invalidate the cache for a new full replay.
  for (const event of events) buffer.append(event);
  const replayed = buffer.snapshot();
  expect(replayed).not.toBe(first);
  expect(replayed).toEqual(events);
  expect(buffer.snapshot()).toBe(replayed);
  expect(first).toEqual(events);
});

it('shares buffer publications with the view cache across append and full recovery', () => {
  const buffer = new CommittedEventBuffer();
  const project = createAgentSessionViewProjector();
  const { failed, events, continued, continuedEvents } = taskTokenBudgetEvidence;
  expect(continuedEvents.slice(0, events.length)).toEqual(events);
  for (const event of events) buffer.append(event);
  const read = (snapshot = failed, hasTerminalEvent = true) => ({
    snapshot, events: buffer.snapshot(), lastCommittedSeq: buffer.last?.seq, hasTerminalEvent,
  });
  const firstState = read();
  const firstView = project(firstState);
  expect(project(read())).toBe(firstView);
  expect(firstView).toEqual(agentSessionView(firstState));

  for (const event of continuedEvents.slice(events.length)) buffer.append(event);
  const resumed = read(continued, false);
  const resumedView = project(resumed);
  expect(resumedView).not.toBe(firstView);
  expect(resumedView).toEqual(agentSessionView(resumed));
  expect(project(read(continued, false))).toBe(resumedView);
  expect(firstState.events).toEqual(events);
  expect(firstView).toEqual(agentSessionView(firstState));

  buffer.clear();
  for (const event of structuredClone(continuedEvents)) buffer.append(event);
  const recovered = read(continued, false);
  const recoveredView = project(recovered);
  expect(recovered.events).not.toBe(resumed.events);
  expect(recoveredView).not.toBe(resumedView);
  expect(recoveredView).toEqual(agentSessionView(recovered));
  expect(project(read(continued, false))).toBe(recoveredView);
  expect(resumed.events).toEqual(continuedEvents);
  expect(firstState.events).toEqual(events);
});

it('reuses repeated publications and refreshes changed snapshots and event windows', () => {
  const project = createAgentSessionViewProjector();
  const { failed, events, continued, continuedEvents } = taskTokenBudgetEvidence;
  const state = { snapshot: failed, events,
    lastCommittedSeq: events[events.length - 1]?.seq, hasTerminalEvent: true };
  const initial = project(state);
  expect(initial).toEqual(agentSessionView(state));
  expect(project({ ...state })).toBe(initial);

  const refreshed = { ...state, snapshot: continued };
  const refreshedView = project(refreshed);
  expect(refreshedView).not.toBe(initial);
  expect(refreshedView).toEqual(agentSessionView(refreshed));

  const resumed = { snapshot: continued, events: continuedEvents,
    lastCommittedSeq: continuedEvents[continuedEvents.length - 1]?.seq, hasTerminalEvent: false };
  expect(project(resumed)).toEqual(agentSessionView(resumed));
  expect(project({ ...resumed })).toBe(project(resumed));
  expect(project(state)).toEqual(initial);
});
