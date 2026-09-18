import { describe, expect, it, vi } from 'vitest';
import { projectAgentChatNodes } from '@/lib/ai/conversation-projection';
import { projectAgentActivity } from '@/lib/ai/agent-session-projection';
import { AgentSessionCommittedClient } from '@/lib/ai/agent-session-client';
import {
  agentSessionView,
  createAgentSessionAdapter,
  projectAgentInbox,
  type AgentSessionAdapterDependencies,
} from '@/lib/ai/agent-session-adapter';
import {
  agentSessionEventFixture,
  agentSessionSteerFixture,
  queuedSteerMessageFixture,
  agentSessionWaitingApprovalEventFixture,
  sessionEvent,
} from '@/test/fixtures/agent-session';
import type {
  AgentSessionEvent,
  AgentSessionSnapshot,
} from '@/types/agent-session';
import { AGENT_SESSION_EVENT_VERSION } from '@/types/agent-session';
import { terminalLoginScopeKey } from '@/lib/ai/terminal-login-scope';

const provider = {
  id: 'provider-test',
  profile: 'openai' as const,
  kind: 'openAi' as const,
  baseUrl: 'https://example.invalid',
  model: 'model-test',
  requiresApiKey: true,
};

function snapshot(ended = false): AgentSessionSnapshot {
  return {
    header: {
      sessionId: 'session-fixture',
      taskId: 'task-fixture',
      goal: 'Check nginx and report evidence.',
      executionSurface: 'direct',
      createdAtUnixMs: 1_000,
    },
    status: ended ? 'completed' : 'running',
    ended,
    archived: false,
    eventCount: agentSessionEventFixture.length,
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

it('projects model, permission, and execution surface changes over an older snapshot', () => {
  const selected = {
    routeId: 'other', modelId: 'gpt-5.6',
    reasoningEffort: 'high',
  };
  const base = agentSessionEventFixture[0]!;
  const events: AgentSessionEvent[] = [base, {
    ...base, seq: 1, type: 'session/model_selected', data: { provider: selected },
  }, {
    ...base, seq: 2, type: 'session/permission_changed', data: { mode: 'operator' },
  }, {
    ...base, seq: 3, type: 'session/execution_surface_changed', data: { surface: 'boundTerminal' },
  }];
  const view = agentSessionView({ snapshot: snapshot(), events, lastCommittedSeq: 3, hasTerminalEvent: false });
  expect(view.snapshot.value.header).toMatchObject({ modelSelection: selected, permissionMode: 'operator', executionSurface: 'boundTerminal' });
  expect(view.activityNodes.some(node => node.kind === 'unknown')).toBe(false);
});

it('clears a stale snapshot plan when a newer turn starts', () => {
  const persisted = snapshot();
  const view = agentSessionView({
    snapshot: {
      ...persisted,
      task: {
        ...persisted.task,
        plan: {
          version: 1,
          steps: [{ id: 'old', title: 'Old turn work', status: 'inProgress' }],
        },
      },
    },
    events: [
      agentSessionEventFixture[0]!,
      sessionEvent(1, { type: 'turn/start', turnId: 'turn-2' }),
    ],
    lastCommittedSeq: 1,
    hasTerminalEvent: false,
  });

  expect(view.snapshot.value.task.plan).toBeUndefined();
});

it('keeps an unfinished current-turn plan available after the turn settles', () => {
  const persisted = snapshot();
  const view = agentSessionView({
    snapshot: persisted,
    events: [
      agentSessionEventFixture[0]!,
      sessionEvent(1, { type: 'turn/start', turnId: 'turn-1' }),
      sessionEvent(2, {
        type: 'task/plan',
        turnId: 'turn-1',
        data: {
          version: 1,
          steps: [{ id: 'old', title: 'Old turn work', status: 'inProgress' }],
        },
      }),
      sessionEvent(3, {
        type: 'turn/end',
        turnId: 'turn-1',
        data: { reason: 'incomplete' },
      }),
    ],
    lastCommittedSeq: 3,
    hasTerminalEvent: false,
  });

  expect(view.snapshot.value.task.plan?.steps).toEqual([
    { id: 'old', title: 'Old turn work', status: 'inProgress' },
  ]);
});

it.each(['direct', 'boundTerminal'] as const)(
  'loads the frozen %s value from a pre-surface-semantics persisted snapshot',
  (executionSurface) => {
    const persisted = snapshot();
    const view = agentSessionView({
      snapshot: {
        ...persisted,
        header: { ...persisted.header, executionSurface },
      },
      events: [],
      lastCommittedSeq: 0,
      hasTerminalEvent: false,
    });

    expect(view.snapshot.value.header.executionSurface).toBe(executionSurface);
  },
);

function agentDependencies(
  events: readonly AgentSessionEvent[],
  order: string[] = [],
): AgentSessionAdapterDependencies {
  return {
    createSession: vi.fn(async () => snapshot()),
    start: vi.fn(async () => snapshot()),
    followup: vi.fn(async () => snapshot()),
    steer: vi.fn(async () => snapshot()),
    stop: vi.fn(async () => snapshot()),
    sendChildInput: vi.fn(async () => snapshot()),
    cancelChild: vi.fn(async () => snapshot()),
    resume: vi.fn(async () => snapshot()),
    approve: vi.fn(async () => snapshot()),
    reject: vi.fn(async () => snapshot()),
    answerQuestion: vi.fn(async () => snapshot()),
    archive: vi.fn(async () => snapshot()),
    delete: vi.fn(async () => undefined),
    list: vi.fn(async () => ({ sessions: [], recoveryNotices: [] })),
    mutateInbox: vi.fn(async () => snapshot()),
    rename: vi.fn(async () => snapshot()),
    loadArtifact: vi.fn(async (request) => ({
      metadata: {
        artifactId: request.artifactId,
        kind: 'text',
        title: 'Report',
        mediaType: 'text/plain',
        sha256: 'abc',
        sizeBytes: 6,
        sensitivity: 'internal' as const,
        createdAtUnixMs: 1,
      },
      bodyBase64: 'cmVwb3J0',
      truncated: false,
    })),
    client: (sessionId) => new AgentSessionCommittedClient(sessionId, {
      subscribe: async () => {
        order.push('subscribe');
        return () => undefined;
      },
      snapshot: async () => {
        order.push('snapshot');
        return snapshot();
      },
      committedEvents: async ({ afterSeq }) => {
        order.push('committed');
        return {
          events: events.filter((event) => afterSeq === undefined || event.seq > afterSeq),
        };
      },
    }),
  };
}

describe('AgentSessionAdapter', () => {
  it('loads volatile approval arguments through the exact approval identity', async () => {
    const dependencies = agentDependencies(agentSessionWaitingApprovalEventFixture);
    const approvalArguments = vi.fn(async () => ({
      inputKind: 'paste',
      text: 'printf review-before-run',
    }));
    const adapter = createAgentSessionAdapter({ ...dependencies, approvalArguments });
    const input = {
      sessionId: 'session-fixture',
      turnId: 'turn-01',
      stepId: 'step-01',
      requestId: 'request-1',
      callId: 'call-health',
      approvalId: 'approval-health',
    };

    await expect(adapter.loadApprovalArguments?.(input)).resolves.toEqual({
      inputKind: 'paste',
      text: 'printf review-before-run',
    });
    expect(approvalArguments).toHaveBeenCalledWith(input);
  });

  it('lists reconnect history by login while retaining exact target filtering for auto-restore', async () => {
    const login = { kind: 'remote' as const, host: '175.178.66.45', port: 22, username: 'root' };
    const items = [
      { id: 'old', terminal: 'old', username: 'root' },
      { id: 'new', terminal: 'new', username: 'root' },
      { id: 'other-user', terminal: 'other', username: 'deploy' },
    ].map(({ id, terminal, username }) => ({
      header: { ...snapshot().header, sessionId: id, target: {
        ...login, username, targetId: `terminal-${terminal}`, sessionId: terminal,
      } },
      status: 'idle' as const, ended: false, archived: false, eventCount: 1,
      pendingTurns: 0, pendingStepMessages: 0,
    }));
    const dependencies = agentDependencies(agentSessionEventFixture);
    const adapter = createAgentSessionAdapter({
      ...dependencies,
      list: vi.fn(async () => ({ sessions: items, recoveryNotices: [] })),
    });
    const scopeKey = terminalLoginScopeKey({ ...login, targetId: 'terminal-current', sessionId: 'current' })!;

    expect((await adapter.list({ scopeKey, limit: 100 })).sessions.map((item) => item.id)).toEqual(['old', 'new']);
    expect((await adapter.list({ targetId: 'terminal-new', limit: 100 })).sessions.map((item) => item.id)).toEqual(['new']);
  });

  it('retains subagent lineage in list summaries and projects live child state', async () => {
    const metadata = {
      descriptorId: 'descriptor-child',
      parentTaskId: 'task-fixture',
      role: 'explorer' as const,
      continuable: false,
      depth: 1,
      inheritance: { mode: 'blank' as const },
      capabilityScope: { toolNames: ['read_file'], effects: ['readOnly' as const], targetIds: ['terminal-a'] },
      targetScope: [],
      budget: {
        maxStepsPerTurn: 8,
        maxTurns: 1,
        maxToolCalls: 16,
        maxTokens: 8_192,
        timeoutMs: 60_000,
      },
      provider: { routeId: 'provider-test', modelId: 'model-test' },
    };
    const child = {
      header: {
        ...snapshot().header,
        sessionId: 'session-child',
        taskId: 'task-child',
        goal: 'Inspect the existing page',
        parentSessionId: 'session-fixture',
        subagent: metadata,
      },
      status: 'running' as const,
      ended: false,
      archived: false,
      eventCount: 2,
      pendingTurns: 0,
      pendingStepMessages: 0,
    };
    const events: AgentSessionEvent[] = [
      agentSessionEventFixture[0]!,
      sessionEvent(1, {
        type: 'subagent/descriptor',
        data: {
          descriptorId: metadata.descriptorId,
          childSessionId: child.header.sessionId,
          parentSessionId: 'session-fixture',
          parentTaskId: metadata.parentTaskId,
          role: metadata.role,
          continuable: metadata.continuable,
          depth: metadata.depth,
          inheritance: metadata.inheritance,
          capabilityScope: metadata.capabilityScope,
          targetScope: metadata.targetScope,
          budget: metadata.budget,
        },
      }),
    ];
    const dependencies = agentDependencies(events);
    const adapter = createAgentSessionAdapter({
      ...dependencies,
      list: vi.fn(async () => ({ sessions: [child], recoveryNotices: [] })),
    });

    expect((await adapter.list({ limit: 100 })).sessions[0]).toMatchObject({
      id: 'session-child',
      parentSessionId: 'session-fixture',
      subagent: {
        descriptorId: metadata.descriptorId,
        role: metadata.role,
        continuable: metadata.continuable,
        depth: metadata.depth,
      },
    });
    expect((await adapter.open('session-fixture')).subagents).toEqual([
      expect.objectContaining({
        sessionId: 'session-child',
        parentSessionId: 'session-fixture',
        descriptorId: 'descriptor-child',
        role: 'explorer',
        status: 'running',
      }),
    ]);
    adapter.dispose();
  });

  it('submits and cancels a continuable child through its parent-owned commands', async () => {
    const childSnapshot: AgentSessionSnapshot = {
      ...snapshot(),
      header: {
        ...snapshot().header,
        parentSessionId: 'parent-session',
        subagent: {
          descriptorId: 'descriptor-child',
          parentTaskId: 'parent-task',
          role: 'explorer',
          continuable: true,
          depth: 1,
          inheritance: { mode: 'blank' },
          capabilityScope: { toolNames: ['read_file'], effects: ['readOnly'], targetIds: [] },
          targetScope: [],
          budget: {
            maxStepsPerTurn: 8,
            maxTurns: 4,
            maxToolCalls: 16,
            maxTokens: 8_192,
            timeoutMs: 60_000,
          },
          provider: { routeId: 'provider-test', modelId: 'model-test' },
        },
      },
      status: 'idle',
    };
    let events: AgentSessionEvent[] = [sessionEvent(0, {
      type: 'session/created',
      data: {
        taskId: childSnapshot.header.taskId,
        goal: childSnapshot.header.goal,
        parentSessionId: 'parent-session',
        executionSurface: 'direct',
        subagent: childSnapshot.header.subagent,
      },
    })];
    const state = () => ({
      snapshot: childSnapshot,
      events,
      lastCommittedSeq: events[events.length - 1]?.seq,
      hasTerminalEvent: false,
    });
    const sendChildInput = vi.fn(async (request) => {
      events = [...events, sessionEvent(1, {
        type: 'agent/inbox/spliced',
        data: {
          operation: 'enqueued',
          lane: 'nextTurn',
          messages: [{
            messageId: request.clientSubmissionId!,
            clientSubmissionId: request.clientSubmissionId,
            content: request.content,
            source: { kind: 'user', label: 'User', producerId: 'shellspan-user' },
          }],
        },
      })];
      return childSnapshot;
    });
    const base = agentDependencies(events);
    const dependencies: AgentSessionAdapterDependencies = {
      ...base,
      sendChildInput,
      client: () => ({
        state,
        onChange: () => () => undefined,
        connect: async () => state(),
        reconnect: async () => state(),
        disconnect: vi.fn(),
      }),
    };
    const adapter = createAgentSessionAdapter(dependencies);

    await expect(adapter.submit(childSnapshot.header.sessionId, {
      content: 'Continue the inspection.',
      mode: 'nextTurn',
      clientOperationId: 'child-followup',
      provider,
    })).resolves.toEqual({
      sessionId: childSnapshot.header.sessionId,
      clientOperationId: 'child-followup',
      mode: 'nextTurn',
    });
    expect(sendChildInput).toHaveBeenCalledWith({
      parentSessionId: 'parent-session',
      childSessionId: childSnapshot.header.sessionId,
      content: 'Continue the inspection.',
      clientSubmissionId: 'child-followup',
    });
    expect((await adapter.open(childSnapshot.header.sessionId)).nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'userMessage', clientSubmissionId: 'child-followup' }),
    ]));

    await adapter.stop(childSnapshot.header.sessionId);
    expect(dependencies.cancelChild).toHaveBeenCalledWith({
      parentSessionId: 'parent-session',
      childSessionId: childSnapshot.header.sessionId,
    });
    expect(dependencies.stop).not.toHaveBeenCalled();
    adapter.dispose();
  });

  it('refreshes the existing Session after changing its execution surface', async () => {
    const base = agentSessionEventFixture[0]!;
    const events: AgentSessionEvent[] = [base];
    const dependencies = agentDependencies(events);
    const setExecutionSurface = vi.fn(async () => {
      events.push({
        ...base,
        seq: 1,
        type: 'session/execution_surface_changed',
        data: { surface: 'boundTerminal' },
      });
      return snapshot();
    });
    const adapter = createAgentSessionAdapter({ ...dependencies, setExecutionSurface });
    await adapter.open('session-fixture');

    await adapter.setExecutionSurface?.('session-fixture', 'boundTerminal');

    expect(setExecutionSurface).toHaveBeenCalledWith({ sessionId: 'session-fixture', surface: 'boundTerminal' });
    expect((await adapter.open('session-fixture')).snapshot.value.header.executionSurface).toBe('boundTerminal');
  });

  it('resumes a completed conversation before switching its execution surface', async () => {
    const base = agentSessionEventFixture[0]!;
    const events: AgentSessionEvent[] = [base, {
      ...base, seq: 1, type: 'session/ended', data: { status: 'completed' },
    }];
    const order: string[] = [];
    const dependencies = agentDependencies(events);
    const resume = vi.fn(async () => {
      order.push('resume');
      events.push({ ...base, seq: 2, type: 'session/resumed', data: {} });
      return snapshot();
    });
    const setExecutionSurface = vi.fn(async () => {
      order.push('switch');
      events.push({
        ...base, seq: 3, type: 'session/execution_surface_changed',
        data: { surface: 'boundTerminal' },
      });
      return snapshot();
    });
    const adapter = createAgentSessionAdapter({ ...dependencies, resume, setExecutionSurface });

    await adapter.setExecutionSurface?.('session-fixture', 'boundTerminal');

    expect(order).toEqual(['resume', 'switch']);
    expect((await adapter.open('session-fixture')).snapshot.value.header.executionSurface).toBe('boundTerminal');
  });

  it('passes the selected execution surface through Session creation', async () => {
    const dependencies = agentDependencies(agentSessionEventFixture);
    const adapter = createAgentSessionAdapter(dependencies);
    const request = {
      sessionId: 'session-fixture',
      taskId: 'task-fixture',
      goal: 'Show command execution',
      executionSurface: 'boundTerminal' as const,
    };

    await adapter.create({ kind: 'agent', request });

    expect(dependencies.createSession).toHaveBeenCalledWith(request);
  });

  it.each(['cancelled', 'failed', 'completed'] as const)('resumes an ended %s session before starting and submitting', async status => {
    const base = agentSessionEventFixture[0]!;
    const events: AgentSessionEvent[] = [base, { ...base, seq: 1, type: 'session/ended', data: { status } }];
    const dependencies = agentDependencies(events);
    const order: string[] = [];
    const resume = vi.fn(async () => {
      order.push('resume');
      events.push({ ...base, seq: 2, type: 'session/resumed', data: {} });
      return snapshot();
    });
    const start = vi.fn(async () => { order.push('start'); return snapshot(); });
    const followup = vi.fn(async () => { order.push('followup'); return snapshot(); });
    const adapter = createAgentSessionAdapter({ ...dependencies, resume, start, followup });
    await adapter.submit('session-fixture', { content: 'continue', mode: 'nextTurn', clientOperationId: 'continue-1', provider });
    expect(order).toEqual(['resume', 'start', 'followup']);
    expect((await adapter.open('session-fixture')).snapshot.value.ended).toBe(false);
    expect((await adapter.open('session-fixture')).status).toBe('idle');
    adapter.dispose();
  });

  it('repairs a lost stop event before acknowledging the stop', async () => {
    const base = agentSessionEventFixture[0]!;
    const events: AgentSessionEvent[] = [base, { ...base, seq: 1, type: 'agent/status', data: { status: 'running' } }];
    const dependencies = agentDependencies(events);
    const stop = vi.fn(async () => {
      events.push({ ...base, seq: 2, type: 'agent/status', data: { status: 'idle', reason: 'stoppedByUser' } });
      return snapshot();
    });
    const adapter = createAgentSessionAdapter({ ...dependencies, stop });
    await adapter.open('session-fixture');
    await adapter.stop('session-fixture');
    expect((await adapter.open('session-fixture')).status).toBe('idle');
    adapter.dispose();
  });
  it('prefers provider-reported prompt usage while retaining Runtime-estimated categories', () => {
    const events: readonly AgentSessionEvent[] = [
      ...agentSessionEventFixture.slice(0, 10),
      {
        version: AGENT_SESSION_EVENT_VERSION,
        sessionId: 'session-fixture',
        seq: 10,
        timeUnixMs: 2_000,
        type: 'request/usage',
        turnId: 'turn-1',
        stepId: 'step-1',
        data: {
          requestId: 'request-1',
          usage: {
            uncachedInputTokens: 30_000,
            cacheReadTokens: 1_500,
            outputTokens: 12,
            totalTokens: 31_512,
          },
          finishReason: 'stop',
        },
      },
    ];
    const view = agentSessionView({
      snapshot: snapshot(), events, lastCommittedSeq: 10, hasTerminalEvent: false,
    });
    expect(view.contextUsage).toEqual({
      usedTokens: 31_500,
      contextWindow: 64_000,
      source: 'reported',
      breakdown: { systemTokens: 1_200, toolsTokens: 6_800, messageTokens: 24_000 },
    });
  });

  it('projects committed Inbox mutations in Runtime order', () => {
    const events: AgentSessionEvent[] = [
      {
        version: AGENT_SESSION_EVENT_VERSION, sessionId: 'session-fixture', seq: 0,
        timeUnixMs: 1, type: 'agent/inbox/spliced',
        data: {
          operation: 'enqueued', lane: 'nextTurn', messages: [
            {
              messageId: 'a', clientSubmissionId: 'submission-a', content: 'A',
              source: { kind: 'user', label: 'User', producerId: 'shellspan-user' },
            },
            {
              messageId: 'b', clientSubmissionId: 'submission-b', content: 'B',
              source: { kind: 'user', label: 'User', producerId: 'shellspan-user' },
            },
          ],
        },
      },
      {
        version: AGENT_SESSION_EVENT_VERSION, sessionId: 'session-fixture', seq: 1,
        timeUnixMs: 2, type: 'agent/inbox/reordered',
        data: {
          lane: 'nextTurn', orderedItemIds: ['b', 'a'], previousRevision: 1,
          clientOperationId: 'reorder-1',
        },
      },
      {
        version: AGENT_SESSION_EVENT_VERSION, sessionId: 'session-fixture', seq: 2,
        timeUnixMs: 3, type: 'agent/inbox/item_updated',
        data: {
          itemId: 'b', lane: 'nextTurn', content: 'B updated', previousRevision: 2,
          clientOperationId: 'update-1',
        },
      },
      {
        version: AGENT_SESSION_EVENT_VERSION, sessionId: 'session-fixture', seq: 3,
        timeUnixMs: 4, type: 'agent/inbox/item_removed',
        data: {
          itemId: 'a', lane: 'nextTurn', previousRevision: 3,
          clientOperationId: 'remove-1',
        },
      },
    ];
    expect(projectAgentInbox(events)).toEqual([{
      id: 'b', clientSubmissionId: 'submission-b', lane: 'nextTurn',
      content: 'B updated', state: 'queued', source: 'user', startsTurn: true,
      provenance: { kind: 'user', label: 'User', producerId: 'shellspan-user' },
    }]);
  });

  it('does not resolve mutation commands until their committed operation event is projected', async () => {
    let events = [...agentSessionEventFixture];
    let publish: ((state: ReturnType<AgentSessionCommittedClient['state']>) => void) | undefined;
    const state = () => ({
      snapshot: snapshot(),
      events,
      lastCommittedSeq: events[events.length - 1]?.seq,
      hasTerminalEvent: false,
    });
    const dependencies: AgentSessionAdapterDependencies = {
      ...agentDependencies(events),
      client: () => ({
        state,
        onChange: (listener) => {
          publish = listener;
          return () => undefined;
        },
        connect: vi.fn(async () => state()),
        reconnect: vi.fn(async () => state()),
        disconnect: vi.fn(),
      }),
    };
    const adapter = createAgentSessionAdapter(dependencies);
    let resolved = false;
    const operation = adapter.mutateInbox({
      type: 'remove', sessionId: 'session-fixture', itemId: 'queued-1',
      expectedRevision: events.length, clientOperationId: 'mutation-1',
    }).then(() => { resolved = true; });
    await Promise.resolve();
    expect(resolved).toBe(false);

    const seq = events.length;
    events = [...events, {
      version: AGENT_SESSION_EVENT_VERSION,
      sessionId: 'session-fixture',
      seq,
      timeUnixMs: 9_999,
      type: 'agent/inbox/item_removed',
      data: {
        itemId: 'queued-1', lane: 'nextTurn', previousRevision: seq,
        clientOperationId: 'mutation-1',
      },
    }];
    publish?.(state());
    await operation;
    expect(resolved).toBe(true);
    adapter.dispose();
  });

  it('repairs a lost live question answer via reconnect before acknowledging the form', async () => {
    const identity = { sessionId: 'session-fixture', turnId: 'turn', stepId: 'step', requestId: 'request', callId: 'call', questionRequestId: 'question' };
    const input = { identity, clientOperationId: 'question-operation', answers: [{ id: 'choice', selected: [], custom: 'Answer' }] };
    const answered: AgentSessionEvent = { version: AGENT_SESSION_EVENT_VERSION, sessionId: 'session-fixture', seq: agentSessionEventFixture.length, timeUnixMs: 99_999, turnId: 'turn', stepId: 'step', type: 'question/answered', data: { submission: input, fingerprint: '0'.repeat(64) } };
    const stale = { snapshot: snapshot(), events: [...agentSessionEventFixture], hasTerminalEvent: false };
    const fresh = { ...stale, events: [...agentSessionEventFixture, answered] };
    const reconnect = vi.fn(async () => fresh);
    const dependencies = { ...agentDependencies(agentSessionEventFixture), client: () => ({ state: () => stale, onChange: vi.fn(() => () => undefined), connect: vi.fn(async () => stale), reconnect, disconnect: vi.fn() }) };
    const adapter = createAgentSessionAdapter(dependencies);
    await adapter.open('session-fixture');
    await adapter.answerQuestion(input);
    expect(dependencies.answerQuestion).toHaveBeenCalledWith(input);
    expect(reconnect).toHaveBeenCalledOnce();
    reconnect.mockResolvedValueOnce(stale);
    await expect(adapter.answerQuestion(input)).rejects.toThrow('not visible');
    adapter.dispose();
  });
  it('releases the current event subscription when UI switches sessions without stopping Runtime', async () => {
    const base = agentDependencies(agentSessionEventFixture);
    const disconnect = vi.fn();
    const state = {
      snapshot: snapshot(),
      events: agentSessionEventFixture,
      lastCommittedSeq: agentSessionEventFixture[agentSessionEventFixture.length - 1]?.seq,
      hasTerminalEvent: false,
    };
    const dependencies: AgentSessionAdapterDependencies = {
      ...base,
      client: vi.fn(() => ({
        state: () => state,
        onChange: () => () => undefined,
        connect: vi.fn(async () => state),
        reconnect: vi.fn(async () => state),
        disconnect,
      })),
    };
    const adapter = createAgentSessionAdapter(dependencies);
    const unsubscribe = adapter.subscribe('session-fixture', vi.fn());
    await adapter.open('session-fixture');
    unsubscribe();
    expect(disconnect).toHaveBeenCalledOnce();
    expect(dependencies.stop).not.toHaveBeenCalled();
    adapter.dispose();
  });

  it('opens through the subscribe-first committed client and shares one event window', async () => {
    const order: string[] = [];
    const adapter = createAgentSessionAdapter(
      agentDependencies(agentSessionWaitingApprovalEventFixture, order),
    );
    const view = await adapter.open('session-fixture');

    expect(order.slice(0, 3)).toEqual(['subscribe', 'snapshot', 'committed']);
    expect(view.throughSeq).toBe(
      agentSessionWaitingApprovalEventFixture[agentSessionWaitingApprovalEventFixture.length - 1]?.seq,
    );
    expect(view.nodes.some((node) => (
      node.kind === 'turnProcess'
      && node.children.some((child) => child.kind === 'approvalMarker')
    ))).toBe(true);
    expect(view.status).toBe('running');
    expect(view).not.toHaveProperty('activity');
    expect(view.activityNodes.some((node) => node.kind === 'request')).toBe(true);
    expect(view.contextUsage).toEqual({
      usedTokens: 32_000,
      contextWindow: 64_000,
      source: 'estimated',
      breakdown: { systemTokens: 1_200, toolsTokens: 6_800, messageTokens: 24_000 },
    });
    expect(view.pendingApproval).toEqual(expect.objectContaining({
      approvalId: 'approval-health',
      callId: 'call-health',
    }));
    expect(view.inbox).toEqual([
      expect.objectContaining({ id: 'message-user', state: 'claimed' }),
    ]);
    adapter.dispose();
  });

  it('maps submit, stop, delete, and approval intentions without owning Runtime state', async () => {
    const dependencies = agentDependencies(agentSessionEventFixture);
    const adapter = createAgentSessionAdapter(dependencies);

    await adapter.submit('session-fixture', {
      content: 'Start now.',
      mode: 'start',
      clientOperationId: 'operation-start',
      provider,
      terminalContext: {
        sessionId: 'terminal-fixture', version: 1, maxLines: 200, maxBytes: 8192,
        content: 'Welcome to the server',
      },
    });
    await adapter.submit('session-fixture', {
      content: 'Avoid restart.',
      mode: 'nextStep',
      clientOperationId: 'operation-steer',
      provider,
    });
    await adapter.submit('session-fixture', {
      content: 'Run verification next.',
      mode: 'nextTurn',
      clientOperationId: 'operation-queue',
      provider,
    });
    await adapter.stop('session-fixture');
    await adapter.delete('session-fixture');
    const approval = {
      sessionId: 'session-fixture',
      turnId: 'turn-1',
      stepId: 'step-1',
      requestId: 'request-1',
      callId: 'call-health',
      approvalId: 'approval-health',
      risk: 'stateChange' as const,
      arguments: { command: 'systemctl restart nginx' },
    };
    await adapter.approve(approval);
    await adapter.reject(approval);
    await adapter.loadArtifact('session-fixture', 'artifact-report', 4096);

    expect(dependencies.start).toHaveBeenCalledWith({
      sessionId: 'session-fixture',
      selection: { routeId: provider.id, modelId: provider.model, reasoningEffort: undefined },
    });
    expect(dependencies.followup).toHaveBeenCalledWith({
      sessionId: 'session-fixture',
      messageId: 'operation-start',
      clientSubmissionId: 'operation-start',
      content: 'Start now.',
      terminalContext: {
        sessionId: 'terminal-fixture', version: 1, maxLines: 200, maxBytes: 8192,
        content: 'Welcome to the server',
      },
    });
    expect(dependencies.steer).toHaveBeenCalledWith({
      sessionId: 'session-fixture',
      messageId: 'operation-steer',
      clientSubmissionId: 'operation-steer',
      content: 'Avoid restart.',
    });
    expect(dependencies.followup).toHaveBeenCalledWith({
      sessionId: 'session-fixture',
      messageId: 'operation-queue',
      clientSubmissionId: 'operation-queue',
      content: 'Run verification next.',
    });
    expect(dependencies.stop).toHaveBeenCalledWith({ sessionId: 'session-fixture' });
    expect(dependencies.delete).toHaveBeenCalledWith({ sessionId: 'session-fixture' });
    const approvalDecision = {
      sessionId: 'session-fixture',
      turnId: 'turn-1',
      stepId: 'step-1',
      requestId: 'request-1',
      callId: 'call-health',
      approvalId: 'approval-health',
    };
    expect(dependencies.approve).toHaveBeenCalledWith(approvalDecision);
    expect(dependencies.reject).toHaveBeenCalledWith(approvalDecision);
    expect(dependencies.loadArtifact).toHaveBeenCalledWith({
      sessionId: 'session-fixture', artifactId: 'artifact-report', maxBytes: 4096,
    });
    adapter.dispose();
  });

  it.each(['followup', 'steer', 'stop'] as const)(
    'propagates %s errors for controller normalization',
    async (operation) => {
      const dependencies = {
        ...agentDependencies(agentSessionEventFixture),
        [operation]: vi.fn(async () => { throw new Error(`${operation} disconnected`); }),
      } as AgentSessionAdapterDependencies;
      const adapter = createAgentSessionAdapter(dependencies);
      const action = operation === 'stop'
        ? adapter.stop('session-fixture')
        : adapter.submit('session-fixture', {
            content: 'Continue',
            mode: operation === 'steer' ? 'nextStep' : 'nextTurn',
            clientOperationId: `operation-${operation}`,
            provider,
          });
      await expect(action).rejects.toThrow(`${operation} disconnected`);
      adapter.dispose();
    },
  );

  it('does not accept an ended snapshot as a committed terminal event', () => {
    const events = agentSessionEventFixture.slice(0, 3);
    const view = agentSessionView({
      snapshot: snapshot(true),
      events,
      lastCommittedSeq: events[events.length - 1]?.seq,
      hasTerminalEvent: false,
    });
    expect(view.status).toBe('running');
    expect(view.error).toBeNull();
  });
});


describe('Committed queue steering', () => {
  it('replays a lane reassignment, original attachment and single conversation identity through consumption', () => {
    const queued = projectAgentInbox(agentSessionSteerFixture.slice(0, 7));
    expect(queued.map((item) => [item.id, item.lane])).toEqual([
      ['existing-step', 'nextStep'], ['queued-steer', 'nextStep'],
    ]);
    expect(queued[1]).toMatchObject({
      id: queuedSteerMessageFixture.messageId, clientSubmissionId: 'original-submission',
      content: queuedSteerMessageFixture.content, images: queuedSteerMessageFixture.images, state: 'queued',
    });
    const cold = agentSessionView({ snapshot: snapshot(), events: agentSessionSteerFixture, lastCommittedSeq: 10, hasTerminalEvent: false });
    expect(cold.committedOperationIds).toContain('steer-operation');
    expect(cold.inbox.find((item) => item.id === 'queued-steer')).toMatchObject({ lane: 'nextStep', state: 'claimed', images: queuedSteerMessageFixture.images });
    const users = projectAgentChatNodes(agentSessionSteerFixture).filter((node) => node.kind === 'userMessage' && node.messageId === 'queued-steer');
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({ turnId: 'turn-steer', stepId: 'step-next', images: queuedSteerMessageFixture.images });
    expect(projectAgentActivity(agentSessionSteerFixture.slice(0, 7)).nodes.find((node) => node.key === 'activity:inbox:queued-steer')).toBeDefined();
  });

  it('waits for the live receipt, settles despite delayed IPC, and deduplicates its retry', async () => {
    const events = [...agentSessionSteerFixture.slice(0, 6)];
    let publish: ((event: AgentSessionEvent) => void) | undefined;
    const client = new AgentSessionCommittedClient('session-fixture', {
      snapshot: async () => snapshot(),
      committedEvents: async ({ afterSeq }) => ({ events: events.filter((event) => afterSeq === undefined || event.seq > afterSeq) }),
      subscribe: async (listener) => { publish = listener; return () => undefined; },
    });
    const dependencies = { ...agentDependencies(events), client: () => client };
    let rejectIpc: ((error: Error) => void) | undefined;
    vi.mocked(dependencies.mutateInbox).mockImplementation(() => new Promise((_resolve, reject) => {
      rejectIpc = reject;
    }));
    const adapter = createAgentSessionAdapter(dependencies);
    const input = { type: 'steer' as const, sessionId: 'session-fixture', itemId: 'queued-steer', expectedRevision: 6, clientOperationId: 'steer-operation' };
    let resolved = false;
    const pending = adapter.mutateInbox(input).then(() => { resolved = true; });
    await vi.waitFor(() => expect(dependencies.mutateInbox).toHaveBeenCalledOnce());
    expect(dependencies.mutateInbox).toHaveBeenCalledWith({ sessionId: 'session-fixture', expectedRevision: 6, clientOperationId: 'steer-operation', mutation: { type: 'steer', itemId: 'queued-steer' } });
    expect(resolved).toBe(false);
    events.push(agentSessionSteerFixture[6]);
    publish?.(events[6]);
    await client.settled();
    await pending;
    expect(resolved).toBe(true);
    rejectIpc?.(new Error('late IPC failure after committed receipt'));
    await adapter.mutateInbox(input);
    expect(dependencies.mutateInbox).toHaveBeenCalledOnce();
    expect(dependencies.followup).not.toHaveBeenCalled();
    expect(dependencies.steer).not.toHaveBeenCalled();
    adapter.dispose();
  });

  it('reconnects after an ambiguous IPC error and acknowledges a consumed, durably committed operation', async () => {
    const events = [...agentSessionSteerFixture.slice(0, 6)];
    const dependencies = agentDependencies(events);
    vi.mocked(dependencies.mutateInbox).mockImplementation(async () => {
      events.push(...agentSessionSteerFixture.slice(6));
      throw new Error('IPC response lost');
    });
    const adapter = createAgentSessionAdapter(dependencies);
    await adapter.mutateInbox({ type: 'steer', sessionId: 'session-fixture', itemId: 'queued-steer', expectedRevision: 6, clientOperationId: 'steer-operation' });
    const view = await adapter.open('session-fixture');
    expect(view.inbox.find((item) => item.id === 'queued-steer')?.state).toBe('claimed');
    expect(view.committedOperationIds).toContain('steer-operation');
    adapter.dispose();
  });

  it('backfills a lost live receipt on timeout and leaves an uncommitted error retryable', async () => {
    vi.useFakeTimers();
    const events = [...agentSessionSteerFixture.slice(0, 6)];
    const dependencies = agentDependencies(events);
    const adapter = createAgentSessionAdapter(dependencies);
    const input = { type: 'steer' as const, sessionId: 'session-fixture', itemId: 'queued-steer', expectedRevision: 6, clientOperationId: 'steer-operation' };
    try {
      await adapter.open('session-fixture');
      const pending = adapter.mutateInbox(input);
      await vi.advanceTimersByTimeAsync(1);
      events.push(agentSessionSteerFixture[6]);
      await vi.advanceTimersByTimeAsync(15_000);
      await pending;
      expect((await adapter.open('session-fixture')).committedOperationIds).toContain('steer-operation');
    } finally { adapter.dispose(); vi.useRealTimers(); }

    const failedDependencies = agentDependencies(agentSessionSteerFixture.slice(0, 6));
    vi.mocked(failedDependencies.mutateInbox).mockRejectedValue(new Error('disk unavailable'));
    const failedAdapter = createAgentSessionAdapter(failedDependencies);
    await expect(failedAdapter.mutateInbox(input)).rejects.toThrow('disk unavailable');
    expect((await failedAdapter.open('session-fixture')).inbox.find((item) => item.id === 'queued-steer')?.lane).toBe('nextTurn');
    failedAdapter.dispose();
  });
});
