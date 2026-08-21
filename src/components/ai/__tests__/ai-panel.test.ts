import { act, fireEvent, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { initI18n } from '@/locales';
import { useAgentStore } from '@/stores/agentStore';
import { useAiStore } from '@/stores/aiStore';
import type { AiChatMessage } from '@/types/ai';
import {
  AiPanel,
  cancelActiveAiRequests,
  clampAiPanelWidth,
  extractSingleLineCommand,
  getAiPanelWidthBounds,
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

  it('keeps hidden model reasoning out of future conversation history', () => {
    const messages = [
      message('reasoning', 'user', 'What model are you?'),
      message(
        'reasoning',
        'assistant',
        '<think>I should answer briefly.</think>\n\nI am MiniMax-M3.',
      ),
    ];

    expect(selectConversationHistory(messages, 'chat')).toEqual([
      { role: 'user', content: 'What model are you?' },
      { role: 'assistant', content: 'I am MiniMax-M3.' },
    ]);
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

describe('AI panel width', () => {
  it('keeps the panel within its normal width range', () => {
    expect(getAiPanelWidthBounds(1480)).toEqual({ min: 320, max: 720 });
    expect(clampAiPanelWidth(200, 1480)).toBe(320);
    expect(clampAiPanelWidth(800, 1480)).toBe(720);
    expect(clampAiPanelWidth(461.6, 1480)).toBe(462);
  });

  it('preserves the minimum main-content width in a smaller container', () => {
    expect(getAiPanelWidthBounds(1000)).toEqual({ min: 320, max: 520 });
    expect(clampAiPanelWidth(700, 1000)).toBe(520);
  });

  it('widens when its left edge is dragged left', async () => {
    await initI18n('zh-CN');
    useAiStore.getState().setOpen(true);
    const frames: FrameRequestCallback[] = [];
    const requestFrame = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    const cancelFrame = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});

    try {
      const { container, unmount } = render(
        createElement('div', null, createElement(AiPanel)),
      );
      const wrapper = container.firstElementChild as HTMLElement;
      vi.spyOn(wrapper, 'getBoundingClientRect').mockReturnValue({
        left: 0,
        top: 0,
        width: 1480,
        height: 900,
        right: 1480,
        bottom: 900,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      });
      const panel = container.querySelector('[data-slot="ai-panel"]') as HTMLElement;
      const handle = screen.getByRole('separator', { name: '调整 AI 助手宽度' });
      expect(container.querySelector('[data-slot="ai-panel-resize-indicator"]')).toHaveClass(
        'w-px',
        'group-hover:w-[3px]',
        'group-data-[resizing]:w-[3px]',
      );
      Object.defineProperty(handle, 'setPointerCapture', { value: vi.fn() });
      Object.defineProperty(handle, 'releasePointerCapture', { value: vi.fn() });

      fireEvent.pointerDown(handle, { button: 0, pointerId: 7, clientX: 1080 });
      expect(document.body.style.userSelect).toBe('none');
      fireEvent.pointerMove(handle, { pointerId: 7, clientX: 960 });
      expect(frames).toHaveLength(1);
      act(() => frames[0](0));
      expect(panel).toHaveStyle({ width: '520px' });

      fireEvent.pointerUp(handle, { pointerId: 7, clientX: 960 });
      expect(document.body.style.userSelect).toBe('');
      unmount();
    } finally {
      useAiStore.getState().setOpen(false);
      requestFrame.mockRestore();
      cancelFrame.mockRestore();
    }
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
