import { create } from 'zustand';
import type { AiChatMessage, AiContext, AiConversation, AiSessionFile, AiTaskKind } from '@/types/ai';
import { generateId } from '@/lib/utils';

export type AiPhase = 'idle' | 'streaming' | 'error';

interface AiState {
  open: boolean;
  messages: AiChatMessage[];
  conversations: AiConversation[];
  loadedConversationIds: string[];
  phase: AiPhase;
  activeRequestId?: string;
  activeTask?: AiTaskKind;
  error?: string;
  errorRequestId?: string;
  setOpen: (open: boolean) => void;
  toggleOpen: () => void;
  beginRequest: (input: {
    requestId: string;
    task: AiTaskKind;
    userContent: string;
    providerId: string;
    conversationId?: string;
    sessionId?: string;
    context?: AiContext;
  }) => void;
  appendDelta: (requestId: string, text: string) => void;
  completeRequest: (requestId: string) => void;
  cancelRequest: (requestId: string) => void;
  failRequest: (requestId: string, message: string) => void;
  clearConversation: (
    conversationId: string | undefined,
    lane: 'conversation' | 'command',
  ) => void;
  hydrateSessionIndex: (conversations: AiConversation[]) => void;
  hydrateSession: (session: AiSessionFile) => void;
  hydrateSessions: (sessions: AiSessionFile[]) => void;
  upsertConversation: (conversation: AiConversation) => void;
  archiveConversation: (conversationId: string) => void;
  removeConversations: (conversationIds: string[]) => void;
  clear: () => void;
}

function messageLane(task: AiTaskKind): 'conversation' | 'command' {
  if (task === 'generateCommand') return 'command';
  return 'conversation';
}

export const useAiStore = create<AiState>()((set) => ({
  open: false,
  messages: [],
  conversations: [],
  loadedConversationIds: [],
  phase: 'idle',
  setOpen: (open) => set({ open }),
  toggleOpen: () => set((state) => ({ open: !state.open })),
  beginRequest: ({
    requestId: activeRequestId,
    task: activeTask,
    userContent,
    providerId,
    conversationId,
    sessionId,
    context,
  }) =>
    set((state) => ({
      open: true,
      phase: 'streaming',
      activeRequestId,
      activeTask,
      error: undefined,
      errorRequestId: undefined,
      messages: [
        ...state.messages,
        {
          id: generateId(),
          requestId: activeRequestId,
          role: 'user',
          content: userContent,
          task: activeTask,
          status: 'completed',
          providerId,
          conversationId,
          sessionId,
          context,
        },
        {
          id: `assistant-${activeRequestId}`,
          requestId: activeRequestId,
          role: 'assistant',
          content: '',
          task: activeTask,
          status: 'streaming',
          providerId,
          conversationId,
          sessionId,
        },
      ],
    })),
  appendDelta: (requestId, text) =>
    set((state) => {
      if (state.activeRequestId !== requestId) return state;
      return {
        messages: state.messages.map((message) =>
          message.id === `assistant-${requestId}`
            && message.status === 'streaming'
            ? { ...message, content: message.content + text }
            : message,
        ),
      };
    }),
  completeRequest: (requestId) =>
    set((state) => {
      if (state.activeRequestId !== requestId) return state;
      const assistant = state.messages.find((message) => message.id === `assistant-${requestId}`);
      if (!assistant?.content.trim()) {
        return {
          phase: 'error',
          activeRequestId: undefined,
          activeTask: undefined,
          error: 'AI provider returned an empty response',
          errorRequestId: requestId,
          messages: state.messages.filter((message) => message.id !== `assistant-${requestId}`),
        };
      }
      return {
        phase: 'idle',
        activeRequestId: undefined,
        activeTask: undefined,
        messages: state.messages.map((message) => (
          message.id === `assistant-${requestId}`
            ? { ...message, status: 'completed' as const }
            : message
        )),
      };
    }),
  cancelRequest: (requestId) =>
    set((state) =>
      state.activeRequestId === requestId
        ? {
            phase: 'idle',
            activeRequestId: undefined,
            activeTask: undefined,
            messages: state.messages
              .filter((message) => (
                message.id !== `assistant-${requestId}` || message.content.length > 0
              ))
              .map((message) => (
                message.id === `assistant-${requestId}`
                  ? { ...message, status: 'cancelled' as const }
                  : message
              )),
          }
        : state,
    ),
  failRequest: (requestId, error) =>
    set((state) =>
      state.activeRequestId === requestId
        ? {
            phase: 'error',
            activeRequestId: undefined,
            activeTask: undefined,
            error,
            errorRequestId: requestId,
            messages: state.messages
              .filter((message) => (
                message.id !== `assistant-${requestId}` || message.content.length > 0
              ))
              .map((message) => (
                message.id === `assistant-${requestId}`
                  ? { ...message, status: 'failed' as const }
                  : message
              )),
          }
        : state,
    ),
  clearConversation: (conversationId, lane) => set((state) => {
    const clearsFailedRequest = Boolean(
      state.errorRequestId
      && state.messages.some((message) => (
        message.requestId === state.errorRequestId
        && message.conversationId === conversationId
        && messageLane(message.task) === lane
      )),
    );
    const messages = state.messages.filter((message) => (
      message.conversationId !== conversationId || messageLane(message.task) !== lane
    ));
    return messages.length === state.messages.length
      ? state
      : {
          messages,
          ...(clearsFailedRequest ? { error: undefined, errorRequestId: undefined } : {}),
        };
  }),
  hydrateSessionIndex: (conversations) => set({
    conversations,
    loadedConversationIds: [],
  }),
  hydrateSession: (session) => set((state) => {
    const loadedIds = new Set(session.messages.map((message) => message.id));
    return {
      conversations: [
        session.conversation,
        ...state.conversations.filter((item) => item.id !== session.conversation.id),
      ],
      messages: [
        ...session.messages,
        ...state.messages.filter((message) => !loadedIds.has(message.id)),
      ],
      loadedConversationIds: state.loadedConversationIds.includes(session.conversation.id)
        ? state.loadedConversationIds
        : [...state.loadedConversationIds, session.conversation.id],
    };
  }),
  hydrateSessions: (sessions) => set((state) => {
    const loadedMessages = sessions.flatMap((session) => session.messages);
    const loadedIds = new Set(loadedMessages.map((message) => message.id));
    return {
      conversations: sessions.map((session) => session.conversation),
      messages: [
        ...loadedMessages,
        ...state.messages.filter((message) => !loadedIds.has(message.id)),
      ],
      loadedConversationIds: sessions.map((session) => session.conversation.id),
    };
  }),
  upsertConversation: (conversation) => set((state) => {
    const hasInMemoryMessages = state.messages.some((message) => (
      message.conversationId === conversation.id
    ));
    return {
      conversations: [
        conversation,
        ...state.conversations.filter((item) => item.id !== conversation.id),
      ],
      loadedConversationIds: hasInMemoryMessages
        && !state.loadedConversationIds.includes(conversation.id)
        ? [...state.loadedConversationIds, conversation.id]
        : state.loadedConversationIds,
    };
  }),
  archiveConversation: (conversationId) => set((state) => ({
    conversations: state.conversations.map((conversation) => (
      conversation.id === conversationId
        ? { ...conversation, archived: true, updatedAt: new Date().toISOString() }
        : conversation
    )),
  })),
  removeConversations: (conversationIds) => set((state) => {
    const removed = new Set(conversationIds);
    return {
      conversations: state.conversations.filter((conversation) => !removed.has(conversation.id)),
      messages: state.messages.filter((message) => (
        !message.conversationId || !removed.has(message.conversationId)
      )),
      loadedConversationIds: state.loadedConversationIds.filter((id) => !removed.has(id)),
    };
  }),
  clear: () => set({
    messages: [],
    conversations: [],
    loadedConversationIds: [],
    phase: 'idle',
    activeRequestId: undefined,
    activeTask: undefined,
    error: undefined,
    errorRequestId: undefined,
  }),
}));
