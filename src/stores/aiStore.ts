import { create } from 'zustand';
import type { AiChatMessage, AiTaskKind } from '@/types/ai';
import { generateId } from '@/lib/utils';

export type AiPhase = 'idle' | 'streaming' | 'error';

interface AiState {
  open: boolean;
  messages: AiChatMessage[];
  phase: AiPhase;
  activeRequestId?: string;
  activeTask?: AiTaskKind;
  error?: string;
  setOpen: (open: boolean) => void;
  toggleOpen: () => void;
  beginRequest: (requestId: string, task: AiTaskKind, userContent: string) => void;
  appendDelta: (requestId: string, text: string) => void;
  completeRequest: (requestId: string) => void;
  cancelRequest: (requestId: string) => void;
  failRequest: (requestId: string, message: string) => void;
  clear: () => void;
}

export const useAiStore = create<AiState>()((set) => ({
  open: false,
  messages: [],
  phase: 'idle',
  setOpen: (open) => set({ open }),
  toggleOpen: () => set((state) => ({ open: !state.open })),
  beginRequest: (activeRequestId, activeTask, userContent) =>
    set((state) => ({
      open: true,
      phase: 'streaming',
      activeRequestId,
      activeTask,
      error: undefined,
      messages: [
        ...state.messages,
        { id: generateId(), role: 'user', content: userContent },
        { id: `assistant-${activeRequestId}`, role: 'assistant', content: '' },
      ],
    })),
  appendDelta: (requestId, text) =>
    set((state) => {
      if (state.activeRequestId !== requestId) return state;
      return {
        messages: state.messages.map((message) =>
          message.id === `assistant-${requestId}`
            ? { ...message, content: message.content + text }
            : message,
        ),
      };
    }),
  completeRequest: (requestId) =>
    set((state) =>
      state.activeRequestId === requestId
        ? { phase: 'idle', activeRequestId: undefined, activeTask: undefined }
        : state,
    ),
  cancelRequest: (requestId) =>
    set((state) =>
      state.activeRequestId === requestId
        ? {
            phase: 'idle',
            activeRequestId: undefined,
            activeTask: undefined,
            messages: state.messages.filter(
              (message) => message.id !== `assistant-${requestId}` || message.content.length > 0,
            ),
          }
        : state,
    ),
  failRequest: (requestId, error) =>
    set((state) =>
      state.activeRequestId === requestId
        ? { phase: 'error', activeRequestId: undefined, activeTask: undefined, error }
        : state,
    ),
  clear: () => set({ messages: [], phase: 'idle', activeRequestId: undefined, activeTask: undefined, error: undefined }),
}));
