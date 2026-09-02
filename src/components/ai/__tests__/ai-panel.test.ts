import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useAiStore } from '@/stores/aiStore';
import { useTerminalStore } from '@/stores/terminalStore';
import type { AiChatMessage } from '@/types/ai';
import {
  canStartAiRequest,
  cancelActiveAiRequests,
  clampAiPanelWidth,
  getAiPanelWidthBounds,
  runtimeTargetFromSession,
  sanitizeTerminalSelection,
  selectConversationHistory,
  shouldSubmitAiDraft,
  summarizeAiError,
} from '../ai-panel';

function message(
  requestId: string,
  role: 'user' | 'assistant',
  content: string,
  status: AiChatMessage['status'] = 'completed',
): AiChatMessage {
  return {
    id: `${role}-${requestId}`,
    requestId,
    role,
    content,
    task: 'ask',
    status,
    providerId: 'provider-1',
    conversationId: 'conversation-1',
    sessionId: 'terminal-1',
  };
}

describe('AI panel pure behavior', () => {
  beforeEach(() => {
    useAiStore.getState().clear();
    useTerminalStore.setState({ sessions: [], activeSessionId: null });
  });

  it('submits only an unmodified Enter outside IME composition', () => {
    expect(shouldSubmitAiDraft('Enter', false, false, 13)).toBe(true);
    expect(shouldSubmitAiDraft('Enter', true, false, 13)).toBe(false);
    expect(shouldSubmitAiDraft('Enter', false, true, 229)).toBe(false);
  });

  it('keeps only completed request pairs in bounded conversation history', () => {
    const history = selectConversationHistory([
      message('done', 'user', 'Question'),
      message('done', 'assistant', 'Answer'),
      message('failed', 'user', 'Incomplete'),
      message('failed', 'assistant', '', 'failed'),
    ], 'ask', 'conversation-1');

    expect(history.messages).toEqual([
      { role: 'user', content: 'Question' },
      { role: 'assistant', content: 'Answer' },
    ]);
  });

  it('redacts terminal secrets and classifies provider failures', () => {
    expect(sanitizeTerminalSelection('\u001b[31mpassword=hunter2\u001b[0m'))
      .not.toContain('hunter2');
    expect(summarizeAiError('AI provider HTTP 429: slow down').key)
      .toBe('ai.error.rateLimited');
  });

  it('clamps panel width while preserving main content', () => {
    expect(getAiPanelWidthBounds(1_200)).toEqual({ min: 320, max: 720 });
    expect(clampAiPanelWidth(900, 1_200)).toBe(720);
  });

  it('builds an Agent target with a runtime-safe identifier', () => {
    const target = runtimeTargetFromSession({
      sessionId: '123e4567-e89b-12d3-a456-426614174000',
      title: 'Local',
      host: 'local',
      port: 0,
      username: 'operator',
      status: 'connected',
    });

    expect(target).toMatchObject({
      kind: 'local',
      targetId: 'terminal-123e4567-e89b-12d3-a456-426614174000',
      sessionId: '123e4567-e89b-12d3-a456-426614174000',
    });
    expect(target.targetId).toMatch(/^[A-Za-z0-9_-]{1,128}$/);
  });

  it('cancels the active Ask request immediately and through the backend', async () => {
    useAiStore.getState().beginRequest({
      requestId: 'request-1',
      task: 'ask',
      providerId: 'provider-1',
      userContent: 'Question',
    });
    const cancel = vi.fn().mockResolvedValue(undefined);

    expect(cancelActiveAiRequests(cancel)).toEqual(['request-1']);
    expect(useAiStore.getState().activeRequestId).toBeUndefined();
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledWith('request-1'));
  });

  it('rejects a terminal request after its bound conversation closes', () => {
    useAiStore.getState().beginRequest({
      requestId: 'request-1',
      task: 'ask',
      providerId: 'provider-1',
      userContent: 'Question',
      conversationId: 'conversation-1',
      sessionId: 'terminal-1',
    });
    expect(canStartAiRequest('request-1', 'conversation-1')).toBe(false);
  });
});
