import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAiStore } from '@/stores/aiStore';
import type { AiChatMessage, AiConversation } from '@/types/ai';

const tauriMocks = vi.hoisted(() => ({
  append: vi.fn(),
  archive: vi.fn().mockResolvedValue(undefined),
  cancel: vi.fn().mockResolvedValue(undefined),
  clear: vi.fn().mockResolvedValue(undefined),
  create: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/tauri', () => ({
  invokeAppendAiSessionMessage: tauriMocks.append,
  invokeArchiveAiSession: tauriMocks.archive,
  invokeCancelAiRequest: tauriMocks.cancel,
  invokeClearAiSessionLane: tauriMocks.clear,
  invokeCreateAiSession: tauriMocks.create,
}));

import {
  clearPersistedAiConversation,
  flushAiSessionPersistence,
  persistAiMessage,
} from '../ai-sessions';

const conversation: AiConversation = {
  id: 'conversation-1',
  startedAt: '2026-08-22T09:00:00.000Z',
  updatedAt: '2026-08-22T09:00:00.000Z',
  title: 'root@example.com',
  archived: false,
  sessionId: 'session-1',
  host: 'example.com',
  port: 22,
  username: 'root',
};

const assistant: AiChatMessage = {
  id: 'assistant-request-1',
  requestId: 'request-1',
  role: 'assistant',
  content: 'Done',
  task: 'chat',
  status: 'completed',
  providerId: 'provider-1',
  conversationId: conversation.id,
  sessionId: 'session-1',
};

describe('AI session persistence queue', () => {
  beforeEach(async () => {
    await flushAiSessionPersistence();
    useAiStore.getState().clear();
    useAiStore.getState().upsertConversation(conversation);
    vi.clearAllMocks();
  });

  it('keeps append and clear events in logical order', async () => {
    let finishAppend: (() => void) | undefined;
    tauriMocks.append.mockImplementationOnce(() => new Promise<void>((resolve) => {
      finishAppend = resolve;
    }));

    const append = persistAiMessage(assistant);
    await Promise.resolve();
    await Promise.resolve();
    expect(tauriMocks.append).toHaveBeenCalledTimes(1);

    const clear = clearPersistedAiConversation(
      conversation.id,
      conversation.startedAt,
      'conversation',
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(tauriMocks.clear).not.toHaveBeenCalled();

    finishAppend?.();
    await Promise.all([append, clear]);
    expect(tauriMocks.clear).toHaveBeenCalledTimes(1);
  });
});
