import { skillContexts } from './skill-projection';
import { projectQuestions } from './question-projection';
import { questionKey } from '@/types/agent-question';
import {
  agentEventTimestamp,
  agentToolEventKey,
  validateCommittedAgentEventWindow,
} from '@/lib/ai/agent-session-event-window';
import type {
  AgentSessionAssistantContentBlock,
  AgentSessionEvent,
  AgentSessionRuntimeStatus,
  AgentSessionStopReason,
  AgentSessionTokenUsage,
  AgentSessionToolStatus,
} from '@/types/agent-session';
import type {
  AiApprovalMarkerNode,
  AiArtifactNode,
  AiAssistantMessageNode,
  AiContextInjectionNode,
  AiConversationNode,
  AiDurableSessionStats,
  AiDurableTurnStats,
  AiErrorNode,
  AiReasoningNode,
  AiRetryNode,
  AiSystemPromptNode,
  AiToolNode,
  AiTurnProcessChildNode,
  AiTurnProcessNode,
  AiTurnProcessStatus,
  AiTurnTailNode,
  AiUserMessageNode,
} from './conversation-node';

type RuntimeEventLike = Readonly<{
  type: string;
  sessionId: string;
  seq: number;
  timeUnixMs: number;
  turnId?: string;
  stepId?: string;
}>;

interface RequestFacts {
  readonly requestId: string;
  readonly providerId: string;
  readonly model: string;
  readonly turnId: string | null;
  readonly stepId: string | null;
  readonly startedAt: number;
  firstResponseAt?: number;
  completedAt?: number;
  usage?: AgentSessionTokenUsage;
  stopReason?: AgentSessionStopReason;
}

interface TurnState {
  readonly id: string;
  readonly sessionId: string;
  readonly firstSeq: number;
  readonly timestamp: string;
  readonly steps: Set<string>;
  readonly requestIds: string[];
  readonly children: Map<string, AiTurnProcessChildNode>;
  readonly assistants: Map<string, AiAssistantMessageNode>;
  lastSeq: number;
  startSeq?: number;
  startedAt?: number;
  endSeq?: number;
  endTimestamp?: string;
  endReason?: string;
  status?: Exclude<AiTurnProcessStatus, 'running' | 'partial'>;
}

const PROCESS_CHILD_ORDER = {
  contextInjection: 0,
  reasoning: 1,
  assistantMessage: 2,
  retry: 3,
  tool: 4,
  approvalMarker: 5,
  error: 6,
} satisfies Record<AiTurnProcessChildNode['kind'], number>;

function eventTurnId(event: RuntimeEventLike): string | null {
  return event.turnId ?? null;
}

function eventStepId(event: RuntimeEventLike): string | null {
  return event.stepId ?? null;
}

function terminalStatusFromReason(
  reason: string,
): Exclude<AiTurnProcessStatus, 'running' | 'partial'> {
  if (/waiting/i.test(reason)) return 'waiting';
  if (/cancel|stop|interrupt/i.test(reason)) return 'cancelled';
  if (/fail|error|limit|max.?token/i.test(reason)) return 'failed';
  return 'completed';
}

function errorState(
  status: AgentSessionRuntimeStatus | Exclude<AiTurnProcessStatus, 'running' | 'partial'>,
): AiErrorNode['state'] {
  if (status === 'failed') return 'failed';
  if (status === 'cancelled') return 'cancelled';
  return 'unknown';
}

function toolState(status: AgentSessionToolStatus): AiToolNode['state'] {
  switch (status) {
    case 'pending': return 'preparing';
    case 'awaitingApproval': return 'approval';
    case 'running': return 'running';
    case 'completed': return 'succeeded';
    case 'rejected': return 'rejected';
    case 'failed':
    case 'timedOut':
    case 'cancelled':
      return 'failed';
  }
}

function approvalToolState(
  status: Extract<AgentSessionEvent, { type: 'tool/approval' }>['data']['status'],
): AiToolNode['state'] {
  switch (status) {
    case 'requested': return 'approval';
    case 'approved': return 'running';
    case 'rejected': return 'rejected';
    case 'expired':
    case 'cancelled':
      return 'failed';
  }
}

function toolSummary(argumentsValue: unknown): string {
  if (!argumentsValue || typeof argumentsValue !== 'object') return '';
  const record = argumentsValue as Record<string, unknown>;
  const summary = record.explanation ?? record.summary ?? record.intent;
  return typeof summary === 'string' ? summary : '';
}

function textContent(blocks: readonly AgentSessionAssistantContentBlock[]): string {
  return blocks.flatMap((block) => block.type === 'text' ? [block.text] : []).join('');
}

function reasoningContent(blocks: readonly AgentSessionAssistantContentBlock[]): string {
  return blocks.flatMap((block) => block.type === 'reasoning' ? [block.text] : []).join('');
}

function hasToolCall(blocks: readonly AgentSessionAssistantContentBlock[]): boolean {
  return blocks.some((block) => block.type === 'toolCall');
}

function usageField(
  requests: readonly RequestFacts[],
  field: keyof AgentSessionTokenUsage,
): number | null {
  if (requests.length === 0) return null;
  const reported = requests.map((request) => request.usage?.[field]);
  if (reported.some((value) => value === undefined)) return null;
  return reported.reduce<number>((sum, value) => sum + (value as number), 0);
}

function hasReportedUsage(usage: AgentSessionTokenUsage | undefined): boolean {
  return usage !== undefined && Object.values(usage).some((value) => value !== undefined);
}

function aggregateUsage(stats: AiDurableTurnStats): AgentSessionTokenUsage | null {
  const usage = {
    ...(stats.uncachedInputTokens === null ? {} : { uncachedInputTokens: stats.uncachedInputTokens }),
    ...(stats.cacheReadTokens === null ? {} : { cacheReadTokens: stats.cacheReadTokens }),
    ...(stats.cacheWriteTokens === null ? {} : { cacheWriteTokens: stats.cacheWriteTokens }),
    ...(stats.outputTokens === null ? {} : { outputTokens: stats.outputTokens }),
    ...(stats.reasoningTokens === null ? {} : { reasoningTokens: stats.reasoningTokens }),
    ...(stats.totalTokens === null ? {} : { totalTokens: stats.totalTokens }),
  };
  return Object.keys(usage).length === 0 ? null : usage;
}

function sumComplete(
  stats: readonly AiDurableTurnStats[],
  field: 'uncachedInputTokens' | 'cacheReadTokens' | 'cacheWriteTokens'
    | 'outputTokens' | 'reasoningTokens' | 'totalTokens',
): number | null {
  if (stats.length === 0 || stats.some((value) => value[field] === null)) return null;
  return stats.reduce((sum, value) => sum + (value[field] ?? 0), 0);
}

/** Aggregate the same durable facts used by each Turn tail into a session-wide reading. */
export function aggregateDurableSessionStats(
  turns: readonly AiDurableTurnStats[],
  historyComplete = true,
): AiDurableSessionStats {
  const timeToFirstTokenCount = turns.reduce(
    (sum, value) => sum + value.timeToFirstTokenCount,
    0,
  );
  const timeToFirstTokenMs = timeToFirstTokenCount === 0
    ? null
    : turns.reduce((sum, value) => sum + (value.timeToFirstTokenMs ?? 0), 0);
  const decodePairs = turns.filter((value) => (
    value.decodeDurationMs !== null && value.decodeTokens !== null
  ));
  const decodeDurationMs = decodePairs.length === 0
    ? null
    : decodePairs.reduce((sum, value) => sum + (value.decodeDurationMs ?? 0), 0);
  const decodeTokens = decodePairs.length === 0
    ? null
    : decodePairs.reduce((sum, value) => sum + (value.decodeTokens ?? 0), 0);
  const requestCount = turns.reduce((sum, value) => sum + value.requestCount, 0);
  const toolCount = turns.reduce((sum, value) => sum + value.toolCount, 0);
  const modelDurationMs = requestCount === 0
    || turns.some((value) => value.requestCount > 0 && value.modelDurationMs === null)
    ? null
    : turns.reduce((sum, value) => sum + (value.modelDurationMs ?? 0), 0);
  const toolDurationMs = toolCount === 0
    || turns.some((value) => value.toolCount > 0 && value.toolDurationMs === null)
    ? null
    : turns.reduce((sum, value) => sum + (value.toolDurationMs ?? 0), 0);
  return {
    historyComplete,
    turnCount: turns.length,
    stepCount: turns.reduce((sum, value) => sum + value.stepCount, 0),
    requestCount,
    toolCount,
    modelDurationMs,
    toolDurationMs,
    timeToFirstTokenMs,
    timeToFirstTokenCount,
    averageTimeToFirstTokenMs: timeToFirstTokenMs === null
      ? null
      : Math.round(timeToFirstTokenMs / timeToFirstTokenCount),
    decodeDurationMs,
    decodeTokens,
    uncachedInputTokens: sumComplete(turns, 'uncachedInputTokens'),
    cacheReadTokens: sumComplete(turns, 'cacheReadTokens'),
    cacheWriteTokens: sumComplete(turns, 'cacheWriteTokens'),
    outputTokens: sumComplete(turns, 'outputTokens'),
    reasoningTokens: sumComplete(turns, 'reasoningTokens'),
    totalTokens: sumComplete(turns, 'totalTokens'),
    tokensPerSecond: decodeTokens !== null && decodeDurationMs !== null && decodeDurationMs > 0
      ? decodeTokens / (decodeDurationMs / 1_000)
      : null,
    usageComplete: turns.length > 0 && turns.every((value) => value.usageComplete),
  };
}

function processChildSort(
  left: AiTurnProcessChildNode,
  right: AiTurnProcessChildNode,
): number {
  return left.firstSeq - right.firstSeq
    || PROCESS_CHILD_ORDER[left.kind] - PROCESS_CHILD_ORDER[right.kind]
    || left.key.localeCompare(right.key);
}

function topLevelSort(left: AiConversationNode, right: AiConversationNode): number {
  return left.firstSeq - right.firstSeq || left.key.localeCompare(right.key);
}

/**
 * Project one committed Event v5 window into chat-readable nodes only.
 * Lifecycle and request diagnostics are projected independently by Activity.
 */
export function projectAgentChatNodes(
  events: readonly AgentSessionEvent[],
): readonly AiConversationNode[] {
  validateCommittedAgentEventWindow(events);
  if (events.length === 0) return [];

  const turns = new Map<string, TurnState>();
  const userMessages = new Map<string, AiUserMessageNode>();
  const systemPrompts = new Map<string, AiSystemPromptNode>();
  let latestPromptKey: string | undefined;
  let previousPromptContent: string | undefined;
  const artifacts = new Map<string, AiArtifactNode>();
  const requests = new Map<string, RequestFacts>();
  const activeRequestByStep = new Map<string, string>();
  const tools = new Map<string, AiToolNode>();
  const unscopedNodes = new Map<string, AiConversationNode>();
  let latestTurnId: string | null = null;

  const ensureTurn = (event: RuntimeEventLike, explicitTurnId = event.turnId): TurnState | null => {
    const id = explicitTurnId ?? null;
    if (id === null) return null;
    latestTurnId = id;
    const existing = turns.get(id);
    if (existing) {
      existing.lastSeq = Math.max(existing.lastSeq, event.seq);
      if (event.stepId) existing.steps.add(event.stepId);
      return existing;
    }
    const turn: TurnState = {
      id,
      sessionId: event.sessionId,
      firstSeq: event.seq,
      lastSeq: event.seq,
      timestamp: agentEventTimestamp(event.timeUnixMs),
      steps: new Set(event.stepId ? [event.stepId] : []),
      requestIds: [],
      children: new Map(),
      assistants: new Map(),
    };
    turns.set(id, turn);
    return turn;
  };

  const putProcessChild = (
    turnId: string | null,
    node: AiTurnProcessChildNode,
  ): void => {
    if (turnId === null) {
      unscopedNodes.set(node.key, node);
      return;
    }
    const turn = turns.get(turnId);
    if (turn) turn.children.set(node.key, node);
  };

  const putAssistant = (turnId: string | null, node: AiAssistantMessageNode): void => {
    if (turnId === null) {
      unscopedNodes.set(node.key, node);
      return;
    }
    turns.get(turnId)?.assistants.set(node.key, node);
  };

  const updateRequestUsage = (
    requestId: string,
    usage: AgentSessionTokenUsage,
    stopReason?: AgentSessionStopReason,
    completedAt?: number,
  ): void => {
    const request = requests.get(requestId);
    if (!request) return;
    request.usage = usage;
    if (stopReason !== undefined) request.stopReason = stopReason;
    if (completedAt !== undefined) request.completedAt = completedAt;
  };

  const upsertReasoning = (
    event: RuntimeEventLike,
    content: string,
    state: AiReasoningNode['state'],
    replace: boolean,
  ): void => {
    if (!content) return;
    const turn = ensureTurn(event);
    const turnId = eventTurnId(event);
    const identity = event.stepId ?? 'unscoped-step';
    const key = `reasoning:${turnId ?? 'unscoped'}:${identity}`;
    const previous = turn?.children.get(key) ?? unscopedNodes.get(key);
    const previousReasoning = previous?.kind === 'reasoning' ? previous : undefined;
    const nextContent = replace ? content : `${previousReasoning?.content ?? ''}${content}`;
    const node: AiReasoningNode = {
      kind: 'reasoning',
      key,
      sourceKind: 'agent',
      sessionId: event.sessionId,
      turnId,
      stepId: eventStepId(event),
      firstSeq: previousReasoning?.firstSeq ?? event.seq,
      lastSeq: event.seq,
      timestamp: previousReasoning?.timestamp ?? agentEventTimestamp(event.timeUnixMs),
      requestId: event.stepId ? activeRequestByStep.get(event.stepId) ?? null : null,
      summary: nextContent.trim().split('\n')[0] ?? '',
      content: nextContent,
      state,
    };
    putProcessChild(turnId, node);
  };

  const upsertAssistantText = (
    event: RuntimeEventLike,
    requestId: string | null,
    text: string,
    state: AiAssistantMessageNode['state'],
    blocks?: readonly AgentSessionAssistantContentBlock[],
    messageId?: string,
  ): void => {
    const turn = ensureTurn(event);
    const turnId = eventTurnId(event);
    const identity = event.stepId ?? requestId ?? messageId ?? 'unscoped-step';
    let key = `assistant:${turnId ?? 'unscoped'}:${identity}`;
    let previous = turn?.assistants.get(key) ?? unscopedNodes.get(key);
    let previousAssistant = previous?.kind === 'assistantMessage' ? previous : undefined;
    if (blocks !== undefined
      && previousAssistant !== undefined
      && previousAssistant.state !== 'streaming'
      && messageId !== undefined
      && previousAssistant.messageId !== messageId) {
      key = `assistant:${turnId ?? 'unscoped'}:${messageId}`;
      previous = turn?.assistants.get(key) ?? unscopedNodes.get(key);
      previousAssistant = previous?.kind === 'assistantMessage' ? previous : undefined;
    }
    const content = blocks === undefined
      ? `${previousAssistant ? textContent(previousAssistant.blocks) : ''}${text}`
      : text;
    const node: AiAssistantMessageNode = {
      kind: 'assistantMessage',
      key,
      sourceKind: 'agent',
      sessionId: event.sessionId,
      turnId,
      stepId: eventStepId(event),
      firstSeq: previousAssistant?.firstSeq ?? event.seq,
      lastSeq: event.seq,
      timestamp: previousAssistant?.timestamp ?? agentEventTimestamp(event.timeUnixMs),
      messageId: messageId ?? previousAssistant?.messageId ?? identity,
      requestId: requestId ?? previousAssistant?.requestId ?? null,
      blocks: blocks ?? [{ type: 'text', text: content }],
      state,
    };
    putAssistant(turnId, node);
  };

  const upsertTurnError = (
    event: RuntimeEventLike,
    status: AgentSessionRuntimeStatus | Exclude<AiTurnProcessStatus, 'running' | 'partial'>,
    message: string,
    scope: AiErrorNode['scope'],
  ): void => {
    const resolvedTurnId = event.turnId ?? latestTurnId;
    if (resolvedTurnId === null) return;
    const turn = ensureTurn(event, resolvedTurnId);
    if (!turn) return;
    const key = `error:turn:${resolvedTurnId}`;
    const previous = turn.children.get(key);
    const previousError = previous?.kind === 'error' ? previous : undefined;
    putProcessChild(resolvedTurnId, {
      kind: 'error',
      key,
      sourceKind: 'agent',
      sessionId: event.sessionId,
      turnId: resolvedTurnId,
      stepId: eventStepId(event),
      firstSeq: previousError?.firstSeq ?? event.seq,
      lastSeq: event.seq,
      timestamp: previousError?.timestamp ?? agentEventTimestamp(event.timeUnixMs),
      scope,
      message,
      code: null,
      state: errorState(status),
    });
  };

  const updateTool = (
    event: RuntimeEventLike,
    callId: string,
    update: (node: AiToolNode) => AiToolNode,
  ): void => {
    const identity = agentToolEventKey(event, callId);
    const previous = tools.get(identity);
    if (!previous) return;
    const next = { ...update(previous), lastSeq: event.seq };
    tools.set(identity, next);
    putProcessChild(previous.turnId, next);
  };

  const settleStreamingOutput = (
    event: RuntimeEventLike,
    status: Exclude<AiTurnProcessStatus, 'running' | 'partial'>,
    scope: 'step' | 'turn' | 'session',
  ): void => {
    const currentTurn = event.turnId ? turns.get(event.turnId) : undefined;
    const scopedTurns = scope === 'session' ? turns.values() : currentTurn ? [currentTurn] : [];
    const nodeMaps: Map<string, AiConversationNode>[] = [unscopedNodes];
    for (const turn of scopedTurns) {
      nodeMaps.push(turn.children, turn.assistants);
      if (scope === 'session' && turn.endSeq === undefined) {
        turn.status = status;
        turn.lastSeq = event.seq;
      }
    }
    for (const nodes of nodeMaps) {
      for (const [key, node] of nodes) {
        if ((node.kind !== 'reasoning' && node.kind !== 'assistantMessage')
          || node.state !== 'streaming'
          || (scope !== 'session' && node.turnId !== eventTurnId(event))
          || (scope === 'step' && node.stepId !== eventStepId(event))) continue;
        // Runtime failures can end a scope without committing an assistant/message.
        // Keep the partial content, but never leave it streaming or imply it completed.
        nodes.set(key, node.kind === 'reasoning'
          ? { ...node, lastSeq: event.seq, state: 'interrupted' }
          : {
            ...node,
            lastSeq: event.seq,
            state: status === 'failed' || status === 'cancelled' ? status : 'interrupted',
          });
      }
    }
  };

  for (const event of events) {
    if (event.turnId) ensureTurn(event);
    switch (event.type) {
      case 'session/created':
      case 'agent/created':
      case 'agent/inbox/reordered':
      case 'agent/inbox/item_steered':
      case 'session/model_selected':
      case 'session/permission_changed':
      case 'session/renamed':
      case 'request/context':
      case 'compaction/start':
      case 'compaction/summary':
      case 'compaction/end':
      case 'subagent/descriptor':
      case 'subagent/message':
      case 'subagent/settled':
      case 'subagent/detached':
      case 'task/linked':
      case 'task/plan':
      case 'task/state':
      case 'task/evidence':
        break;
      case 'agent/status':
        if (event.data.status === 'completed' || event.data.status === 'failed'
          || event.data.status === 'cancelled') {
          settleStreamingOutput(event, event.data.status, 'session');
        }
        if (event.data.status === 'failed' || event.data.status === 'cancelled') {
          upsertTurnError(event, event.data.status, event.data.reason ?? event.data.status, 'session');
        }
        break;
      case 'session/ended':
        settleStreamingOutput(event, event.data.status, 'session');
        if (event.data.status !== 'completed') {
          upsertTurnError(event, event.data.status, event.data.reason ?? event.data.status, 'session');
        }
        break;
      case 'agent/inbox/spliced':
        for (const message of event.data.messages) {
          if (message.source.kind !== 'user') continue;
          if (event.data.operation === 'discarded') {
            userMessages.delete(message.messageId);
            continue;
          }
          if (event.data.lane !== 'nextTurn') continue;
          const key = `user:${message.messageId}`;
          const previous = userMessages.get(message.messageId);
          userMessages.set(message.messageId, {
            kind: 'userMessage',
            key,
            sourceKind: 'agent',
            sessionId: event.sessionId,
            turnId: previous?.turnId ?? null,
            stepId: previous?.stepId ?? null,
            firstSeq: previous?.firstSeq ?? event.seq,
            lastSeq: event.seq,
            timestamp: previous?.timestamp ?? agentEventTimestamp(event.timeUnixMs),
            messageId: message.messageId,
            ...(message.clientSubmissionId ? { clientSubmissionId: message.clientSubmissionId } : {}),
            content: message.content,
            images: message.images,
            delivery: 'committed',
          });
        }
        break;
      case 'agent/inbox/item_updated': {
        const previous = userMessages.get(event.data.itemId);
        if (previous) {
          userMessages.set(event.data.itemId, {
            ...previous,
            lastSeq: event.seq,
            content: event.data.content,
          });
        }
        break;
      }
      case 'agent/inbox/item_removed':
        userMessages.delete(event.data.itemId);
        break;
      case 'turn/start': {
        const turn = ensureTurn(event);
        if (turn) {
          turn.startSeq = event.seq;
          turn.startedAt = event.timeUnixMs;
        }
        break;
      }
      case 'turn/end': {
        const turn = ensureTurn(event);
        if (!turn) break;
        turn.endSeq = event.seq;
        turn.endTimestamp = agentEventTimestamp(event.timeUnixMs);
        turn.endReason = event.data.reason;
        turn.status = terminalStatusFromReason(event.data.reason);
        settleStreamingOutput(event, turn.status, 'turn');
        if (turn.status === 'failed' || turn.status === 'cancelled') {
          upsertTurnError(event, turn.status, event.data.reason, 'turn');
        }
        break;
      }
      case 'step/start': {
        const turn = ensureTurn(event);
        if (event.stepId) turn?.steps.add(event.stepId);
        break;
      }
      case 'step/end': {
        const status = terminalStatusFromReason(event.data.reason);
        settleStreamingOutput(event, status, 'step');
        if (status === 'failed' || status === 'cancelled') {
          upsertTurnError(event, status, event.data.reason, 'step');
        }
        break;
      }
      case 'skill/catalog_published':
      case 'skill/catalog_observed':
      case 'skill/step_prepared': {
        for (const context of skillContexts(event)) putProcessChild(eventTurnId(event), {
          kind: 'contextInjection', key: context.id, sourceKind: 'agent', sessionId: event.sessionId,
          turnId: eventTurnId(event), stepId: eventStepId(event), firstSeq: event.seq, lastSeq: event.seq,
          timestamp: agentEventTimestamp(event.timeUnixMs), messageId: context.id, content: context.content, provenance: context.source,
          ...(context.loaded ? { loadedSkill: context.loaded } : {}),
        });
        break;
      }
      case 'user/message': {
        const message = event.data.message;
        if (message.source.kind === 'user') {
          const previous = userMessages.get(message.messageId);
          userMessages.set(message.messageId, {
            kind: 'userMessage',
            key: `user:${message.messageId}`,
            sourceKind: 'agent',
            sessionId: event.sessionId,
            turnId: eventTurnId(event),
            stepId: eventStepId(event),
            firstSeq: previous?.firstSeq ?? event.seq,
            lastSeq: event.seq,
            timestamp: previous?.timestamp ?? agentEventTimestamp(event.timeUnixMs),
            messageId: message.messageId,
            ...(message.clientSubmissionId ? { clientSubmissionId: message.clientSubmissionId } : {}),
            content: message.content,
            images: message.images,
            delivery: 'committed',
          });
        } else {
          const node: AiContextInjectionNode = {
            kind: 'contextInjection',
            key: `context:${message.messageId}`,
            sourceKind: 'agent',
            sessionId: event.sessionId,
            turnId: eventTurnId(event),
            stepId: eventStepId(event),
            firstSeq: event.seq,
            lastSeq: event.seq,
            timestamp: agentEventTimestamp(event.timeUnixMs),
            messageId: message.messageId,
            content: message.content,
            provenance: message.source,
          };
          putProcessChild(eventTurnId(event), node);
        }
        break;
      }
      case 'request/header':
      case 'request/start': {
        const turn = ensureTurn(event);
        if (event.type === 'request/start' || event.data.snapshotReason === undefined) {
          const facts: RequestFacts = {
            requestId: event.data.requestId,
            providerId: event.data.providerId,
            model: event.data.model,
            turnId: eventTurnId(event),
            stepId: eventStepId(event),
            startedAt: event.timeUnixMs,
          };
          requests.set(event.data.requestId, facts);
          if (event.stepId) activeRequestByStep.set(event.stepId, event.data.requestId);
          if (turn && !turn.requestIds.includes(event.data.requestId)) turn.requestIds.push(event.data.requestId);
        }

        const existing = latestPromptKey ? systemPrompts.get(latestPromptKey) : undefined;
        const requestIds = existing?.requestIds.includes(event.data.requestId)
          ? existing.requestIds
          : [...(existing?.requestIds ?? []), event.data.requestId];
        if (event.type === 'request/start') {
          if (existing) systemPrompts.set(existing.key, {
            ...existing, lastSeq: event.seq, requestId: event.data.requestId, requestIds,
          });
          break;
        }

        // Snapshot state spans Turns. Config/tool-only changes belong in Activity;
        // legacy per-step headers do not declare real message-series boundaries.
        const boundary = event.data.snapshotReason !== undefined
          ? event.data.snapshotReason !== 'change'
          : event.data.reason === 'recovery';
        const showsPrompt = previousPromptContent === undefined || boundary
          || previousPromptContent !== event.data.systemPrompt;
        previousPromptContent = event.data.systemPrompt;
        if (!event.data.systemPrompt) {
          latestPromptKey = undefined;
          break;
        }
        if (!showsPrompt && existing) {
          systemPrompts.set(existing.key, {
            ...existing, lastSeq: event.seq, requestId: event.data.requestId, requestIds,
            providerId: event.data.providerId,
            model: event.data.model,
            reasoningEffort: event.data.reasoningEffort ?? null,
            seriesId: event.data.series.seriesId,
            toolSchemas: event.data.toolSchemas,
          });
          break;
        }
        const key = systemPrompts.size === 0
          && event.data.snapshotReason === undefined
          ? `system-prompt:${event.sessionId}`
          : `system-prompt:${event.data.requestId}`;
        latestPromptKey = key;
        systemPrompts.set(key, {
          kind: 'systemPrompt',
          key,
          sourceKind: 'agent',
          sessionId: event.sessionId,
          turnId: eventTurnId(event),
          stepId: eventStepId(event),
          firstSeq: event.seq,
          lastSeq: event.seq,
          timestamp: agentEventTimestamp(event.timeUnixMs),
          requestId: event.data.requestId,
          requestIds: [event.data.requestId],
          providerId: event.data.providerId,
          model: event.data.model,
          reasoningEffort: event.data.reasoningEffort ?? null,
          seriesId: event.data.series.seriesId,
          content: event.data.systemPrompt,
          toolSchemas: event.data.toolSchemas,
        });
        break;
      }
      case 'request/retry': {
        const previous = event.data.previousRequestId
          ? requests.get(event.data.previousRequestId)
          : undefined;
        if (previous && previous.completedAt === undefined) previous.completedAt = event.timeUnixMs;
        const node: AiRetryNode = {
          kind: 'retry',
          key: `retry:${event.data.requestId}:${event.data.attempt}`,
          sourceKind: 'agent',
          sessionId: event.sessionId,
          turnId: eventTurnId(event),
          stepId: eventStepId(event),
          firstSeq: event.seq,
          lastSeq: event.seq,
          timestamp: agentEventTimestamp(event.timeUnixMs),
          requestId: event.data.requestId,
          previousRequestId: event.data.previousRequestId ?? null,
          attempt: event.data.attempt,
          reason: event.data.reason,
        };
        putProcessChild(eventTurnId(event), node);
        break;
      }
      case 'request/failure': {
        const request = requests.get(event.data.requestId);
        if (request) {
          request.completedAt = event.timeUnixMs;
          request.stopReason = 'error';
        }
        // Failed chunks remain in the audit log, but are not an assistant answer.
        const turn = event.turnId ? turns.get(event.turnId) : undefined;
        for (const nodes of [turn?.assistants, turn?.children, unscopedNodes]) {
          if (!nodes) continue;
          for (const [key, node] of nodes) {
            if ((node.kind === 'assistantMessage' || node.kind === 'reasoning')
              && node.requestId === event.data.requestId && node.state === 'streaming') {
              nodes.delete(key);
            }
          }
        }
        break;
      }
      case 'assistant/chunk': {
        const request = requests.get(event.data.requestId);
        if (request && request.firstResponseAt === undefined
          && (event.data.reasoningDelta || event.data.textDelta || event.data.toolCallDelta)) {
          request.firstResponseAt = event.timeUnixMs;
        }
        if (event.data.usage) updateRequestUsage(event.data.requestId, event.data.usage);
        if (event.data.reasoningDelta) {
          upsertReasoning(event, event.data.reasoningDelta, 'streaming', false);
        }
        if (event.data.textDelta) {
          upsertAssistantText(event, event.data.requestId, event.data.textDelta, 'streaming');
        }
        break;
      }
      case 'assistant/message': {
        const requestId = event.stepId ? activeRequestByStep.get(event.stepId) ?? null : null;
        const reasoning = reasoningContent(event.data.content);
        if (reasoning) {
          upsertReasoning(
            event,
            reasoning,
            event.data.interrupted ? 'interrupted' : 'completed',
            true,
          );
        }
        upsertAssistantText(
          event,
          requestId,
          textContent(event.data.content),
          event.data.interrupted ? 'interrupted' : 'completed',
          event.data.content,
          event.data.messageId,
        );
        if (requestId) {
          updateRequestUsage(
            requestId,
            event.data.usage,
            event.data.stopReason,
            event.timeUnixMs,
          );
        }
        break;
      }
      case 'request/usage':
        updateRequestUsage(
          event.data.requestId,
          event.data.usage,
          event.data.finishReason,
          requests.get(event.data.requestId)?.completedAt ?? event.timeUnixMs,
        );
        break;
      case 'tool/call': {
        const call = event.data.call;
        const identity = agentToolEventKey(event, call.callId);
        const node: AiToolNode = {
          kind: 'tool',
          key: `tool:${identity}`,
          sourceKind: 'agent',
          sessionId: event.sessionId,
          turnId: eventTurnId(event),
          stepId: eventStepId(event),
          firstSeq: event.seq,
          lastSeq: event.seq,
          timestamp: agentEventTimestamp(event.timeUnixMs),
          callId: call.callId,
          name: call.name,
          summary: toolSummary(call.arguments),
          state: 'preparing',
          effect: call.effect ?? 'unknown',
          durationMs: null,
          detailRef: {
            kind: 'agentTool', sessionId: event.sessionId, callId: call.callId,
            turnId: eventTurnId(event), stepId: eventStepId(event),
          },
          evidenceRefs: [],
          input: call.arguments,
          output: null,
          error: null,
          target: call.target ?? null,
          idempotency: null,
          approval: null,
        };
        tools.set(identity, node);
        putProcessChild(eventTurnId(event), node);
        break;
      }
      case 'tool/approval': {
        const approvalId = event.data.approvalId ?? `${event.data.requestId}:${event.data.callId}`;
        const turnId = eventTurnId(event);
        const turn = turnId ? turns.get(turnId) : undefined;
        const key = `approval:${approvalId}`;
        const previous = turn?.children.get(key) ?? unscopedNodes.get(key);
        const previousApproval = previous?.kind === 'approvalMarker' ? previous : undefined;
        const node: AiApprovalMarkerNode = {
          kind: 'approvalMarker',
          key,
          sourceKind: 'agent',
          sessionId: event.sessionId,
          turnId,
          stepId: eventStepId(event),
          firstSeq: previousApproval?.firstSeq ?? event.seq,
          lastSeq: event.seq,
          timestamp: previousApproval?.timestamp ?? agentEventTimestamp(event.timeUnixMs),
          approvalId,
          requestId: event.data.requestId,
          callId: event.data.callId,
          status: event.data.status,
          risk: event.data.risk ?? 'unknown',
          prompt: event.data.prompt ?? null,
          reason: event.data.reason ?? null,
          expiresAtUnixMs: event.data.expiresAtUnixMs ?? null,
        };
        putProcessChild(turnId, node);
        updateTool(event, event.data.callId, (tool) => ({
          ...tool,
          state: approvalToolState(event.data.status),
          effect: event.data.risk ?? tool.effect,
          approval: {
            approvalId,
            requestId: event.data.requestId,
            status: event.data.status,
            risk: event.data.risk ?? tool.effect,
            prompt: event.data.prompt ?? null,
            reason: event.data.reason ?? null,
            expiresAtUnixMs: event.data.expiresAtUnixMs ?? null,
          },
        }));
        break;
      }
      case 'tool/execution':
        updateTool(event, event.data.callId, (tool) => ({
          ...tool,
          state: 'running',
          idempotency: event.data.idempotency,
        }));
        break;
      case 'tool/result': {
        for (const context of skillContexts(event)) putProcessChild(eventTurnId(event), {
          kind: 'contextInjection', key: context.id, sourceKind: 'agent', sessionId: event.sessionId,
          turnId: eventTurnId(event), stepId: eventStepId(event), firstSeq: event.seq, lastSeq: event.seq,
          timestamp: agentEventTimestamp(event.timeUnixMs), messageId: context.id, content: context.content, provenance: context.source,
          ...(context.loaded ? { loadedSkill: context.loaded } : {}),
        });

        const identity = agentToolEventKey(event, event.data.callId);
        if (!tools.has(identity)) {
          const node: AiToolNode = {
            kind: 'tool',
            key: `tool:${identity}`,
            sourceKind: 'agent',
            sessionId: event.sessionId,
            turnId: eventTurnId(event),
            stepId: eventStepId(event),
            firstSeq: event.seq,
            lastSeq: event.seq,
            timestamp: agentEventTimestamp(event.timeUnixMs),
            callId: event.data.callId,
            name: event.data.name,
            summary: event.data.summary,
            state: toolState(event.data.status),
            effect: 'unknown',
            durationMs: event.data.durationMs ?? null,
            detailRef: {
              kind: 'agentTool', sessionId: event.sessionId, callId: event.data.callId,
              turnId: eventTurnId(event), stepId: eventStepId(event),
            },
            evidenceRefs: event.data.evidenceRefs ?? [],
            input: null,
            output: event.data.data ?? event.data.summary,
            error: event.data.status === 'failed' || event.data.status === 'timedOut'
              ? event.data.summary
              : null,
            target: null,
            idempotency: null,
            approval: null,
          };
          tools.set(identity, node);
          putProcessChild(eventTurnId(event), node);
        } else {
          updateTool(event, event.data.callId, (tool) => ({
            ...tool,
            state: toolState(event.data.status),
            summary: event.data.summary,
            durationMs: event.data.durationMs ?? null,
            evidenceRefs: event.data.evidenceRefs ?? [],
            output: event.data.data ?? event.data.summary,
            error: event.data.status === 'failed' || event.data.status === 'timedOut'
              ? event.data.summary
              : null,
          }));
        }
        break;
      }
      case 'context/artifact': {
        const previous = artifacts.get(event.data.artifactId);
        artifacts.set(event.data.artifactId, {
          kind: 'artifact',
          key: `artifact:${event.data.artifactId}`,
          sourceKind: 'agent',
          sessionId: event.sessionId,
          turnId: eventTurnId(event),
          stepId: eventStepId(event),
          firstSeq: previous?.firstSeq ?? event.seq,
          lastSeq: event.seq,
          timestamp: previous?.timestamp ?? agentEventTimestamp(event.timeUnixMs),
          artifactId: event.data.artifactId,
          artifactKind: event.data.kind,
          title: event.data.title,
          sizeBytes: event.data.sizeBytes ?? null,
          mediaType: event.data.mediaType ?? null,
          sha256: event.data.sha256 ?? null,
          sensitivity: event.data.sensitivity ?? null,
        });
        break;
      }
      default:
        // Future Event v5 extensions remain visible in Activity, never as guessed chat copy.
        break;
    }
  }

  const completedStats = (turn: TurnState): AiDurableTurnStats => {
    const turnRequests = turn.requestIds
      .map((requestId) => requests.get(requestId))
      .filter((request): request is RequestFacts => request !== undefined);
    const modelDurations = turnRequests.flatMap((request) => (
      request.completedAt === undefined
        ? []
        : [Math.max(0, request.completedAt - request.startedAt)]
    ));
    const ttfts = turnRequests.flatMap((request) => (
      request.firstResponseAt === undefined
        ? []
        : [Math.max(0, request.firstResponseAt - request.startedAt)]
    ));
    const toolChildren = [...turn.children.values()].filter((child) => child.kind === 'tool');
    const toolDurations = toolChildren.flatMap((child) => (
      child.durationMs === null ? [] : [child.durationMs]
    ));
    const modelDurationMs = modelDurations.length === 0
      || modelDurations.length !== turnRequests.length
      ? null
      : modelDurations.reduce((sum, duration) => sum + duration, 0);
    const timeToFirstTokenMs = ttfts.length === 0
      ? null
      : ttfts.reduce((sum, duration) => sum + duration, 0);
    const decodePairs = turnRequests.flatMap((request) => {
      const outputTokens = request.usage?.outputTokens;
      if (request.firstResponseAt === undefined || request.completedAt === undefined
        || outputTokens === undefined) return [];
      return [{
        durationMs: Math.max(0, request.completedAt - request.firstResponseAt),
        outputTokens,
      }];
    });
    const decodeDurationMs = decodePairs.length === 0
      ? null
      : decodePairs.reduce((sum, value) => sum + value.durationMs, 0);
    const decodeTokens = decodePairs.length === 0
      ? null
      : decodePairs.reduce((sum, value) => sum + value.outputTokens, 0);
    return {
      turnCount: 1,
      stepCount: turn.steps.size,
      requestCount: turnRequests.length,
      toolCount: toolChildren.length,
      modelDurationMs,
      toolDurationMs: toolDurations.length === 0 || toolDurations.length !== toolChildren.length
        ? null
        : toolDurations.reduce((sum, duration) => sum + duration, 0),
      timeToFirstTokenMs,
      timeToFirstTokenCount: ttfts.length,
      averageTimeToFirstTokenMs: timeToFirstTokenMs === null
        ? null
        : Math.round(timeToFirstTokenMs / ttfts.length),
      decodeDurationMs,
      decodeTokens,
      uncachedInputTokens: usageField(turnRequests, 'uncachedInputTokens'),
      cacheReadTokens: usageField(turnRequests, 'cacheReadTokens'),
      cacheWriteTokens: usageField(turnRequests, 'cacheWriteTokens'),
      outputTokens: usageField(turnRequests, 'outputTokens'),
      reasoningTokens: usageField(turnRequests, 'reasoningTokens'),
      totalTokens: usageField(turnRequests, 'totalTokens'),
      tokensPerSecond: decodeTokens !== null && decodeDurationMs !== null && decodeDurationMs > 0
        ? decodeTokens / (decodeDurationMs / 1_000)
        : null,
      usageComplete: turnRequests.length > 0
        && turnRequests.every((request) => hasReportedUsage(request.usage)),
    };
  };

  const scopedUsers = new Map<string, AiUserMessageNode[]>();
  for (const node of userMessages.values()) {
    if (node.turnId === null) {
      unscopedNodes.set(node.key, node);
      continue;
    }
    const values = scopedUsers.get(node.turnId) ?? [];
    values.push(node);
    scopedUsers.set(node.turnId, values);
  }

  const scopedPrompts = new Map<string, AiSystemPromptNode[]>();
  for (const node of systemPrompts.values()) {
    if (node.turnId === null) {
      unscopedNodes.set(node.key, node);
      continue;
    }
    const values = scopedPrompts.get(node.turnId) ?? [];
    values.push(node);
    scopedPrompts.set(node.turnId, values);
  }

  const scopedArtifacts = new Map<string, AiArtifactNode[]>();
  for (const node of artifacts.values()) {
    if (node.turnId === null) {
      unscopedNodes.set(node.key, node);
      continue;
    }
    const values = scopedArtifacts.get(node.turnId) ?? [];
    values.push(node);
    scopedArtifacts.set(node.turnId, values);
  }

  const nodes: AiConversationNode[] = [...unscopedNodes.values()].sort(topLevelSort);
  const orderedTurns = [...turns.values()].sort((left, right) => (
    left.firstSeq - right.firstSeq || left.id.localeCompare(right.id)
  ));
  const settledTurnStats: AiDurableTurnStats[] = [];
  for (const turn of orderedTurns) {
    nodes.push(...(scopedPrompts.get(turn.id) ?? []).sort(topLevelSort));
    nodes.push(...(scopedUsers.get(turn.id) ?? []).sort(topLevelSort));

    const assistants = [...turn.assistants.values()].sort(topLevelSort);
    const closing = [...assistants].reverse().find((assistant) => (
      textContent(assistant.blocks).trim() !== '' && !hasToolCall(assistant.blocks)
    ));
    for (const assistant of assistants) {
      if (assistant.key !== closing?.key) turn.children.set(assistant.key, assistant);
    }
    const children = [...turn.children.values()].sort(processChildSort);
    const status: AiTurnProcessStatus = turn.startSeq === undefined
      ? 'partial'
      : turn.status ?? (turn.endSeq === undefined ? 'running' : 'completed');
    const answerGeneration = [...turn.requestIds].reverse()[0] ?? `turn:${turn.id}`;
    const process: AiTurnProcessNode = {
      kind: 'turnProcess',
      key: `turn-process:${turn.id}`,
      sourceKind: 'agent',
      sessionId: turn.sessionId,
      turnId: turn.id,
      stepId: null,
      firstSeq: turn.startSeq ?? turn.firstSeq,
      lastSeq: turn.endSeq ?? turn.lastSeq,
      timestamp: turn.timestamp,
      status,
      answerGeneration,
      hasStartBoundary: turn.startSeq !== undefined,
      hasEndBoundary: turn.endSeq !== undefined,
      childKeys: children.map((child) => child.key),
      children,
    };
    nodes.push(process);
    const hasTurnTail = turn.startSeq !== undefined && turn.endSeq !== undefined
      && Boolean(turn.endReason && turn.endTimestamp);
    if (closing) nodes.push(hasTurnTail ? { ...closing, hasTurnTail: true } : closing);
    nodes.push(...(scopedArtifacts.get(turn.id) ?? []).sort(topLevelSort));

    if (turn.startSeq !== undefined && turn.endSeq !== undefined && turn.endReason && turn.endTimestamp) {
      const stats = completedStats(turn);
      settledTurnStats.push(stats);
      const latestRequest = [...turn.requestIds]
        .reverse()
        .map((requestId) => requests.get(requestId))
        .find((request) => request !== undefined);
      const tail: AiTurnTailNode = {
        kind: 'turnTail',
        key: `turn-tail:${turn.id}`,
        sourceKind: 'agent',
        sessionId: turn.sessionId,
        turnId: turn.id,
        stepId: null,
        firstSeq: turn.endSeq,
        lastSeq: turn.endSeq,
        timestamp: turn.endTimestamp,
        status: turn.status ?? 'completed',
        endReason: turn.endReason,
        stopReason: latestRequest?.stopReason ?? null,
        usage: aggregateUsage(stats),
        stats,
        sessionStats: aggregateDurableSessionStats(settledTurnStats, events[0]?.seq === 0),
        summaryText: closing ? textContent(closing.blocks) : undefined,
        durationMs: turn.startedAt === undefined ? undefined
          : Math.max(0, Date.parse(turn.endTimestamp) - turn.startedAt),
        models: [...new Map(turn.requestIds.flatMap((requestId) => {
          const request = requests.get(requestId);
          return request ? [[JSON.stringify([request.providerId, request.model]), {
            providerId: request.providerId, model: request.model,
          }] as const] : [];
        })).values()],
      };
      nodes.push(tail);
    }
  }

  const questionNodes = projectQuestions(events).map((question): import('./conversation-node').AiQuestionNode => ({
    kind: 'question', key: `question:${questionKey(question.identity)}`, sourceKind: 'agent',
    sessionId: question.identity.sessionId, turnId: question.identity.turnId, stepId: question.identity.stepId,
    firstSeq: question.firstSeq, lastSeq: question.lastSeq, timestamp: question.timestamp, question,
  }));
  for (const question of questionNodes) {
    const followingAnswer = nodes.findIndex((node) => node.turnId === question.turnId
      && (node.kind === 'assistantMessage' || node.kind === 'turnTail') && node.firstSeq > question.firstSeq);
    const afterTurn = nodes.reduce((end, node, index) => node.turnId === question.turnId ? index + 1 : end, 0);
    nodes.splice(followingAnswer >= 0 ? followingAnswer : afterTurn || nodes.length, 0, question);
  }
  return nodes;
}
