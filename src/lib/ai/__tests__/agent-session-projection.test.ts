import { describe, expect, it } from 'vitest';

import {
  createAgentActivityProjector,
  projectAgentActivity,
  projectAgentActivityNodes,
} from '@/lib/ai/agent-session-projection';
import {
  agentSessionAllEventFamiliesFixture,
  agentSessionEventFixture,
  sessionEvent,
} from '@/test/fixtures/agent-session';
import { agentSessionBaselineScenarios } from '@/test/fixtures/agent-session-baseline';
import type { AgentSessionEvent } from '@/types/agent-session';

describe('Agent committed Activity projection', () => {
  it('keeps a recovery step nonterminal without generating a failure diagnostic', () => {
    const events = [
      sessionEvent(0, { type: 'turn/start', turnId: 'turn-recovery' }),
      sessionEvent(1, { type: 'step/start', turnId: 'turn-recovery', stepId: 'step-recovery' }),
      sessionEvent(2, { type: 'step/end', turnId: 'turn-recovery', stepId: 'step-recovery', data: { reason: 'outputLimitContinuation' } }),
    ];
    const activity = projectAgentActivity(events);
    expect(activity.turns[0]?.status).toBe('running');
    expect(activity.turns[0]?.steps[0]).toMatchObject({
      status: 'idle', endReason: 'outputLimitContinuation',
    });
    expect(activity.nodes.some((node) => node.status === 'failed')).toBe(false);
    const exhausted = projectAgentActivity([
      ...events,
      sessionEvent(3, { type: 'turn/end', turnId: 'turn-recovery', data: { reason: 'outputLimit' } }),
    ]);
    expect(exhausted.turns[0]?.status).toBe('failed');
  });

  it('preserves the structured final retry failure without adding assistant text', () => {
    const headerIndex = agentSessionEventFixture.findIndex((event) => event.type === 'request/header');
    const header = agentSessionEventFixture[headerIndex];
    if (header?.type !== 'request/header') throw new Error('request fixture missing');
    const failure = sessionEvent(header.seq + 1, {
      type: 'request/failure',
      turnId: header.turnId,
      stepId: header.stepId,
      data: {
        requestId: header.data.requestId,
        attempt: 3,
        maxAttempts: 3,
        cumulativeDelayMs: 750,
        interrupted: false,
        failure: {
          kind: 'rateLimited',
          message: 'provider busy',
          status: 429,
          code: 'HTTP_429',
          retryAfterMs: 500,
        },
      },
    });
    const events = [...agentSessionEventFixture.slice(0, headerIndex + 1), failure];
    const activity = projectAgentActivity(events);
    expect(activity.turns[0]?.steps[0]?.requests[0]).toMatchObject({
      finishReason: 'error',
      failure: failure.data,
    });
    expect(projectAgentActivityNodes(events).find((node) => node.kind === 'request'))
      .toMatchObject({ status: 'failed', detail: 'provider busy' });
    expect(projectAgentActivityNodes(events).some((node) => node.kind === 'assistantMessage'))
      .toBe(false);
  });

  it('projects status, turns, every request attempt, tools, plan, context, agents and evidence', () => {
    const activity = projectAgentActivity(agentSessionEventFixture);

    expect(activity.sessionId).toBe('session-fixture');
    expect(activity.status).toBe('completed');
    expect(activity.turns[0]?.steps[0]?.requests[0]?.requestId).toBe('request-1');
    expect(activity.turns[0]?.steps[0]?.requests.map((request) => request.requestId))
      .toEqual(['request-1']);
    expect(activity.turns[0]?.steps[0]?.tools[0]?.callId).toBe('call-health');
    expect(activity.plan?.steps.length).toBeGreaterThan(0);
    expect(activity.context.artifacts.length).toBeGreaterThan(0);
    expect(activity.agents.some((agent) => agent.role === 'verifier')).toBe(true);
    expect(activity.evidenceCount).toBeGreaterThan(0);
    expect(activity.nodes).toEqual(projectAgentActivityNodes(agentSessionEventFixture));
  });

  it('keeps a finished turn plan visible until the next turn starts', () => {
    const events: AgentSessionEvent[] = [
      sessionEvent(0, { type: 'turn/start', turnId: 'turn-1' }),
      sessionEvent(1, {
        type: 'task/plan',
        turnId: 'turn-1',
        data: {
          version: 1,
          steps: [{ id: 'inspect', title: 'Inspect target', status: 'completed' }],
        },
      }),
      sessionEvent(2, {
        type: 'turn/end',
        turnId: 'turn-1',
        data: { reason: 'completed' },
      }),
    ];

    expect(projectAgentActivity(events).plan?.version).toBe(1);
    events.push(sessionEvent(3, { type: 'turn/start', turnId: 'turn-2' }));
    expect(projectAgentActivity(events).plan).toBeNull();
  });

  it.each(['pending', 'inProgress', 'blocked', 'failed'] as const)('retains a %s plan across continuation, replacement and replay', (status) => {
    const project = createAgentActivityProjector();
    const plan = {
      version: 1,
      steps: [
        { id: 'read', title: 'Inspect target', status: 'completed' as const },
        { id: 'verify', title: 'Verify target', status, detail: 'Check after reconnect', evidenceRefs: ['read-1'] },
      ],
    };
    const events: AgentSessionEvent[] = [
      sessionEvent(0, { type: 'turn/start', turnId: 'turn-1' }),
      sessionEvent(1, {
        type: 'task/plan',
        turnId: 'turn-1',
        data: plan,
      }),
      sessionEvent(2, {
        type: 'turn/end',
        turnId: 'turn-1',
        data: { reason: 'stepBudgetReached: maximum 128 Steps per Turn' },
      }),
    ];

    expect(project(events).plan).toEqual(plan);
    expect(project(events).planActive).toBe(false);
    expect(project(events).turns[0]).toMatchObject({ status: 'idle' });
    events.push(sessionEvent(3, { type: 'turn/start', turnId: 'turn-2' }));
    expect(project(events).plan).toEqual(plan);
    expect(project(events).planActive).toBe(false);
    expect(projectAgentActivity(events).plan).toEqual(plan);

    const replacement = { version: 2, steps: [{ id: 'verify', title: 'Verify target', status: 'completed' as const }] };
    events.push(sessionEvent(4, { type: 'task/plan', turnId: 'turn-2', data: replacement }));
    expect(project(events).plan).toEqual(replacement);
    expect(project(events).planActive).toBe(true);
    events.push(sessionEvent(5, { type: 'turn/end', turnId: 'turn-2', data: { reason: 'completed' } }));
    events.push(sessionEvent(6, { type: 'turn/start', turnId: 'turn-3' }));
    expect(project(events).plan).toBeNull();
    expect(project(events).planActive).toBe(false);
    expect(projectAgentActivity(events).plan).toBeNull();
  });

  it('allows an explicit empty plan to clear retained unfinished work', () => {
    const events = [
      sessionEvent(0, { type: 'turn/start', turnId: 'turn-1' }),
      sessionEvent(1, { type: 'task/plan', turnId: 'turn-1', data: {
        version: 1, steps: [{ id: 'verify', title: 'Verify target', status: 'pending' }],
      } }),
      sessionEvent(2, { type: 'turn/end', turnId: 'turn-1', data: { reason: 'incomplete' } }),
      sessionEvent(3, { type: 'turn/start', turnId: 'turn-2' }),
      sessionEvent(4, { type: 'task/plan', turnId: 'turn-2', data: { version: 2, steps: [] } }),
    ];
    expect(projectAgentActivity(events).plan).toEqual({ version: 2, steps: [] });
  });

  it('activates only plans owned by the open turn, including after replay', () => {
    const project = createAgentActivityProjector();
    const plan = { version: 1, steps: [{ id: 'verify', title: 'Verify result', status: 'inProgress' as const }] };
    const events = [
      sessionEvent(0, { type: 'turn/start', turnId: 'turn-1' }),
      sessionEvent(1, { type: 'task/plan', turnId: 'turn-1', data: plan }),
    ];
    const expectActive = (active: boolean): void => {
      expect(project(events).planActive).toBe(active);
      expect(projectAgentActivity(events).planActive).toBe(active);
    };
    expectActive(true);
    events.push(sessionEvent(2, { type: 'turn/end', turnId: 'turn-1', data: { reason: 'incomplete' } }));
    expectActive(false);
    events.push(sessionEvent(3, { type: 'turn/start', turnId: 'turn-2' }));
    expectActive(false);
    events.push(sessionEvent(4, { type: 'task/plan', turnId: 'turn-1', data: plan }));
    expectActive(false);
    events.push(sessionEvent(5, { type: 'task/plan', data: plan }));
    expectActive(false);
    events.push(sessionEvent(6, { type: 'task/plan', turnId: 'turn-2', data: { ...plan, version: 2 } }));
    expectActive(true);
    events.push(sessionEvent(7, { type: 'session/ended', data: { status: 'failed', reason: 'terminalTargetUnavailable' } }));
    expectActive(false);
    events.push(sessionEvent(8, { type: 'session/resumed' }));
    expectActive(false);
  });

  it.each([
    'noProgress: repeated tool calls',
    'modelStreamTotalTimeout: provider stalled',
    'networkRecoveryTimeout: provider stayed offline',
    'taskTokenBudgetExceeded: budget exhausted',
    'taskActiveTimeExceeded: budget exhausted',
    'preStepRejected: policy denied the step',
    'terminalTargetUnavailable: terminal changed',
    'runtimeRestarted: an in-flight Model Step was not replayed',
  ])('projects %s as failed activity', (reason) => {
    const activity = projectAgentActivity([
      sessionEvent(0, { type: 'turn/start', turnId: 'turn-failed' }),
      sessionEvent(1, { type: 'turn/end', turnId: 'turn-failed', data: { reason } }),
    ]);
    expect(activity.turns[0]).toMatchObject({ status: 'failed', endReason: reason });
    expect(activity.nodes.find((node) => node.kind === 'turn'))
      .toMatchObject({ status: 'failed', detail: reason });
  });

  it('keeps request header, context, usage and lifecycle in stable non-drifting categories', () => {
    const nodes = projectAgentActivityNodes(agentSessionAllEventFamiliesFixture);
    const request = nodes.find((node) => node.key === 'activity:request:request-1');
    const context = nodes.find((node) => node.key === 'activity:request-context:request-1');
    const usage = nodes.find((node) => node.key === 'activity:request-usage:request-1');
    expect(request).toMatchObject({
      kind: 'request',
      status: 'completed',
      eventTypes: expect.arrayContaining([
        'request/header',
        'request/context',
        'assistant/message',
        'request/usage',
      ]),
      data: expect.objectContaining({
        requestId: 'request-1',
        providerId: 'openai',
        model: 'gpt-test',
      }),
    });
    expect(request?.records.map((record) => record.type)).toEqual(expect.arrayContaining([
      'request/header',
      'request/context',
      'assistant/message',
      'request/usage',
    ]));
    expect(context).toMatchObject({ kind: 'requestContext' });
    expect(usage).toMatchObject({ kind: 'requestUsage' });
    expect(new Set([request?.key, context?.key, usage?.key]).size).toBe(3);

    const session = nodes.find((node) => node.key === 'activity:session:session-fixture');
    const agent = nodes.find((node) => node.key === 'activity:agent:session-fixture');
    const turn = nodes.find((node) => node.key === 'activity:turn:turn-1');
    const step = nodes.find((node) => node.key === 'activity:step:step-1');
    expect(session).toMatchObject({
      kind: 'session',
      status: 'completed',
      eventTypes: ['session/created', 'session/renamed', 'session/ended'],
    });
    expect(agent).toMatchObject({
      kind: 'agent',
      status: 'completed',
      eventTypes: ['agent/created', 'agent/status', 'agent/status'],
    });
    expect(turn).toMatchObject({ kind: 'turn', status: 'completed' });
    expect(step).toMatchObject({ kind: 'step', status: 'completed' });
  });

  it('retains retry, error, cancellation and unknown diagnostics in Activity', () => {
    const retry = projectAgentActivityNodes(agentSessionBaselineScenarios['retry-success'].events);
    expect(retry.find((node) => node.kind === 'retry')).toMatchObject({
      key: 'activity:retry:request-02:2',
      detail: 'fixture transport reset',
    });
    const retryActivity = projectAgentActivity(agentSessionBaselineScenarios['retry-success'].events);
    expect(retryActivity.turns[0]?.steps[0]?.requests).toEqual([
      expect.objectContaining({ requestId: 'request-01' }),
      expect.objectContaining({
        requestId: 'request-02',
        retryReason: 'fixture transport reset',
      }),
    ]);

    const failed = projectAgentActivityNodes(agentSessionBaselineScenarios['provider-error'].events);
    expect(failed.some((node) => node.kind === 'error' && node.detail === 'provider error'))
      .toBe(true);
    expect(failed.some((node) => (
      node.kind === 'error' && node.detail === 'Fixture provider unavailable.'
    ))).toBe(true);

    const cancelled = projectAgentActivityNodes(agentSessionBaselineScenarios.cancelled.events);
    expect(cancelled.some((node) => node.kind === 'cancellation')).toBe(true);

    const unknownEvent = {
      ...agentSessionEventFixture[0],
      type: 'future/safe-extension',
      data: { status: 'completed' },
    } as unknown as AgentSessionEvent;
    expect(projectAgentActivityNodes([unknownEvent])).toEqual([
      expect.objectContaining({
        key: 'activity:unknown:future/safe-extension:0',
        kind: 'unknown',
        eventTypes: ['future/safe-extension'],
      }),
    ]);
  });

  it('covers every committed event while updating stable entity keys', () => {
    const nodes = projectAgentActivityNodes(agentSessionAllEventFamiliesFixture);
    const coveredSeqs = new Set(nodes.flatMap((node) => node.eventSeqs));
    expect([...coveredSeqs].sort((left, right) => left - right))
      .toEqual(agentSessionAllEventFamiliesFixture.map((event) => event.seq));
    expect(nodes.map((node) => node.key)).toEqual([
      ...new Set(nodes.map((node) => node.key)),
    ]);
    expect(nodes.find((node) => node.kind === 'tool')).toMatchObject({
      key: 'activity:tool:turn-1:step-1:call-health',
      status: 'completed',
      eventTypes: ['tool/call', 'tool/approval', 'tool/approval', 'tool/execution', 'tool/result'],
    });
    expect(nodes.find((node) => node.kind === 'tool')?.records).toHaveLength(5);
  });

  it('is replay-idempotent and preserves keys when older history is prepended', () => {
    const first = projectAgentActivityNodes(agentSessionAllEventFamiliesFixture);
    const second = projectAgentActivityNodes(structuredClone(agentSessionAllEventFamiliesFixture));
    expect(first).toEqual(second);
    expect(first.map((node) => node.key)).toEqual(second.map((node) => node.key));

    const pages = agentSessionBaselineScenarios.pagination.pages;
    expect(pages).toBeDefined();
    if (!pages) return;
    const currentKeys = projectAgentActivityNodes(pages.current).map((node) => node.key);
    const fullKeys = new Set(projectAgentActivityNodes([...pages.older, ...pages.current])
      .map((node) => node.key));
    expect(currentKeys.every((key) => fullKeys.has(key))).toBe(true);
  });

  it('accepts a contiguous page after seq zero and rejects invalid windows', () => {
    const page = agentSessionEventFixture.slice(4, 12);
    expect(() => projectAgentActivity(page)).not.toThrow();

    const gap = [agentSessionEventFixture[0], agentSessionEventFixture[2]];
    expect(() => projectAgentActivity(gap)).toThrow('ordered and contiguous');

    const mixed = agentSessionEventFixture.slice(0, 2).map((event, index) => (
      index === 1 ? { ...event, sessionId: 'other-session' } : event
    ));
    expect(() => projectAgentActivity(mixed)).toThrow('cannot mix session ids');

    const invalidTime = [{ ...agentSessionEventFixture[0], timeUnixMs: 1.5 }];
    expect(() => projectAgentActivity(invalidTime)).toThrow('invalid timestamp');

    const unsupported = [{ ...agentSessionEventFixture[0], version: 99 }];
    expect(() => projectAgentActivity(unsupported as never)).toThrow('Unsupported');
  });
});
