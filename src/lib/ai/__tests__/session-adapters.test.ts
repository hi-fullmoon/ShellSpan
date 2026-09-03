import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentSessionCommittedClient } from '@/lib/agent-session-client';
import {
  agentSessionView,
  createAgentSessionAdapter,
  projectAgentInbox,
  type AgentSessionAdapterDependencies,
} from '@/lib/ai/agent-session-adapter';
import {
  createAskSessionAdapter,
  type AskSessionAdapterDependencies,
} from '@/lib/ai/ask-session-adapter';
import type { AiSessionView } from '@/lib/ai/session-adapter';
import { useAiStore } from '@/stores/aiStore';
import {
  agentSessionEventFixture,
  agentSessionWaitingApprovalEventFixture,
} from '@/test/fixtures/agent-session';
import {
  ASK_STREAM_REQUEST_ID,
  askStreamingConversationFixture,
} from '@/test/fixtures/ask-streaming';
import type { AiStreamEvent } from '@/types/ai';
import type {
  AgentSessionEvent,
  AgentSessionSnapshot,
} from '@/types/agent-session';
import { AGENT_SESSION_EVENT_VERSION } from '@/types/agent-session';

const provider = {
  id: 'provider-test',
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
    approve: vi.fn(async () => snapshot()),
    reject: vi.fn(async () => snapshot()),
    archive: vi.fn(async () => snapshot()),
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

afterEach(() => {
  useAiStore.getState().clear();
});

describe('AgentSessionAdapter', () => {
  it('projects committed Inbox mutations in Runtime order', () => {
    const events: AgentSessionEvent[] = [
      {
        version: AGENT_SESSION_EVENT_VERSION, sessionId: 'session-fixture', seq: 0,
        timeUnixMs: 1, type: 'agent/inbox/spliced',
        data: {
          operation: 'enqueued', lane: 'nextTurn', messages: [
            { messageId: 'a', clientSubmissionId: 'submission-a', content: 'A', source: { kind: 'user' } },
            { messageId: 'b', clientSubmissionId: 'submission-b', content: 'B', source: { kind: 'user' } },
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
      content: 'B updated', state: 'queued', source: 'user',
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
    expect(view.nodes.some((node) => node.kind === 'approvalMarker')).toBe(true);
    expect(view.activity?.sessionId).toBe('session-fixture');
    expect(view.pendingApproval).toEqual(expect.objectContaining({
      approvalId: 'approval-health',
      callId: 'call-health',
    }));
    expect(view.inbox).toEqual([
      expect.objectContaining({ id: 'message-user', state: 'claimed' }),
    ]);
    adapter.dispose();
  });

  it('maps submit, stop, and approval intentions without owning Runtime state', async () => {
    const dependencies = agentDependencies(agentSessionEventFixture);
    const adapter = createAgentSessionAdapter(dependencies);

    await adapter.submit('session-fixture', {
      content: 'Start now.',
      mode: 'start',
      clientOperationId: 'operation-start',
      provider,
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
    const approval = {
      sessionId: 'session-fixture',
      turnId: 'turn-1',
      stepId: 'step-1',
      requestId: 'request-1',
      callId: 'call-health',
      approvalId: 'approval-health',
    };
    await adapter.approve(approval);
    await adapter.reject(approval);
    await adapter.loadArtifact('session-fixture', 'artifact-report', 4096);

    expect(dependencies.start).toHaveBeenCalledWith({ sessionId: 'session-fixture', provider });
    expect(dependencies.followup).toHaveBeenCalledWith({
      sessionId: 'session-fixture',
      messageId: 'operation-start',
      clientSubmissionId: 'operation-start',
      content: 'Start now.',
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
    expect(dependencies.approve).toHaveBeenCalledWith(approval);
    expect(dependencies.reject).toHaveBeenCalledWith(approval);
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

describe('AskSessionAdapter', () => {
  it('subscribes before submit and projects stream/error state through aiStore', async () => {
    const order: string[] = [];
    let streamListener: ((event: AiStreamEvent) => void) | undefined;
    const dependencies: AskSessionAdapterDependencies = {
      store: useAiStore,
      start: vi.fn(async () => { order.push('start'); }),
      stop: vi.fn(async () => undefined),
      listen: vi.fn(async (listener) => {
        order.push('listen');
        streamListener = listener;
        return () => { streamListener = undefined; };
      }),
      create: vi.fn(async () => undefined),
      archive: vi.fn(async () => undefined),
      persistMessage: vi.fn(async () => undefined),
    };
    const adapter = createAskSessionAdapter(dependencies);
    await adapter.create({ kind: 'ask', conversation: askStreamingConversationFixture });
    const views: AiSessionView[] = [];
    const unsubscribe = adapter.subscribe(askStreamingConversationFixture.id, (view) => {
      views.push(view);
    });

    await adapter.submit(askStreamingConversationFixture.id, {
      content: 'Why did the deployment fail?',
      mode: 'start',
      clientOperationId: ASK_STREAM_REQUEST_ID,
      provider,
    });
    streamListener?.({ type: 'textDelta', requestId: ASK_STREAM_REQUEST_ID, text: 'Inspecting ' });
    streamListener?.({
      type: 'textDelta',
      requestId: ASK_STREAM_REQUEST_ID,
      text: 'the deployment output.',
    });
    streamListener?.({ type: 'completed', requestId: ASK_STREAM_REQUEST_ID });

    expect(order).toEqual(['listen', 'start']);
    const completedView = views[views.length - 1];
    expect(completedView?.status).toBe('idle');
    expect(completedView?.nodes.find((node) => node.kind === 'assistantMessage'))
      .toEqual(expect.objectContaining({
        key: 'assistant:ask-stream-request',
        content: 'Inspecting the deployment output.',
        state: 'completed',
      }));

    useAiStore.getState().beginRequest({
      requestId: 'request-error',
      task: 'ask',
      userContent: 'Retry?',
      providerId: provider.id,
      conversationId: askStreamingConversationFixture.id,
    });
    streamListener?.({ type: 'error', requestId: 'request-error', message: 'Provider disconnected.' });
    const failedView = views[views.length - 1];
    expect(failedView?.error).toEqual(expect.objectContaining({
      message: 'Provider disconnected.',
      retryable: true,
    }));
    expect(failedView?.nodes.some((node) => node.kind === 'error')).toBe(true);

    unsubscribe();
    adapter.dispose();
  });

  it('routes a streaming Stop through the Ask cancel adapter and propagates errors', async () => {
    const dependencies: AskSessionAdapterDependencies = {
      store: useAiStore,
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => { throw new Error('cancel disconnected'); }),
      listen: vi.fn(async () => () => undefined),
      create: vi.fn(async () => undefined),
      archive: vi.fn(async () => undefined),
      persistMessage: vi.fn(async () => undefined),
    };
    const adapter = createAskSessionAdapter(dependencies);
    await adapter.create({ kind: 'ask', conversation: askStreamingConversationFixture });
    useAiStore.getState().beginRequest({
      requestId: 'request-cancel',
      task: 'ask',
      userContent: 'Stop this',
      providerId: provider.id,
      conversationId: askStreamingConversationFixture.id,
    });
    await expect(adapter.stop(askStreamingConversationFixture.id)).rejects.toThrow('cancel disconnected');
    expect(dependencies.stop).toHaveBeenCalledWith('request-cancel');
    adapter.dispose();
  });
});
