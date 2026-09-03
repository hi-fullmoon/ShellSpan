import { AgentSessionCommittedClient, type AgentSessionStreamState } from '@/lib/agent-session-client';
import {
  invokeAgentRuntimeFollowup,
  invokeAgentRuntimeSteer,
  invokeApproveAgentRuntimeTool,
  invokeArchiveAgentRuntimeSession,
  invokeCancelAgentRuntime,
  invokeCreateAgentRuntimeSession,
  invokeGetAgentRuntimeArtifact,
  invokeListAgentRuntimeSessions,
  invokeMutateAgentRuntimeInbox,
  invokeRejectAgentRuntimeTool,
  invokeRenameAgentRuntimeSession,
  invokeStartAgentRuntime,
} from '@/lib/tauri';
import { projectAgentActivity } from '@/lib/agent-session-projection';
import type {
  AgentSessionEvent,
  AgentSessionListPage,
  AgentSessionSnapshot,
} from '@/types/agent-session';
import { projectAgentConversationNodes } from './conversation-projection';
import type { AiConversationNode } from './conversation-node';
import type {
  AiApprovalDecisionInput,
  AiContextUsage,
  AiCreateSessionInput,
  AiInboxMutationInput,
  AiInboxItem,
  AiPendingApproval,
  AiSessionAdapter,
  AiSessionError,
  AiSessionListener,
  AiSessionSummary,
  AiSessionSummaryPage,
  AiSessionRenameInput,
  AiSessionView,
  AiSubmitInput,
  AiSubmitReceipt,
  ListSessionsInput,
} from './session-adapter';

function contextUsage(events: readonly AgentSessionEvent[]): AiContextUsage | undefined {
  const latestContext = [...events].reverse().find((event) => event.type === 'request/context');
  if (latestContext?.type !== 'request/context') return undefined;
  const estimated = latestContext.data.inputTokens;
  const contextWindow = latestContext.data.contextWindow;
  if (estimated === undefined || contextWindow === undefined || contextWindow <= 0) return undefined;
  const reported = [...events].reverse().find((event) => (
    event.type === 'request/usage'
    && event.data.requestId === latestContext.data.requestId
    && event.data.inputTokens !== undefined
  ));
  const systemTokens = latestContext.data.systemTokens;
  const toolsTokens = latestContext.data.toolSchemaTokens;
  const messageTokens = latestContext.data.messageTokens;
  return {
    usedTokens: reported?.type === 'request/usage' && reported.data.inputTokens !== undefined
      ? reported.data.inputTokens
      : estimated,
    contextWindow,
    source: reported ? 'reported' : 'estimated',
    ...(systemTokens !== undefined && toolsTokens !== undefined && messageTokens !== undefined
      ? { breakdown: { systemTokens, toolsTokens, messageTokens } }
      : {}),
  };
}

interface AgentCommittedClientLike {
  state(): AgentSessionStreamState;
  onChange(listener: (state: AgentSessionStreamState) => void): () => void;
  connect(): Promise<AgentSessionStreamState>;
  reconnect(): Promise<AgentSessionStreamState>;
  disconnect(): void;
}

export interface AgentSessionAdapterDependencies {
  readonly createSession: typeof invokeCreateAgentRuntimeSession;
  readonly start: typeof invokeStartAgentRuntime;
  readonly followup: typeof invokeAgentRuntimeFollowup;
  readonly steer: typeof invokeAgentRuntimeSteer;
  readonly stop: typeof invokeCancelAgentRuntime;
  readonly approve: typeof invokeApproveAgentRuntimeTool;
  readonly reject: typeof invokeRejectAgentRuntimeTool;
  readonly archive: typeof invokeArchiveAgentRuntimeSession;
  readonly list: typeof invokeListAgentRuntimeSessions;
  readonly mutateInbox: typeof invokeMutateAgentRuntimeInbox;
  readonly rename: typeof invokeRenameAgentRuntimeSession;
  readonly loadArtifact: typeof invokeGetAgentRuntimeArtifact;
  readonly client: (sessionId: string) => AgentCommittedClientLike;
}

const defaultDependencies: AgentSessionAdapterDependencies = {
  createSession: invokeCreateAgentRuntimeSession,
  start: invokeStartAgentRuntime,
  followup: invokeAgentRuntimeFollowup,
  steer: invokeAgentRuntimeSteer,
  stop: invokeCancelAgentRuntime,
  approve: invokeApproveAgentRuntimeTool,
  reject: invokeRejectAgentRuntimeTool,
  archive: invokeArchiveAgentRuntimeSession,
  list: invokeListAgentRuntimeSessions,
  mutateInbox: invokeMutateAgentRuntimeInbox,
  rename: invokeRenameAgentRuntimeSession,
  loadArtifact: invokeGetAgentRuntimeArtifact,
  client: (sessionId) => new AgentSessionCommittedClient(sessionId),
};

interface AgentAdapterEntry {
  readonly client: AgentCommittedClientLike;
  readonly listeners: Set<AiSessionListener>;
  readonly stopListening: () => void;
  connecting?: Promise<AiSessionView>;
  view?: AiSessionView;
}

function sessionSummary(
  snapshot: AgentSessionSnapshot,
  events: readonly AgentSessionEvent[],
  status: AiSessionView['status'],
): AiSessionSummary {
  const lastEvent = events[events.length - 1];
  return {
    id: snapshot.header.sessionId,
    kind: 'agent',
    title: [...events].reverse().find((event) => event.type === 'session/renamed')?.data.title
      ?? snapshot.header.title
      ?? snapshot.header.goal,
    updatedAt: new Date(lastEvent?.timeUnixMs ?? snapshot.header.createdAtUnixMs).toISOString(),
    status,
    scopeKey: snapshot.header.target?.targetId ?? snapshot.header.sessionId,
    archived: snapshot.archived,
    revision: events.length,
  };
}

function inboxSource(source: import('@/types/agent-session').AgentSessionMessageSource): AiInboxItem['source'] {
  return source.kind;
}

export function projectAgentInbox(events: readonly AgentSessionEvent[]): readonly AiInboxItem[] {
  const items = new Map<string, AiInboxItem>();
  for (const event of events) {
    if (event.type === 'agent/inbox/spliced') {
      for (const message of event.data.messages) {
        if (event.data.operation === 'enqueued') {
          items.set(message.messageId, {
            id: message.messageId,
            ...(message.clientSubmissionId
              ? { clientSubmissionId: message.clientSubmissionId }
              : {}),
            lane: event.data.lane,
            content: message.content,
            state: 'queued',
            source: inboxSource(message.source),
          });
        } else if (event.data.operation === 'claimed') {
          const previous = items.get(message.messageId);
          if (previous) items.set(message.messageId, { ...previous, state: 'claimed' });
        } else {
          items.delete(message.messageId);
        }
      }
    } else if (event.type === 'agent/inbox/item_updated') {
      const previous = items.get(event.data.itemId);
      if (previous) items.set(event.data.itemId, { ...previous, content: event.data.content });
    } else if (event.type === 'agent/inbox/item_removed') {
      items.delete(event.data.itemId);
    } else if (event.type === 'agent/inbox/reordered') {
      const ordered = event.data.orderedItemIds
        .map((itemId) => items.get(itemId))
        .filter((item): item is AiInboxItem => item !== undefined);
      const other = [...items.values()].filter((item) => item.lane !== event.data.lane);
      items.clear();
      for (const item of [...other, ...ordered]) items.set(item.id, item);
    }
  }
  return [...items.values()];
}

function pendingApproval(nodes: readonly AiConversationNode[]): AiPendingApproval | null {
  const node = nodes.find((candidate) => (
    candidate.kind === 'approvalMarker' && candidate.status === 'requested'
  ));
  if (node?.kind !== 'approvalMarker' || node.turnId === null || node.stepId === null) return null;
  const tool = nodes.find((candidate) => candidate.kind === 'tool' && candidate.callId === node.callId);
  return {
    sessionId: node.sessionId,
    turnId: node.turnId,
    stepId: node.stepId,
    requestId: node.requestId,
    callId: node.callId,
    approvalId: node.approvalId,
    risk: node.risk,
    prompt: node.prompt,
    reason: node.reason,
    expiresAtUnixMs: node.expiresAtUnixMs,
    toolName: tool?.kind === 'tool' ? tool.name : node.callId,
    target: tool?.kind === 'tool' ? tool.target : null,
    arguments: tool?.kind === 'tool' ? tool.input : null,
    effect: tool?.kind === 'tool' ? tool.effect : node.risk,
    evidenceRefs: tool?.kind === 'tool' ? tool.evidenceRefs : [],
  };
}

function terminalError(nodes: readonly AiConversationNode[]): AiSessionError | null {
  const node = [...nodes].reverse().find((candidate) => candidate.kind === 'error');
  if (node?.kind !== 'error') return null;
  return {
    kind: node.state === 'cancelled' ? 'cancelled' : 'terminal',
    message: node.message,
    retryable: false,
  };
}

export function agentSessionView(state: AgentSessionStreamState): AiSessionView {
  if (!state.snapshot) throw new Error('Agent Session snapshot is unavailable');
  const events = state.events;
  const activity = projectAgentActivity(events);
  const nodes = projectAgentConversationNodes(events);
  return {
    summary: sessionSummary(state.snapshot, events, activity.status),
    snapshot: { kind: 'agent', value: state.snapshot },
    nodes,
    inbox: projectAgentInbox(events),
    pendingApproval: pendingApproval(nodes),
    status: activity.status,
    error: terminalError(nodes),
    throughSeq: state.lastCommittedSeq ?? null,
    revision: state.lastCommittedSeq === undefined ? state.snapshot.eventCount : state.lastCommittedSeq + 1,
    committedOperationIds: events.flatMap((event) => {
      switch (event.type) {
        case 'agent/inbox/item_updated':
        case 'agent/inbox/item_removed':
        case 'agent/inbox/reordered':
        case 'session/renamed':
          return [event.data.clientOperationId];
        default:
          return [];
      }
    }),
    canLoadOlder: false,
    contextUsage: contextUsage(events),
  };
}

function listSummary(page: AgentSessionListPage): readonly AiSessionSummary[] {
  return page.sessions.map((session) => ({
    id: session.header.sessionId,
    kind: 'agent',
    title: session.header.title ?? session.header.goal,
    updatedAt: new Date(session.header.createdAtUnixMs).toISOString(),
    status: session.status,
    scopeKey: session.header.target?.targetId ?? session.header.sessionId,
    archived: session.archived,
    revision: session.eventCount,
  }));
}

/** Create the Agent adapter over the existing subscribe-first committed client. */
export function createAgentSessionAdapter(
  dependencies: AgentSessionAdapterDependencies = defaultDependencies,
): AiSessionAdapter<'agent'> {
  const entries = new Map<string, AgentAdapterEntry>();

  const ensureEntry = (sessionId: string): AgentAdapterEntry => {
    const existing = entries.get(sessionId);
    if (existing) return existing;
    const client = dependencies.client(sessionId);
    const listeners = new Set<AiSessionListener>();
    const entry: AgentAdapterEntry = {
      client,
      listeners,
      stopListening: client.onChange((state) => {
        const view = agentSessionView(state);
        entry.view = view;
        for (const listener of listeners) listener(view);
      }),
    };
    entries.set(sessionId, entry);
    return entry;
  };

  const openEntry = async (sessionId: string): Promise<AiSessionView> => {
    const entry = ensureEntry(sessionId);
    entry.connecting ??= entry.client.connect().then((state) => {
      const view = agentSessionView(state);
      entry.view = view;
      return view;
    }).finally(() => {
      entry.connecting = undefined;
    });
    return entry.connecting;
  };

  const waitForCommittedOperation = async (
    sessionId: string,
    clientOperationId: string,
    command: () => Promise<unknown>,
  ): Promise<void> => {
    const entry = ensureEntry(sessionId);
    await openEntry(sessionId);
    if (entry.view?.committedOperationIds?.includes(clientOperationId)) return;
    let settled = false;
    let resolveCommit: (() => void) | undefined;
    let rejectCommit: ((error: Error) => void) | undefined;
    const committed = new Promise<void>((resolve, reject) => {
      resolveCommit = resolve;
      rejectCommit = reject;
    });
    const listener: AiSessionListener = (next) => {
      if (!next.committedOperationIds?.includes(clientOperationId) || settled) return;
      settled = true;
      entry.listeners.delete(listener);
      resolveCommit?.();
    };
    entry.listeners.add(listener);
    const timeout = globalThis.setTimeout(() => {
      if (settled) return;
      void entry.client.reconnect().then((state) => {
        if (settled) return;
        const refreshed = agentSessionView(state);
        entry.view = refreshed;
        for (const subscribed of entry.listeners) subscribed(refreshed);
        if (refreshed.committedOperationIds?.includes(clientOperationId)) return;
        settled = true;
        entry.listeners.delete(listener);
        rejectCommit?.(new Error('Committed Agent Runtime mutation event timed out'));
      }, () => {
        if (settled) return;
        settled = true;
        entry.listeners.delete(listener);
        rejectCommit?.(new Error('Committed Agent Runtime mutation event timed out'));
      });
    }, 15_000);
    try {
      await command();
      if (entry.view?.committedOperationIds?.includes(clientOperationId) && !settled) {
        settled = true;
        entry.listeners.delete(listener);
        resolveCommit?.();
      }
      await committed;
    } catch (error) {
      if (!settled) {
        settled = true;
        entry.listeners.delete(listener);
      }
      throw error;
    } finally {
      globalThis.clearTimeout(timeout);
    }
  };

  const decision = (input: AiApprovalDecisionInput) => ({ ...input });

  const createSession = async (
    input: Extract<AiCreateSessionInput, { readonly kind: 'agent' }>,
  ): Promise<AiSessionView> => {
    await dependencies.createSession(input.request);
    return openEntry(input.request.sessionId);
  };

  return {
    kind: 'agent',
    async list(input: ListSessionsInput): Promise<AiSessionSummaryPage> {
      const page = await dependencies.list({ cursor: input.cursor, limit: input.limit });
      const sessions = listSummary(page).filter((session) => (
        (input.scopeKey === undefined || session.scopeKey === input.scopeKey)
        && (input.archived === undefined || session.archived === input.archived)
      ));
      return { sessions, nextCursor: page.nextCursor };
    },
    create: createSession,
    open: openEntry,
    subscribe(sessionId: string, listener: AiSessionListener): () => void {
      const entry = ensureEntry(sessionId);
      entry.listeners.add(listener);
      if (entry.view) listener(entry.view);
      void openEntry(sessionId).catch(() => undefined);
      return () => {
        entry.listeners.delete(listener);
        if (entry.listeners.size === 0) {
          const connecting = entry.connecting;
          if (connecting) {
            void connecting.finally(() => {
              if (entry.listeners.size === 0) entry.client.disconnect();
            });
          } else {
            entry.client.disconnect();
          }
        }
      };
    },
    async submit(
      sessionId: string | null,
      input: AiSubmitInput<'agent'>,
    ): Promise<AiSubmitReceipt> {
      const content = input.content.trim();
      if (!content) throw new Error('Agent submission content is empty');
      let resolvedSessionId = sessionId;
      if (resolvedSessionId === null) {
        if (!input.create) throw new Error('Agent submission requires create input for a new session');
        resolvedSessionId = (await createSession(input.create)).summary.id;
      }
      await openEntry(resolvedSessionId);
      if (input.mode === 'start') {
        await dependencies.start({ sessionId: resolvedSessionId, provider: input.provider });
      }
      const message = {
        sessionId: resolvedSessionId,
        messageId: input.clientOperationId,
        clientSubmissionId: input.clientOperationId,
        content,
      };
      if (input.mode === 'nextStep') await dependencies.steer(message);
      else await dependencies.followup(message);
      return {
        sessionId: resolvedSessionId,
        clientOperationId: input.clientOperationId,
        mode: input.mode,
      };
    },
    async stop(sessionId: string): Promise<void> {
      await dependencies.stop({ sessionId });
    },
    async approve(input: AiApprovalDecisionInput): Promise<void> {
      await dependencies.approve(decision(input));
    },
    async reject(input: AiApprovalDecisionInput): Promise<void> {
      await dependencies.reject(decision(input));
    },
    async archive(sessionId: string): Promise<void> {
      await dependencies.archive({ sessionId });
    },
    async mutateInbox(input: AiInboxMutationInput): Promise<void> {
      const { type, sessionId, expectedRevision, clientOperationId } = input;
      const mutation = type === 'update'
        ? { type, itemId: input.itemId, content: input.content }
        : type === 'remove'
          ? { type, itemId: input.itemId }
          : { type, lane: input.lane, orderedItemIds: input.orderedItemIds };
      await waitForCommittedOperation(sessionId, clientOperationId, () => dependencies.mutateInbox({
        sessionId,
        expectedRevision,
        clientOperationId,
        mutation,
      }));
    },
    async rename(input: AiSessionRenameInput): Promise<void> {
      await waitForCommittedOperation(input.sessionId, input.clientOperationId, () => (
        dependencies.rename(input)
      ));
    },
    async refresh(sessionId: string): Promise<AiSessionView> {
      const entry = ensureEntry(sessionId);
      const state = await entry.client.reconnect();
      const view = agentSessionView(state);
      entry.view = view;
      for (const listener of entry.listeners) listener(view);
      return view;
    },
    async loadOlder(_sessionId: string, _cursor: string): Promise<readonly AiConversationNode[]> {
      return [];
    },
    async loadArtifact(sessionId: string, artifactId: string, maxBytes: number) {
      return dependencies.loadArtifact({ sessionId, artifactId, maxBytes });
    },
    dispose(): void {
      for (const entry of entries.values()) {
        entry.stopListening();
        entry.client.disconnect();
      }
      entries.clear();
    },
  };
}
