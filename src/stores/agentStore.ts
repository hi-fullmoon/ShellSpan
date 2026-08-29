import { create } from 'zustand';
import { generateId } from '@/lib/utils';
import type {
  AgentChatMessage,
  AgentPermissionMode,
  AgentRunPhase,
  AgentRunRecord,
  AgentSafeFallback,
  AgentTargetSnapshot,
  AgentToolApprovalSnapshot,
  PersistedAgentRunState,
} from '@/types/agent';

export interface BeginAgentRunInput {
  readonly requestId: string;
  readonly conversationId?: string;
  readonly conversationStartedAt?: string;
  readonly goal: string;
  readonly providerId: string;
  readonly target: AgentTargetSnapshot;
  readonly targetTitle: string;
  readonly permissionMode: AgentPermissionMode;
}

interface AgentState {
  readonly messages: readonly AgentChatMessage[];
  readonly runs: Readonly<Record<string, AgentRunRecord>>;
  readonly tools: Readonly<Record<string, AgentToolApprovalSnapshot>>;
  readonly activeRequestId?: string;
  beginRun: (input: BeginAgentRunInput) => void;
  markStarted: (requestId: string, maxToolSteps: number, toolResultTimeoutMs: number) => void;
  setPhase: (requestId: string, phase: AgentRunPhase) => void;
  appendText: (requestId: string, text: string) => void;
  registerTool: (snapshot: AgentToolApprovalSnapshot) => void;
  updateTool: (snapshot: AgentToolApprovalSnapshot) => void;
  markFallback: (requestId: string, fallback: AgentSafeFallback) => void;
  markStepLimit: (requestId: string) => void;
  requestStop: (requestId: string) => void;
  completeRun: (requestId: string, fallback: boolean) => void;
  endIncomplete: (requestId: string) => void;
  cancelRun: (requestId: string) => void;
  failRun: (requestId: string, error: string) => void;
  hydrateConversation: (
    conversationId: string,
    states: readonly PersistedAgentRunState[],
  ) => void;
  clearConversation: (conversationId: string) => void;
  clear: () => void;
}

function toolKey(requestId: string, callId: string): string {
  return `${requestId}\u0000${callId}`;
}

function phaseForTool(snapshot: AgentToolApprovalSnapshot): AgentRunPhase {
  switch (snapshot.status) {
    case 'pending':
      return 'preparingCommand';
    case 'awaitingApproval':
      return 'awaitingApproval';
    case 'running':
      return 'executing';
    case 'completed':
    case 'rejected':
    case 'failed':
    case 'timedOut':
    case 'cancelled':
      return 'readingResult';
  }
}

function isTerminalToolStatus(status: AgentToolApprovalSnapshot['status']): boolean {
  return ['completed', 'rejected', 'failed', 'timedOut', 'cancelled'].includes(status);
}

function deriveCompletedState(
  run: AgentRunRecord,
  tools: Readonly<Record<string, AgentToolApprovalSnapshot>>,
  fallback: boolean,
): Pick<AgentRunRecord, 'phase' | 'status'> {
  if (fallback || run.fallback) return { phase: 'incomplete', status: 'incomplete' };
  const snapshots = run.toolCallIds
    .map((callId) => tools[toolKey(run.requestId, callId)])
    .filter((snapshot): snapshot is AgentToolApprovalSnapshot => Boolean(snapshot));
  if (snapshots.length === 0) return { phase: 'completed', status: 'completed' };
  const successful = snapshots.filter((snapshot) => (
    snapshot.status === 'completed' && snapshot.result?.exitCode === 0
  )).length;
  if (!run.stepLimitReached && successful === snapshots.length) {
    return { phase: 'completed', status: 'completed' };
  }
  if (successful > 0) return { phase: 'partial', status: 'partial' };
  return { phase: 'incomplete', status: 'incomplete' };
}

function finishAssistant(
  messages: readonly AgentChatMessage[],
  requestId: string,
  status: AgentChatMessage['status'],
): readonly AgentChatMessage[] {
  return messages
    .filter((message) => (
      message.id !== `agent-assistant-${requestId}`
      || Boolean(message.content.trim())
      || message.toolCallIds.length > 0
    ))
    .map((message) => (
      message.id === `agent-assistant-${requestId}`
        ? { ...message, status }
        : message
    ));
}

function updateRun(
  runs: AgentState['runs'],
  requestId: string,
  update: (run: AgentRunRecord) => AgentRunRecord,
): AgentState['runs'] {
  const run = runs[requestId];
  if (!run) return runs;
  return { ...runs, [requestId]: update(run) };
}

function recoverPersistedState(state: PersistedAgentRunState): PersistedAgentRunState {
  const interrupted = state.run.status === 'running';
  const run: AgentRunRecord = interrupted
    ? {
        ...state.run,
        phase: 'incomplete',
        status: 'cancelled',
        stopRequested: true,
        error: 'Agent task was cancelled during application restart.',
      }
    : { ...state.run };
  const messages = state.messages.map((message) => (
    message.status === 'streaming'
      ? { ...message, status: 'cancelled' as const }
      : { ...message }
  ));
  const tools = state.tools.map((snapshot) => {
    if (
      snapshot.status !== 'pending'
      && snapshot.status !== 'awaitingApproval'
      && snapshot.status !== 'running'
    ) {
      return { ...snapshot };
    }
    return {
      ...snapshot,
      approval: undefined,
      recoveredFromStatus: snapshot.status,
      status: 'cancelled' as const,
      result: {
        requestId: snapshot.toolCall.requestId,
        callId: snapshot.toolCall.callId,
        status: 'cancelled' as const,
        output: '',
      },
    };
  });
  return { run, messages, tools };
}

export const useAgentStore = create<AgentState>()((set) => ({
  messages: [],
  runs: {},
  tools: {},
  beginRun: (input) => set((state) => {
    const target = Object.freeze({ ...input.target });
    const run: AgentRunRecord = Object.freeze({
      requestId: input.requestId,
      conversationId: input.conversationId ?? input.target.sessionId,
      conversationStartedAt: input.conversationStartedAt ?? new Date(0).toISOString(),
      goal: input.goal,
      providerId: input.providerId,
      target,
      targetTitle: input.targetTitle,
      permissionMode: input.permissionMode,
      toolCallIds: Object.freeze([]),
      phase: 'analyzing',
      status: 'running',
      stopRequested: false,
    });
    return {
      activeRequestId: input.requestId,
      runs: { ...state.runs, [input.requestId]: run },
      messages: [
        ...state.messages,
        {
          id: generateId(),
          requestId: input.requestId,
          conversationId: input.conversationId ?? input.target.sessionId,
          role: 'user',
          content: input.goal,
          status: 'completed',
          providerId: input.providerId,
          target,
          toolCallIds: [],
        },
        {
          id: `agent-assistant-${input.requestId}`,
          requestId: input.requestId,
          conversationId: input.conversationId ?? input.target.sessionId,
          role: 'assistant',
          content: '',
          status: 'streaming',
          providerId: input.providerId,
          target,
          toolCallIds: [],
        },
      ],
    };
  }),
  markStarted: (requestId, maxToolSteps, toolResultTimeoutMs) => set((state) => ({
    runs: updateRun(state.runs, requestId, (run) => ({
      ...run,
      phase: 'analyzing',
      maxToolSteps,
      toolResultTimeoutMs,
    })),
  })),
  setPhase: (requestId, phase) => set((state) => ({
    runs: updateRun(state.runs, requestId, (run) => (
      run.status === 'running' ? { ...run, phase } : run
    )),
  })),
  appendText: (requestId, text) => set((state) => {
    if (state.activeRequestId !== requestId || !text) return state;
    return {
      messages: state.messages.map((message) => (
        message.id === `agent-assistant-${requestId}` && message.status === 'streaming'
          ? { ...message, content: message.content + text }
          : message
      )),
    };
  }),
  registerTool: (snapshot) => set((state) => {
    const { requestId, callId } = snapshot.toolCall;
    const run = state.runs[requestId];
    if (!run || run.status !== 'running') return state;
    const key = toolKey(requestId, callId);
    const toolCallIds = run.toolCallIds.includes(callId)
      ? run.toolCallIds
      : Object.freeze([...run.toolCallIds, callId]);
    return {
      tools: { ...state.tools, [key]: snapshot },
      runs: {
        ...state.runs,
        [requestId]: { ...run, toolCallIds, phase: phaseForTool(snapshot) },
      },
      messages: state.messages.map((message) => (
        message.id === `agent-assistant-${requestId}` && !message.toolCallIds.includes(callId)
          ? { ...message, toolCallIds: [...message.toolCallIds, callId] }
          : message
      )),
    };
  }),
  updateTool: (snapshot) => set((state) => {
    const { requestId, callId } = snapshot.toolCall;
    const key = toolKey(requestId, callId);
    const current = state.tools[key];
    if (!current || isTerminalToolStatus(current.status)) return state;
    return {
      tools: { ...state.tools, [key]: snapshot },
      runs: updateRun(state.runs, requestId, (run) => (
        run.status === 'running'
          ? { ...run, phase: phaseForTool(snapshot) }
          : run
      )),
    };
  }),
  markFallback: (requestId, fallback) => set((state) => ({
    runs: updateRun(state.runs, requestId, (run) => ({
      ...run,
      fallback,
      phase: 'preparingCommand',
    })),
  })),
  markStepLimit: (requestId) => set((state) => ({
    runs: updateRun(state.runs, requestId, (run) => ({
      ...run,
      stepLimitReached: true,
      phase: 'verifying',
    })),
  })),
  requestStop: (requestId) => set((state) => ({
    runs: updateRun(state.runs, requestId, (run) => ({ ...run, stopRequested: true })),
  })),
  completeRun: (requestId, fallback) => set((state) => {
    const run = state.runs[requestId];
    if (!run || run.status !== 'running') return state;
    const outcome = deriveCompletedState(run, state.tools, fallback);
    const assistant = state.messages.find((message) => (
      message.id === `agent-assistant-${requestId}`
    ));
    if (!assistant?.content.trim() && assistant?.toolCallIds.length === 0) {
      return {
        activeRequestId: state.activeRequestId === requestId ? undefined : state.activeRequestId,
        runs: {
          ...state.runs,
          [requestId]: {
            ...run,
            phase: 'incomplete',
            status: 'failed',
            error: 'AI provider returned an empty Agent response',
          },
        },
        messages: finishAssistant(state.messages, requestId, 'failed'),
      };
    }
    return {
      activeRequestId: state.activeRequestId === requestId ? undefined : state.activeRequestId,
      runs: { ...state.runs, [requestId]: { ...run, ...outcome } },
      messages: finishAssistant(state.messages, requestId, 'completed'),
    };
  }),
  endIncomplete: (requestId) => set((state) => {
    const run = state.runs[requestId];
    if (!run || run.status !== 'running') return state;
    return {
      activeRequestId: state.activeRequestId === requestId ? undefined : state.activeRequestId,
      runs: {
        ...state.runs,
        [requestId]: { ...run, phase: 'incomplete', status: 'incomplete' },
      },
      messages: finishAssistant(state.messages, requestId, 'completed'),
    };
  }),
  cancelRun: (requestId) => set((state) => {
    const run = state.runs[requestId];
    if (!run || run.status !== 'running') return state;
    return {
      activeRequestId: state.activeRequestId === requestId ? undefined : state.activeRequestId,
      runs: {
        ...state.runs,
        [requestId]: { ...run, phase: 'incomplete', status: 'cancelled' },
      },
      messages: finishAssistant(state.messages, requestId, 'cancelled'),
    };
  }),
  failRun: (requestId, error) => set((state) => {
    const run = state.runs[requestId];
    if (!run || run.status !== 'running') return state;
    return {
      activeRequestId: state.activeRequestId === requestId ? undefined : state.activeRequestId,
      runs: {
        ...state.runs,
        [requestId]: { ...run, phase: 'incomplete', status: 'failed', error },
      },
      messages: finishAssistant(state.messages, requestId, 'failed'),
    };
  }),
  hydrateConversation: (conversationId, persistedStates) => set((state) => {
    const recovered = persistedStates
      .map(recoverPersistedState)
      .filter((item) => item.run.conversationId === conversationId);
    const existingRequestIds = new Set(Object.values(state.runs)
      .filter((run) => run.conversationId === conversationId)
      .map((run) => run.requestId));
    const recoveredRequestIds = new Set(recovered.map((item) => item.run.requestId));
    const runs = Object.fromEntries(
      Object.entries(state.runs).filter(([, run]) => run.conversationId !== conversationId),
    );
    const tools = Object.fromEntries(
      Object.entries(state.tools).filter(([, tool]) => (
        !existingRequestIds.has(tool.toolCall.requestId)
      )),
    );
    for (const item of recovered) {
      runs[item.run.requestId] = item.run;
      for (const tool of item.tools) {
        tools[toolKey(tool.toolCall.requestId, tool.toolCall.callId)] = tool;
      }
    }
    const messageIds = new Set(
      recovered.flatMap((item) => item.messages.map((message) => message.id)),
    );
    return {
      runs,
      tools,
      messages: [
        ...recovered.flatMap((item) => item.messages),
        ...state.messages.filter((message) => (
          message.conversationId !== conversationId && !messageIds.has(message.id)
        )),
      ],
      activeRequestId: state.activeRequestId && recoveredRequestIds.has(state.activeRequestId)
        ? undefined
        : state.activeRequestId,
    };
  }),
  clearConversation: (conversationId) => set((state) => {
    const requestIds = new Set(Object.values(state.runs)
      .filter((run) => run.conversationId === conversationId)
      .map((run) => run.requestId));
    if (state.activeRequestId && requestIds.has(state.activeRequestId)) return state;
    return {
      messages: state.messages.filter((message) => message.conversationId !== conversationId),
      runs: Object.fromEntries(Object.entries(state.runs)
        .filter(([requestId]) => !requestIds.has(requestId))),
      tools: Object.fromEntries(Object.entries(state.tools)
        .filter(([, tool]) => !requestIds.has(tool.toolCall.requestId))),
    };
  }),
  clear: () => set((state) => state.activeRequestId
    ? state
    : { messages: [], runs: {}, tools: {} }),
}));

export function agentToolKey(requestId: string, callId: string): string {
  return toolKey(requestId, callId);
}
