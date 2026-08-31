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
  invokeDeleteAiSessions,
} from '@/lib/tauri';
import { createLogger } from '@/lib/logger';
import { generateId } from '@/lib/utils';
import { flushAiStreamDelta } from '@/lib/ai-stream-batcher';
import { redactTerminalSecrets } from '@/lib/terminal-output-buffer';
import {
  enqueueAiSessionPersistence,
  flushAiSessionPersistenceQueue,
} from '@/lib/ai-session-persistence-queue';
import {
  cancelAgentForSession,
  shutdownAgentLifecycle,
} from '@/lib/agent-lifecycle';
import { flushAgentSessionPersistence } from '@/lib/agent-sessions';

const logger = createLogger('aiSessions');

export function resolvedAiConversationScope(
  conversation: Pick<AiConversation, 'scope'>,
): 'workbench' | 'terminal' {
  return conversation.scope ?? 'terminal';
}

export function conversationFromTerminal(session: TerminalSession): AiConversation | undefined {
  if (!session.conversationId || !session.conversationStartedAt) return undefined;
  return {
    id: session.conversationId,
    startedAt: session.conversationStartedAt,
    updatedAt: session.conversationStartedAt,
    title: session.title,
    archived: false,
    scope: 'terminal',
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
    scope: 'terminal',
    sessionId: conversation.sessionId,
    profileId: conversation.profileId,
    host: conversation.host,
    port: conversation.port,
    username: conversation.username,
  };
  useAiStore.getState().upsertConversation(conversation);
  await enqueueAiSessionPersistence(conversation.id, () => invokeCreateAiSession(meta));
  return conversation;
}

export function ensureWorkbenchAiConversation(title: string): AiConversation {
  const ai = useAiStore.getState();
  const existing = ai.activeWorkbenchConversationId
    ? ai.conversations.find((conversation) => (
        conversation.id === ai.activeWorkbenchConversationId
        && resolvedAiConversationScope(conversation) === 'workbench'
        && !conversation.archived
      ))
    : undefined;
  if (existing) return existing;

  const timestamp = new Date().toISOString();
  const conversation: AiConversation = {
    id: generateId(),
    startedAt: timestamp,
    updatedAt: timestamp,
    title,
    archived: false,
    scope: 'workbench',
    host: '',
    port: 0,
    username: '',
  };
  const meta: AiSessionMeta = {
    id: conversation.id,
    timestamp,
    title,
    scope: 'workbench',
    host: '',
    port: 0,
    username: '',
  };
  ai.upsertConversation(conversation);
  ai.setActiveWorkbenchConversationId(conversation.id);
  const reboundMessages = ai.bindUnboundWorkbenchMessages(conversation.id);
  void enqueueAiSessionPersistence(conversation.id, () => invokeCreateAiSession(meta))
    .catch((error) => logger.warn('Failed to create Workbench AI conversation', error));
  for (const message of reboundMessages) {
    void persistAiMessage(message).catch((error) => {
      logger.warn('Failed to migrate an in-memory Workbench AI message', error);
    });
  }
  return conversation;
}

export function startNewWorkbenchAiConversation(title: string): string {
  const ai = useAiStore.getState();
  const previousConversationId = ai.activeWorkbenchConversationId;
  const previousConversation = previousConversationId
    ? ai.conversations.find((conversation) => conversation.id === previousConversationId)
    : undefined;

  if (previousConversation && !previousConversation.archived) {
    ai.archiveConversation(previousConversation.id);
    void enqueueAiSessionPersistence(previousConversation.id, () => (
      invokeArchiveAiSession(
        previousConversation.id,
        previousConversation.startedAt,
        'new_conversation',
      )
    )).catch((error) => logger.warn('Failed to archive previous Workbench AI conversation', error));
  }
  ai.setActiveWorkbenchConversationId(null);
  return ensureWorkbenchAiConversation(title).id;
}

export async function persistAiMessage(message: AiChatMessage): Promise<void> {
  if (!message.conversationId) return;
  const conversation = useAiStore
    .getState()
    .conversations.find((item) => item.id === message.conversationId);
  if (!conversation) return;
  const redactedMessage = {
    ...message,
    content: redactTerminalSecrets(message.content),
  };
  await enqueueAiSessionPersistence(conversation.id, () => (
    invokeAppendAiSessionMessage(conversation.id, conversation.startedAt, redactedMessage)
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
  lane: 'conversation' | 'command' | 'agent',
): Promise<void> {
  return enqueueAiSessionPersistence(conversationId, () => (
    invokeClearAiSessionLane(conversationId, startedAt, lane)
  ));
}

export async function deletePersistedAiConversations(
  conversations: Pick<AiConversation, 'id' | 'startedAt'>[],
): Promise<number> {
  await flushAiSessionPersistenceQueue();
  return invokeDeleteAiSessions(conversations.map(({ id, startedAt }) => ({ id, startedAt })));
}

export function startNewTerminalAiConversation(sessionId: string): string | undefined {
  const terminal = useTerminalStore
    .getState()
    .sessions.find((session) => session.sessionId === sessionId);
  if (!terminal) return undefined;

  const previousConversationId = terminal.conversationId;
  const previousStartedAt = terminal.conversationStartedAt;
  const ai = useAiStore.getState();
  const previousConversation = previousConversationId
    ? ai.conversations.find((conversation) => conversation.id === previousConversationId)
    : undefined;

  if (previousConversationId && previousStartedAt && previousConversation) {
    ai.archiveConversation(previousConversationId);
    void enqueueAiSessionPersistence(previousConversationId, () => (
      invokeArchiveAiSession(previousConversationId, previousStartedAt, 'new_conversation')
    )).catch((error) => logger.warn('Failed to archive previous AI conversation', error));
  }

  useTerminalStore.getState().startNewConversation(sessionId);
  return useTerminalStore
    .getState()
    .sessions.find((session) => session.sessionId === sessionId)
    ?.conversationId;
}

export async function flushAiSessionPersistence(): Promise<void> {
  await flushAiSessionPersistenceQueue();
}

export async function finalizeAiSessionsBeforeExit(): Promise<void> {
  await shutdownAgentLifecycle();
  await flushAgentSessionPersistence();
  const ai = useAiStore.getState();
  const requestId = ai.activeRequestId;
  if (requestId) {
    flushAiStreamDelta(requestId);
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
  const agentFinalization = cancelAgentForSession(sessionId)
    .then(() => flushAgentSessionPersistence())
    .catch((error) => {
      logger.warn('Failed to finalize Agent task for closed terminal', error);
    });

  const ai = useAiStore.getState();
  const activeRequestId = ai.activeRequestId;
  const activeMessage = activeRequestId
    ? ai.messages.find((message) => (
        message.requestId === activeRequestId
        && message.conversationId === conversationId
      ))
    : undefined;
  if (activeRequestId && activeMessage) {
    flushAiStreamDelta(activeRequestId);
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
  void agentFinalization.then(() => enqueueAiSessionPersistence(conversationId, () => (
    invokeArchiveAiSession(conversationId, conversationStartedAt)
  )))
    .catch((error) => logger.warn('Failed to archive AI session', error));
}
