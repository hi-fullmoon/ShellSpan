import type { AiChatMessage, AiConversation, AiSessionMeta } from '@/types/ai';
import type { TerminalSession } from '@/stores/terminalStore';
import { useAiStore } from '@/stores/aiStore';
import { useTerminalStore } from '@/stores/terminalStore';
import {
  invokeAppendAiSessionMessage,
  invokeArchiveAiSession,
  invokeCancelAiRequest,
  invokeClearAiSessionLane,
  invokeCreateAiSession,
} from '@/lib/tauri';
import { createLogger } from '@/lib/logger';

const logger = createLogger('aiSessions');
const persistenceQueues = new Map<string, Promise<void>>();

function enqueuePersistence(
  conversationId: string,
  operation: () => Promise<void>,
): Promise<void> {
  const previous = persistenceQueues.get(conversationId) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(operation);
  persistenceQueues.set(conversationId, next);
  const cleanup = (): void => {
    if (persistenceQueues.get(conversationId) === next) {
      persistenceQueues.delete(conversationId);
    }
  };
  void next.then(cleanup, cleanup);
  return next;
}

export function conversationFromTerminal(session: TerminalSession): AiConversation | undefined {
  if (!session.conversationId || !session.conversationStartedAt) return undefined;
  return {
    id: session.conversationId,
    startedAt: session.conversationStartedAt,
    updatedAt: session.conversationStartedAt,
    title: session.title,
    archived: false,
    sessionId: session.sessionId,
    profileId: session.profileId,
    host: session.host,
    port: session.port,
    username: session.username,
  };
}

export async function ensureAiSessionFile(session: TerminalSession): Promise<AiConversation | undefined> {
  const baseConversation = conversationFromTerminal(session);
  if (!baseConversation) return undefined;
  const existing = useAiStore
    .getState()
    .conversations.find((item) => item.id === baseConversation.id);
  const conversation = existing
    ? { ...baseConversation, updatedAt: existing.updatedAt, archived: false }
    : baseConversation;
  const meta: AiSessionMeta = {
    id: conversation.id,
    timestamp: conversation.startedAt,
    title: conversation.title,
    sessionId: conversation.sessionId,
    profileId: conversation.profileId,
    host: conversation.host,
    port: conversation.port,
    username: conversation.username,
  };
  useAiStore.getState().upsertConversation(conversation);
  await enqueuePersistence(conversation.id, () => invokeCreateAiSession(meta));
  return conversation;
}

export async function persistAiMessage(message: AiChatMessage): Promise<void> {
  if (!message.conversationId) return;
  const conversation = useAiStore
    .getState()
    .conversations.find((item) => item.id === message.conversationId);
  if (!conversation) return;
  await enqueuePersistence(conversation.id, () => (
    invokeAppendAiSessionMessage(conversation.id, conversation.startedAt, message)
  ));
  const latestConversation = useAiStore
    .getState()
    .conversations.find((item) => item.id === conversation.id) ?? conversation;
  useAiStore.getState().upsertConversation({
    ...latestConversation,
    updatedAt: new Date().toISOString(),
  });
}

export async function clearPersistedAiConversation(
  conversationId: string,
  startedAt: string,
  lane: 'conversation' | 'command',
): Promise<void> {
  return enqueuePersistence(conversationId, () => (
    invokeClearAiSessionLane(conversationId, startedAt, lane)
  ));
}

export async function flushAiSessionPersistence(): Promise<void> {
  while (persistenceQueues.size > 0) {
    await Promise.allSettled([...persistenceQueues.values()]);
  }
}

export async function finalizeAiSessionsBeforeExit(): Promise<void> {
  const ai = useAiStore.getState();
  const requestId = ai.activeRequestId;
  if (requestId) {
    ai.cancelRequest(requestId);
    const partialAssistant = useAiStore.getState().messages.find((message) => (
      message.id === `assistant-${requestId}` && message.content.length > 0
    ));
    if (partialAssistant) {
      await persistAiMessage(partialAssistant).catch((error) => {
        logger.warn('Failed to persist AI response before exit', error);
      });
    }
    await invokeCancelAiRequest(requestId).catch((error) => {
      logger.warn('Failed to cancel AI request before exit', error);
    });
  }
  await flushAiSessionPersistence();
}

export function archiveTerminalAiSession(sessionId: string): void {
  const session = useTerminalStore
    .getState()
    .sessions.find((item) => item.sessionId === sessionId);
  if (!session?.conversationId || !session.conversationStartedAt) return;
  const conversationId = session.conversationId;
  const conversationStartedAt = session.conversationStartedAt;

  const ai = useAiStore.getState();
  const activeRequestId = ai.activeRequestId;
  const activeMessage = activeRequestId
    ? ai.messages.find((message) => (
        message.requestId === activeRequestId
        && message.conversationId === conversationId
      ))
    : undefined;
  if (activeRequestId && activeMessage) {
    ai.cancelRequest(activeRequestId);
    const partialAssistant = useAiStore.getState().messages.find((message) => (
      message.id === `assistant-${activeRequestId}` && message.content.length > 0
    ));
    if (partialAssistant) {
      void persistAiMessage(partialAssistant).catch((error) => {
        logger.warn('Failed to persist cancelled AI response', error);
      });
    }
    void invokeCancelAiRequest(activeRequestId).catch((error) => {
      logger.warn('Failed to cancel AI request for closed terminal', error);
    });
  }

  ai.archiveConversation(conversationId);
  void enqueuePersistence(conversationId, () => (
    invokeArchiveAiSession(conversationId, conversationStartedAt)
  ))
    .catch((error) => logger.warn('Failed to archive AI session', error));
}
