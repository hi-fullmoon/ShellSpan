import { enqueueAiSessionPersistence } from '@/lib/ai-session-persistence-queue';
import { createLogger } from '@/lib/logger';
import { redactSensitiveValue } from '@/lib/terminal-output-buffer';
import {
  invokeAppendAiSessionAgentState,
  invokeClearAiSessionLane,
} from '@/lib/tauri';
import { agentToolKey, useAgentStore } from '@/stores/agentStore';
import { auditRecoveredAgentTool } from '@/lib/agent-recovery-audit';
import type { AiSessionFile } from '@/types/ai';
import type { PersistedAgentRunState } from '@/types/agent';

const logger = createLogger('agentSessions');
const PERSIST_DEBOUNCE_MS = 100;
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const inFlight = new Set<Promise<void>>();
let unsubscribe: (() => void) | undefined;
let hydrating = false;

function snapshotForRun(requestId: string): PersistedAgentRunState | undefined {
  const state = useAgentStore.getState();
  const run = state.runs[requestId];
  if (!run) return undefined;
  const messages = state.messages.filter((message) => message.requestId === requestId);
  const tools = run.toolCallIds.flatMap((callId) => {
    const snapshot = state.tools[agentToolKey(requestId, callId)];
    if (!snapshot) return [];
    const { approval: _approval, ...persistable } = snapshot;
    return [persistable];
  });
  return redactSensitiveValue({ run, messages, tools });
}

function track(operation: Promise<void>): Promise<void> {
  inFlight.add(operation);
  const cleanup = (): void => {
    inFlight.delete(operation);
  };
  void operation.then(cleanup, cleanup);
  return operation;
}

export function persistAgentRunState(requestId: string): Promise<void> {
  const snapshot = snapshotForRun(requestId);
  if (!snapshot) return Promise.resolve();
  const operation = enqueueAiSessionPersistence(snapshot.run.conversationId, () => (
    invokeAppendAiSessionAgentState(
      snapshot.run.conversationId,
      snapshot.run.conversationStartedAt,
      snapshot,
    )
  ));
  return track(operation);
}

export function stageAgentRunPersistence(requestId: string): void {
  const existing = timers.get(requestId);
  if (existing) clearTimeout(existing);
  timers.set(requestId, setTimeout(() => {
    timers.delete(requestId);
    void persistAgentRunState(requestId).catch((error) => {
      logger.warn('Failed to persist Agent run state', error);
    });
  }, PERSIST_DEBOUNCE_MS));
}

export function initializeAgentSessionPersistence(): () => void {
  if (unsubscribe) return unsubscribe;
  unsubscribe = useAgentStore.subscribe((state, previous) => {
    if (hydrating || (
      state.runs === previous.runs
      && state.messages === previous.messages
      && state.tools === previous.tools
    )) return;
    const changed = new Set<string>();
    for (const [requestId, run] of Object.entries(state.runs)) {
      if (previous.runs[requestId] !== run) changed.add(requestId);
    }
    const previousMessages = new Map(previous.messages.map((message) => [message.id, message]));
    for (const message of state.messages) {
      if (previousMessages.get(message.id) !== message) changed.add(message.requestId);
    }
    for (const [key, tool] of Object.entries(state.tools)) {
      if (previous.tools[key] !== tool) changed.add(tool.toolCall.requestId);
    }
    for (const requestId of changed) stageAgentRunPersistence(requestId);
  });
  return unsubscribe;
}

export function hydrateAgentSession(session: AiSessionFile): void {
  const state = useAgentStore.getState();
  const active = state.activeRequestId ? state.runs[state.activeRequestId] : undefined;
  if (active?.conversationId === session.conversation.id) return;
  hydrating = true;
  try {
    useAgentStore.getState().hydrateConversation(
      session.conversation.id,
      session.agentStates ?? [],
    );
    const recoveredState = useAgentStore.getState();
    for (const item of session.agentStates ?? []) {
      const recovered = recoveredState.runs[item.run.requestId];
      if (recovered?.conversationId !== session.conversation.id) continue;
      for (const callId of recovered.toolCallIds) {
        const tool = recoveredState.tools[agentToolKey(recovered.requestId, callId)];
        if (tool?.recoveredFromStatus) auditRecoveredAgentTool(tool);
      }
    }
  } finally {
    hydrating = false;
  }
}

export async function flushAgentSessionPersistence(): Promise<void> {
  const requestIds = [...timers.keys()];
  for (const requestId of requestIds) {
    const timer = timers.get(requestId);
    if (timer) clearTimeout(timer);
    timers.delete(requestId);
    await persistAgentRunState(requestId);
  }
  while (inFlight.size > 0) {
    await Promise.allSettled([...inFlight]);
  }
}

export async function clearAgentConversationData(
  conversationId: string,
  startedAt: string,
): Promise<void> {
  const state = useAgentStore.getState();
  const active = state.activeRequestId
    ? state.runs[state.activeRequestId]
    : undefined;
  if (active?.conversationId === conversationId) {
    throw new Error('Active Agent task must be cancelled before clearing its lane.');
  }
  await flushAgentSessionPersistence();
  await enqueueAiSessionPersistence(conversationId, () => (
    invokeClearAiSessionLane(conversationId, startedAt, 'agent')
  ));
  useAgentStore.getState().clearConversation(conversationId);
}

export function agentRequestIdsForSession(sessionId: string): string[] {
  return Object.values(useAgentStore.getState().runs)
    .filter((run) => run.target.sessionId === sessionId && run.status === 'running')
    .map((run) => run.requestId);
}
