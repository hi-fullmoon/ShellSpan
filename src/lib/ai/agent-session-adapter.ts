import { AgentSessionCommittedClient, type AgentSessionStreamState } from '@/lib/ai/agent-session-client';
import { createCommittedEventProjection } from './committed-event-projection';
import { projectContextUsage } from './context-usage';
import { fallbackSessionTitle } from './session-title';
import { normalizeAiSessionError } from './session-error';
import { invokeAnswerAgentRuntimeQuestion, invokeListAgentRuntimeSkills, invokeListAgentFileReferences } from '@/lib/ipc/tauri';
import { projectQuestions } from './question-projection';
import { QuestionSubmissionError, questionSubmissionIssue, reconcileQuestionSubmission } from './question-submission';
import type { AnswerQuestionInput } from '@/types/agent-question';
import { modelRetryConfirmation } from './failure-recovery';
import { childBudgetExhausted } from './subagent-continuation';
import { awaitInboxAdmission, awaitMutationAcknowledgement, withOperationDeadline } from './mutation-acknowledgement';
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
  AgentExecutionSurface,
  AgentSessionEvent,
  AgentSessionListPage,
  AgentSessionPermissionMode,
  AgentSessionSnapshot,
  AgentSubagentModel,
} from '@/types/agent-session';
import { createAgentChatProjector, projectAgentChatNodes } from './conversation-projection';
import { findConversationTool } from './conversation-tool';
import type { AiConversationNode } from './conversation-node';
import type {
  AiApprovalDecisionInput,
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
  readonly retryModel?: typeof invokeRetryAgentModel;
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
  retryModel: invokeRetryAgentModel,
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
  /** Committed journal state plus settings that are still pending. */
  readonly project: (state: AgentSessionStreamState) => AiSessionView;
  /** Committed journal state only. */
  readonly projectCommitted: (state: AgentSessionStreamState) => AiSessionView;
  readonly client: AgentCommittedClientLike;
  readonly listeners: Set<AiSessionListener>;
  readonly stopListening: () => void;
  connecting?: Promise<AiSessionView>;
  view?: AiSessionView;
  leases: number;
  /** Settings chosen on an ended Session; applied when explicit input resumes it. */
  pendingSettings?: PendingSessionSettings;
}

interface PendingSessionSettings {
  readonly model?: AgentSubagentModel;
  readonly permissionMode?: AgentSessionPermissionMode;
  readonly executionSurface?: AgentExecutionSurface;
}

/** Changing a setting must not reopen an ended root Session; only explicit input does. */
function defersSettings(view: AiSessionView): boolean {
  const value = view.snapshot.value;
  return value.ended && !view.summary.archived && !value.header.subagent;
}

function sameModel(left: AgentSubagentModel | undefined, right: AgentSubagentModel): boolean {
  return left?.routeId === right.routeId && left.modelId === right.modelId
    && (left.reasoningEffort ?? undefined) === (right.reasoningEffort ?? undefined);
}

/** Drop pending values that already match the committed header. */
function normalizePendingSettings(
  header: AgentSessionSnapshot['header'],
  pending: PendingSessionSettings,
): PendingSessionSettings | undefined {
  const next: { -readonly [Key in keyof PendingSessionSettings]: PendingSessionSettings[Key] } = {};
  if (pending.model && !sameModel(header.modelSelection, pending.model)) next.model = pending.model;
  if (pending.permissionMode && pending.permissionMode !== header.permissionMode) next.permissionMode = pending.permissionMode;
  if (pending.executionSurface && pending.executionSurface !== header.executionSurface) next.executionSurface = pending.executionSurface;
  return next.model || next.permissionMode || next.executionSurface ? next : undefined;
}

function withPendingSessionSettings(view: AiSessionView, pending: PendingSessionSettings | undefined): AiSessionView {
  if (!pending) return view;
  const value = view.snapshot.value;
  return {
    ...view,
    snapshot: {
      ...view.snapshot,
      value: {
        ...value,
        header: {
          ...value.header,
          ...(pending.model ? { modelSelection: pending.model } : {}),
          ...(pending.permissionMode ? { permissionMode: pending.permissionMode } : {}),
          ...(pending.executionSurface ? { executionSurface: pending.executionSurface } : {}),
        },
      },
    },
  };
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
    if (event.type === 'subagent/recovery_started') {
      failed = false;
      activeTurnId = undefined;
      const message = event.data.message;
      items.set(message.messageId, {
        id: message.messageId, clientSubmissionId: message.clientSubmissionId,
        lane: 'nextTurn', content: message.content, state: 'queued', paused: false,
        startsTurn: false, source: inboxSource(message.source), provenance: message.source,
      });
    } else if (event.type === 'session/resumed') {
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
      if (previous) items.set(event.data.itemId, {
        ...previous, content: event.data.content, images: event.data.images ?? previous.images,
      });
    } else if (event.type === 'agent/inbox/item_removed') {
      items.delete(event.data.itemId);
    } else if (event.type === 'agent/inbox/item_steered') {
      const previous = items.get(event.data.itemId);
      if (previous) {
        items.delete(previous.id);
        items.set(previous.id, { ...previous, lane: 'nextStep', startsTurn: false });
      }
    } else if (event.type === 'agent/inbox/reordered') {
      const orderedIds = new Set(event.data.orderedItemIds);
      const ordered = event.data.orderedItemIds
        .map((itemId) => items.get(itemId))
        .filter((item): item is AiInboxItem => item !== undefined);
      const remaining = [...items.values()].filter(
        (item) => item.lane === event.data.lane && !orderedIds.has(item.id),
      );
      const other = [...items.values()].filter((item) => item.lane !== event.data.lane);
      items.clear();
      for (const item of [...other, ...ordered, ...remaining]) items.set(item.id, item);
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
  const activeTurn = nodes.find(candidate => candidate.kind === 'turnProcess'
    && !candidate.hasEndBoundary && (candidate.status === 'running' || candidate.status === 'partial'));
  const node = activeTurn?.kind === 'turnProcess'
    ? activeTurn.children.find(candidate => candidate.kind === 'approvalMarker' && candidate.status === 'requested')
    : undefined;
  if (node?.kind !== 'approvalMarker' || node.turnId === null || node.stepId === null) return null;
  const tool = findConversationTool(nodes, node);
  const args = tool?.nativeName === 'exec_command' && tool.input && typeof tool.input === 'object'
    && !Array.isArray(tool.input) ? tool.input as Record<string, unknown> : null;
  const boundDirect = args?.channel === 'direct' && args.elevated !== true
    && typeof args.connectionPolicyBinding === 'string' && /^[a-f0-9]{64}$/u.test(args.connectionPolicyBinding);
  let commandSandbox: AiPendingApproval['commandSandbox'];
  if (boundDirect && tool?.target?.kind === 'local'
    && (args.sandboxExecutor === 'nonoMacAcceptance'
      || (args.sandboxExecutor === 'windowsAppContainer' && tool.target.windowsSandboxRequired === true))) {
    commandSandbox = 'local';
  } else if (boundDirect && args.sandboxExecutor === 'bubblewrapV1' && tool?.target?.kind === 'remote') {
    commandSandbox = 'remote';
  }
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
    ...(commandSandbox && { commandSandbox }),
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

function settleUnsavedOutput(node: AiConversationNode): AiConversationNode {
  if (node.kind === 'turnProcess' && node.status === 'running') {
    return { ...node, status: 'failed', children: node.children.map(settleProcessOutput) };
  }
  return settleProcessOutput(node);
}

function settleProcessOutput<Node extends AiConversationNode>(node: Node): Node {
  if ((node.kind === 'assistantMessage' && node.state === 'streaming')
    || (node.kind === 'reasoning' && (node.state === 'streaming' || node.state === 'settled'))) {
    return { ...node, state: 'interrupted' };
  }
  return node;
}

export function agentSessionView(state: AgentSessionStreamState, projected?: {
  readonly activity: ReturnType<typeof projectAgentActivity>;
  readonly nodes: readonly AiConversationNode[];
  readonly metadataEvents: readonly AgentSessionEvent[];
}): AiSessionView {
  if (!state.snapshot) throw new Error('Agent Session snapshot is unavailable');
  const events = projected?.metadataEvents ?? state.events;
  const activity = projected?.activity ?? projectAgentActivity(state.events);
  const committedNodes = projected?.nodes ?? projectAgentChatNodes(state.events);
  const storageFault = state.storageFaultAtSeq !== undefined && !state.hasTerminalEvent;
  const status = storageFault ? 'failed' : activity.status;
  const nodes = storageFault ? committedNodes.map(settleUnsavedOutput) : committedNodes;
  const header = { ...state.snapshot.header };
  let recovery: import('@/types/agent-session').AgentSessionRecoveryState = state.snapshot.recovery;
  for (const event of events) {
    if (event.type === 'task/state' && event.data.recovery) recovery = event.data.recovery;
    if (event.type === 'session/model_selected') header.modelSelection = event.data.provider;
    if (event.type === 'session/permission_changed') header.permissionMode = event.data.mode;
    if (event.type === 'session/execution_surface_changed') header.executionSurface = event.data.surface;
    if (event.type === 'session/terminal_reconnected') {
      header.target = event.data.target;
      header.permissionMode = 'requestApproval';
      recovery = { status: 'none' };
    }
  }
  const task = activity.plan === undefined
    ? state.snapshot.task
    : activity.plan === null
      ? (({ plan: _plan, ...rest }) => rest)(state.snapshot.task)
      : { ...state.snapshot.task, plan: activity.plan };
  return {
    summary: sessionSummary({ ...state.snapshot, header }, state.events, status, events),
    snapshot: {
      kind: 'agent',
      value: {
        ...state.snapshot,
        status: activity.status,
        ended: [...events].reverse().find(event => event.type === 'session/ended' || event.type === 'session/resumed'
          || event.type === 'subagent/recovery_started')?.type === 'session/ended',
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
    pendingApproval: storageFault || state.snapshot.archived || status === 'completed'
      || status === 'failed' || status === 'cancelled' ? null : pendingApproval(nodes),
    pendingQuestion: storageFault || state.snapshot.archived || status === 'completed'
      || status === 'failed' || status === 'cancelled'
      ? null
      : projectQuestions(events).find((q) => q.status === 'pending') ?? null,
    status,
    statusReason: storageFault ? 'journalWriteFailed' : activity.statusReason,
    recovery,
    error: storageFault ? { kind: 'terminal', message: 'journalWriteFailed', retryable: false }
      : status === 'failed' || status === 'cancelled' ? terminalError(nodes) : null,
    syncError: state.syncError ? normalizeAiSessionError(state.syncError) : undefined,
    syncRecovery: state.syncRecovery,
    storageFaultAtSeq: storageFault ? state.storageFaultAtSeq : undefined,
    throughSeq: state.lastCommittedSeq ?? null,
    revision: state.lastCommittedSeq === undefined ? state.snapshot.eventCount : state.lastCommittedSeq + 1,
    committedOperationIds: events.flatMap((event) => {
      switch (event.type) {
        case 'subagent/recovery_started':
          return [event.data.recoveryId];
        case 'agent/inbox/spliced':
          return event.data.operation === 'enqueued'
            ? event.data.messages.flatMap(message => message.clientSubmissionId ? [message.clientSubmissionId] : []) : [];
        case 'question/answered':
        case 'question/action_answered':
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
    contextUsage: projectContextUsage(events),
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
      && previous.storageFaultAtSeq === state.storageFaultAtSeq
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
    const idle = [...entries].filter(([, entry]) => !entry.listeners.size && !entry.leases && !entry.connecting
      && !entry.pendingSettings);
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
    const projectCommitted = createAgentSessionViewProjector();
    const entry: AgentAdapterEntry = {
      projectCommitted,
      project: (state) => withPendingSessionSettings(projectCommitted(state), entry.pendingSettings),
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
    entry.connecting ??= entry.client.connect().catch((error) => {
      if (error instanceof Error && error.name === 'AbortError' && entries.get(sessionId) === entry) {
        return entry.client.connect();
      }
      throw error;
    }).then((state) => {
      const view = entry.project(state);
      entry.view = view;
      return view;
    }).finally(() => {
      entry.connecting = undefined;
      trim();
    });
    return entry.connecting;
  };

  const reopenEndedSession = async (
    sessionId: string,
    current?: AiSessionView,
    signal?: AbortSignal,
  ): Promise<AiSessionView> => {
    const view = current ?? await openEntry(sessionId);
    signal?.throwIfAborted();
    if (!view.snapshot.value.ended
      && !['cancelled', 'failed', 'completed'].includes(view.status)) return view;
    await (dependencies.resume ?? invokeResumeAgentRuntime)({ sessionId });
    signal?.throwIfAborted();
    const entry = ensureEntry(sessionId);
    const state = await entry.client.reconnect();
    signal?.throwIfAborted();
    const resumed = entry.project(state);
    entry.view = resumed;
    for (const listener of entry.listeners) listener(resumed);
    return resumed;
  };

  const publish = (entry: AgentAdapterEntry, view: AiSessionView): AiSessionView => {
    entry.view = view;
    for (const listener of entry.listeners) listener(view);
    return view;
  };

  /** Apply deferred settings to a live Session before it admits new input.
   * Permission goes first so the next turn never runs under the old mode. Each
   * applied value leaves the pending set immediately, so a failure keeps only
   * what still needs to be applied and aborts the caller. */
  const applyPendingSettings = async (
    sessionId: string,
    view: AiSessionView,
    signal?: AbortSignal,
  ): Promise<AiSessionView> => {
    const entry = ensureEntry(sessionId);
    if (!entry.pendingSettings) return view;
    const without = (key: keyof PendingSessionSettings): void => {
      const next: PendingSessionSettings = { ...entry.pendingSettings, [key]: undefined };
      entry.pendingSettings = next.model || next.permissionMode || next.executionSurface ? next : undefined;
    };
    const { permissionMode, executionSurface, model } = entry.pendingSettings;
    if (permissionMode) {
      await (dependencies.setPermission ?? invokeSetAgentRuntimePermission)({ sessionId, mode: permissionMode });
      without('permissionMode');
      signal?.throwIfAborted();
    }
    if (executionSurface) {
      await (dependencies.setExecutionSurface ?? invokeSetAgentRuntimeExecutionSurface)({ sessionId, surface: executionSurface });
      without('executionSurface');
      signal?.throwIfAborted();
    }
    if (model) {
      await (dependencies.selectModel ?? invokeSelectAgentRuntimeModel)({ sessionId, selection: {
        routeId: model.routeId, modelId: model.modelId, reasoningEffort: model.reasoningEffort } });
      without('model');
      signal?.throwIfAborted();
    }
    const state = await entry.client.reconnect();
    signal?.throwIfAborted();
    return publish(entry, entry.project(state));
  };

  const resumeEndedSession = async (
    sessionId: string,
    current?: AiSessionView,
    signal?: AbortSignal,
  ): Promise<AiSessionView> => applyPendingSettings(
    sessionId,
    await reopenEndedSession(sessionId, current, signal),
    signal,
  );

  /** Record a setting for an ended Session instead of reopening it. */
  const recordDeferredSetting = (sessionId: string, patch: PendingSessionSettings): void => {
    const entry = ensureEntry(sessionId);
    const committed = entry.projectCommitted(entry.client.state());
    entry.pendingSettings = normalizePendingSettings(committed.snapshot.value.header,
      { ...entry.pendingSettings, ...patch });
    publish(entry, entry.project(entry.client.state()));
  };

  const waitForCommittedOperation = async (
    sessionId: string,
    clientOperationId: string,
    command: (view: AiSessionView, signal: AbortSignal) => Promise<unknown>,
    options: { readonly confirmed?: (view: AiSessionView) => boolean; readonly question?: AnswerQuestionInput } = {},
  ): Promise<void> => {
    const entry = ensureEntry(sessionId);
    const question = options.question;
    const confirmationError = (error: unknown): Error => question
      ? new QuestionSubmissionError(questionSubmissionIssue(error, 'confirm'))
      : error instanceof Error ? error : new Error(String(error));
    const timedOut = () => confirmationError(new Error('Committed Agent Runtime operation confirmation timed out'));
    const confirmed = options.confirmed ?? ((view: AiSessionView) => view.committedOperationIds?.includes(clientOperationId) === true);
    let canConfirm = !options.confirmed;
    let hasReceipt = false;
    let acknowledge!: () => void;
    const committed = new Promise<void>(resolve => { acknowledge = resolve; });
    const listener: AiSessionListener = next => {
      if (canConfirm && confirmed(next)) {
        hasReceipt = true;
        acknowledge();
      }
    };
    entry.listeners.add(listener);
    try {
      await withOperationDeadline(18_000, timedOut, async (signal) => {
        const view = entry.view ?? await Promise.race([openEntry(sessionId), committed.then(() => undefined)]);
        signal.throwIfAborted();
        if (!view || hasReceipt || (canConfirm && confirmed(view))) return;
        // Let a live receipt settle the operation independently of the command
        // reply or a backfill that is already in flight.
        await awaitMutationAcknowledgement(() => {
          signal.throwIfAborted();
          if (hasReceipt) return Promise.resolve();
          const request = command(view, signal);
          canConfirm = true;
          if (entry.view) listener(entry.view);
          return request;
        }, committed, async trigger => {
          signal.throwIfAborted();
          if (entry.view && confirmed(entry.view)) return;
          const failure = trigger.kind === 'error' ? trigger.error : undefined;
          let state: AgentSessionStreamState;
          try { state = await entry.client.reconnect(); }
          catch (error) {
            if (!question && trigger.kind === 'error') throw failure;
            throw confirmationError(error);
          }
          signal.throwIfAborted();
          const refreshed = entry.project(state);
          entry.view = refreshed;
          for (const subscribed of entry.listeners) subscribed(refreshed);
          if (confirmed(refreshed)) return;
          if (question) {
            const issue = reconcileQuestionSubmission(question, refreshed, trigger.kind === 'error'
              ? questionSubmissionIssue(failure)
              : questionSubmissionIssue('Committed question answer is not visible yet', 'confirm'));
            if (issue) throw new QuestionSubmissionError(issue);
            return;
          }
          if (trigger.kind === 'error') throw failure;
          throw timedOut();
        }, { backfillAfterMs: 15_000, backfillOnSuccess: Boolean(question), signal });
      });
    } finally {
      entry.listeners.delete(listener);
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
    let resolveObserved!: (paused: boolean) => void;
    const observed = new Promise<boolean>(resolve => { resolveObserved = resolve; });
    const listener: AiSessionListener = view => {
      if (view.committedOperationIds?.includes(input.clientOperationId)) {
        resolveObserved(view.status === 'failed' || view.inbox.some(item => item.clientSubmissionId === input.clientOperationId && item.paused));
      }
    };
    entry.listeners.add(listener);
    try {
      return await awaitInboxAdmission(async () => isPaused(await command()), observed, async signal => {
        let refreshed: AgentSessionStreamState;
        try { refreshed = await entry.client.reconnect(); }
        catch { return { kind: 'unavailable' }; }
        signal.throwIfAborted();
        entry.view = entry.project(refreshed);
        for (const subscribed of entry.listeners) subscribed(entry.view);
        return confirmed(refreshed.events) ? { kind: 'found', paused: isPaused(refreshed.snapshot) } : { kind: 'missing' };
      });
    } finally {
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
      await waitForCommittedOperation(input.identity.sessionId, input.clientOperationId,
        () => dependencies.answerQuestion(input), { question: input });
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
      // Reconnecting a terminal resets permissionMode to requestApproval on the backend;
      // drop any deferred permission change so it cannot override that security reset.
      if (entry.pendingSettings?.permissionMode) {
        const next: PendingSessionSettings = { ...entry.pendingSettings, permissionMode: undefined };
        entry.pendingSettings = next.model || next.executionSurface ? next : undefined;
      }
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
      const selection = { routeId: provider.id, modelId: provider.model, reasoningEffort: provider.reasoningEffort };
      const view = await openEntry(sessionId);
      if (defersSettings(view)) {
        const value = view.snapshot.value;
        const retainedImages = value.surface.messages.some(m => m.role === 'userImages')
          || value.inbox.nextTurn.some(m => (m.images?.length ?? 0) > 0)
          || value.inbox.nextStep.some(m => (m.images?.length ?? 0) > 0);
        if (retainedImages) requireVision(provider);
        recordDeferredSetting(sessionId, { model: selection });
        return;
      }
      await resumeEndedSession(sessionId, view);
      await (dependencies.selectModel ?? invokeSelectAgentRuntimeModel)({ sessionId, selection });
      const entry = ensureEntry(sessionId);
      entry.view = entry.project(await entry.client.reconnect());
      for (const listener of entry.listeners) listener(entry.view);
    },
    async setPermission(sessionId, mode) {
      const view = await openEntry(sessionId);
      if (defersSettings(view)) {
        recordDeferredSetting(sessionId, { permissionMode: mode });
        return;
      }
      await resumeEndedSession(sessionId, view);
      await (dependencies.setPermission ?? invokeSetAgentRuntimePermission)({ sessionId, mode });
      const entry = ensureEntry(sessionId);
      entry.view = entry.project(await entry.client.reconnect());
      for (const listener of entry.listeners) listener(entry.view);
    },
    async setExecutionSurface(sessionId, surface) {
      const view = await openEntry(sessionId);
      if (defersSettings(view)) {
        if (view.snapshot.value.header.target?.windowsSandboxRequired === true && surface !== 'direct') {
          throw new Error('WINDOWS_SANDBOX_DIRECT_REQUIRED');
        }
        recordDeferredSetting(sessionId, { executionSurface: surface });
        return;
      }
      await resumeEndedSession(sessionId, view);
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
        if (!committed && childBudgetExhausted(view.snapshot.value)) {
          throw new Error('subagentBudgetExhausted: cumulative child budget is exhausted');
        }
        await admit(resolvedSessionId, input, () => dependencies.sendChildInput({
          parentSessionId,
          childSessionId: resolvedSessionId,
          content,
          clientSubmissionId: input.clientOperationId,
        }));
        return {
          sessionId: resolvedSessionId,
          clientOperationId: input.clientOperationId,
          mode: 'nextTurn',
        };
      }
      const deferredModel = entries.get(resolvedSessionId)?.pendingSettings?.model;
      const paused = input.paused || (input.queued && view.status === 'failed');
      if (!paused || hasImages) view = await resumeEndedSession(resolvedSessionId, view);
      // An idle restored Session needs an owning runtime before its next input. start is idempotent.
      // A text follow-up still sends retained image bytes. Reattach after process restart
      // and apply the same vision preflight before accepting more Inbox content.
      const retainedImages = view.snapshot.value.surface.messages.some(m => m.role === 'userImages');
      if (retainedImages) requireVision(input.provider);
      if (hasImages || (!paused && (input.mode === 'start' || view.status === 'idle' || retainedImages))) {
        const selection = deferredModel
          ? { routeId: deferredModel.routeId, modelId: deferredModel.modelId, reasoningEffort: deferredModel.reasoningEffort }
          : { routeId: input.provider.id, modelId: input.provider.model, reasoningEffort: input.provider.reasoningEffort };
        await dependencies.start({ sessionId: resolvedSessionId, selection });
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
      const { sessionId, expectedRevision, clientOperationId, ...mutation } = input;
      await waitForCommittedOperation(sessionId, clientOperationId, async (current, signal) => {
        let revision = expectedRevision;
        if (mutation.type === 'resume') {
          const view = await resumeEndedSession(sessionId, current, signal);
          const selection = view.snapshot.value.header.modelSelection;
          if (!selection) throw new Error('Select a model before resuming queued input');
          await dependencies.start({ sessionId, selection });
          signal.throwIfAborted();
          revision = ensureEntry(sessionId).view?.revision ?? expectedRevision;
        }
        return dependencies.mutateInbox({ sessionId, expectedRevision: revision, clientOperationId, mutation });
      });
    },
    async rename(input: AiSessionRenameInput): Promise<void> {
      await waitForCommittedOperation(input.sessionId, input.clientOperationId, () => (
        dependencies.rename(input)
      ));
    },
    async refresh(sessionId: string): Promise<AiSessionView> {
      const entry = ensureEntry(sessionId);
      return withOperationDeadline(18_000, () => new Error('Agent Runtime refresh timed out'), async signal => {
        const state = await entry.client.reconnect();
        signal.throwIfAborted();
        const view = entry.project(state);
        entry.view = view;
        for (const listener of entry.listeners) listener(view);
        return view;
      });
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
      let before = await openEntry(sessionId);
      // A model switched after the failure must govern the retry itself.
      if (entries.get(sessionId)?.pendingSettings) before = await resumeEndedSession(sessionId, before);
      const id = `${before.snapshot.value.header.subagent ? 'child' : 'model'}-retry-${turnId}`;
      await waitForCommittedOperation(sessionId, id, () => (dependencies.retryModel ?? invokeRetryAgentModel)({ sessionId, turnId }), {
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
    approve: protect(adapter.approve, input => input.sessionId),
    reject: protect(adapter.reject, input => input.sessionId),
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
