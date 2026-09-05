import { AgentSessionCommittedClient, type AgentSessionStreamState } from '@/lib/agent-session-client';
import { invokeAnswerAgentRuntimeQuestion, invokeListAgentRuntimeSkills, invokeListAgentFileReferences } from '@/lib/tauri';
import { projectQuestions } from './question-projection';
import { invokeSubmitAgentImages } from '@/lib/tauri';
import { requireVision } from '@/lib/vision-contract';
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
  invokeSelectAgentRuntimeModel,
  invokeSetAgentRuntimePermission,
} from '@/lib/tauri';
import { projectAgentActivity } from '@/lib/agent-session-projection';
import type {
  AgentSessionEvent,
  AgentSessionListPage,
  AgentSessionSnapshot,
} from '@/types/agent-session';
import { projectAgentChatNodes } from './conversation-projection';
import { findConversationTool } from './conversation-tool';
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
    && event.data.usage.uncachedInputTokens !== undefined
    && event.data.usage.cacheReadTokens !== undefined
  ));
  const systemTokens = latestContext.data.systemTokens;
  const toolsTokens = latestContext.data.toolSchemaTokens;
  const messageTokens = latestContext.data.messageTokens;
  return {
    usedTokens: reported?.type === 'request/usage'
      ? reported.data.usage.uncachedInputTokens! + reported.data.usage.cacheReadTokens!
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
  readonly selectModel?: typeof invokeSelectAgentRuntimeModel;
  readonly setPermission?: typeof invokeSetAgentRuntimePermission;
  readonly submitImages?: typeof invokeSubmitAgentImages;
  readonly listFileReferences?: typeof invokeListAgentFileReferences;
  readonly listSkills?: typeof invokeListAgentRuntimeSkills;
  readonly createSession: typeof invokeCreateAgentRuntimeSession;
  readonly start: typeof invokeStartAgentRuntime;
  readonly answerQuestion: typeof invokeAnswerAgentRuntimeQuestion;
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
  selectModel: invokeSelectAgentRuntimeModel,
  setPermission: invokeSetAgentRuntimePermission,
  submitImages: invokeSubmitAgentImages,
  listSkills: invokeListAgentRuntimeSkills,
  listFileReferences: invokeListAgentFileReferences,
  createSession: invokeCreateAgentRuntimeSession,
  start: invokeStartAgentRuntime,
  answerQuestion: invokeAnswerAgentRuntimeQuestion,
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
  let activeTurnId: string | undefined;
  for (const event of events) {
    if (event.type === 'turn/start') {
      activeTurnId = event.turnId;
    } else if (event.type === 'turn/end' && event.turnId === activeTurnId) {
      activeTurnId = undefined;
    } else if (event.type === 'agent/inbox/spliced') {
      for (const message of event.data.messages) {
        if (event.data.operation === 'enqueued') {
          items.set(message.messageId, {
            id: message.messageId,
            ...(message.clientSubmissionId
              ? { clientSubmissionId: message.clientSubmissionId }
              : {}),
            lane: event.data.lane,
            content: message.content,
            ...(message.images ? { images: message.images } : {}),
            state: 'queued',
            // Runtime briefly enqueues even an immediate send before claiming it.
            // Keep its presentation stable when agent/status becomes running.
            startsTurn: message.source.kind === 'user'
              && event.data.lane === 'nextTurn' && activeTurnId === undefined,
            source: inboxSource(message.source),
            provenance: message.source,
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
    } else if (event.type === 'agent/inbox/item_steered') {
      const previous = items.get(event.data.itemId);
      if (previous) {
        items.delete(previous.id);
        items.set(previous.id, { ...previous, lane: 'nextStep', startsTurn: false });
      }
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

function flattenChatNodes(nodes: readonly AiConversationNode[]): readonly AiConversationNode[] {
  const readable: AiConversationNode[] = [];
  for (const node of nodes) {
    readable.push(node);
    if (node.kind === 'turnProcess') readable.push(...node.children);
  }
  return readable;
}

function pendingApproval(nodes: readonly AiConversationNode[]): AiPendingApproval | null {
  const readable = flattenChatNodes(nodes);
  const node = readable.find((candidate) => (
    candidate.kind === 'approvalMarker' && candidate.status === 'requested'
  ));
  if (node?.kind !== 'approvalMarker' || node.turnId === null || node.stepId === null) return null;
  const tool = findConversationTool(nodes, node);
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
    toolName: tool?.name ?? node.callId,
    target: tool?.target ?? null,
    arguments: tool?.input ?? null,
    effect: tool?.effect ?? node.risk,
    evidenceRefs: tool?.evidenceRefs ?? [],
  };
}

function terminalError(nodes: readonly AiConversationNode[]): AiSessionError | null {
  const readable = flattenChatNodes(nodes);
  const node = [...readable].reverse().find((candidate) => candidate.kind === 'error');
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
  const nodes = projectAgentChatNodes(events);
  const header = { ...state.snapshot.header };
  for (const event of events) {
    if (event.type === 'session/model_selected') header.modelSelection = event.data.provider;
    if (event.type === 'session/permission_changed') header.permissionMode = event.data.mode;
  }
  return {
    summary: sessionSummary(state.snapshot, events, activity.status),
    snapshot: {
      kind: 'agent',
      value: {
        ...state.snapshot,
        header,
        task: activity.plan === undefined ? state.snapshot.task : { ...state.snapshot.task, plan: activity.plan },
      },
    },
    nodes,
    activityNodes: activity.nodes,
    inbox: projectAgentInbox(events),
    pendingApproval: pendingApproval(nodes),
    pendingQuestion: projectQuestions(events).find((q) => q.status === 'pending') ?? null,
    status: activity.status,
    error: terminalError(nodes),
    throughSeq: state.lastCommittedSeq ?? null,
    revision: state.lastCommittedSeq === undefined ? state.snapshot.eventCount : state.lastCommittedSeq + 1,
    committedOperationIds: events.flatMap((event) => {
      switch (event.type) {
        case 'question/answered':
          return [event.data.submission.clientOperationId];
        case 'agent/inbox/item_updated':
        case 'agent/inbox/item_removed':
        case 'agent/inbox/item_steered':
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
    // A timeout can fire while the IPC command is still pending.
    void committed.catch(() => undefined);
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
      // The durable receipt can arrive before the IPC response, or after the
      // response is lost entirely. It is sufficient to settle the operation.
      await Promise.race([command(), committed]);
      if (entry.view?.committedOperationIds?.includes(clientOperationId) && !settled) {
        settled = true;
        entry.listeners.delete(listener);
        resolveCommit?.();
      }
      await committed;
    } catch (error) {
      // IPC may fail after durable append. Reconnect before reporting failure,
      // so retries can acknowledge the original operation, even after consumption.
      if (!entry.view?.committedOperationIds?.includes(clientOperationId)) {
        try {
          const refreshed = agentSessionView(await entry.client.reconnect());
          entry.view = refreshed;
          for (const subscribed of entry.listeners) subscribed(refreshed);
        } catch {
          // Preserve the original error; the caller retries the same identity.
        }
      }
      if (entry.view?.committedOperationIds?.includes(clientOperationId)) {
        entry.listeners.delete(listener);
        return;
      }
      if (!settled) {
        settled = true;
        entry.listeners.delete(listener);
      }
      throw error;
    } finally {
      globalThis.clearTimeout(timeout);
    }
  };

  const decision = (input: AiApprovalDecisionInput) => ({
    sessionId: input.sessionId,
    turnId: input.turnId,
    stepId: input.stepId,
    requestId: input.requestId,
    callId: input.callId,
    approvalId: input.approvalId,
  });

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
    async answerQuestion(input): Promise<void> {
      await dependencies.answerQuestion(input);
      // IPC success alone is not the UI acknowledgement: a lost live event must
      // be repaired before the form discards its retryable draft.
      const entry = ensureEntry(input.identity.sessionId);
      const view = agentSessionView(await entry.client.reconnect());
      entry.view = view;
      for (const listener of entry.listeners) listener(view);
      if (!view.committedOperationIds?.includes(input.clientOperationId)) {
        throw new Error('Committed question answer is not visible yet');
      }
    },
    listFileReferences: (sessionId, query, signal) => (dependencies.listFileReferences ?? invokeListAgentFileReferences)(sessionId, query, signal),
    listSkills: (sessionId) => (dependencies.listSkills ?? invokeListAgentRuntimeSkills)(sessionId),
    create: createSession,
    open: openEntry,
    async selectModel(sessionId, provider) {
      await (dependencies.selectModel ?? invokeSelectAgentRuntimeModel)({ sessionId, selection: { routeId: provider.id, modelId: provider.model, reasoningEffort: provider.reasoningEffort } });
      const entry = ensureEntry(sessionId);
      entry.view = agentSessionView(await entry.client.reconnect());
      for (const listener of entry.listeners) listener(entry.view);
    },
    async setPermission(sessionId, mode) {
      await (dependencies.setPermission ?? invokeSetAgentRuntimePermission)({ sessionId, mode });
      const entry = ensureEntry(sessionId);
      entry.view = agentSessionView(await entry.client.reconnect());
      for (const listener of entry.listeners) listener(entry.view);
    },
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
      const content = input.content;
      const hasImages = Boolean(input.images?.length);
      if (!content.trim() && !hasImages) throw new Error('Agent submission content is empty');
      if (hasImages) requireVision(input.provider);
      let resolvedSessionId = sessionId;
      if (resolvedSessionId === null) {
        if (!input.create) throw new Error('Agent submission requires create input for a new session');
        resolvedSessionId = (await createSession(input.create)).summary.id;
      }
      const view = await openEntry(resolvedSessionId);
      // An idle restored Session needs an owning runtime before its next input. start is idempotent.
      // A text follow-up still sends retained image bytes. Reattach after process restart
      // and apply the same vision preflight before accepting more Inbox content.
      const retainedImages = view.snapshot.value.surface.messages.some(m => m.role === 'userImages');
      if (retainedImages) requireVision(input.provider);
      if (input.mode === 'start' || view.status === 'idle' || hasImages || retainedImages) {
        await dependencies.start({ sessionId: resolvedSessionId, selection: { routeId: input.provider.id, modelId: input.provider.model, reasoningEffort: input.provider.reasoningEffort } });
      }
      const message = {
        sessionId: resolvedSessionId,
        messageId: input.clientOperationId,
        clientSubmissionId: input.clientOperationId,
        content,
      };
      if (hasImages) {
        if (!dependencies.submitImages) throw new Error('Image transport is unavailable');
        await dependencies.submitImages({ sessionId: resolvedSessionId, clientOperationId: input.clientOperationId,
          content, images: input.images!, lane: input.mode === 'nextStep' ? 'nextStep' : 'nextTurn' });
        // Backfill lost events before the durable draft can be acknowledged and removed.
        const state = await ensureEntry(resolvedSessionId).client.reconnect();
        if (!state.events.some(e => e.type === 'agent/inbox/spliced' && e.data.operation === 'enqueued'
          && e.data.messages.some(m => m.clientSubmissionId === input.clientOperationId))) {
          throw new Error('Image submission is not confirmed; retry the same draft');
        }
      }
      else if (input.mode === 'nextStep') await dependencies.steer(message);
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
        : type === 'remove' || type === 'steer'
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
