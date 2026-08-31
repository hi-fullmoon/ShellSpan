import { create } from 'zustand';
import type {
  AiChatMessage,
  AiContext,
  AiConversation,
  AiConversationScope,
  AiSessionFile,
  AiTaskKind,
} from '@/types/ai';
import type { AppSection } from '@/types';
import { generateId } from '@/lib/utils';

export type AiPhase = 'idle' | 'streaming' | 'error';
export type AiPanelSection = AiConversationScope;

function latestActiveWorkbenchConversationId(conversations: AiConversation[]): string | null {
  return conversations
    .filter((conversation) => conversation.scope === 'workbench' && !conversation.archived)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0]?.id ?? null;
}

interface AiState {
  panelOpenBySection: Record<AiPanelSection, boolean>;
  messages: AiChatMessage[];
  conversations: AiConversation[];
  activeWorkbenchConversationId: string | null;
  loadedConversationIds: string[];
  phase: AiPhase;
  activeRequestId?: string;
  activeTask?: AiTaskKind;
  error?: string;
  errorRequestId?: string;
  setOpen: (open: boolean, section?: AiPanelSection) => void;
  toggleOpen: (section?: AiPanelSection) => void;
  beginRequest: (input: {
    requestId: string;
    task: AiTaskKind;
    userContent: string;
    providerId: string;
    scope?: AiPanelSection;
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
    scope?: AppSection,
  ) => void;
  hydrateSessionIndex: (conversations: AiConversation[]) => void;
  hydrateSession: (session: AiSessionFile) => void;
  hydrateSessions: (sessions: AiSessionFile[]) => void;
  upsertConversation: (conversation: AiConversation) => void;
  setActiveWorkbenchConversationId: (conversationId: string | null) => void;
  bindUnboundWorkbenchMessages: (conversationId: string) => AiChatMessage[];
  archiveConversation: (conversationId: string) => void;
  removeConversations: (conversationIds: string[]) => void;
  clear: () => void;
}

function messageLane(task: AiTaskKind): 'conversation' | 'command' {
  if (task === 'generateCommand') return 'command';
  return 'conversation';
}

export const useAiStore = create<AiState>()((set) => ({
  panelOpenBySection: {
    workbench: false,
    terminal: false,
  },
  messages: [],
  conversations: [],
  activeWorkbenchConversationId: null,
  loadedConversationIds: [],
  phase: 'idle',
  setOpen: (open, section) => set((state) => ({
    panelOpenBySection: section
      ? { ...state.panelOpenBySection, [section]: open }
      : { workbench: open, terminal: open },
  })),
  toggleOpen: (section) => set((state) => {
    if (!section) {
      const open = !Object.values(state.panelOpenBySection).some(Boolean);
      return { panelOpenBySection: { workbench: open, terminal: open } };
    }
    return {
      panelOpenBySection: {
        ...state.panelOpenBySection,
        [section]: !state.panelOpenBySection[section],
      },
    };
  }),
  beginRequest: ({
    requestId: activeRequestId,
    task: activeTask,
    userContent,
    providerId,
    scope,
    conversationId,
    sessionId,
    context,
  }) =>
    set((state) => ({
      panelOpenBySection: scope
        ? { ...state.panelOpenBySection, [scope]: true }
        : { workbench: true, terminal: true },
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
          scope,
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
          scope,
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
  clearConversation: (conversationId, lane, scope) => set((state) => {
    const clearsFailedRequest = Boolean(
      state.errorRequestId
      && state.messages.some((message) => (
        message.requestId === state.errorRequestId
        && message.conversationId === conversationId
        && messageLane(message.task) === lane
        && (conversationId !== undefined || scope === undefined || (message.scope ?? 'workbench') === scope)
      )),
    );
    const messages = state.messages.filter((message) => (
      message.conversationId !== conversationId
      || messageLane(message.task) !== lane
      || (conversationId === undefined
        && scope !== undefined
        && (message.scope ?? 'workbench') !== scope)
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
    activeWorkbenchConversationId: latestActiveWorkbenchConversationId(conversations),
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
    return {
      conversations: [
        conversation,
        ...state.conversations.filter((item) => item.id !== conversation.id),
      ],
      // upsertConversation is used only for the active, locally owned session.
      // Mark even an empty conversation as loaded so the history loader cannot
      // race a just-created Agent session and block its pending submission.
      loadedConversationIds: !state.loadedConversationIds.includes(conversation.id)
        ? [...state.loadedConversationIds, conversation.id]
        : state.loadedConversationIds,
    };
  }),
  setActiveWorkbenchConversationId: (activeWorkbenchConversationId) => set({
    activeWorkbenchConversationId,
  }),
  bindUnboundWorkbenchMessages: (conversationId) => {
    const rebound: AiChatMessage[] = [];
    set((state) => ({
      messages: state.messages.map((message) => {
        if (
          message.conversationId
          || message.sessionId
          || (message.scope ?? 'workbench') !== 'workbench'
        ) return message;
        const nextMessage = {
          ...message,
          scope: 'workbench' as const,
          conversationId,
        };
        rebound.push(nextMessage);
        return nextMessage;
      }),
    }));
    return rebound;
  },
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
      activeWorkbenchConversationId: state.activeWorkbenchConversationId
        && removed.has(state.activeWorkbenchConversationId)
        ? null
        : state.activeWorkbenchConversationId,
    };
  }),
  clear: () => set({
    messages: [],
    conversations: [],
    loadedConversationIds: [],
    activeWorkbenchConversationId: null,
    phase: 'idle',
    activeRequestId: undefined,
    activeTask: undefined,
    error: undefined,
    errorRequestId: undefined,
  }),
}));
