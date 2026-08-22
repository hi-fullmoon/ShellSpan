import { create } from 'zustand';
import type { AiChatMessage, AiContext, AiTaskKind } from '@/types/ai';
import { generateId } from '@/lib/utils';

export type AiPhase = 'idle' | 'streaming' | 'error';

interface AiState {
  open: boolean;
  messages: AiChatMessage[];
  phase: AiPhase;
  activeRequestId?: string;
  activeTask?: AiTaskKind;
  error?: string;
  errorRequestId?: string;
  setOpen: (open: boolean) => void;
  toggleOpen: () => void;
  beginRequest: (input: {
    requestId: string;
    task: Exclude<AiTaskKind, 'diagnosticAgent'>;
    userContent: string;
    providerId: string;
    sessionId?: string;
    context?: AiContext;
  }) => void;
  appendDelta: (requestId: string, text: string) => void;
  completeRequest: (requestId: string) => void;
  cancelRequest: (requestId: string) => void;
  failRequest: (requestId: string, message: string) => void;
  clearConversation: (
    sessionId: string | undefined,
    lane: 'conversation' | 'command',
  ) => void;
  clear: () => void;
}

function messageLane(task: AiTaskKind): 'conversation' | 'command' | 'agent' {
  if (task === 'generateCommand') return 'command';
  if (task === 'diagnosticAgent') return 'agent';
  return 'conversation';
}

export const useAiStore = create<AiState>()((set) => ({
  open: false,
  messages: [],
  phase: 'idle',
  setOpen: (open) => set({ open }),
  toggleOpen: () => set((state) => ({ open: !state.open })),
  beginRequest: ({
    requestId: activeRequestId,
    task: activeTask,
    userContent,
    providerId,
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
  clearConversation: (sessionId, lane) => set((state) => {
    const clearsFailedRequest = Boolean(
      state.errorRequestId
      && state.messages.some((message) => (
        message.requestId === state.errorRequestId
        && message.sessionId === sessionId
        && messageLane(message.task) === lane
      )),
    );
    const messages = state.messages.filter((message) => (
      message.sessionId !== sessionId || messageLane(message.task) !== lane
    ));
    return messages.length === state.messages.length
      ? state
      : {
          messages,
          ...(clearsFailedRequest ? { error: undefined, errorRequestId: undefined } : {}),
        };
  }),
  clear: () => set({
    messages: [],
    phase: 'idle',
    activeRequestId: undefined,
    activeTask: undefined,
    error: undefined,
    errorRequestId: undefined,
  }),
}));
