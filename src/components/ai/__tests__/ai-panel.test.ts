import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAgentStore } from '@/stores/agentStore';
import { useAiStore } from '@/stores/aiStore';
import type { AiChatMessage } from '@/types/ai';
import {
  cancelActiveAiRequests,
  extractSingleLineCommand,
  selectConversationHistory,
  shouldSubmitAiDraft,
} from '../ai-panel';

function message(
  requestId: string,
  role: AiChatMessage['role'],
  content: string,
  overrides: Partial<AiChatMessage> = {},
): AiChatMessage {
  return {
    id: `${role}-${requestId}`,
    requestId,
    role,
    content,
    task: 'chat',
    status: 'completed',
    providerId: 'provider-1',
    ...overrides,
  };
}

describe('extractSingleLineCommand', () => {
  it('extracts a single-line fenced shell command', () => {
    expect(extractSingleLineCommand('Use this:\n```bash\ndf -h\n```')).toBe('df -h');
  });

  it('rejects multi-line command blocks so insertion cannot execute earlier lines', () => {
    expect(extractSingleLineCommand('```bash\ncd /tmp\nrm file\n```')).toBeUndefined();
  });
});

describe('selectConversationHistory', () => {
  it('keeps command generation separate from the conversational lane', () => {
    const messages = [
      message('chat-1', 'user', 'Explain this'),
      message('chat-1', 'assistant', 'Explanation'),
      message('command-1', 'user', 'Show disk usage', { task: 'generateCommand' }),
      message('command-1', 'assistant', '```bash\ndf -h\n```', { task: 'generateCommand' }),
    ];

    expect(selectConversationHistory(messages, 'chat').map((item) => item.content))
      .toEqual(['Explain this', 'Explanation']);
    expect(selectConversationHistory(messages, 'generateCommand').map((item) => item.content))
      .toEqual(['Show disk usage', '```bash\ndf -h\n```']);
  });

  it('excludes cancelled, failed, and unfinished exchanges', () => {
    const messages = [
      message('completed', 'user', 'Good request'),
      message('completed', 'assistant', 'Good answer'),
      message('cancelled', 'user', 'Cancelled request'),
      message('cancelled', 'assistant', 'Partial', { status: 'cancelled' }),
      message('failed', 'user', 'Failed request'),
      message('failed', 'assistant', 'Partial failure', { status: 'failed' }),
      message('streaming', 'user', 'Current request'),
      message('streaming', 'assistant', 'Still running', { status: 'streaming' }),
      message('orphan', 'user', 'No assistant response'),
    ];

    expect(selectConversationHistory(messages, 'chat').map((item) => item.content))
      .toEqual(['Good request', 'Good answer']);
  });

  it('preserves bounded historical terminal context with an untrusted-data boundary', () => {
    const longContext = `prefix-${'x'.repeat(8100)}`;
    const messages = [
      message('context', 'user', 'What failed?', {
        context: { label: 'root@server', content: longContext },
      }),
      message('context', 'assistant', 'The service failed.'),
    ];

    const [historicalUser] = selectConversationHistory(messages, 'explainTerminal');
    expect(historicalUser.content).toContain('<historical_terminal_context_json>');
    expect(historicalUser.content).toContain('root@server');
    expect(historicalUser.content).not.toContain('prefix-');
    expect(historicalUser.content).toContain('x'.repeat(8000));
  });
});

describe('shouldSubmitAiDraft', () => {
  it('submits only an unmodified Enter outside IME composition', () => {
    expect(shouldSubmitAiDraft('Enter', false, false, 13)).toBe(true);
    expect(shouldSubmitAiDraft('Enter', true, false, 13)).toBe(false);
    expect(shouldSubmitAiDraft('Enter', false, true, 13)).toBe(false);
    expect(shouldSubmitAiDraft('Enter', false, false, 229)).toBe(false);
    expect(shouldSubmitAiDraft('a', false, false, 65)).toBe(false);
  });
});

describe('cancelActiveAiRequests', () => {
  beforeEach(() => {
    useAiStore.getState().clear();
    useAgentStore.getState().clear();
  });

  it('immediately clears the loading state and cancels every backend request', () => {
    useAiStore.getState().beginRequest({
      requestId: 'chat-request',
      task: 'chat',
      userContent: 'hello',
      providerId: 'provider-1',
    });
    useAgentStore.getState().beginRun(
      'agent-request',
      'diagnose',
      'session-1',
      'root@server',
    );
    const cancelBackend = vi.fn().mockResolvedValue(undefined);

    expect(cancelActiveAiRequests(cancelBackend)).toEqual([
      'chat-request',
      'agent-request',
    ]);

    expect(useAiStore.getState()).toMatchObject({
      phase: 'idle',
      activeRequestId: undefined,
    });
    expect(useAiStore.getState().messages.some((message) => (
      message.requestId === 'chat-request' && message.status === 'streaming'
    ))).toBe(false);
    expect(useAgentStore.getState().run?.phase).toBe('cancelled');
    expect(cancelBackend).toHaveBeenCalledTimes(2);
    expect(cancelBackend).toHaveBeenCalledWith('chat-request');
    expect(cancelBackend).toHaveBeenCalledWith('agent-request');
  });
});
