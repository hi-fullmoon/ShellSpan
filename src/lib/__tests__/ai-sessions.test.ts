import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAiStore } from '@/stores/aiStore';
import { useTerminalStore } from '@/stores/terminalStore';
import { registerAgentLifecycleHandlers } from '@/lib/agent-lifecycle';
import type { AiChatMessage, AiConversation } from '@/types/ai';
import {
  createAiStreamDeltaBatcher,
  registerAiStreamDeltaBatcher,
} from '@/lib/ai-stream-batcher';

const tauriMocks = vi.hoisted(() => ({
  append: vi.fn(),
  archive: vi.fn().mockResolvedValue(undefined),
  cancel: vi.fn().mockResolvedValue(undefined),
  clear: vi.fn().mockResolvedValue(undefined),
  create: vi.fn().mockResolvedValue(undefined),
  deleteSessions: vi.fn().mockResolvedValue(1),
}));

vi.mock('@/lib/tauri', () => ({
  invokeAppendAiSessionMessage: tauriMocks.append,
  invokeArchiveAiSession: tauriMocks.archive,
  invokeCancelAiRequest: tauriMocks.cancel,
  invokeClearAiSessionLane: tauriMocks.clear,
  invokeCreateAiSession: tauriMocks.create,
  invokeDeleteAiSessions: tauriMocks.deleteSessions,
}));

import {
  archiveTerminalAiSession,
  clearPersistedAiConversation,
  deletePersistedAiConversations,
  finalizeAiSessionsBeforeExit,
  flushAiSessionPersistence,
  ensureWorkbenchAiConversation,
  persistAiMessage,
  startNewTerminalAiConversation,
  startNewWorkbenchAiConversation,
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
    useTerminalStore.setState({ sessions: [], activeSessionId: null });
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

  it('redacts secrets in the persisted copy without mutating the visible message', async () => {
    const sensitive = {
      ...assistant,
      content: 'PASSWORD=hunter2\nAuthorization: Bearer token-value',
    };

    await persistAiMessage(sensitive);

    expect(tauriMocks.append).toHaveBeenCalledWith(
      conversation.id,
      conversation.startedAt,
      expect.objectContaining({
        content: 'PASSWORD=[REDACTED]\nAuthorization: Bearer [REDACTED]',
      }),
    );
    expect(sensitive.content).toContain('hunter2');
  });

  it('flushes buffered stream text before persisting on exit', async () => {
    useAiStore.getState().beginRequest({
      requestId: 'request-exit',
      task: 'chat',
      userContent: 'Question',
      providerId: 'provider-1',
      conversationId: conversation.id,
      sessionId: conversation.sessionId,
    });
    const batcher = createAiStreamDeltaBatcher(
      (requestId, text) => useAiStore.getState().appendDelta(requestId, text),
      vi.fn(() => 11),
      vi.fn(),
    );
    const unregister = registerAiStreamDeltaBatcher(batcher);

    try {
      batcher.push('request-exit', 'Buffered ending');
      await finalizeAiSessionsBeforeExit();

      expect(tauriMocks.append).toHaveBeenCalledWith(
        conversation.id,
        conversation.startedAt,
        expect.objectContaining({
          id: 'assistant-request-exit',
          content: 'Buffered ending',
          status: 'cancelled',
        }),
      );
      expect(tauriMocks.cancel).toHaveBeenCalledWith('request-exit');
    } finally {
      unregister();
      batcher.dispose();
    }
  });

  it('awaits Agent shutdown before final exit persistence completes', async () => {
    const shutdown = vi.fn().mockResolvedValue(undefined);
    const unregister = registerAgentLifecycleHandlers({
      cancelForSession: vi.fn().mockResolvedValue(undefined),
      shutdown,
    });

    try {
      await finalizeAiSessionsBeforeExit();
      expect(shutdown).toHaveBeenCalledTimes(1);
    } finally {
      unregister();
    }
  });

  it('cancels the Agent lane before archiving a closed terminal conversation', async () => {
    let finishCancellation: (() => void) | undefined;
    const cancelForSession = vi.fn(() => new Promise<void>((resolve) => {
      finishCancellation = resolve;
    }));
    const unregister = registerAgentLifecycleHandlers({
      cancelForSession,
      shutdown: vi.fn().mockResolvedValue(undefined),
    });
    useTerminalStore.setState({
      sessions: [{
        sessionId: 'session-1',
        title: conversation.title,
        host: conversation.host,
        port: conversation.port,
        username: conversation.username,
        status: 'connected',
        conversationId: conversation.id,
        conversationStartedAt: conversation.startedAt,
      }],
      activeSessionId: 'session-1',
    });

    try {
      archiveTerminalAiSession('session-1');
      expect(cancelForSession).toHaveBeenCalledWith('session-1');
      expect(tauriMocks.archive).not.toHaveBeenCalled();
      finishCancellation?.();
      await vi.waitFor(() => expect(tauriMocks.archive).toHaveBeenCalledWith(
        conversation.id,
        conversation.startedAt,
      ));
    } finally {
      unregister();
    }
  });

  it('waits for pending writes before deleting persisted conversations', async () => {
    let finishAppend: (() => void) | undefined;
    tauriMocks.append.mockImplementationOnce(() => new Promise<void>((resolve) => {
      finishAppend = resolve;
    }));

    const append = persistAiMessage(assistant);
    await Promise.resolve();
    await Promise.resolve();
    const deletion = deletePersistedAiConversations([conversation]);
    await Promise.resolve();
    expect(tauriMocks.deleteSessions).not.toHaveBeenCalled();

    finishAppend?.();
    await append;
    await expect(deletion).resolves.toBe(1);
    expect(tauriMocks.deleteSessions).toHaveBeenCalledWith([{
      id: conversation.id,
      startedAt: conversation.startedAt,
    }]);
  });

  it('archives the current AI conversation before rotating to a new one', async () => {
    useTerminalStore.setState({
      sessions: [{
        sessionId: 'session-1',
        title: conversation.title,
        host: conversation.host,
        port: conversation.port,
        username: conversation.username,
        status: 'connected',
        conversationId: conversation.id,
        conversationStartedAt: conversation.startedAt,
      }],
      activeSessionId: 'session-1',
    });

    const nextConversationId = startNewTerminalAiConversation('session-1');
    await flushAiSessionPersistence();

    expect(nextConversationId).toBeTruthy();
    expect(nextConversationId).not.toBe(conversation.id);
    expect(useAiStore.getState().conversations[0]).toMatchObject({
      id: conversation.id,
      archived: true,
    });
    expect(tauriMocks.archive).toHaveBeenCalledWith(
      conversation.id,
      conversation.startedAt,
      'new_conversation',
    );
  });

  it('creates and rotates an isolated Workbench AI conversation', async () => {
    const first = ensureWorkbenchAiConversation('Workbench conversation');
    await flushAiSessionPersistence();

    expect(first).toMatchObject({
      title: 'Workbench conversation',
      scope: 'workbench',
      archived: false,
      host: '',
      port: 0,
      username: '',
    });
    expect(useAiStore.getState().activeWorkbenchConversationId).toBe(first.id);
    expect(tauriMocks.create).toHaveBeenCalledWith(expect.objectContaining({
      id: first.id,
      scope: 'workbench',
    }));

    const nextId = startNewWorkbenchAiConversation('Workbench conversation');
    await flushAiSessionPersistence();

    expect(nextId).not.toBe(first.id);
    expect(useAiStore.getState().activeWorkbenchConversationId).toBe(nextId);
    expect(useAiStore.getState().conversations.find((item) => item.id === first.id))
      .toMatchObject({ archived: true, scope: 'workbench' });
    expect(tauriMocks.archive).toHaveBeenCalledWith(
      first.id,
      first.startedAt,
      'new_conversation',
    );
  });
});
