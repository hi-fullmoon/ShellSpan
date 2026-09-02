import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAiStore } from '@/stores/aiStore';
import { useTerminalStore } from '@/stores/terminalStore';
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
  listAgentSessions: vi.fn().mockResolvedValue({ sessions: [] }),
  cancelAgentSession: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/tauri', () => ({
  invokeAppendAiSessionMessage: tauriMocks.append,
  invokeArchiveAiSession: tauriMocks.archive,
  invokeCancelAiRequest: tauriMocks.cancel,
  invokeClearAiSessionLane: tauriMocks.clear,
  invokeCreateAiSession: tauriMocks.create,
  invokeDeleteAiSessions: tauriMocks.deleteSessions,
  invokeListAgentRuntimeSessions: tauriMocks.listAgentSessions,
  invokeCancelAgentRuntime: tauriMocks.cancelAgentSession,
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

  it('cancels matching Agent Sessions before archiving a closed terminal conversation', async () => {
    let finishCancellation: (() => void) | undefined;
    tauriMocks.listAgentSessions.mockResolvedValueOnce({
      sessions: [{
        ended: false,
        archived: false,
        header: { sessionId: 'agent-session-1', target: { sessionId: 'session-1' } },
      }],
    });
    tauriMocks.cancelAgentSession.mockImplementationOnce(() => new Promise<void>((resolve) => {
      finishCancellation = resolve;
    }));
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

    archiveTerminalAiSession('session-1');
    await vi.waitFor(() => expect(tauriMocks.cancelAgentSession).toHaveBeenCalledWith({
      sessionId: 'agent-session-1',
    }));
    expect(tauriMocks.archive).not.toHaveBeenCalled();
    finishCancellation?.();
    await vi.waitFor(() => expect(tauriMocks.archive).toHaveBeenCalledWith(
      conversation.id,
      conversation.startedAt,
    ));
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

  it('retries a failed Workbench creation during exit flush without recreating it once ready', async () => {
    tauriMocks.create.mockRejectedValueOnce(new Error('temporary disk failure'));

    const first = ensureWorkbenchAiConversation('Workbench conversation');
    await finalizeAiSessionsBeforeExit();

    expect(tauriMocks.create).toHaveBeenCalledTimes(2);
    expect(tauriMocks.create.mock.calls[0]?.[0]).toMatchObject({ id: first.id });
    expect(tauriMocks.create.mock.calls[1]?.[0]).toMatchObject({ id: first.id });

    const existing = ensureWorkbenchAiConversation('Workbench conversation');
    await flushAiSessionPersistence();

    expect(existing.id).toBe(first.id);
    expect(tauriMocks.create).toHaveBeenCalledTimes(2);
  });

  it('shares one in-flight Workbench creation across concurrent ensure calls', async () => {
    let finishCreation: (() => void) | undefined;
    tauriMocks.create.mockImplementationOnce(() => new Promise<void>((resolve) => {
      finishCreation = resolve;
    }));

    const first = ensureWorkbenchAiConversation('Workbench conversation');
    const concurrent = ensureWorkbenchAiConversation('Workbench conversation');
    await vi.waitFor(() => expect(tauriMocks.create).toHaveBeenCalledTimes(1));

    expect(concurrent.id).toBe(first.id);
    finishCreation?.();
    await flushAiSessionPersistence();

    ensureWorkbenchAiConversation('Workbench conversation');
    await flushAiSessionPersistence();
    expect(tauriMocks.create).toHaveBeenCalledTimes(1);
  });

  it('retries creation before migrating unbound Workbench messages in queue order', async () => {
    const unboundMessages: AiChatMessage[] = [
      {
        ...assistant,
        id: 'legacy-workbench-user',
        requestId: 'legacy-workbench-request',
        role: 'user',
        content: 'Question from before Workbench sessions',
        scope: 'workbench',
        conversationId: undefined,
        sessionId: undefined,
      },
      {
        ...assistant,
        id: 'legacy-workbench-assistant',
        requestId: 'legacy-workbench-request',
        content: 'Answer from before Workbench sessions',
        scope: 'workbench',
        conversationId: undefined,
        sessionId: undefined,
      },
    ];
    useAiStore.setState({ messages: unboundMessages });
    tauriMocks.create.mockRejectedValueOnce(new Error('temporary IPC failure'));

    const created = ensureWorkbenchAiConversation('Workbench conversation');
    await flushAiSessionPersistence();

    expect(tauriMocks.create).toHaveBeenCalledTimes(2);
    expect(tauriMocks.append.mock.calls.map(([, , message]) => message.id)).toEqual([
      'legacy-workbench-user',
      'legacy-workbench-assistant',
    ]);
    expect(tauriMocks.create.mock.invocationCallOrder[1]).toBeLessThan(
      tauriMocks.append.mock.invocationCallOrder[0]!,
    );
    expect(useAiStore.getState().messages).toEqual([
      expect.objectContaining({
        id: 'legacy-workbench-user',
        conversationId: created.id,
      }),
      expect.objectContaining({
        id: 'legacy-workbench-assistant',
        conversationId: created.id,
      }),
    ]);
  });
});
