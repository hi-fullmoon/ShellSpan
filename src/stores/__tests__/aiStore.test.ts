import { beforeEach, describe, expect, it } from 'vitest';
import { useAiStore } from '../aiStore';

function begin(requestId = 'request-1'): void {
  useAiStore.getState().beginRequest({
    requestId,
    task: 'explainTerminal',
    userContent: 'Explain the failure',
    providerId: 'deepseek-primary',
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
      sessionId: 'session-2',
    });
    useAiStore.getState().appendDelta('session-two-command', '```bash\ndf -h\n```');
    useAiStore.getState().completeRequest('session-two-command');

    useAiStore.getState().clearConversation('session-1', 'conversation');

    expect(useAiStore.getState().messages.map((message) => message.requestId))
      .toEqual(['session-two-command', 'session-two-command']);
  });
});
