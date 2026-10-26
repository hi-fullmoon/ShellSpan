import { AgentSessionCommittedClient, type AgentSessionStreamState } from '@/lib/ai/agent-session-client';
import { createCommittedEventProjection } from './committed-event-projection';
import { fallbackSessionTitle } from './session-title';
import { AiAdmissionUnconfirmedError, normalizeAiSessionError } from './session-error';
import { invokeAnswerAgentRuntimeQuestion, invokeListAgentRuntimeSkills, invokeListAgentFileReferences } from '@/lib/ipc/tauri';
import { projectQuestions } from './question-projection';
import { modelRetryConfirmation } from './failure-recovery';
import { awaitMutationAcknowledgement } from './mutation-acknowledgement';
import { invokeSubmitAgentImages } from '@/lib/ipc/tauri';
import { requireVision } from '@/lib/ai/vision-contract';
import {
  invokeAgentRuntimeFollowup,
  invokeAgentRuntimeSteer,
  invokeApproveAgentRuntimeTool,
  invokeArchiveAgentRuntimeSession,
  invokeCancelAgentRuntimeChild,
  invokeDeleteAgentRuntimeSession,
  invokeInterruptAgentRuntime,
  invokeResumeAgentRuntime,
  invokeRetryAgentModel,
  invokeCreateAgentRuntimeSession,
  invokeContinueAgentRuntimeOnTarget,
  invokeReconnectAgentTerminal,
  invokeGetPendingAgentRuntimeApprovalArguments,
  invokeGetAgentRuntimeArtifact,
  invokeListAgentRuntimeSessions,
  invokeMutateAgentRuntimeInbox,
  invokeRejectAgentRuntimeTool,
  invokeRenameAgentRuntimeSession,
  invokeStartAgentRuntime,
  invokeSelectAgentRuntimeModel,
  invokeSetAgentRuntimePermission,
  invokeSetAgentRuntimeExecutionSurface,
  invokeBindAgentProjectRoot,
  invokeSendAgentRuntimeChildInput,
} from '@/lib/ipc/tauri';
import { createAgentActivityProjector, projectAgentActivity } from '@/lib/ai/agent-session-projection';
import { terminalLoginScopeKey } from '@/lib/ai/terminal-login-scope';
import type {
  AgentSessionEvent,
  AgentSessionListPage,
  AgentSessionSnapshot,
} from '@/types/agent-session';
import { createAgentChatProjector, projectAgentChatNodes } from './conversation-projection';
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
  AiSessionSubagentSummary,
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
  retrySync?(): Promise<AgentSessionStreamState>;
  disconnect(): void;
}

export interface AgentSessionAdapterDependencies {
  readonly selectModel?: typeof invokeSelectAgentRuntimeModel;
  readonly setPermission?: typeof invokeSetAgentRuntimePermission;
  readonly setExecutionSurface?: typeof invokeSetAgentRuntimeExecutionSurface;
  readonly reconnectTerminal?: typeof invokeReconnectAgentTerminal;
  readonly submitImages?: typeof invokeSubmitAgentImages;
  readonly listFileReferences?: typeof invokeListAgentFileReferences;
  readonly listSkills?: typeof invokeListAgentRuntimeSkills;
  readonly createSession: typeof invokeCreateAgentRuntimeSession;
  readonly start: typeof invokeStartAgentRuntime;
  readonly answerQuestion: typeof invokeAnswerAgentRuntimeQuestion;
  readonly followup: typeof invokeAgentRuntimeFollowup;
  readonly steer: typeof invokeAgentRuntimeSteer;
  readonly stop: typeof invokeInterruptAgentRuntime;
  readonly sendChildInput: typeof invokeSendAgentRuntimeChildInput;
  readonly cancelChild: typeof invokeCancelAgentRuntimeChild;
  readonly resume?: typeof invokeResumeAgentRuntime;
  readonly approve: typeof invokeApproveAgentRuntimeTool;
  readonly reject: typeof invokeRejectAgentRuntimeTool;
  readonly approvalArguments?: typeof invokeGetPendingAgentRuntimeApprovalArguments;
  readonly archive: typeof invokeArchiveAgentRuntimeSession;
  readonly delete: typeof invokeDeleteAgentRuntimeSession;
  readonly list: typeof invokeListAgentRuntimeSessions;
  readonly mutateInbox: typeof invokeMutateAgentRuntimeInbox;
  readonly rename: typeof invokeRenameAgentRuntimeSession;
  readonly loadArtifact: typeof invokeGetAgentRuntimeArtifact;
  readonly client: (sessionId: string) => AgentCommittedClientLike;
}

const defaultDependencies: AgentSessionAdapterDependencies = {
  selectModel: invokeSelectAgentRuntimeModel,
  setPermission: invokeSetAgentRuntimePermission,
  setExecutionSurface: invokeSetAgentRuntimeExecutionSurface,
  submitImages: invokeSubmitAgentImages,
  listSkills: invokeListAgentRuntimeSkills,
  listFileReferences: invokeListAgentFileReferences,
  createSession: invokeCreateAgentRuntimeSession,
  start: invokeStartAgentRuntime,
  answerQuestion: invokeAnswerAgentRuntimeQuestion,
  followup: invokeAgentRuntimeFollowup,
  steer: invokeAgentRuntimeSteer,
  stop: invokeInterruptAgentRuntime,
  sendChildInput: invokeSendAgentRuntimeChildInput,
  cancelChild: invokeCancelAgentRuntimeChild,
  resume: invokeResumeAgentRuntime,
  approve: invokeApproveAgentRuntimeTool,
  reject: invokeRejectAgentRuntimeTool,
  approvalArguments: invokeGetPendingAgentRuntimeApprovalArguments,
  archive: invokeArchiveAgentRuntimeSession,
  delete: invokeDeleteAgentRuntimeSession,
  list: invokeListAgentRuntimeSessions,
  mutateInbox: invokeMutateAgentRuntimeInbox,
  rename: invokeRenameAgentRuntimeSession,
  loadArtifact: invokeGetAgentRuntimeArtifact,
  client: (sessionId) => new AgentSessionCommittedClient(sessionId),
};

interface AgentAdapterEntry {
  readonly project: (state: AgentSessionStreamState) => AiSessionView;
  readonly client: AgentCommittedClientLike;
  readonly listeners: Set<AiSessionListener>;
  readonly stopListening: () => void;
  connecting?: Promise<AiSessionView>;
  view?: AiSessionView;
  leases: number;
}

function sessionSubagentSummary(
  subagent: AgentSessionSnapshot['header']['subagent'],
): AiSessionSubagentSummary | undefined {
  return subagent
    ? {
        descriptorId: subagent.descriptorId,
        role: subagent.role,
        continuable: subagent.continuable,
        depth: subagent.depth,
      }
    : undefined;
}

function sessionSummary(
  snapshot: AgentSessionSnapshot,
  events: readonly AgentSessionEvent[],
  status: AiSessionView['status'],
  metadataEvents: readonly AgentSessionEvent[] = events,
): AiSessionSummary {
  const lastEvent = events[events.length - 1];
  return {
    id: snapshot.header.sessionId,
    kind: 'agent',
    title: [...metadataEvents].reverse().find((event) => event.type === 'session/renamed')?.data.title
      ?? snapshot.header.title
      ?? fallbackSessionTitle(snapshot.header.goal),
    updatedAt: new Date(lastEvent?.timeUnixMs ?? snapshot.header.createdAtUnixMs).toISOString(),
    status,
    scopeKey: sessionScopeKey(snapshot.header.target, snapshot.header.sessionId),
    targetId: snapshot.header.target?.targetId,
    parentSessionId: snapshot.header.parentSessionId,
    subagent: sessionSubagentSummary(snapshot.header.subagent),
    archived: snapshot.archived,
    revision: events.length,
  };
}

function inboxSource(source: import('@/types/agent-session').AgentSessionMessageSource): AiInboxItem['source'] {
  return source.kind;
}

export function projectAgentInbox(events: readonly AgentSessionEvent[]): readonly AiInboxItem[] {
  const items = new Map<string, AiInboxItem>();
  const closedTurns = new Set<string>();
  let activeTurnId: string | undefined;
  let failed = false;
  for (const event of events) {
    if (event.turnId && !closedTurns.has(event.turnId) && event.type !== 'turn/end') {
      activeTurnId = event.turnId;
    }
    if (event.type === 'session/resumed') {
      failed = false;
      activeTurnId = undefined;
    } else if (event.type === 'session/ended') {
      failed = event.data.status === 'failed';
    } else if (event.type === 'turn/end') {
      if (event.turnId) closedTurns.add(event.turnId);
      if (event.turnId === activeTurnId) activeTurnId = undefined;
    } else if (event.type === 'step/preparation_abandoned') {
      if (event.turnId) closedTurns.add(event.turnId);
      if (event.turnId === activeTurnId) activeTurnId = undefined;
    } else if (event.type === 'agent/inbox/spliced') {
      for (const message of event.data.messages) {
        if (event.data.operation === 'enqueued') {
          items.set(message.messageId, {
            id: message.messageId,
            ...(message.clientSubmissionId
              ? { clientSubmissionId: message.clientSubmissionId }
              : {}),
            lane: event.data.lane,
            ...(event.data.lane === 'nextTurn' && typeof message.source.metadata?.targetTurnId === 'string' ? { redirected: true } : {}),
            content: message.content,
            ...(message.images ? { images: message.images } : {}),
            state: 'queued',
            ...((failed || message.source.metadata?.admissionPaused === true) ? { paused: true } : {}),
            // Runtime briefly enqueues even an immediate send before claiming it.
            // Keep its presentation stable when agent/status becomes running.
            startsTurn: message.source.kind === 'user'
              && !failed && message.source.metadata?.admissionPaused !== true
              && event.data.lane === 'nextTurn' && activeTurnId === undefined
              && ![...items.values()].some(item => item.source === 'user' && item.lane === 'nextTurn'
                && item.state === 'queued' && !item.paused && !item.consumed)
              && typeof message.source.metadata?.targetTurnId !== 'string',
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
    } else if (event.type === 'user/message') {
      const previous = items.get(event.data.message.messageId);
      if (previous) items.set(previous.id, { ...previous, consumed: true });
    } else if (event.type === 'agent/inbox/paused') {
      for (const id of event.data.itemIds) {
        const previous = items.get(id);
        if (previous) items.set(id, { ...previous, paused: true, startsTurn: false });
      }
    } else if (event.type === 'agent/inbox/item_resumed') {
      const previous = items.get(event.data.itemId);
      if (previous) items.set(previous.id, { ...previous, paused: false });
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

export function agentSessionView(state: AgentSessionStreamState, projected?: {
  readonly activity: ReturnType<typeof projectAgentActivity>;
  readonly nodes: readonly AiConversationNode[];
  readonly metadataEvents: readonly AgentSessionEvent[];
}): AiSessionView {
  if (!state.snapshot) throw new Error('Agent Session snapshot is unavailable');
  const events = projected?.metadataEvents ?? state.events;
  const activity = projected?.activity ?? projectAgentActivity(state.events);
  const nodes = projected?.nodes ?? projectAgentChatNodes(state.events);
  const header = { ...state.snapshot.header };
  for (const event of events) {
    if (event.type === 'session/model_selected') header.modelSelection = event.data.provider;
    if (event.type === 'session/permission_changed') header.permissionMode = event.data.mode;
    if (event.type === 'session/execution_surface_changed') header.executionSurface = event.data.surface;
    if (event.type === 'session/terminal_reconnected') {
      header.target = event.data.target;
      header.permissionMode = 'requestApproval';
    }
  }
  const task = activity.plan === undefined
    ? state.snapshot.task
    : activity.plan === null
      ? (({ plan: _plan, ...rest }) => rest)(state.snapshot.task)
      : { ...state.snapshot.task, plan: activity.plan };
  return {
    summary: sessionSummary({ ...state.snapshot, header }, state.events, activity.status, events),
    snapshot: {
      kind: 'agent',
      value: {
        ...state.snapshot,
        status: activity.status,
        ended: [...events].reverse().find(event => event.type === 'session/ended' || event.type === 'session/resumed')?.type === 'session/ended',
        header,
        task,
      },
    },
    nodes,
    activityNodes: activity.nodes,
    taskPlanActive: activity.planActive,
    subagents: activity.agents.filter((agent) => (
      agent.descriptorId !== undefined
      && agent.parentSessionId === state.snapshot?.header.sessionId
    )),
    inbox: projectAgentInbox(events),
    pendingApproval: pendingApproval(nodes),
    pendingQuestion: projectQuestions(events).find((q) => q.status === 'pending') ?? null,
    status: activity.status,
    error: activity.status === 'failed' || activity.status === 'cancelled' ? terminalError(nodes) : null,
    syncError: state.syncError ? normalizeAiSessionError(state.syncError) : undefined,
    syncRecovery: state.syncRecovery,
    throughSeq: state.lastCommittedSeq ?? null,
    revision: state.lastCommittedSeq === undefined ? state.snapshot.eventCount : state.lastCommittedSeq + 1,
    committedOperationIds: events.flatMap((event) => {
      switch (event.type) {
        case 'agent/inbox/spliced':
          return event.data.operation === 'enqueued'
            ? event.data.messages.flatMap(message => message.clientSubmissionId ? [message.clientSubmissionId] : []) : [];
        case 'question/answered':
          return [event.data.submission.clientOperationId];
        case 'agent/inbox/item_resumed':
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

/** A session-owned incremental projection, discarded together with its client. */
export function createAgentSessionViewProjector(): (state: AgentSessionStreamState) => AiSessionView {
  let previous: AgentSessionStreamState | undefined;
  let view: AiSessionView | undefined;
  const chat = createAgentChatProjector();
  const activity = createAgentActivityProjector();
  // Chunks affect chat and Activity, but never inbox/configuration/question state.
  const metadata = createCommittedEventProjection(() => {
    const events: AgentSessionEvent[] = [];
    return {
      apply(event) { if (event.type !== 'assistant/chunk') events.push(event); },
      snapshot() { return events; },
    };
  });
  return (state) => {
    // connect() publishes and returns the same committed window. Preserve the
    // view identity so both consumers can reuse it without replaying metadata.
    if (view && previous && previous.snapshot === state.snapshot && previous.events === state.events
      && previous.lastCommittedSeq === state.lastCommittedSeq
      && previous.syncError === state.syncError
      && previous.syncRecovery === state.syncRecovery
      && previous.hasTerminalEvent === state.hasTerminalEvent) return view;
    view = agentSessionView(state, {
      activity: activity(state.events), nodes: chat(state.events), metadataEvents: metadata(state.events),
    });
    previous = state;
    return view;
  };
}

function listSummary(page: AgentSessionListPage): readonly AiSessionSummary[] {
  return page.sessions.map((session) => ({
    id: session.header.sessionId,
    kind: 'agent',
    title: session.header.title ?? fallbackSessionTitle(session.header.goal),
    updatedAt: new Date(session.header.createdAtUnixMs).toISOString(),
    status: session.status,
    scopeKey: sessionScopeKey(session.header.target, session.header.sessionId),
    targetId: session.header.target?.targetId,
    parentSessionId: session.header.parentSessionId,
    subagent: sessionSubagentSummary(session.header.subagent),
    archived: session.archived,
    revision: session.eventCount,
  }));
}

function sessionScopeKey(
  target: AgentSessionSnapshot['header']['target'],
  sessionId: string,
): string {
  if (target?.targetId === 'workbench-ai') return target.targetId;
  return (target && terminalLoginScopeKey(target)) ?? target?.targetId ?? sessionId;
}

/** Create the Agent adapter over the existing subscribe-first committed client. */
export function createAgentSessionAdapter(
  dependencies: AgentSessionAdapterDependencies = defaultDependencies,
): AiSessionAdapter<'agent'> {
  const entries = new Map<string, AgentAdapterEntry>();

  const evict = (sessionId: string): void => {
    const entry = entries.get(sessionId);
    entry?.stopListening();
    entry?.client.disconnect();
    entries.delete(sessionId);
  };

  // Retain a small warm working set. Native runtimes own execution; evicting
  // a frontend subscription never stops a task or discards its durable journal.
  const trim = (): void => {
    const idle = [...entries].filter(([, entry]) => !entry.listeners.size && !entry.leases && !entry.connecting);
    let events = idle.reduce((count, [, entry]) => count + entry.client.state().events.length, 0);
    while (idle.length > 4 || events > 20_000) {
      const oldest = idle.shift();
      if (!oldest) break;
      events -= oldest[1].client.state().events.length;
      evict(oldest[0]);
    }
  };

  const ensureEntry = (sessionId: string): AgentAdapterEntry => {
    const existing = entries.get(sessionId);
    if (existing) {
      entries.delete(sessionId);
      entries.set(sessionId, existing);
      return existing;
    }
    const client = dependencies.client(sessionId);
    const listeners = new Set<AiSessionListener>();
    const entry: AgentAdapterEntry = {
      project: createAgentSessionViewProjector(),
      client,
      listeners,
      leases: 0,
      stopListening: client.onChange((state) => {
        // Hidden sessions ingest committed events, but do not build chat,
        // activity and metadata views until an observer needs them.
        if (!listeners.size && !entry.leases) { trim(); return; }
        const view = entry.project(state);
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
      const view = entry.project(state);
      entry.view = view;
      return view;
    }).finally(() => {
      entry.connecting = undefined;
      trim();
    });
    return entry.connecting;
  };

  const resumeEndedSession = async (
    sessionId: string,
    current?: AiSessionView,
  ): Promise<AiSessionView> => {
    const view = current ?? await openEntry(sessionId);
    if (!view.snapshot.value.ended
      && !['cancelled', 'failed', 'completed'].includes(view.status)) return view;
    await (dependencies.resume ?? invokeResumeAgentRuntime)({ sessionId });
    const entry = ensureEntry(sessionId);
    const resumed = entry.project(await entry.client.reconnect());
    entry.view = resumed;
    for (const listener of entry.listeners) listener(resumed);
    return resumed;
  };

  const waitForCommittedOperation = async (
    sessionId: string,
    clientOperationId: string,
    command: () => Promise<unknown>,
    recovery?: { readonly confirmed: (view: AiSessionView) => boolean },
  ): Promise<void> => {
    const entry = ensureEntry(sessionId);
    await openEntry(sessionId);
    const confirmed = (view?: AiSessionView): boolean => Boolean(view && (recovery
      ? recovery.confirmed(view) : view.committedOperationIds?.includes(clientOperationId)));
    if (!recovery && confirmed(entry.view)) return;
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
      if (!confirmed(next) || settled) return;
      settled = true;
      entry.listeners.delete(listener);
      resolveCommit?.();
    };
    entry.listeners.add(listener);
    let recoveryTimeout: ReturnType<typeof globalThis.setTimeout> | undefined;
    const timeout = globalThis.setTimeout(() => {
      if (settled) return;
      if (recovery) recoveryTimeout = globalThis.setTimeout(() => {
        if (settled) return;
        settled = true;
        entry.listeners.delete(listener);
        rejectCommit?.(new Error('Model retry recovery confirmation timed out'));
      }, 3_000);
      void entry.client.reconnect().then((state) => {
        if (settled) return;
        const refreshed = entry.project(state);
        entry.view = refreshed;
        for (const subscribed of entry.listeners) subscribed(refreshed);
        if (confirmed(refreshed)) return;
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
      const running = command();
      if (recovery && entry.view) listener(entry.view);
      await awaitMutationAcknowledgement(running, committed, () => {
        if (entry.view) listener(entry.view);
      });
    } catch (error) {
      // IPC may fail after durable append. Reconnect before reporting failure,
      // so retries can acknowledge the original operation, even after consumption.
      if (!confirmed(entry.view)) {
        try {
          const reconnect = entry.client.reconnect();
          const state = recovery ? await Promise.race([reconnect, committed.then(() => {
            throw new Error('Model retry was confirmed while reconnecting');
          })]) : await reconnect;
          const refreshed = entry.project(state);
          entry.view = refreshed;
          for (const subscribed of entry.listeners) subscribed(refreshed);
        } catch {
          // Preserve the original error; the caller retries the same identity.
        }
      }
      if (confirmed(entry.view)) {
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
      if (recoveryTimeout !== undefined) globalThis.clearTimeout(recoveryTimeout);
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

  const admit = async (sessionId: string, input: AiSubmitInput<'agent'>,
    command: () => Promise<AgentSessionSnapshot>): Promise<boolean> => {
    const entry = ensureEntry(sessionId);
    const confirmed = (events: readonly AgentSessionEvent[]): boolean => events.some(event => (
      event.type === 'agent/inbox/spliced' && event.data.operation === 'enqueued'
      && event.data.messages.some(message => message.clientSubmissionId === input.clientOperationId)
    ));
    const isPaused = (snapshot: AgentSessionSnapshot | null | undefined): boolean => snapshot?.status === 'failed'
      || Boolean(snapshot?.inbox.pausedIds?.includes(input.clientOperationId));
    let resolveObserved!: (result: { kind: 'observed'; paused: boolean }) => void;
    const observed = new Promise<{ kind: 'observed'; paused: boolean }>(resolve => { resolveObserved = resolve; });
    const listener: AiSessionListener = view => {
      if (view.committedOperationIds?.includes(input.clientOperationId)) {
        resolveObserved({ kind: 'observed', paused: isPaused(view.snapshot.value) });
      }
    };
    entry.listeners.add(listener);
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    let pollTimer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      deadlineTimer = setTimeout(() => reject(new AiAdmissionUnconfirmedError()), 15_000);
    });
    try {
      const request = command().then(snapshot => ({ kind: 'accepted' as const, snapshot }), error => ({ kind: 'error' as const, error: error as unknown }));
      // A live durable receipt also settles a missing IPC reply immediately.
      for (;;) {
        const result = await Promise.race([request, observed, deadline, new Promise<{ kind: 'pending' }>(resolve => {
          pollTimer = setTimeout(() => resolve({ kind: 'pending' }), 3000);
        })]);
        clearTimeout(pollTimer);
        if (result.kind === 'observed') return result.paused;
        if (result.kind === 'accepted') return isPaused(result.snapshot);
        if (result.kind === 'error' && /different payload|SUBMISSION_CONFLICT/.test(String(result.error))) throw result.error;
        let refreshed: AgentSessionStreamState;
        try {
          const refresh = await Promise.race([
            entry.client.reconnect().then(state => ({ kind: 'refreshed' as const, state })), observed, deadline,
          ]);
          if (refresh.kind === 'observed') return refresh.paused;
          refreshed = refresh.state;
        } catch (error) {
          if (error instanceof AiAdmissionUnconfirmedError) throw error;
          // Unreachable storage cannot establish that the message was rejected.
          await Promise.race([observed, deadline, new Promise<void>(resolve => {
            pollTimer = setTimeout(resolve, 3000);
          })]);
          continue;
        }
        entry.view = entry.project(refreshed);
        for (const subscribed of entry.listeners) subscribed(entry.view);
        if (confirmed(refreshed.events)) return isPaused(refreshed.snapshot);
        if (result.kind === 'error') throw result.error;
      }
    } finally {
      clearTimeout(deadlineTimer);
      clearTimeout(pollTimer);
      entry.listeners.delete(listener);
    }
  };

  const adapter = {
    kind: 'agent',
    async list(input: ListSessionsInput): Promise<AiSessionSummaryPage> {
      const page = await dependencies.list({ cursor: input.cursor, limit: input.limit });
      const sessions = listSummary(page).filter((session) => (
        (input.scopeKey === undefined || session.scopeKey === input.scopeKey)
        && (input.targetId === undefined || session.targetId === input.targetId)
        && (input.archived === undefined || session.archived === input.archived)
      ));
      return { sessions, nextCursor: page.nextCursor };
    },
    async answerQuestion(input): Promise<void> {
      await dependencies.answerQuestion(input);
      // IPC success alone is not the UI acknowledgement: a lost live event must
      // be repaired before the form discards its retryable draft.
      const entry = ensureEntry(input.identity.sessionId);
      const view = entry.project(await entry.client.reconnect());
      entry.view = view;
      for (const listener of entry.listeners) listener(view);
      if (!view.committedOperationIds?.includes(input.clientOperationId)) {
        throw new Error('Committed question answer is not visible yet');
      }
    },
    async listFileReferences(sessionId, query, signal) {
      if (signal.aborted) throw new Error('Cancelled');
      return (dependencies.listFileReferences ?? invokeListAgentFileReferences)(sessionId, query, signal);
    },
    async listSkills(sessionId) {
      return (dependencies.listSkills ?? invokeListAgentRuntimeSkills)(sessionId);
    },
    create: createSession,
    async continueOnTarget(input) {
      await invokeContinueAgentRuntimeOnTarget(input.request);
      return openEntry(input.request.sessionId);
    },
    async reconnectTerminal(sessionId, previousSessionId, terminalSessionId) {
      await (dependencies.reconnectTerminal ?? invokeReconnectAgentTerminal)({ sessionId, previousSessionId, terminalSessionId });
      // Reopening belongs to the explicit reconnect action, never to background
      // file/skill discovery that may finish after a terminal was closed.
      const entry = ensureEntry(sessionId);
      const rebound = entry.project(await entry.client.reconnect());
      entry.view = await resumeEndedSession(sessionId, rebound);
      for (const listener of entry.listeners) listener(entry.view);
      return entry.view;
    },
    open: openEntry,
    peek(sessionId: string) {
      const entry = entries.get(sessionId);
      if (!entry?.view) return undefined;
      ensureEntry(sessionId);
      entry.view = entry.project(entry.client.state());
      return entry.view;
    },
    async selectModel(sessionId, provider) {
      await resumeEndedSession(sessionId);
      await (dependencies.selectModel ?? invokeSelectAgentRuntimeModel)({ sessionId, selection: { routeId: provider.id, modelId: provider.model, reasoningEffort: provider.reasoningEffort } });
      const entry = ensureEntry(sessionId);
      entry.view = entry.project(await entry.client.reconnect());
      for (const listener of entry.listeners) listener(entry.view);
    },
    async setPermission(sessionId, mode) {
      await resumeEndedSession(sessionId);
      await (dependencies.setPermission ?? invokeSetAgentRuntimePermission)({ sessionId, mode });
      const entry = ensureEntry(sessionId);
      entry.view = entry.project(await entry.client.reconnect());
      for (const listener of entry.listeners) listener(entry.view);
    },
    async setExecutionSurface(sessionId, surface) {
      await resumeEndedSession(sessionId);
      await (dependencies.setExecutionSurface ?? invokeSetAgentRuntimeExecutionSurface)({ sessionId, surface });
      const entry = ensureEntry(sessionId);
      entry.view = entry.project(await entry.client.reconnect());
      for (const listener of entry.listeners) listener(entry.view);
    },
    async bindProjectRoot(sessionId, root) {
      await resumeEndedSession(sessionId);
      await invokeBindAgentProjectRoot({ sessionId, root });
      const entry = ensureEntry(sessionId);
      entry.view = entry.project(await entry.client.reconnect());
      for (const listener of entry.listeners) listener(entry.view);
    },
    subscribe(sessionId: string, listener: AiSessionListener): () => void {
      const entry = ensureEntry(sessionId);
      entry.listeners.add(listener);
      if (entry.view) {
        entry.view = entry.project(entry.client.state());
        listener(entry.view);
      }
      void openEntry(sessionId).catch(() => undefined);
      return () => {
        entry.listeners.delete(listener);
        trim();
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
      let view = await openEntry(resolvedSessionId);
      const committed = ensureEntry(resolvedSessionId).client.state().events.find(event => (
        event.type === 'agent/inbox/spliced' && event.data.operation === 'enqueued'
        && event.data.messages.some(message => message.clientSubmissionId === input.clientOperationId)
      ));
      if (committed?.type === 'agent/inbox/spliced' && !hasImages && !view.snapshot.value.header.subagent) {
        const message = { sessionId: resolvedSessionId, messageId: input.clientOperationId,
          clientSubmissionId: input.clientOperationId, content,
          ...(input.targetTurnId ? { targetTurnId: input.targetTurnId } : {}),
          ...(input.terminalContext ? { terminalContext: input.terminalContext } : {}) };
        const paused = await admit(resolvedSessionId, input, () => input.mode === 'nextStep'
          ? dependencies.steer(message) : dependencies.followup(message));
        return { sessionId: resolvedSessionId, clientOperationId: input.clientOperationId, mode: input.mode, ...(paused ? { paused: true } : {}) };
      }
      if (view.summary.archived) {
        throw new Error('This conversation cannot accept human follow-up messages');
      }
      if (committed && hasImages && dependencies.submitImages) {
        const submitImages = dependencies.submitImages;
        const paused = await admit(resolvedSessionId, input, () => submitImages({ sessionId: resolvedSessionId,
          clientOperationId: input.clientOperationId, content, images: input.images!,
          lane: input.mode === 'nextStep' ? 'nextStep' : 'nextTurn',
          ...(input.targetTurnId ? { targetTurnId: input.targetTurnId } : {}) }));
        return { sessionId: resolvedSessionId, clientOperationId: input.clientOperationId, mode: input.mode, ...(paused ? { paused: true } : {}) };
      }
      const child = view.snapshot.value.header.subagent;
      if (child) {
        const parentSessionId = view.snapshot.value.header.parentSessionId;
        if (!child.continuable || !parentSessionId) {
          throw new Error('This one-shot subagent cannot accept human follow-up messages');
        }
        if (hasImages) throw new Error('Subagent continuation accepts text only');
        await dependencies.sendChildInput({
          parentSessionId,
          childSessionId: resolvedSessionId,
          content,
          clientSubmissionId: input.clientOperationId,
        });
        const entry = ensureEntry(resolvedSessionId);
        const state = await entry.client.reconnect();
        if (!state.events.some((event) => (
          event.type === 'agent/inbox/spliced'
          && event.data.operation === 'enqueued'
          && event.data.messages.some((message) => (
            message.clientSubmissionId === input.clientOperationId
          ))
        ))) {
          throw new Error('Subagent continuation is not confirmed; retry the same draft');
        }
        entry.view = entry.project(state);
        for (const listener of entry.listeners) listener(entry.view);
        return {
          sessionId: resolvedSessionId,
          clientOperationId: input.clientOperationId,
          mode: 'nextTurn',
        };
      }
      const paused = input.paused || (input.queued && view.status === 'failed');
      if (!paused || hasImages) view = await resumeEndedSession(resolvedSessionId, view);
      // An idle restored Session needs an owning runtime before its next input. start is idempotent.
      // A text follow-up still sends retained image bytes. Reattach after process restart
      // and apply the same vision preflight before accepting more Inbox content.
      const retainedImages = view.snapshot.value.surface.messages.some(m => m.role === 'userImages');
      if (retainedImages) requireVision(input.provider);
      if (hasImages || (!paused && (input.mode === 'start' || view.status === 'idle' || retainedImages))) {
        await dependencies.start({ sessionId: resolvedSessionId, selection: { routeId: input.provider.id, modelId: input.provider.model, reasoningEffort: input.provider.reasoningEffort } });
      }
      const message = {
        sessionId: resolvedSessionId,
        messageId: input.clientOperationId,
        clientSubmissionId: input.clientOperationId,
        content,
        ...(paused ? { paused: true } : {}),
        ...(input.targetTurnId ? { targetTurnId: input.targetTurnId } : {}),
        ...(input.terminalContext ? { terminalContext: input.terminalContext } : {}),
      };
      let admittedPaused = Boolean(paused);
      if (hasImages) {
        if (!dependencies.submitImages) throw new Error('Image transport is unavailable');
        const submitImages = dependencies.submitImages;
        admittedPaused = await admit(resolvedSessionId, input, () => submitImages({ sessionId: resolvedSessionId, clientOperationId: input.clientOperationId,
          content, images: input.images!, lane: input.mode === 'nextStep' ? 'nextStep' : 'nextTurn',
          ...(paused ? { paused: true } : {}),
          ...(input.targetTurnId ? { targetTurnId: input.targetTurnId } : {}),
          ...(input.terminalContext ? { terminalContext: input.terminalContext } : {}) }));
      }
      else admittedPaused = await admit(resolvedSessionId, input, () => input.mode === 'nextStep'
        ? dependencies.steer(message) : dependencies.followup(message));
      return {
        sessionId: resolvedSessionId,
        clientOperationId: input.clientOperationId,
        mode: input.mode,
        ...(admittedPaused || paused ? { paused: true } : {}),
      };
    },
    async stop(sessionId: string): Promise<void> {
      const current = await openEntry(sessionId);
      const parentSessionId = current.snapshot.value.header.parentSessionId;
      if (current.snapshot.value.header.subagent && parentSessionId) {
        await dependencies.cancelChild({ parentSessionId, childSessionId: sessionId });
      } else {
        await dependencies.stop({ sessionId });
      }
      const entry = ensureEntry(sessionId);
      entry.view = entry.project(await entry.client.reconnect());
      for (const listener of entry.listeners) listener(entry.view);
    },
    async approve(input: AiApprovalDecisionInput): Promise<void> {
      await dependencies.approve(decision(input));
    },
    async reject(input: AiApprovalDecisionInput): Promise<void> {
      await dependencies.reject(decision(input));
    },
    async loadApprovalArguments(input: AiApprovalDecisionInput): Promise<unknown | null> {
      return dependencies.approvalArguments?.(decision(input)) ?? null;
    },
    async archive(sessionId: string): Promise<void> {
      await dependencies.archive({ sessionId });
      evict(sessionId);
    },
    async delete(sessionId: string): Promise<void> {
      await dependencies.delete({ sessionId });
      evict(sessionId);
    },
    evict,
    async mutateInbox(input: AiInboxMutationInput): Promise<void> {
      const { type, sessionId, expectedRevision, clientOperationId } = input;
      const mutation = type === 'update'
        ? { type, itemId: input.itemId, content: input.content }
        : type === 'remove' || type === 'steer' || type === 'resume'
          ? { type, itemId: input.itemId }
          : { type, lane: input.lane, orderedItemIds: input.orderedItemIds };
      if (type === 'resume') {
        const view = await resumeEndedSession(sessionId);
        const selection = view.snapshot.value.header.modelSelection;
        if (!selection) throw new Error('Select a model before resuming queued input');
        await dependencies.start({ sessionId, selection });
      }
      const revision = type === 'resume' ? ensureEntry(sessionId).view?.revision ?? expectedRevision : expectedRevision;
      await waitForCommittedOperation(sessionId, clientOperationId, () => dependencies.mutateInbox({
        sessionId,
        expectedRevision: revision,
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
      const view = entry.project(state);
      entry.view = view;
      for (const listener of entry.listeners) listener(view);
      return view;
    },
    async retrySync(sessionId: string): Promise<AiSessionView> {
      const entry = ensureEntry(sessionId);
      const state = await (entry.client.retrySync?.() ?? entry.client.reconnect());
      const view = entry.project(state);
      entry.view = view;
      for (const listener of entry.listeners) listener(view);
      return view;
    },
    async retryModel(sessionId, turnId): Promise<void> {
      // An old admission receipt does not prove a paused recovery was resumed.
      // Always dispatch the explicit action; native receipt handling is idempotent.
      const before = await openEntry(sessionId);
      const id = `model-retry-${turnId}`;
      await waitForCommittedOperation(sessionId, id, () => invokeRetryAgentModel({ sessionId, turnId }), {
        confirmed: modelRetryConfirmation(before, turnId),
      });
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
  } satisfies AiSessionAdapter<'agent'>;

  // Mutation/recovery work must retain its client even when the user switches
  // terminals before the durable acknowledgement arrives.
  const protect = <Args extends unknown[], Result>(
    operation: (...args: Args) => Promise<Result>,
    identify: (...args: Args) => string | null,
  ) => async (...args: Args): Promise<Result> => {
    const sessionId = identify(...args);
    const entry = sessionId ? ensureEntry(sessionId) : undefined;
    if (entry) entry.leases++;
    try { return await operation(...args); }
    finally { if (entry) entry.leases--; trim(); }
  };
  return {
    ...adapter,
    create: protect(adapter.create, input => input.request.sessionId),
    open: protect(adapter.open, id => id),
    submit: protect(adapter.submit, (id, input) => id ?? input.create?.request.sessionId ?? null),
    answerQuestion: protect(adapter.answerQuestion, input => input.identity.sessionId),
    selectModel: protect(adapter.selectModel, id => id),
    setPermission: protect(adapter.setPermission, id => id),
    setExecutionSurface: protect(adapter.setExecutionSurface, id => id),
    reconnectTerminal: protect(adapter.reconnectTerminal, id => id),
    bindProjectRoot: protect(adapter.bindProjectRoot, id => id),
    stop: protect(adapter.stop, id => id),
    mutateInbox: protect(adapter.mutateInbox, input => input.sessionId),
    rename: protect(adapter.rename, input => input.sessionId),
    refresh: protect(adapter.refresh, id => id),
    retrySync: protect(adapter.retrySync, id => id),
    retryModel: protect(adapter.retryModel, id => id),
  };
}
