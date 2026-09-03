import {
  isSupportedAgentSessionEventVersion,
  type AgentSessionEvent,
  type AgentSessionRuntimeStatus,
  type AgentSessionToolStatus,
} from '@/types/agent-session';
import type {
  AiApprovalMarkerNode,
  AiArtifactNode,
  AiAssistantMessageNode,
  AiConversationNode,
  AiErrorNode,
  AiLifecycleMarkerCategory,
  AiLifecycleMarkerNode,
  AiSessionStatus,
  AiToolNode,
  AiTurnStatsNode,
  AiUserMessageNode,
} from './conversation-node';

interface TurnMetricAccumulator {
  readonly turnId: string;
  readonly number: number;
  readonly firstSeq: number;
  readonly timestamp: string;
  stepCount: number;
  modelDurationMs: number;
  modelDurationCount: number;
  toolDurationMs: number;
  toolDurationCount: number;
  ttftTotalMs: number;
  ttftCount: number;
  inputTokens: number;
  inputTokenCount: number;
  outputTokens: number;
  outputTokenCount: number;
  totalTokens: number;
  totalTokenCount: number;
}

interface CompletedTurnMetric {
  readonly metrics: TurnMetricAccumulator;
  readonly lastSeq: number;
  readonly timestamp: string;
}

type AgentEventFamily =
  | 'session'
  | 'agent'
  | 'inbox'
  | 'turn'
  | 'step'
  | 'user'
  | 'assistant'
  | 'request'
  | 'tool'
  | 'artifact'
  | 'compaction'
  | 'subagent'
  | 'task';

const AGENT_EVENT_FAMILIES = {
  'session/created': 'session',
  'agent/created': 'agent',
  'agent/status': 'agent',
  'session/ended': 'session',
  'agent/inbox/spliced': 'inbox',
  'agent/inbox/item_updated': 'inbox',
  'agent/inbox/item_removed': 'inbox',
  'agent/inbox/reordered': 'inbox',
  'session/renamed': 'session',
  'turn/start': 'turn',
  'turn/end': 'turn',
  'step/start': 'step',
  'step/end': 'step',
  'user/message': 'user',
  'assistant/chunk': 'assistant',
  'assistant/message': 'assistant',
  'request/header': 'request',
  'request/context': 'request',
  'request/retry': 'request',
  'request/usage': 'request',
  'tool/call': 'tool',
  'tool/approval': 'tool',
  'tool/execution': 'tool',
  'tool/result': 'tool',
  'context/artifact': 'artifact',
  'compaction/start': 'compaction',
  'compaction/summary': 'compaction',
  'compaction/end': 'compaction',
  'subagent/descriptor': 'subagent',
  'subagent/message': 'subagent',
  'subagent/settled': 'subagent',
  'subagent/detached': 'subagent',
  'task/linked': 'task',
  'task/plan': 'task',
  'task/state': 'task',
  'task/evidence': 'task',
} satisfies { readonly [Type in AgentSessionEvent['type']]: AgentEventFamily };

interface RuntimeEventLike {
  readonly type: string;
  readonly sessionId: string;
  readonly seq: number;
  readonly timeUnixMs: number;
  readonly turnId?: string;
  readonly stepId?: string;
  readonly data?: unknown;
}

function eventTimestamp(event: RuntimeEventLike): string {
  return new Date(event.timeUnixMs).toISOString();
}

function turnId(event: RuntimeEventLike): string | null {
  return event.turnId ?? null;
}

function stepId(event: RuntimeEventLike): string | null {
  return event.stepId ?? null;
}

function normalizeStatus(value: string): AiSessionStatus | 'info' | 'unknown' {
  switch (value) {
    case 'idle':
    case 'running':
    case 'waiting':
    case 'completed':
    case 'failed':
    case 'cancelled':
      return value;
    default:
      return 'unknown';
  }
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

function toolSummary(argumentsValue: unknown): string {
  if (!argumentsValue || typeof argumentsValue !== 'object') return '';
  const record = argumentsValue as Record<string, unknown>;
  const summary = record.explanation ?? record.summary ?? record.intent;
  return typeof summary === 'string' ? summary : '';
}

function errorState(status: AgentSessionRuntimeStatus): AiErrorNode['state'] {
  if (status === 'failed') return 'failed';
  if (status === 'cancelled') return 'cancelled';
  return 'unknown';
}

function validateAgentEventWindow(events: readonly AgentSessionEvent[]): void {
  if (events.length === 0) return;
  const first = events[0];
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (!isSupportedAgentSessionEventVersion(event.version)) {
      throw new Error(`Unsupported Agent Session event version at seq ${event.seq}`);
    }
    if (event.sessionId !== first.sessionId) {
      throw new Error('Agent Session node projection cannot mix session ids');
    }
    if (!Number.isSafeInteger(event.seq) || event.seq !== first.seq + index) {
      throw new Error('Agent Session node events must be ordered and contiguous');
    }
    if (!Number.isSafeInteger(event.timeUnixMs) || event.timeUnixMs <= 0) {
      throw new Error(`Agent Session event ${event.seq} has an invalid timestamp`);
    }
  }
}

function unknownRuntimeNode(event: RuntimeEventLike): AiLifecycleMarkerNode {
  return {
    kind: 'lifecycleMarker',
    key: `marker:unknown:${event.type}:${event.seq}`,
    sourceKind: 'agent',
    sessionId: event.sessionId,
    turnId: turnId(event),
    stepId: stepId(event),
    firstSeq: event.seq,
    lastSeq: event.seq,
    timestamp: eventTimestamp(event),
    category: 'unknown',
    state: 'unknown',
    label: event.type,
    detail: null,
    eventTypes: [event.type],
    eventSeqs: [event.seq],
  };
}

/**
 * Fold one complete committed Agent event window into stable UI-facing nodes.
 * Known event coverage is compile-time checked by AGENT_EVENT_FAMILIES; an
 * unknown runtime event becomes an explicit audit marker with unknown state.
 */
export function projectAgentConversationNodes(
  events: readonly AgentSessionEvent[],
): readonly AiConversationNode[] {
  validateAgentEventWindow(events);
  const nodes: AiConversationNode[] = [];
  const indexByKey = new Map<string, number>();
  const messageKeys = new Map<string, string>();
  const assistantKeys = new Map<string, string>();
  const assistantKeysByTurn = new Map<string, string>();
  const toolKeys = new Map<string, string>();
  const toolKeysByCall = new Map<string, string>();
  const subagentKeys = new Map<string, string>();
  const turnMetrics = new Map<string, TurnMetricAccumulator>();
  const completedTurns: CompletedTurnMetric[] = [];
  const requestStarts = new Map<string, { readonly turnId: string; readonly timeUnixMs: number; firstChunkSeen: boolean }>();
  let turnCounter = 0;
  let activeCompactionKey: string | null = null;
  let activeRecoveryKey: string | null = null;
  let terminalErrorKey: string | null = null;
  let taskKey = 'marker:task:unscoped';

  const put = (node: AiConversationNode): void => {
    const index = indexByKey.get(node.key);
    if (index === undefined) {
      indexByKey.set(node.key, nodes.length);
      nodes.push(node);
    } else {
      nodes[index] = node;
    }
  };

  const get = (key: string): AiConversationNode | undefined => {
    const index = indexByKey.get(key);
    return index === undefined ? undefined : nodes[index];
  };

  const metricsFor = (event: RuntimeEventLike): TurnMetricAccumulator | null => {
    if (!event.turnId) return null;
    const existing = turnMetrics.get(event.turnId);
    if (existing) return existing;
    const metrics: TurnMetricAccumulator = {
      turnId: event.turnId,
      number: ++turnCounter,
      firstSeq: event.seq,
      timestamp: eventTimestamp(event),
      stepCount: 0,
      modelDurationMs: 0,
      modelDurationCount: 0,
      toolDurationMs: 0,
      toolDurationCount: 0,
      ttftTotalMs: 0,
      ttftCount: 0,
      inputTokens: 0,
      inputTokenCount: 0,
      outputTokens: 0,
      outputTokenCount: 0,
      totalTokens: 0,
      totalTokenCount: 0,
    };
    turnMetrics.set(event.turnId, metrics);
    return metrics;
  };

  const lifecycle = (
    key: string,
    event: RuntimeEventLike,
    category: AiLifecycleMarkerCategory,
    state: AiLifecycleMarkerNode['state'],
    detail: string | null = null,
  ): void => {
    const previous = get(key);
    if (previous?.kind === 'lifecycleMarker') {
      put({
        ...previous,
        lastSeq: event.seq,
        state,
        detail,
        eventTypes: [...previous.eventTypes, event.type],
        eventSeqs: [...previous.eventSeqs, event.seq],
      });
      return;
    }
    put({
      kind: 'lifecycleMarker',
      key,
      sourceKind: 'agent',
      sessionId: event.sessionId,
      turnId: turnId(event),
      stepId: stepId(event),
      firstSeq: event.seq,
      lastSeq: event.seq,
      timestamp: eventTimestamp(event),
      category,
      state,
      label: event.type,
      detail,
      eventTypes: [event.type],
      eventSeqs: [event.seq],
    });
  };

  const updateTool = (
    event: RuntimeEventLike,
    callId: string,
    update: (node: AiToolNode) => AiToolNode,
  ): boolean => {
    const scoped = `${event.stepId ?? 'unscoped'}\u0000${callId}`;
    const key = toolKeys.get(scoped) ?? toolKeysByCall.get(callId);
    const previous = key ? get(key) : undefined;
    if (previous?.kind !== 'tool') return false;
    put({ ...update(previous), lastSeq: event.seq });
    return true;
  };

  const upsertTerminalError = (
    event: RuntimeEventLike,
    status: AgentSessionRuntimeStatus,
    message: string | undefined,
  ): void => {
    const key = terminalErrorKey ?? `error:session:${event.seq}`;
    terminalErrorKey = key;
    const previous = get(key);
    if (previous?.kind === 'error') {
      put({
        ...previous,
        lastSeq: event.seq,
        message: message ?? previous.message,
        state: errorState(status),
      });
      return;
    }
    put({
      kind: 'error',
      key,
      sourceKind: 'agent',
      sessionId: event.sessionId,
      turnId: turnId(event),
      stepId: stepId(event),
      firstSeq: event.seq,
      lastSeq: event.seq,
      timestamp: eventTimestamp(event),
      scope: 'session',
      message: message ?? status,
      code: null,
      state: errorState(status),
    });
  };

  for (const event of events) {
    const family = (AGENT_EVENT_FAMILIES as Readonly<Record<string, AgentEventFamily | undefined>>)[event.type];
    if (family === undefined) {
      put(unknownRuntimeNode(event));
      continue;
    }

    switch (event.type) {
      case 'session/created':
        taskKey = `marker:task:${event.data.taskId}`;
        lifecycle(`marker:session/created:${event.seq}`, event, 'session', 'started', event.data.goal);
        break;
      case 'agent/created':
        lifecycle(`marker:agent:${event.data.agentId}`, event, 'agent', 'started', null);
        break;
      case 'agent/status':
        if (event.data.status === 'failed' || event.data.status === 'cancelled') {
          upsertTerminalError(event, event.data.status, event.data.reason);
        } else {
          lifecycle(
            `marker:agent/status:${event.seq}`,
            event,
            'agent',
            normalizeStatus(event.data.status),
            event.data.reason ?? null,
          );
        }
        break;
      case 'session/ended':
        lifecycle(
          `marker:terminal:${event.seq}`,
          event,
          'terminal',
          event.data.status,
          event.data.reason ?? null,
        );
        if (event.data.status !== 'completed') {
          upsertTerminalError(event, event.data.status, event.data.reason);
        }
        break;
      case 'agent/inbox/spliced':
        for (const message of event.data.messages) {
          const existingKey = messageKeys.get(message.messageId);
          if (event.data.lane === 'nextTurn' && message.source.kind === 'user') {
            const key = existingKey ?? `user:${message.messageId}`;
            messageKeys.set(message.messageId, key);
            const previous = get(key);
            if (previous?.kind === 'userMessage') {
              put({ ...previous, lastSeq: event.seq, content: message.content });
            } else {
              put({
                kind: 'userMessage',
                key,
                sourceKind: 'agent',
                sessionId: event.sessionId,
                turnId: null,
                stepId: null,
                firstSeq: event.seq,
                lastSeq: event.seq,
                timestamp: eventTimestamp(event),
                messageId: message.messageId,
                ...(message.clientSubmissionId
                  ? { clientSubmissionId: message.clientSubmissionId }
                  : {}),
                content: message.content,
                delivery: 'committed',
              });
            }
          } else {
            const key = existingKey ?? `marker:inbox:${message.messageId}`;
            messageKeys.set(message.messageId, key);
            lifecycle(
              key,
              event,
              'inbox',
              event.data.operation === 'discarded' ? 'cancelled' : 'info',
              message.content,
            );
          }
        }
        break;
      case 'agent/inbox/item_updated': {
        const key = messageKeys.get(event.data.itemId);
        const previous = key ? get(key) : undefined;
        if (previous?.kind === 'userMessage') {
          put({ ...previous, lastSeq: event.seq, content: event.data.content });
        } else if (previous?.kind === 'lifecycleMarker') {
          put({ ...previous, lastSeq: event.seq, detail: event.data.content });
        }
        break;
      }
      case 'agent/inbox/item_removed':
        lifecycle(
          `marker:inbox-removed:${event.data.itemId}`,
          event,
          'inbox',
          'cancelled',
          event.data.itemId,
        );
        break;
      case 'agent/inbox/reordered':
      case 'session/renamed':
        break;
      case 'turn/start':
        metricsFor(event);
        lifecycle(`marker:turn:${event.turnId ?? event.seq}`, event, 'turn', 'started');
        break;
      case 'turn/end': {
        const status = /cancel|stop|interrupt/i.test(event.data.reason)
          ? 'cancelled'
          : /fail|error/i.test(event.data.reason)
            ? 'failed'
            : 'completed';
        lifecycle(
          `marker:turn:${event.turnId ?? event.seq}`,
          event,
          'turn',
          status,
          event.data.reason,
        );
        if (/max.?token/i.test(event.data.reason)) {
          lifecycle(`marker:turn-max-tokens:${event.seq}`, event, 'terminal', 'failed', event.data.reason);
        }
        const metrics = metricsFor(event);
        if (metrics) completedTurns.push({
          metrics,
          lastSeq: event.seq,
          timestamp: eventTimestamp(event),
        });
        break;
      }
      case 'step/start':
        {
          const metrics = metricsFor(event);
          if (metrics) metrics.stepCount += 1;
        }
        lifecycle(`marker:step:${event.stepId ?? event.seq}`, event, 'step', 'started');
        break;
      case 'step/end':
        lifecycle(
          `marker:step:${event.stepId ?? event.seq}`,
          event,
          'step',
          /waiting/i.test(event.data.reason)
            ? 'waiting'
            : /cancel|stop|interrupt/i.test(event.data.reason)
              ? 'cancelled'
              : /fail|error|max.?token/i.test(event.data.reason)
                ? 'failed'
                : 'completed',
          event.data.reason,
        );
        break;
      case 'user/message': {
        const message = event.data.message;
        const key = messageKeys.get(message.messageId) ?? `user:${message.messageId}`;
        messageKeys.set(message.messageId, key);
        if (message.source.kind === 'user' || message.source.kind === 'legacyImport') {
          const previous = get(key);
          const firstSeq = previous?.kind === 'userMessage' ? previous.firstSeq : event.seq;
          const timestamp = previous?.kind === 'userMessage'
            ? previous.timestamp
            : eventTimestamp(event);
          put({
            kind: 'userMessage',
            key,
            sourceKind: 'agent',
            sessionId: event.sessionId,
            turnId: turnId(event),
            stepId: stepId(event),
            firstSeq,
            lastSeq: event.seq,
            timestamp,
            messageId: message.messageId,
            ...(message.clientSubmissionId
              ? { clientSubmissionId: message.clientSubmissionId }
              : {}),
            content: message.content,
            delivery: 'committed',
          });
        } else {
          lifecycle(
            key,
            event,
            message.source.kind === 'subagent' ? 'subagent' : 'inbox',
            'info',
            message.content,
          );
        }
        break;
      }
      case 'assistant/chunk': {
        const request = requestStarts.get(event.data.requestId);
        if (request && !request.firstChunkSeen) {
          request.firstChunkSeen = true;
          const metrics = turnMetrics.get(request.turnId);
          if (metrics) {
            metrics.ttftTotalMs += Math.max(0, event.timeUnixMs - request.timeUnixMs);
            metrics.ttftCount += 1;
          }
        }
        const identity = event.stepId ?? event.data.requestId;
        const key = assistantKeys.get(identity)
          ?? `assistant:${event.turnId ?? 'unscoped'}:${identity}`;
        assistantKeys.set(identity, key);
        if (event.turnId) assistantKeysByTurn.set(event.turnId, key);
        const previous = get(key);
        const content = previous?.kind === 'assistantMessage'
          ? previous.content + event.data.text
          : event.data.text;
        const node: AiAssistantMessageNode = {
          kind: 'assistantMessage',
          key,
          sourceKind: 'agent',
          sessionId: event.sessionId,
          turnId: turnId(event),
          stepId: stepId(event),
          firstSeq: previous?.kind === 'assistantMessage' ? previous.firstSeq : event.seq,
          lastSeq: event.seq,
          timestamp: previous?.kind === 'assistantMessage'
            ? previous.timestamp
            : eventTimestamp(event),
          messageId: previous?.kind === 'assistantMessage' ? previous.messageId : identity,
          requestId: event.data.requestId,
          content,
          state: 'streaming',
        };
        put(node);
        break;
      }
      case 'assistant/message': {
        const identity = event.stepId ?? event.data.messageId;
        const key = assistantKeys.get(identity)
          ?? (event.turnId ? assistantKeysByTurn.get(event.turnId) : undefined)
          ?? `assistant:${event.turnId ?? 'unscoped'}:${identity}`;
        const previous = get(key);
        if (!event.data.content && previous?.kind !== 'assistantMessage') {
          lifecycle(`marker:assistant/message:${event.seq}`, event, 'request', 'info');
          break;
        }
        const node: AiAssistantMessageNode = {
          kind: 'assistantMessage',
          key,
          sourceKind: 'agent',
          sessionId: event.sessionId,
          turnId: turnId(event),
          stepId: stepId(event),
          firstSeq: previous?.kind === 'assistantMessage' ? previous.firstSeq : event.seq,
          lastSeq: event.seq,
          timestamp: previous?.kind === 'assistantMessage'
            ? previous.timestamp
            : eventTimestamp(event),
          messageId: event.data.messageId,
          requestId: previous?.kind === 'assistantMessage' ? previous.requestId : null,
          content: event.data.content || (previous?.kind === 'assistantMessage' ? previous.content : ''),
          state: event.data.interrupted ? 'interrupted' : 'completed',
        };
        assistantKeys.set(identity, key);
        if (event.turnId) assistantKeysByTurn.set(event.turnId, key);
        put(node);
        break;
      }
      case 'request/header':
        metricsFor(event);
        if (event.turnId) {
          requestStarts.set(event.data.requestId, {
            turnId: event.turnId,
            timeUnixMs: event.timeUnixMs,
            firstChunkSeen: false,
          });
        }
        lifecycle(
          `marker:request:${event.data.requestId}`,
          event,
          'request',
          'started',
          event.data.model ?? event.data.providerId,
        );
        break;
      case 'request/context':
        lifecycle(
          `marker:request:${event.data.requestId}`,
          event,
          'context',
          event.data.limited ? 'waiting' : 'info',
          event.data.limited ? `omittedMessages=${event.data.omittedMessages ?? 0}` : null,
        );
        break;
      case 'request/retry':
        put({
          kind: 'retry',
          key: `retry:${event.turnId ?? event.data.requestId}:${event.data.attempt}`,
          sourceKind: 'agent',
          sessionId: event.sessionId,
          turnId: turnId(event),
          stepId: stepId(event),
          firstSeq: event.seq,
          lastSeq: event.seq,
          timestamp: eventTimestamp(event),
          requestId: event.data.requestId,
          previousRequestId: event.data.previousRequestId ?? null,
          attempt: event.data.attempt,
          reason: event.data.reason,
        });
        break;
      case 'request/usage': {
        const metrics = metricsFor(event);
        const request = requestStarts.get(event.data.requestId);
        if (metrics && request) {
          metrics.modelDurationMs += Math.max(0, event.timeUnixMs - request.timeUnixMs);
          metrics.modelDurationCount += 1;
        }
        if (metrics && event.data.inputTokens !== undefined) {
          metrics.inputTokens += event.data.inputTokens;
          metrics.inputTokenCount += 1;
        }
        if (metrics && event.data.outputTokens !== undefined) {
          metrics.outputTokens += event.data.outputTokens;
          metrics.outputTokenCount += 1;
        }
        if (metrics && event.data.totalTokens !== undefined) {
          metrics.totalTokens += event.data.totalTokens;
          metrics.totalTokenCount += 1;
        }
        lifecycle(
          `marker:request:${event.data.requestId}`,
          event,
          'request',
          'completed',
          event.data.finishReason,
        );
        break;
      }
      case 'tool/call': {
        const call = event.data.call;
        const scoped = `${event.stepId ?? 'unscoped'}\u0000${call.callId}`;
        const existingCallKey = toolKeysByCall.get(call.callId);
        const key = existingCallKey === undefined
          ? `tool:${call.callId}`
          : `tool:${call.callId}:${event.stepId ?? event.seq}`;
        toolKeys.set(scoped, key);
        toolKeysByCall.set(call.callId, key);
        put({
          kind: 'tool',
          key,
          sourceKind: 'agent',
          sessionId: event.sessionId,
          turnId: turnId(event),
          stepId: stepId(event),
          firstSeq: event.seq,
          lastSeq: event.seq,
          timestamp: eventTimestamp(event),
          callId: call.callId,
          name: call.name,
          summary: toolSummary(call.arguments),
          state: 'preparing',
          effect: call.effect ?? 'unknown',
          durationMs: null,
          detailRef: { kind: 'agentTool', sessionId: event.sessionId, callId: call.callId },
          evidenceRefs: [],
          input: call.arguments,
          output: null,
          error: null,
          target: call.target ?? null,
          idempotency: null,
          approval: null,
        });
        break;
      }
      case 'tool/approval': {
        const approvalId = event.data.approvalId ?? `${event.data.requestId}:${event.data.callId}`;
        const key = `approval:${approvalId}`;
        const previous = get(key);
        const node: AiApprovalMarkerNode = {
          kind: 'approvalMarker',
          key,
          sourceKind: 'agent',
          sessionId: event.sessionId,
          turnId: turnId(event),
          stepId: stepId(event),
          firstSeq: previous?.kind === 'approvalMarker' ? previous.firstSeq : event.seq,
          lastSeq: event.seq,
          timestamp: previous?.kind === 'approvalMarker'
            ? previous.timestamp
            : eventTimestamp(event),
          approvalId,
          requestId: event.data.requestId,
          callId: event.data.callId,
          status: event.data.status,
          risk: event.data.risk ?? 'unknown',
          prompt: event.data.prompt ?? null,
          reason: event.data.reason ?? null,
          expiresAtUnixMs: event.data.expiresAtUnixMs ?? null,
        };
        put(node);
        updateTool(event, event.data.callId, (tool) => ({
          ...tool,
          state: event.data.status === 'requested'
            ? 'approval'
            : event.data.status === 'approved'
              ? 'running'
              : event.data.status === 'rejected'
                ? 'rejected'
                : 'failed',
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
        if (!updateTool(event, event.data.callId, (tool) => ({
          ...tool,
          state: 'running',
          idempotency: event.data.idempotency,
        }))) {
          lifecycle(`marker:tool/execution:${event.seq}`, event, 'unknown', 'unknown', event.data.callId);
        }
        break;
      case 'tool/result':
        {
          const metrics = metricsFor(event);
          if (metrics && event.data.durationMs !== undefined) {
            metrics.toolDurationMs += event.data.durationMs;
            metrics.toolDurationCount += 1;
          }
        }
        if (!updateTool(event, event.data.callId, (tool) => ({
          ...tool,
          state: toolState(event.data.status),
          summary: event.data.summary,
          durationMs: event.data.durationMs ?? null,
          evidenceRefs: event.data.evidenceRefs ?? [],
          output: event.data.data ?? event.data.summary,
          error: event.data.status === 'failed' || event.data.status === 'timedOut'
            ? event.data.summary
            : null,
        }))) {
          lifecycle(`marker:tool/result:${event.seq}`, event, 'unknown', 'unknown', event.data.callId);
        }
        break;
      case 'context/artifact': {
        const node: AiArtifactNode = {
          kind: 'artifact',
          key: `artifact:${event.data.artifactId}`,
          sourceKind: 'agent',
          sessionId: event.sessionId,
          turnId: turnId(event),
          stepId: stepId(event),
          firstSeq: event.seq,
          lastSeq: event.seq,
          timestamp: eventTimestamp(event),
          artifactId: event.data.artifactId,
          artifactKind: event.data.kind,
          title: event.data.title,
          sizeBytes: event.data.sizeBytes ?? null,
          mediaType: event.data.mediaType ?? null,
          sha256: event.data.sha256 ?? null,
          sensitivity: event.data.sensitivity ?? null,
        };
        put(node);
        break;
      }
      case 'compaction/start':
        activeCompactionKey = `marker:compaction:${event.seq}`;
        lifecycle(activeCompactionKey, event, 'compaction', 'started', event.data.reason);
        break;
      case 'compaction/summary':
        activeCompactionKey ??= `marker:compaction:${event.seq}`;
        lifecycle(activeCompactionKey, event, 'compaction', 'info', event.data.summary);
        break;
      case 'compaction/end':
        activeCompactionKey ??= `marker:compaction:${event.seq}`;
        lifecycle(
          activeCompactionKey,
          event,
          'compaction',
          event.data.status,
          `surfaceGeneration=${event.data.surfaceGeneration}`,
        );
        activeCompactionKey = null;
        break;
      case 'subagent/descriptor': {
        const key = `marker:subagent:${event.data.descriptorId}`;
        subagentKeys.set(event.data.descriptorId, key);
        lifecycle(key, event, 'subagent', 'started', event.data.childSessionId);
        break;
      }
      case 'subagent/message': {
        const key = subagentKeys.get(event.data.descriptorId)
          ?? `marker:subagent:${event.data.descriptorId}`;
        subagentKeys.set(event.data.descriptorId, key);
        lifecycle(key, event, 'subagent', 'running', event.data.summary);
        break;
      }
      case 'subagent/settled': {
        const key = subagentKeys.get(event.data.descriptorId)
          ?? `marker:subagent:${event.data.descriptorId}`;
        subagentKeys.set(event.data.descriptorId, key);
        lifecycle(key, event, 'subagent', normalizeStatus(event.data.status), event.data.summary);
        break;
      }
      case 'subagent/detached': {
        const key = subagentKeys.get(event.data.descriptorId)
          ?? `marker:subagent:${event.data.descriptorId}`;
        subagentKeys.set(event.data.descriptorId, key);
        lifecycle(key, event, 'subagent', 'cancelled', event.data.reason);
        break;
      }
      case 'task/linked':
        taskKey = `marker:task:${event.data.taskId}`;
        lifecycle(taskKey, event, 'task', 'started', event.data.goal ?? null);
        break;
      case 'task/plan':
        lifecycle(taskKey, event, 'task', 'info', `planVersion=${event.data.version}`);
        break;
      case 'task/state':
        lifecycle(taskKey, event, 'task', normalizeStatus(event.data.status), event.data.phase ?? null);
        if (event.data.recovery && event.data.recovery.status !== 'none') {
          activeRecoveryKey ??= `marker:recovery:${event.seq}`;
          lifecycle(
            activeRecoveryKey,
            event,
            'recovery',
            event.data.recovery.status === 'completed' ? 'completed' : 'waiting',
            event.data.recovery.summary ?? event.data.recovery.status,
          );
        } else if (activeRecoveryKey !== null) {
          lifecycle(activeRecoveryKey, event, 'recovery', 'completed', null);
          activeRecoveryKey = null;
        }
        break;
      case 'task/evidence':
        lifecycle(
          `marker:evidence:${event.data.evidenceId}`,
          event,
          'task',
          'completed',
          event.data.summary,
        );
        break;
      default:
        put(unknownRuntimeNode(event as RuntimeEventLike));
        break;
    }
  }

  const lastCompletedTurn = completedTurns[completedTurns.length - 1];
  if (lastCompletedTurn) {
    const aggregate = completedTurns.reduce((total, completed) => ({
      stepCount: total.stepCount + completed.metrics.stepCount,
      modelDurationMs: total.modelDurationMs + completed.metrics.modelDurationMs,
      modelDurationCount: total.modelDurationCount + completed.metrics.modelDurationCount,
      toolDurationMs: total.toolDurationMs + completed.metrics.toolDurationMs,
      toolDurationCount: total.toolDurationCount + completed.metrics.toolDurationCount,
      ttftTotalMs: total.ttftTotalMs + completed.metrics.ttftTotalMs,
      ttftCount: total.ttftCount + completed.metrics.ttftCount,
      inputTokens: total.inputTokens + completed.metrics.inputTokens,
      inputTokenCount: total.inputTokenCount + completed.metrics.inputTokenCount,
      outputTokens: total.outputTokens + completed.metrics.outputTokens,
      outputTokenCount: total.outputTokenCount + completed.metrics.outputTokenCount,
      totalTokens: total.totalTokens + completed.metrics.totalTokens,
      totalTokenCount: total.totalTokenCount + completed.metrics.totalTokenCount,
    }), {
      stepCount: 0,
      modelDurationMs: 0,
      modelDurationCount: 0,
      toolDurationMs: 0,
      toolDurationCount: 0,
      ttftTotalMs: 0,
      ttftCount: 0,
      inputTokens: 0,
      inputTokenCount: 0,
      outputTokens: 0,
      outputTokenCount: 0,
      totalTokens: 0,
      totalTokenCount: 0,
    });
    const modelDurationMs = aggregate.modelDurationCount > 0
      ? aggregate.modelDurationMs
      : null;
    const outputTokens = aggregate.outputTokenCount > 0 ? aggregate.outputTokens : null;
    const stats: AiTurnStatsNode = {
      kind: 'turnStats',
      key: `stats:${events[0]?.sessionId ?? lastCompletedTurn.metrics.turnId}`,
      sourceKind: 'agent',
      sessionId: events[0]?.sessionId ?? '',
      turnId: lastCompletedTurn.metrics.turnId,
      stepId: null,
      firstSeq: completedTurns[0]?.metrics.firstSeq ?? lastCompletedTurn.metrics.firstSeq,
      lastSeq: lastCompletedTurn.lastSeq,
      timestamp: lastCompletedTurn.timestamp,
      turnNumber: completedTurns.length,
      stepCount: aggregate.stepCount,
      modelDurationMs,
      toolDurationMs: aggregate.toolDurationCount > 0 ? aggregate.toolDurationMs : null,
      averageTimeToFirstTokenMs: aggregate.ttftCount > 0
        ? Math.round(aggregate.ttftTotalMs / aggregate.ttftCount)
        : null,
      inputTokens: aggregate.inputTokenCount > 0 ? aggregate.inputTokens : null,
      outputTokens,
      totalTokens: aggregate.totalTokenCount > 0 ? aggregate.totalTokens : null,
      tokensPerSecond: outputTokens !== null && modelDurationMs !== null && modelDurationMs > 0
        ? outputTokens / (modelDurationMs / 1_000)
        : null,
    };
    put(stats);
  }

  return nodes;
}
