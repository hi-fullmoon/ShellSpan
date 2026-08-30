import { beforeEach, describe, expect, it } from 'vitest';
import { useAiStore } from '../aiStore';

function begin(requestId = 'request-1'): void {
  useAiStore.getState().beginRequest({
    requestId,
    task: 'explainTerminal',
    userContent: 'Explain the failure',
    providerId: 'deepseek-primary',
    conversationId: 'conversation-1',
    sessionId: 'session-1',
    context: { label: 'root@server', content: 'service failed' },
  });
}

describe('aiStore', () => {
  beforeEach(() => {
    useAiStore.getState().clear();
  });

  it('records request provenance and completes streamed responses', () => {
    begin();
    const [user, assistant] = useAiStore.getState().messages;
    expect(user).toMatchObject({
      requestId: 'request-1',
      task: 'explainTerminal',
      status: 'completed',
      providerId: 'deepseek-primary',
      sessionId: 'session-1',
      context: { label: 'root@server', content: 'service failed' },
    });
    expect(assistant).toMatchObject({ status: 'streaming', content: '' });

    useAiStore.getState().appendDelta('request-1', 'The service stopped.');
    useAiStore.getState().completeRequest('request-1');

    expect(useAiStore.getState()).toMatchObject({ phase: 'idle', activeRequestId: undefined });
    expect(useAiStore.getState().messages[1]).toMatchObject({
      status: 'completed',
      content: 'The service stopped.',
    });
  });

  it('marks a partial cancellation and ignores later deltas', () => {
    begin();
    useAiStore.getState().appendDelta('request-1', 'Partial answer');
    useAiStore.getState().cancelRequest('request-1');
    useAiStore.getState().appendDelta('request-1', ' should be ignored');

    expect(useAiStore.getState().messages[1]).toMatchObject({
      status: 'cancelled',
      content: 'Partial answer',
    });
  });

  it('removes an empty assistant response after cancellation or failure', () => {
    begin('cancelled');
    useAiStore.getState().cancelRequest('cancelled');
    expect(useAiStore.getState().messages).toHaveLength(1);

    begin('failed');
    useAiStore.getState().failRequest('failed', 'connection closed');
    expect(useAiStore.getState().messages.some((item) => item.requestId === 'failed' && item.role === 'assistant'))
      .toBe(false);
    expect(useAiStore.getState()).toMatchObject({ phase: 'error', error: 'connection closed' });
  });

  it('treats an empty completed event as an error', () => {
    begin();
    useAiStore.getState().completeRequest('request-1');

    expect(useAiStore.getState().phase).toBe('error');
    expect(useAiStore.getState().error).toBe('AI provider returned an empty response');
    expect(useAiStore.getState().messages).toHaveLength(1);
  });

  it('clears only the selected terminal and conversation lane', () => {
    begin('session-one-chat');
    useAiStore.getState().appendDelta('session-one-chat', 'Answer');
    useAiStore.getState().completeRequest('session-one-chat');
    useAiStore.getState().beginRequest({
      requestId: 'session-two-command',
      task: 'generateCommand',
      userContent: 'Show disk usage',
      providerId: 'deepseek-primary',
      conversationId: 'conversation-2',
      sessionId: 'session-2',
    });
    useAiStore.getState().appendDelta('session-two-command', '```bash\ndf -h\n```');
    useAiStore.getState().completeRequest('session-two-command');

    useAiStore.getState().clearConversation('conversation-1', 'conversation');

    expect(useAiStore.getState().messages.map((message) => message.requestId))
      .toEqual(['session-two-command', 'session-two-command']);
  });

  it('hydrates Codex-style session files and archives conversations', () => {
    useAiStore.getState().hydrateSessions([{
      conversation: {
        id: 'conversation-history',
        startedAt: '2026-08-22T09:00:00.000Z',
        updatedAt: '2026-08-22T09:01:00.000Z',
        title: 'root@example.com',
        archived: false,
        sessionId: 'old-session',
        host: 'example.com',
        port: 22,
        username: 'root',
      },
      messages: [{
        id: 'message-1',
        requestId: 'request-history',
        role: 'user',
        content: 'What failed?',
        task: 'chat',
        status: 'completed',
        providerId: 'provider-1',
        conversationId: 'conversation-history',
        sessionId: 'old-session',
      }],
    }]);

    expect(useAiStore.getState().messages[0]?.content).toBe('What failed?');
    useAiStore.getState().archiveConversation('conversation-history');
    expect(useAiStore.getState().conversations[0]?.archived).toBe(true);
  });

  it('hydrates the session index without eagerly loading message bodies', () => {
    const conversation = {
      id: 'indexed-conversation',
      startedAt: '2026-08-22T09:00:00.000Z',
      updatedAt: '2026-08-22T09:01:00.000Z',
      title: 'root@example.com',
      archived: true,
      sessionId: 'old-session',
      host: 'example.com',
      port: 22,
      username: 'root',
    };
    useAiStore.getState().hydrateSessionIndex([conversation]);
    expect(useAiStore.getState().conversations).toEqual([conversation]);
    expect(useAiStore.getState().messages).toEqual([]);
    expect(useAiStore.getState().loadedConversationIds).toEqual([]);
  });

  it('removes conversation summaries, loaded messages, and load markers together', () => {
    useAiStore.getState().hydrateSessions([{
      conversation: {
        id: 'conversation-to-delete',
        startedAt: '2026-08-22T09:00:00.000Z',
        updatedAt: '2026-08-22T09:01:00.000Z',
        title: 'root@example.com',
        archived: true,
        host: 'example.com',
        port: 22,
        username: 'root',
      },
      messages: [{
        id: 'message-to-delete',
        requestId: 'request-to-delete',
        role: 'user',
        content: 'Delete me',
        task: 'chat',
        status: 'completed',
        providerId: 'provider-1',
        conversationId: 'conversation-to-delete',
      }],
    }]);

    useAiStore.getState().removeConversations(['conversation-to-delete']);

    expect(useAiStore.getState().conversations).toEqual([]);
    expect(useAiStore.getState().messages).toEqual([]);
    expect(useAiStore.getState().loadedConversationIds).toEqual([]);
  });
});
