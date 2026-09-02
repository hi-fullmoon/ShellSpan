import {
  AGENT_SESSION_EVENT_VERSION,
  type AgentActivityAgent,
  type AgentActivityProjection,
  type AgentActivityRequest,
  type AgentActivityStep,
  type AgentActivityTool,
  type AgentActivityTurn,
  type AgentConversationItem,
  type AgentConversationMarkerItem,
  type AgentConversationProjection,
  type AgentConversationToolItem,
  type AgentSessionEvent,
  type AgentSessionProjection,
  type AgentSessionRuntimeStatus,
  type AgentSessionToolStatus,
} from '@/types/agent-session';

function validateEventWindow(events: readonly AgentSessionEvent[]): void {
  if (events.length === 0) return;
  const sessionId = events[0].sessionId;
  const firstSeq = events[0].seq;
  events.forEach((event, index) => {
    if (event.version !== AGENT_SESSION_EVENT_VERSION) {
      throw new Error(`Unsupported Agent Session event version at seq ${event.seq}`);
    }
    if (event.sessionId !== sessionId) {
      throw new Error('Agent Session projection cannot mix session ids');
    }
    if (!Number.isSafeInteger(event.seq) || event.seq !== firstSeq + index) {
      throw new Error('Agent Session events must be ordered and contiguous');
    }
    if (!Number.isSafeInteger(event.timeUnixMs) || event.timeUnixMs <= 0) {
      throw new Error(`Agent Session event ${event.seq} has an invalid timestamp`);
    }
  });
}

function messageItemId(messageId: string): string {
  return `message:${messageId}`;
}

export function agentSessionToolProjectionId(
  stepId: string | undefined,
  callId: string,
): string {
  return `tool:${stepId ?? 'unscoped'}:${callId}`;
}

function toolEventKey(stepId: string | undefined, callId: string): string {
  return `${stepId ?? 'unscoped'}\u0000${callId}`;
}

function assistantStreamId(event: AgentSessionEvent & { readonly type: 'assistant/chunk' }): string {
  return `assistant:${event.stepId ?? event.data.requestId}`;
}

function toolSummary(argumentsValue: unknown): string | undefined {
  if (!argumentsValue || typeof argumentsValue !== 'object') return undefined;
  const record = argumentsValue as Record<string, unknown>;
  const summary = record.explanation ?? record.summary ?? record.intent;
  return typeof summary === 'string' ? summary : undefined;
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

function projectConversationUnchecked(
  events: readonly AgentSessionEvent[],
): AgentConversationProjection {
  const items: AgentConversationItem[] = [];
  const itemIndex = new Map<string, number>();
  const inboxItemIds = new Map<string, string>();
  const toolItemIds = new Map<string, string>();
  const latestToolItemId = new Map<string, string>();

  const insert = (item: AgentConversationItem): void => {
    const existing = itemIndex.get(item.id);
    if (existing === undefined) {
      itemIndex.set(item.id, items.length);
      items.push(item);
      return;
    }
    items[existing] = item;
  };

  const marker = (item: AgentConversationMarkerItem): void => insert(item);

  const updateTool = (
    stepId: string | undefined,
    callId: string,
    update: (tool: AgentConversationToolItem) => AgentConversationToolItem,
  ): void => {
    const id = toolItemIds.get(toolEventKey(stepId, callId)) ?? latestToolItemId.get(callId);
    if (!id) return;
    const index = itemIndex.get(id);
    if (index === undefined || items[index].kind !== 'tool') return;
    items[index] = update(items[index]);
  };

  for (const event of events) {
    switch (event.type) {
      case 'agent/inbox/spliced': {
        for (const message of event.data.messages) {
          if (event.data.operation === 'enqueued') {
            if (event.data.lane === 'nextTurn' && message.source.kind === 'user') {
              const id = messageItemId(message.messageId);
              inboxItemIds.set(message.messageId, id);
              insert({
                kind: 'message',
                id,
                role: 'user',
                content: message.content,
                status: 'completed',
              });
            } else {
              const id = `inbox:${message.messageId}`;
              inboxItemIds.set(message.messageId, id);
              marker({
                kind: 'marker',
                id,
                marker: message.source.kind === 'runtime' ? 'runtime' : 'steer',
                detail: message.source.kind === 'runtime'
                  ? `${message.source.label}: ${message.content}`
                  : message.content,
                sessionId: message.source.kind === 'subagent'
                  ? message.source.sessionId
                  : undefined,
              });
            }
          } else if (event.data.operation === 'discarded') {
            marker({
              kind: 'marker',
              id: `discarded:${message.messageId}:${event.seq}`,
              marker: 'discarded',
              detail: message.content,
            });
          }
        }
        break;
      }
      case 'user/message': {
        const message = event.data.message;
        if (inboxItemIds.has(message.messageId)) break;
        if (message.source.kind === 'runtime' || message.source.kind === 'subagent') {
          marker({
            kind: 'marker',
            id: messageItemId(message.messageId),
            marker: message.source.kind === 'runtime' ? 'runtime' : 'steer',
            detail: message.source.kind === 'runtime'
              ? `${message.source.label}: ${message.content}`
              : message.content,
            sessionId: message.source.kind === 'subagent'
              ? message.source.sessionId
              : undefined,
            turnId: event.turnId,
            stepId: event.stepId,
          });
          break;
        }
        insert({
          kind: 'message',
          id: messageItemId(message.messageId),
          role: 'user',
          content: message.content,
          status: 'completed',
          turnId: event.turnId,
          stepId: event.stepId,
        });
        break;
      }
      case 'assistant/chunk': {
        const id = assistantStreamId(event);
        const existingIndex = itemIndex.get(id);
        const previous = existingIndex === undefined ? undefined : items[existingIndex];
        insert({
          kind: 'message',
          id,
          role: 'assistant',
          content: previous?.kind === 'message' ? previous.content + event.data.text : event.data.text,
          status: 'streaming',
          turnId: event.turnId,
          stepId: event.stepId,
        });
        break;
      }
      case 'assistant/message': {
        const streamId = event.stepId ? `assistant:${event.stepId}` : undefined;
        const id = streamId && itemIndex.has(streamId)
          ? streamId
          : messageItemId(event.data.messageId);
        if (!event.data.content && event.data.toolCalls.length > 0 && !itemIndex.has(id)) break;
        insert({
          kind: 'message',
          id,
          role: 'assistant',
          content: event.data.content,
          status: event.data.interrupted ? 'interrupted' : 'completed',
          turnId: event.turnId,
          stepId: event.stepId,
        });
        break;
      }
      case 'request/retry':
        marker({
          kind: 'marker',
          id: `retry:${event.seq}`,
          marker: 'retry',
          detail: event.data.reason,
          count: event.data.attempt,
          turnId: event.turnId,
          stepId: event.stepId,
        });
        break;
      case 'request/context':
        if (event.data.limited) {
          marker({
            kind: 'marker',
            id: `context-limited:${event.data.requestId}:${event.seq}`,
            marker: 'contextLimited',
            count: event.data.omittedMessages,
            turnId: event.turnId,
            stepId: event.stepId,
          });
        }
        break;
      case 'tool/call': {
        const { call } = event.data;
        const id = agentSessionToolProjectionId(event.stepId, call.callId);
        toolItemIds.set(toolEventKey(event.stepId, call.callId), id);
        latestToolItemId.set(call.callId, id);
        insert({
          kind: 'tool',
          id,
          callId: call.callId,
          name: call.name,
          title: call.title ?? call.name,
          summary: toolSummary(call.arguments),
          arguments: call.arguments,
          effect: call.effect ?? 'unknown',
          target: call.target,
          status: 'pending',
          evidenceRefs: [],
          turnId: event.turnId,
          stepId: event.stepId,
        });
        break;
      }
      case 'tool/approval':
        updateTool(event.stepId, event.data.callId, (tool) => ({
          ...tool,
          status: approvalToolStatus(event.data.status),
          approvalId: event.data.approvalId,
          approvalRequestId: event.data.requestId,
          approvalExpiresAtUnixMs: event.data.expiresAtUnixMs,
          approvalPrompt: event.data.prompt,
          effect: event.data.risk ?? tool.effect,
        }));
        break;
      case 'tool/execution':
        updateTool(event.stepId, event.data.callId, (tool) => ({
          ...tool,
          status: 'running',
        }));
        break;
      case 'tool/result':
        updateTool(event.stepId, event.data.callId, (tool) => ({
          ...tool,
          status: event.data.status,
          result: event.data.data,
          resultSummary: event.data.summary,
          evidenceRefs: event.data.evidenceRefs ?? [],
        }));
        break;
      case 'context/artifact':
        marker({
          kind: 'marker',
          id: `artifact:${event.data.artifactId}:${event.seq}`,
          marker: 'artifact',
          detail: event.data.title,
          turnId: event.turnId,
          stepId: event.stepId,
        });
        break;
      case 'compaction/summary':
        marker({
          kind: 'marker',
          id: `compaction:${event.data.surfaceGeneration}:${event.seq}`,
          marker: 'compaction',
          detail: event.data.summary,
          count: event.data.surfaceGeneration,
          turnId: event.turnId,
          stepId: event.stepId,
        });
        break;
      case 'subagent/settled':
        marker({
          kind: 'marker',
          id: `subagent-settled:${event.data.childSessionId}:${event.seq}`,
          marker: 'subagentSettled',
          detail: event.data.summary,
          sessionId: event.data.childSessionId,
          status: event.data.status,
          turnId: event.turnId,
          stepId: event.stepId,
        });
        break;
      case 'task/state':
        if (event.data.recovery && event.data.recovery.status !== 'none') {
          marker({
            kind: 'marker',
            id: `recovery:${event.seq}`,
            marker: 'recovery',
            detail: event.data.recovery.summary ?? event.data.recovery.status,
            turnId: event.turnId,
            stepId: event.stepId,
          });
        }
        break;
      case 'agent/status':
        if (event.data.status === 'failed' || event.data.status === 'cancelled') {
          marker({
            kind: 'marker',
            id: `agent-status:${event.seq}`,
            marker: event.data.status,
            detail: event.data.reason,
            status: event.data.status,
            turnId: event.turnId,
            stepId: event.stepId,
          });
        }
        break;
      case 'session/ended':
        if (event.data.reason || event.data.status !== 'completed') {
          marker({
            kind: 'marker',
            id: `session-ended:${event.seq}`,
            marker: event.data.status === 'cancelled' ? 'cancelled' : 'failed',
            detail: event.data.reason,
            status: event.data.status,
          });
        }
        break;
      case 'step/end':
        if (/max.?token/i.test(event.data.reason)) {
          marker({
            kind: 'marker',
            id: `max-tokens:${event.seq}`,
            marker: 'maxTokens',
            detail: event.data.reason,
            turnId: event.turnId,
            stepId: event.stepId,
          });
        }
        break;
      default:
        break;
    }
  }

  return {
    sessionId: events[0]?.sessionId,
    items,
    followKey: items.map((item) => {
      if (item.kind === 'message') return `${item.id}:${item.status}:${item.content.length}`;
      if (item.kind === 'tool') return `${item.id}:${item.status}:${item.resultSummary?.length ?? 0}`;
      return `${item.id}:${item.marker}:${item.detail?.length ?? 0}`;
    }).join('|'),
  };
}

interface MutableActivityStep {
  id: string;
  index: number;
  status: AgentSessionRuntimeStatus;
  startedAt?: number;
  endedAt?: number;
  endReason?: string;
  request?: AgentActivityRequest;
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

function projectActivityUnchecked(events: readonly AgentSessionEvent[]): AgentActivityProjection {
  const turns: MutableActivityTurn[] = [];
  const turnById = new Map<string, MutableActivityTurn>();
  const stepById = new Map<string, MutableActivityStep>();
  const requestStep = new Map<string, MutableActivityStep>();
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
      case 'request/header': {
        const step = ensureStep(event);
        step.request = {
          requestId: event.data.requestId,
          providerId: event.data.providerId,
          model: event.data.model,
          reasoningEffort: event.data.reasoningEffort,
          attempt: event.data.attempt ?? 1,
          surfaceGeneration,
        };
        requestStep.set(event.data.requestId, step);
        break;
      }
      case 'request/context': {
        const step = requestStep.get(event.data.requestId) ?? ensureStep(event);
        inputTokens = event.data.inputTokens ?? inputTokens;
        contextWindow = event.data.contextWindow ?? contextWindow;
        surfaceGeneration = Math.max(surfaceGeneration, event.data.surfaceGeneration);
        if (step.request) {
          step.request = {
            ...step.request,
            inputTokens: event.data.inputTokens,
            contextWindow: event.data.contextWindow,
            surfaceGeneration: event.data.surfaceGeneration,
          };
        }
        break;
      }
      case 'request/retry': {
        const step = requestStep.get(event.data.requestId) ?? ensureStep(event);
        if (step.request) step.request = { ...step.request, attempt: event.data.attempt };
        break;
      }
      case 'request/usage': {
        const step = requestStep.get(event.data.requestId) ?? ensureStep(event);
        if (step.request) {
          step.request = {
            ...step.request,
            inputTokens: event.data.inputTokens ?? step.request.inputTokens,
            outputTokens: event.data.outputTokens,
            totalTokens: event.data.totalTokens,
            finishReason: event.data.finishReason,
          };
        }
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
      request: step.request,
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

export function projectAgentConversation(
  events: readonly AgentSessionEvent[],
): AgentConversationProjection {
  validateEventWindow(events);
  return projectConversationUnchecked(events);
}

export function projectAgentActivity(
  events: readonly AgentSessionEvent[],
): AgentActivityProjection {
  validateEventWindow(events);
  return projectActivityUnchecked(events);
}

export function projectAgentSession(
  events: readonly AgentSessionEvent[],
): AgentSessionProjection {
  validateEventWindow(events);
  const conversation = projectConversationUnchecked(events);
  const activity = projectActivityUnchecked(events);
  let taskId: string | undefined;
  let goal: string | undefined;
  let permissionMode: AgentSessionProjection['permissionMode'];
  let latestRequestId: string | undefined;

  for (const event of events) {
    if (event.type === 'session/created') {
      taskId = event.data.taskId;
      goal = event.data.goal;
      permissionMode = event.data.permissionMode;
    } else if (event.type === 'task/linked') {
      taskId = event.data.taskId;
      goal = event.data.goal ?? goal;
    } else if (event.type === 'request/header') {
      latestRequestId = event.data.requestId;
    }
  }

  return {
    sessionId: events[0]?.sessionId,
    taskId,
    goal,
    permissionMode,
    status: activity.status,
    statusReason: activity.statusReason,
    latestRequestId,
    conversation,
    activity,
  };
}
