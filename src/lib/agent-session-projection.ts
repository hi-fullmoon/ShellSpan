import { skillContexts } from './ai/skill-projection';
import {
  type AgentActivityAgent,
  type AgentActivityNode,
  type AgentActivityProjection,
  type AgentActivityRequest,
  type AgentActivityStep,
  type AgentActivityTool,
  type AgentActivityTurn,
  type AgentSessionEvent,
  type AgentSessionRuntimeStatus,
  type AgentSessionToolStatus,
} from '@/types/agent-session';
import {
  agentEventTimestamp,
  agentToolEventKey,
  validateCommittedAgentEventWindow,
} from '@/lib/agent-session-event-window';

function toolEventKey(stepId: string | undefined, callId: string): string {
  return `${stepId ?? 'unscoped'}\u0000${callId}`;
}

function terminalStatusFromReason(reason: string): AgentSessionRuntimeStatus {
  if (/waiting/i.test(reason)) return 'waiting';
  if (/cancel|stop|interrupt/i.test(reason)) return 'cancelled';
  if (/fail|error|limit|max.?token/i.test(reason)) return 'failed';
  return 'completed';
}

function approvalToolStatus(
  status: Extract<AgentSessionEvent, { type: 'tool/approval' }>['data']['status'],
): AgentSessionToolStatus {
  switch (status) {
    case 'requested': return 'awaitingApproval';
    case 'approved': return 'running';
    case 'rejected': return 'rejected';
    case 'expired': return 'timedOut';
    case 'cancelled': return 'cancelled';
  }
}

function reportedInputTokens(
  usage: import('@/types/agent-session').AgentSessionTokenUsage,
): number | undefined {
  return usage.uncachedInputTokens !== undefined && usage.cacheReadTokens !== undefined
    ? usage.uncachedInputTokens + usage.cacheReadTokens
    : undefined;
}

function withRequestTiming(
  request: AgentActivityRequest,
  terminalAt?: number,
  interrupted = false,
): AgentActivityRequest {
  const firstResponseAt = [request.firstReasoningAt, request.firstTextAt]
    .filter((value): value is number => value !== undefined)
    .sort((left, right) => left - right)[0];
  const reasoningEnd = request.firstTextAt ?? terminalAt;
  return {
    ...request,
    ...(terminalAt === undefined
      ? {}
      : interrupted ? { interruptedAt: terminalAt } : { completedAt: terminalAt }),
    ...(firstResponseAt === undefined
      ? {}
      : { ttftMs: Math.max(0, firstResponseAt - request.startedAt) }),
    ...(request.firstReasoningAt === undefined || reasoningEnd === undefined
      ? {}
      : { reasoningDurationMs: Math.max(0, reasoningEnd - request.firstReasoningAt) }),
    ...(terminalAt === undefined
      ? {}
      : { llmDurationMs: Math.max(0, terminalAt - request.startedAt) }),
  };
}

const ACTIVITY_KIND_ORDER = {
  session: 0,
  agent: 1,
  inbox: 2,
  turn: 3,
  step: 4,
  request: 5,
  requestContext: 6,
  retry: 7,
  assistantStream: 8,
  assistantMessage: 9,
  requestUsage: 10,
  tool: 11,
  approval: 12,
  artifact: 13,
  compaction: 14,
  subagent: 15,
  task: 16,
  evidence: 17,
  error: 18,
  cancellation: 19,
  unknown: 20,
  question: 21,
} satisfies Record<AgentActivityNode['kind'], number>;

type ActivityEventLike = Readonly<{
  type: string;
  sessionId: string;
  seq: number;
  timeUnixMs: number;
  turnId?: string;
  stepId?: string;
  data?: unknown;
}>;

function activityDiagnosticStatus(reason: string): 'failed' | 'cancelled' | null {
  const status = terminalStatusFromReason(reason);
  return status === 'failed' || status === 'cancelled' ? status : null;
}

function activityEventData(event: AgentSessionEvent): unknown {
  return 'data' in event ? event.data ?? null : null;
}

function projectActivityNodesUnchecked(
  events: readonly AgentSessionEvent[],
): readonly AgentActivityNode[] {
  const nodes: AgentActivityNode[] = [];
  const indexByKey = new Map<string, number>();
  const currentRequestByStep = new Map<string, string>();
  const requestTurn = new Map<string, { readonly turnId: string | null; readonly stepId: string | null }>();
  const subagentKeys = new Map<string, string>();
  let taskKey = `activity:task:${events[0]?.sessionId ?? 'unknown'}`;
  let activeCompactionKey: string | null = null;
  let latestTurnId: string | null = null;

  const upsert = (
    key: string,
    kind: AgentActivityNode['kind'],
    event: ActivityEventLike,
    status: AgentActivityNode['status'],
    label: string,
    detail: string | null,
    data: unknown,
    requestId: string | null = null,
    coordinates?: Readonly<{ turnId?: string | null; stepId?: string | null }>,
    preserveData = false,
  ): void => {
    const index = indexByKey.get(key);
    const previous = index === undefined ? undefined : nodes[index];
    const node: AgentActivityNode = previous === undefined
      ? {
          key,
          kind,
          sessionId: event.sessionId,
          turnId: coordinates?.turnId ?? event.turnId ?? null,
          stepId: coordinates?.stepId ?? event.stepId ?? null,
          requestId,
          firstSeq: event.seq,
          lastSeq: event.seq,
          timestamp: agentEventTimestamp(event.timeUnixMs),
          status,
          label,
          detail,
          eventTypes: [event.type],
          eventSeqs: [event.seq],
          records: [{
            type: event.type,
            seq: event.seq,
            timeUnixMs: event.timeUnixMs,
            data,
          }],
          data,
        }
      : {
          ...previous,
          lastSeq: event.seq,
          status,
          label,
          detail,
          eventTypes: [...previous.eventTypes, event.type],
          eventSeqs: [...previous.eventSeqs, event.seq],
          records: [...previous.records, {
            type: event.type,
            seq: event.seq,
            timeUnixMs: event.timeUnixMs,
            data,
          }],
          data: preserveData ? previous.data : data,
        };
    if (index === undefined) {
      indexByKey.set(key, nodes.length);
      nodes.push(node);
    } else {
      nodes[index] = node;
    }
  };

  const diagnostic = (
    scope: 'session' | 'agent' | 'turn' | 'step',
    identity: string,
    event: ActivityEventLike,
    state: 'failed' | 'cancelled',
    detail: string,
  ): void => {
    upsert(
      `activity:${state === 'cancelled' ? 'cancellation' : 'error'}:${scope}:${identity}`,
      state === 'cancelled' ? 'cancellation' : 'error',
      event,
      state,
      `${scope}/${state}`,
      detail,
      { scope, detail },
      null,
      { turnId: event.turnId ?? latestTurnId, stepId: event.stepId ?? null },
    );
  };

  const requestCoordinates = (requestId: string, event: ActivityEventLike) => (
    requestTurn.get(requestId) ?? {
      turnId: event.turnId ?? null,
      stepId: event.stepId ?? null,
    }
  );

  for (const event of events) {
    if (event.turnId) latestTurnId = event.turnId;
    switch (event.type) {
      case 'session/created':
        taskKey = `activity:task:${event.data.taskId}`;
        upsert(
          `activity:session:${event.sessionId}`,
          'session', event, 'started', 'session', event.data.goal, event.data,
        );
        break;
      case 'session/ended':
        upsert(
          `activity:session:${event.sessionId}`,
          'session', event, event.data.status, 'session', event.data.reason ?? null, event.data,
        );
        if (event.data.status !== 'completed') {
          diagnostic('session', event.sessionId, event, event.data.status, event.data.reason ?? event.data.status);
        }
        break;
      case 'agent/created':
        upsert(
          `activity:agent:${event.sessionId}`,
          'agent', event, 'started', event.data.agentId, null, event.data,
        );
        break;
      case 'agent/status':
        upsert(
          `activity:agent:${event.sessionId}`,
          'agent', event, event.data.status, 'agent', event.data.reason ?? null, event.data,
        );
        if (event.data.status === 'failed' || event.data.status === 'cancelled') {
          diagnostic('agent', event.sessionId, event, event.data.status, event.data.reason ?? event.data.status);
        }
        break;
      case 'agent/inbox/spliced':
        for (const message of event.data.messages) {
          upsert(
            `activity:inbox:${message.messageId}`,
            'inbox', event,
            event.data.operation === 'discarded'
              ? 'cancelled'
              : event.data.operation === 'claimed' ? 'completed' : 'started',
            `${event.data.lane}/${event.data.operation}`,
            message.content,
            { ...event.data, messages: [message] },
          );
        }
        break;
      case 'agent/inbox/item_updated':
        upsert(
          `activity:inbox:${event.data.itemId}`,
          'inbox', event, 'updated', `${event.data.lane}/updated`, event.data.content, event.data,
        );
        break;
      case 'agent/inbox/item_removed':
        upsert(
          `activity:inbox:${event.data.itemId}`,
          'inbox', event, 'cancelled', `${event.data.lane}/removed`, event.data.itemId, event.data,
        );
        break;
      case 'agent/inbox/item_steered':
        upsert(
          `activity:inbox:${event.data.itemId}`,
          'inbox', event, 'updated', 'nextStep/steered', null, event.data,
        );
        break;
      case 'agent/inbox/reordered':
        upsert(
          `activity:inbox-order:${event.data.lane}`,
          'inbox', event, 'updated', `${event.data.lane}/reordered`, null, event.data,
        );
        break;
      case 'session/renamed':
        upsert(
          `activity:session:${event.sessionId}`,
          'session', event, 'updated', 'session', event.data.title, event.data,
        );
        break;
      case 'turn/start':
        upsert(
          `activity:turn:${event.turnId ?? 'unscoped'}`,
          'turn', event, 'started', 'turn', null, null,
        );
        break;
      case 'turn/end': {
        const status = terminalStatusFromReason(event.data.reason);
        upsert(
          `activity:turn:${event.turnId ?? 'unscoped'}`,
          'turn', event, status, 'turn', event.data.reason, event.data,
        );
        const diagnosticStatus = activityDiagnosticStatus(event.data.reason);
        if (diagnosticStatus) {
          diagnostic('turn', event.turnId ?? 'unscoped', event, diagnosticStatus, event.data.reason);
        }
        break;
      }
      case 'step/start':
        upsert(
          `activity:step:${event.stepId ?? 'unscoped'}`,
          'step', event, 'started', 'step', null, null,
        );
        break;
      case 'step/end': {
        const status = terminalStatusFromReason(event.data.reason);
        upsert(
          `activity:step:${event.stepId ?? 'unscoped'}`,
          'step', event, status, 'step', event.data.reason, event.data,
        );
        const diagnosticStatus = activityDiagnosticStatus(event.data.reason);
        if (diagnosticStatus) {
          diagnostic('step', event.stepId ?? 'unscoped', event, diagnosticStatus, event.data.reason);
        }
        break;
      }
      case 'skill/catalog_published':
      case 'skill/catalog_observed':
      case 'skill/step_prepared':
        for (const context of skillContexts(event)) upsert(context.id, 'inbox', event, 'completed', context.source.label, context.content, { ...event.data, loadedSkill: context.loaded });
        break;
      case 'user/message':
        upsert(
          `activity:message:${event.data.message.messageId}`,
          'inbox', event, 'completed', event.data.message.source.label,
          event.data.message.content, event.data,
        );
        break;
      case 'request/header':
      case 'request/start': {
        if (event.type === 'request/header' && event.data.snapshotReason !== undefined) {
          upsert(
            `activity:request-header:${event.data.requestId}`,
            'requestContext', event, 'completed', 'request/header',
            event.data.snapshotReason, event.data, event.data.requestId,
          );
          break;
        }
        const coordinates = { turnId: event.turnId ?? null, stepId: event.stepId ?? null };
        requestTurn.set(event.data.requestId, coordinates);
        if (event.stepId) currentRequestByStep.set(event.stepId, event.data.requestId);
        upsert(
          `activity:request:${event.data.requestId}`,
          'request', event, 'started', `${event.data.providerId}/${event.data.model}`,
          event.data.reason, event.data, event.data.requestId,
        );
        break;
      }
      case 'request/context': {
        const coordinates = requestCoordinates(event.data.requestId, event);
        upsert(
          `activity:request:${event.data.requestId}`,
          'request', event, event.data.limited ? 'waiting' : 'running', 'request',
          event.data.limited ? `omittedMessages=${event.data.omittedMessages ?? 0}` : null,
          event.data, event.data.requestId, coordinates,
          true,
        );
        upsert(
          `activity:request-context:${event.data.requestId}`,
          'requestContext', event, event.data.limited ? 'waiting' : 'completed', 'request/context',
          event.data.limited ? `omittedMessages=${event.data.omittedMessages ?? 0}` : null,
          event.data, event.data.requestId, coordinates,
        );
        break;
      }
      case 'request/retry': {
        const coordinates = requestCoordinates(event.data.requestId, event);
        upsert(
          `activity:retry:${event.data.requestId}:${event.data.attempt}`,
          'retry', event, 'waiting', `retry/${event.data.attempt}`, event.data.reason,
          event.data, event.data.requestId, coordinates,
        );
        break;
      }
      case 'request/failure': {
        const coordinates = requestCoordinates(event.data.requestId, event);
        const streamKey = `activity:assistant-stream:${event.data.requestId}`;
        if (indexByKey.has(streamKey)) {
          upsert(streamKey, 'assistantStream', event, 'interrupted', 'assistant/stream',
            event.data.failure.message, event.data, event.data.requestId, coordinates, true);
        }
        upsert(
          `activity:request:${event.data.requestId}`,
          'request', event, event.data.interrupted ? 'interrupted' : 'failed', 'request',
          event.data.failure.message, event.data, event.data.requestId, coordinates,
          true,
        );
        break;
      }
      case 'assistant/chunk': {
        const coordinates = requestCoordinates(event.data.requestId, event);
        const detail = [
          event.data.reasoningDelta ? 'reasoning' : null,
          event.data.textDelta ? 'text' : null,
          event.data.toolCallDelta ? 'toolCall' : null,
          event.data.usage ? 'usage' : null,
        ].filter((value): value is string => value !== null).join('+');
        upsert(
          `activity:assistant-stream:${event.data.requestId}`,
          'assistantStream', event, 'running', 'assistant/stream', detail || null,
          event.data, event.data.requestId, coordinates,
        );
        break;
      }
      case 'assistant/message': {
        const requestId = event.stepId ? currentRequestByStep.get(event.stepId) ?? null : null;
        const coordinates = requestId ? requestCoordinates(requestId, event) : undefined;
        upsert(
          `activity:assistant-message:${event.data.messageId}`,
          'assistantMessage', event, event.data.interrupted ? 'interrupted' : 'completed',
          'assistant/message', event.data.stopReason, event.data, requestId, coordinates,
        );
        if (requestId) {
          upsert(
            `activity:request:${requestId}`,
            'request', event, event.data.interrupted ? 'interrupted' : 'completed', 'request',
            event.data.stopReason, event.data, requestId, coordinates,
            true,
          );
        }
        break;
      }
      case 'request/usage': {
        const coordinates = requestCoordinates(event.data.requestId, event);
        upsert(
          `activity:request:${event.data.requestId}`,
          'request', event,
          event.data.finishReason === 'cancelled'
            ? 'cancelled'
            : event.data.finishReason === 'error' ? 'failed' : 'completed',
          'request', event.data.finishReason, event.data, event.data.requestId, coordinates,
          true,
        );
        upsert(
          `activity:request-usage:${event.data.requestId}`,
          'requestUsage', event, 'completed', 'request/usage', event.data.finishReason,
          event.data, event.data.requestId, coordinates,
        );
        break;
      }
      case 'tool/call': {
        const key = `activity:tool:${agentToolEventKey(event, event.data.call.callId)}`;
        upsert(
          key, 'tool', event, 'pending', event.data.call.name,
          event.data.call.title ?? null, event.data,
        );
        break;
      }
      case 'question/requested':
      case 'question/answered':
      case 'question/cancelled': {
        const identity = event.type === 'question/answered' ? event.data.submission.identity : event.data.identity;
        upsert(`activity:question:${identity.questionRequestId}`, 'question', event,
          event.type === 'question/requested' ? 'pending' : event.type === 'question/answered' ? 'completed' : 'cancelled',
          event.type, null, event.data, identity.requestId);
        break;
      }
      case 'tool/approval': {
        const key = `activity:tool:${agentToolEventKey(event, event.data.callId)}`;
        upsert(
          key, 'tool', event, approvalToolStatus(event.data.status), event.data.callId,
          event.data.reason ?? null, event.data, event.data.requestId,
        );
        const approvalId = event.data.approvalId ?? `${event.data.requestId}:${event.data.callId}`;
        upsert(
          `activity:approval:${approvalId}`,
          'approval', event, approvalToolStatus(event.data.status), 'tool/approval',
          event.data.reason ?? event.data.prompt ?? null, event.data, event.data.requestId,
        );
        break;
      }
      case 'tool/execution':
        upsert(
          `activity:tool:${agentToolEventKey(event, event.data.callId)}`,
          'tool', event, 'running', event.data.callId, event.data.idempotency, event.data,
        );
        break;
      case 'tool/result':
        upsert(
          `activity:tool:${agentToolEventKey(event, event.data.callId)}`,
          'tool', event, event.data.status, event.data.name, event.data.summary, event.data,
        );
        break;
      case 'context/artifact':
        upsert(
          `activity:artifact:${event.data.artifactId}`,
          'artifact', event, 'completed', event.data.title, event.data.kind, event.data,
        );
        break;
      case 'compaction/start':
        activeCompactionKey = `activity:compaction:${event.seq}`;
        upsert(
          activeCompactionKey, 'compaction', event, 'started', 'compaction', event.data.reason, event.data,
        );
        break;
      case 'compaction/summary':
        activeCompactionKey ??= `activity:compaction:generation:${event.data.surfaceGeneration}`;
        upsert(
          activeCompactionKey, 'compaction', event, 'updated', 'compaction', event.data.summary, event.data,
        );
        break;
      case 'compaction/end':
        activeCompactionKey ??= `activity:compaction:generation:${event.data.surfaceGeneration}`;
        upsert(
          activeCompactionKey, 'compaction', event, event.data.status, 'compaction',
          `surfaceGeneration=${event.data.surfaceGeneration}`, event.data,
        );
        activeCompactionKey = null;
        break;
      case 'subagent/descriptor': {
        const key = `activity:subagent:${event.data.descriptorId}`;
        subagentKeys.set(event.data.descriptorId, key);
        upsert(key, 'subagent', event, 'started', event.data.role, event.data.childSessionId, event.data);
        break;
      }
      case 'subagent/message':
        upsert(
          subagentKeys.get(event.data.descriptorId) ?? `activity:subagent:${event.data.descriptorId}`,
          'subagent', event, 'running', event.data.route, event.data.summary, event.data,
        );
        break;
      case 'subagent/settled':
        upsert(
          subagentKeys.get(event.data.descriptorId) ?? `activity:subagent:${event.data.descriptorId}`,
          'subagent', event, event.data.status, 'subagent', event.data.summary, event.data,
        );
        break;
      case 'subagent/detached':
        upsert(
          subagentKeys.get(event.data.descriptorId) ?? `activity:subagent:${event.data.descriptorId}`,
          'subagent', event, 'cancelled', 'subagent/detached', event.data.reason, event.data,
        );
        break;
      case 'task/linked':
        taskKey = `activity:task:${event.data.taskId}`;
        upsert(taskKey, 'task', event, 'started', 'task', event.data.goal ?? null, event.data);
        break;
      case 'task/plan':
        upsert(taskKey, 'task', event, 'updated', 'task/plan', `version=${event.data.version}`, event.data);
        break;
      case 'task/state':
        upsert(
          taskKey, 'task', event, 'updated', event.data.status, event.data.phase ?? null, event.data,
        );
        break;
      case 'task/evidence':
        upsert(
          `activity:evidence:${event.data.evidenceId}`,
          'evidence', event, 'completed', event.data.kind, event.data.summary, event.data,
        );
        break;
      default: {
        const runtimeEvent = event as ActivityEventLike;
        upsert(
          `activity:unknown:${runtimeEvent.type}:${runtimeEvent.seq}`,
          'unknown', runtimeEvent, 'unknown', runtimeEvent.type, null,
          activityEventData(event),
        );
        break;
      }
    }
  }

  return [...nodes].sort((left, right) => (
    left.firstSeq - right.firstSeq
    || ACTIVITY_KIND_ORDER[left.kind] - ACTIVITY_KIND_ORDER[right.kind]
    || left.key.localeCompare(right.key)
  ));
}

/** Project the complete diagnostic Activity trail without exposing it as chat copy. */
export function projectAgentActivityNodes(
  events: readonly AgentSessionEvent[],
): readonly AgentActivityNode[] {
  validateCommittedAgentEventWindow(events);
  return projectActivityNodesUnchecked(events);
}

interface MutableActivityStep {
  id: string;
  index: number;
  status: AgentSessionRuntimeStatus;
  startedAt?: number;
  endedAt?: number;
  endReason?: string;
  requests: AgentActivityRequest[];
  tools: AgentActivityTool[];
}

interface MutableActivityTurn {
  id: string;
  index: number;
  status: AgentSessionRuntimeStatus;
  startedAt?: number;
  endedAt?: number;
  endReason?: string;
  steps: MutableActivityStep[];
}

function projectActivityUnchecked(
  events: readonly AgentSessionEvent[],
): Omit<AgentActivityProjection, 'nodes'> {
  const turns: MutableActivityTurn[] = [];
  const turnById = new Map<string, MutableActivityTurn>();
  const stepById = new Map<string, MutableActivityStep>();
  const requestLocation = new Map<string, { step: MutableActivityStep; index: number }>();
  const pendingRetryReason = new Map<string, string>();
  const headers = new Map<string, Extract<AgentSessionEvent, { type: 'request/header' }>['data']>();
  const toolLocation = new Map<string, { step: MutableActivityStep; index: number }>();
  const latestToolLocation = new Map<string, { step: MutableActivityStep; index: number }>();
  const agents = new Map<string, AgentActivityAgent>();
  const artifacts: AgentActivityProjection['context']['artifacts'][number][] = [];
  let status: AgentSessionRuntimeStatus = 'idle';
  let statusReason: string | undefined;
  let plan: AgentActivityProjection['plan'];
  let recovery: AgentActivityProjection['recovery'] = { status: 'none' };
  let fleet: AgentActivityProjection['fleet'];
  let evidenceCount = 0;
  let inputTokens: number | undefined;
  let contextWindow: number | undefined;
  let surfaceGeneration = 0;
  let compactionCount = 0;
  let primaryAgentId: string | undefined;

  const ensureTurn = (event: AgentSessionEvent): MutableActivityTurn => {
    const id = event.turnId ?? 'unscoped-turn';
    const existing = turnById.get(id);
    if (existing) return existing;
    const turn: MutableActivityTurn = {
      id,
      index: turns.length + 1,
      status: 'running',
      steps: [],
    };
    turns.push(turn);
    turnById.set(id, turn);
    return turn;
  };

  const ensureStep = (event: AgentSessionEvent): MutableActivityStep => {
    const id = event.stepId ?? `${event.turnId ?? 'unscoped-turn'}:unscoped-step`;
    const existing = stepById.get(id);
    if (existing) return existing;
    const turn = ensureTurn(event);
    const step: MutableActivityStep = {
      id,
      index: turn.steps.length + 1,
      status: 'running',
      requests: [],
      tools: [],
    };
    turn.steps.push(step);
    stepById.set(id, step);
    return step;
  };

  const updateActivityTool = (
    stepId: string | undefined,
    callId: string,
    update: (tool: AgentActivityTool) => AgentActivityTool,
  ): void => {
    const location = toolLocation.get(toolEventKey(stepId, callId)) ?? latestToolLocation.get(callId);
    if (!location) return;
    location.step.tools[location.index] = update(location.step.tools[location.index]);
  };

  const updateActivityRequest = (
    requestId: string,
    event: AgentSessionEvent,
    update: (request: AgentActivityRequest) => AgentActivityRequest,
  ): MutableActivityStep => {
    const location = requestLocation.get(requestId);
    if (location) {
      location.step.requests[location.index] = update(location.step.requests[location.index]);
      return location.step;
    }
    return ensureStep(event);
  };

  const latestActivityRequest = (step: MutableActivityStep): AgentActivityRequest | undefined => (
    step.requests[step.requests.length - 1]
  );

  for (const event of events) {
    switch (event.type) {
      case 'session/created':
        agents.set(event.sessionId, {
          sessionId: event.sessionId,
          parentSessionId: event.data.parentSessionId,
          role: 'primary',
          continuable: true,
          status,
        });
        break;
      case 'agent/created': {
        primaryAgentId = event.data.agentId;
        const current = agents.get(event.sessionId);
        agents.set(event.sessionId, {
          sessionId: event.sessionId,
          agentId: event.data.agentId,
          parentSessionId: current?.parentSessionId,
          role: current?.role ?? 'primary',
          continuable: current?.continuable ?? true,
          status: current?.status ?? status,
        });
        break;
      }
      case 'agent/status': {
        status = event.data.status;
        statusReason = event.data.reason;
        const current = agents.get(event.sessionId);
        agents.set(event.sessionId, {
          sessionId: event.sessionId,
          agentId: current?.agentId ?? primaryAgentId,
          parentSessionId: current?.parentSessionId,
          role: current?.role ?? 'primary',
          continuable: current?.continuable ?? true,
          status,
          summary: event.data.reason,
        });
        break;
      }
      case 'session/ended':
        status = event.data.status;
        statusReason = event.data.reason;
        break;
      case 'turn/start': {
        const turn = ensureTurn(event);
        turn.startedAt = event.timeUnixMs;
        turn.status = 'running';
        break;
      }
      case 'turn/end': {
        const turn = ensureTurn(event);
        turn.endedAt = event.timeUnixMs;
        turn.endReason = event.data.reason;
        turn.status = terminalStatusFromReason(event.data.reason);
        break;
      }
      case 'step/start': {
        const step = ensureStep(event);
        step.startedAt = event.timeUnixMs;
        step.status = 'running';
        break;
      }
      case 'step/end': {
        const step = ensureStep(event);
        step.endedAt = event.timeUnixMs;
        step.endReason = event.data.reason;
        step.status = terminalStatusFromReason(event.data.reason);
        break;
      }
      case 'request/header':
      case 'request/start': {
        if (event.type === 'request/header') headers.set(event.data.requestId, event.data);
        if (event.type === 'request/header' && event.data.snapshotReason !== undefined) break;
        const header = event.type === 'request/header'
          ? event.data
          : headers.get(event.data.headerRequestId);
        const step = ensureStep(event);
        const request: AgentActivityRequest = {
          requestId: event.data.requestId,
          providerId: event.data.providerId,
          model: event.data.model,
          reasoningEffort: event.data.reasoningEffort,
          reason: event.data.reason,
          series: event.data.series,
          systemPrompt: header?.systemPrompt ?? null,
          toolSchemas: header?.toolSchemas ?? null,
          attempt: event.data.attempt,
          startedAt: event.timeUnixMs,
          surfaceGeneration,
          ...(pendingRetryReason.has(event.data.requestId)
            ? { retryReason: pendingRetryReason.get(event.data.requestId) }
            : {}),
        };
        const existing = requestLocation.get(event.data.requestId);
        if (existing) {
          existing.step.requests[existing.index] = request;
        } else {
          requestLocation.set(event.data.requestId, { step, index: step.requests.length });
          step.requests.push(request);
        }
        break;
      }
      case 'request/context': {
        updateActivityRequest(event.data.requestId, event, (request) => ({
          ...request,
          inputTokens: event.data.inputTokens,
          contextWindow: event.data.contextWindow,
          surfaceGeneration: event.data.surfaceGeneration,
        }));
        inputTokens = event.data.inputTokens ?? inputTokens;
        contextWindow = event.data.contextWindow ?? contextWindow;
        surfaceGeneration = Math.max(surfaceGeneration, event.data.surfaceGeneration);
        break;
      }
      case 'request/retry': {
        pendingRetryReason.set(event.data.requestId, event.data.reason);
        updateActivityRequest(event.data.requestId, event, (request) => ({
          ...request,
          attempt: event.data.attempt,
          retryReason: event.data.reason,
        }));
        break;
      }
      case 'request/failure': {
        updateActivityRequest(event.data.requestId, event, (request) => withRequestTiming({
          ...request,
          finishReason: 'error',
          failure: event.data,
        }, event.timeUnixMs, event.data.interrupted));
        break;
      }
      case 'assistant/chunk': {
        updateActivityRequest(event.data.requestId, event, (request) => (
          withRequestTiming({
            ...request,
            ...(request.firstReasoningAt === undefined && event.data.reasoningDelta
              ? { firstReasoningAt: event.timeUnixMs }
              : {}),
            ...(request.firstTextAt === undefined && event.data.textDelta
              ? { firstTextAt: event.timeUnixMs }
              : {}),
            ...(event.data.usage ? { usage: event.data.usage } : {}),
          })
        ));
        break;
      }
      case 'assistant/message': {
        const step = ensureStep(event);
        const request = latestActivityRequest(step);
        if (request) {
          updateActivityRequest(request.requestId, event, (current) => withRequestTiming({
            ...current,
            usage: event.data.usage,
            finishReason: event.data.stopReason,
          }, event.timeUnixMs, event.data.interrupted));
        }
        break;
      }
      case 'request/usage': {
        updateActivityRequest(event.data.requestId, event, (request) => ({
            ...request,
            inputTokens: reportedInputTokens(event.data.usage) ?? request.inputTokens,
            usage: event.data.usage,
            outputTokens: event.data.usage.outputTokens,
            totalTokens: event.data.usage.totalTokens,
            finishReason: event.data.finishReason,
          }));
        break;
      }
      case 'tool/call': {
        const step = ensureStep(event);
        const tool: AgentActivityTool = {
          callId: event.data.call.callId,
          name: event.data.call.name,
          title: event.data.call.title ?? event.data.call.name,
          status: 'pending',
          effect: event.data.call.effect ?? 'unknown',
        };
        const location = { step, index: step.tools.length };
        toolLocation.set(toolEventKey(event.stepId, tool.callId), location);
        latestToolLocation.set(tool.callId, location);
        step.tools.push(tool);
        break;
      }
      case 'tool/approval':
        updateActivityTool(event.stepId, event.data.callId, (tool) => ({
          ...tool,
          status: approvalToolStatus(event.data.status),
          effect: event.data.risk ?? tool.effect,
        }));
        break;
      case 'tool/execution':
        updateActivityTool(event.stepId, event.data.callId, (tool) => ({
          ...tool,
          status: 'running',
        }));
        break;
      case 'tool/result':
        updateActivityTool(event.stepId, event.data.callId, (tool) => ({
          ...tool,
          status: event.data.status,
          durationMs: event.data.durationMs,
        }));
        break;
      case 'context/artifact':
        artifacts.push(event.data);
        break;
      case 'compaction/summary':
        compactionCount += 1;
        surfaceGeneration = Math.max(surfaceGeneration, event.data.surfaceGeneration);
        break;
      case 'compaction/end':
        if (event.data.status === 'completed') {
          surfaceGeneration = Math.max(surfaceGeneration, event.data.surfaceGeneration);
        }
        break;
      case 'subagent/descriptor':
        agents.set(event.data.childSessionId, {
          sessionId: event.data.childSessionId,
          parentSessionId: event.data.parentSessionId,
          descriptorId: event.data.descriptorId,
          role: event.data.role,
          continuable: event.data.continuable,
          depth: event.data.depth,
          inheritance: event.data.inheritance,
          capabilityScope: event.data.capabilityScope,
          targetScope: event.data.targetScope,
          budget: event.data.budget,
          status: 'running',
        });
        break;
      case 'subagent/settled': {
        const current = agents.get(event.data.childSessionId);
        agents.set(event.data.childSessionId, {
          sessionId: event.data.childSessionId,
          parentSessionId: current?.parentSessionId ?? event.sessionId,
          descriptorId: event.data.descriptorId,
          role: current?.role ?? 'subagent',
          continuable: current?.continuable ?? false,
          depth: current?.depth,
          inheritance: current?.inheritance,
          capabilityScope: current?.capabilityScope,
          targetScope: current?.targetScope,
          budget: current?.budget,
          status: event.data.status,
          summary: event.data.summary,
        });
        break;
      }
      case 'subagent/detached': {
        const current = agents.get(event.data.childSessionId);
        if (current) {
          agents.set(event.data.childSessionId, {
            ...current,
            detached: true,
            summary: current.summary ?? event.data.reason,
          });
        }
        break;
      }
      case 'task/plan':
        plan = event.data;
        break;
      case 'task/state':
        recovery = event.data.recovery ?? recovery;
        fleet = event.data.fleet ?? fleet;
        break;
      case 'task/evidence':
        evidenceCount += 1;
        break;
      default:
        break;
    }
  }

  const projectedTurns: AgentActivityTurn[] = turns.map((turn) => ({
    id: turn.id,
    index: turn.index,
    status: turn.status,
    startedAt: turn.startedAt,
    endedAt: turn.endedAt,
    durationMs: turn.startedAt !== undefined && turn.endedAt !== undefined
      ? Math.max(0, turn.endedAt - turn.startedAt)
      : undefined,
    endReason: turn.endReason,
    steps: turn.steps.map((step): AgentActivityStep => ({
      id: step.id,
      index: step.index,
      status: step.status,
      startedAt: step.startedAt,
      endedAt: step.endedAt,
      durationMs: step.startedAt !== undefined && step.endedAt !== undefined
        ? Math.max(0, step.endedAt - step.startedAt)
        : undefined,
      endReason: step.endReason,
      requests: step.requests,
      tools: step.tools,
    })),
  }));

  return {
    sessionId: events[0]?.sessionId,
    status,
    statusReason,
    turns: projectedTurns,
    plan,
    context: {
      inputTokens,
      contextWindow,
      surfaceGeneration,
      compactionCount,
      artifacts,
    },
    agents: [...agents.values()],
    recovery,
    fleet,
    evidenceCount,
  };
}

export function projectAgentActivity(
  events: readonly AgentSessionEvent[],
): AgentActivityProjection {
  validateCommittedAgentEventWindow(events);
  const projection = projectActivityUnchecked(events);
  return {
    ...projection,
    nodes: projectActivityNodesUnchecked(events),
  };
}
