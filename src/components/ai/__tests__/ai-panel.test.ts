import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { initI18n } from '@/locales';
import { useAgentStore } from '@/stores/agentStore';
import { useAiStore } from '@/stores/aiStore';
import { useAppStore } from '@/stores/appStore';
import { useTerminalStore } from '@/stores/terminalStore';
import { useProfileStore } from '@/stores/profileStore';
import type { AiChatMessage } from '@/types/ai';
import {
  AiPanel,
  canStartAiRequest,
  cancelActiveAiRequests,
  clampAiPanelWidth,
  extractSingleLineCommand,
  getAiPanelWidthBounds,
  isMessageBoundToTerminal,
  sanitizeTerminalSelection,
  selectConversationHistory,
  shouldSubmitAiDraft,
  stopActiveAgentRun,
  summarizeAiError,
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

beforeEach(() => {
  window.localStorage.removeItem('termbridge.aiPanelWidth');
});

describe('extractSingleLineCommand', () => {
  it('extracts a single-line fenced shell command', () => {
    expect(extractSingleLineCommand('Use this:\n```bash\ndf -h\n```')).toBe('df -h');
  });

  it('rejects multi-line command blocks so insertion cannot execute earlier lines', () => {
    expect(extractSingleLineCommand('```bash\ncd /tmp\nrm file\n```')).toBeUndefined();
  });
});

describe('terminal selection context', () => {
  it('normalizes control sequences before redacting selected terminal content', () => {
    expect(sanitizeTerminalSelection('\u001b[31mapi_key=secret\u001b[0m\rAPI_KEY=next'))
      .toBe('API_KEY=[REDACTED]');
  });
});

describe('terminal conversation binding', () => {
  it('updates the explicit asset and host binding when the active terminal changes', async () => {
    const previousApp = useAppStore.getState();
    const previousTerminal = useTerminalStore.getState();
    const previousProfiles = useProfileStore.getState();
    await initI18n('en-US');
    useAiStore.getState().setOpen(true);
    useAppStore.setState({ activeSection: 'terminal', locale: 'en-US' });
    useProfileStore.setState({
      profiles: [
        {
          id: 'profile-a',
          name: 'Production A',
          host: 'a.example.com',
          port: 22,
          username: 'root',
          authMethod: 'password',
          createdAt: 0,
          updatedAt: 0,
        },
        {
          id: 'profile-b',
          name: 'Staging B',
          host: 'b.example.com',
          port: 2222,
          username: 'deploy',
          authMethod: 'password',
          createdAt: 0,
          updatedAt: 0,
        },
      ],
    });
    useTerminalStore.setState({
      sessions: [
        {
          sessionId: 'session-a',
          title: 'A',
          host: 'a.example.com',
          port: 22,
          username: 'root',
          status: 'connected',
          profileId: 'profile-a',
        },
        {
          sessionId: 'session-b',
          title: 'B',
          host: 'b.example.com',
          port: 2222,
          username: 'deploy',
          status: 'connected',
          profileId: 'profile-b',
        },
      ],
      activeSessionId: 'session-a',
    });

    const { unmount } = render(createElement(AiPanel));
    expect(screen.getByTestId('ai-host-binding')).toHaveTextContent(
      'Bound host: Production A · root@a.example.com:22',
    );
    expect(screen.getByTestId('ai-host-binding')).toHaveTextContent('Source: no output');

    act(() => useTerminalStore.getState().setActiveSession('session-b'));
    expect(screen.getByTestId('ai-host-binding')).toHaveTextContent(
      'Bound host: Staging B · deploy@b.example.com:2222',
    );

    unmount();
    useAiStore.getState().setOpen(false);
    useAppStore.setState(previousApp, true);
    useTerminalStore.setState(previousTerminal, true);
    useProfileStore.setState(previousProfiles, true);
    await initI18n(previousApp.locale);
  });

  it('starts snapshot diagnosis on the exact connected profile with snapshot context', async () => {
    await initI18n('en-US');
    useAgentStore.getState().clear();
    useAppStore.getState().setActiveSection('terminal');
    useTerminalStore.setState({
      sessions: [{
        sessionId: 'health-session',
        title: 'Production',
        host: 'prod.example.com',
        port: 22,
        username: 'root',
        status: 'connected',
        profileId: 'profile-health',
      }],
      activeSessionId: 'health-session',
    });
    useAiStore.getState().setOpen(true);
    const { unmount } = render(createElement(AiPanel));

    try {
      act(() => {
        document.dispatchEvent(new CustomEvent('termbridge:start-health-diagnosis', {
          detail: {
            profileId: 'profile-health',
            sessionId: 'health-session',
            goal: 'Diagnose snapshot collected at 2026-08-23T08:00:00Z',
            context: {
              label: 'root@prod · remote health',
              content: 'Profile ID: profile-health\nSource: SSH read-only',
            },
          },
        }));
      });

      await waitFor(() => expect(useAgentStore.getState().run).toMatchObject({
        profileId: 'profile-health',
        sessionId: 'health-session',
        contextSource: 'remoteHealth',
        contextLabel: 'root@prod · remote health',
      }));
      expect(useAgentStore.getState().run?.steps[0]?.title)
        .toBe('remoteHealth.getSnapshotContext');
    } finally {
      unmount();
      useAgentStore.getState().clear();
      useAiStore.getState().setOpen(false);
    }
  });

  it('keeps commands bound after a terminal reconnect changes sessionId', () => {
    expect(isMessageBoundToTerminal(
      { conversationId: 'conversation-1', sessionId: 'old-session' },
      'conversation-1',
      'new-session',
    )).toBe(true);
    expect(isMessageBoundToTerminal(
      { conversationId: 'conversation-2', sessionId: 'old-session' },
      'conversation-1',
      'new-session',
    )).toBe(false);
  });

  it('does not start a request after its terminal conversation closes', () => {
    useAiStore.getState().clear();
    useTerminalStore.setState({
      sessions: [{
        sessionId: 'session-1',
        title: 'Server',
        host: 'example.com',
        port: 22,
        username: 'root',
        status: 'connected',
        conversationId: 'conversation-1',
        conversationStartedAt: '2026-08-22T09:00:00.000Z',
      }],
      activeSessionId: 'session-1',
    });
    useAiStore.getState().beginRequest({
      requestId: 'request-1',
      task: 'chat',
      userContent: 'Help',
      providerId: 'provider-1',
      conversationId: 'conversation-1',
      sessionId: 'session-1',
    });

    expect(canStartAiRequest('request-1', 'conversation-1')).toBe(true);
    useTerminalStore.setState({ sessions: [], activeSessionId: null });
    expect(canStartAiRequest('request-1', 'conversation-1')).toBe(false);
    useAiStore.getState().cancelRequest('request-1');
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

  it('keeps terminal conversations isolated by session', () => {
    const messages = [
      message('server-a', 'user', 'Check server A', { conversationId: 'conversation-a', sessionId: 'session-a' }),
      message('server-a', 'assistant', 'Server A is healthy', { conversationId: 'conversation-a', sessionId: 'session-a' }),
      message('server-b', 'user', 'Check server B', { conversationId: 'conversation-b', sessionId: 'session-b' }),
      message('server-b', 'assistant', 'Server B needs attention', { conversationId: 'conversation-b', sessionId: 'session-b' }),
    ];

    expect(selectConversationHistory(messages, 'chat', 'conversation-b')).toEqual([
      { role: 'user', content: 'Check server B' },
      { role: 'assistant', content: 'Server B needs attention' },
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

describe('summarizeAiError', () => {
  it('turns an HTML 404 response into a concise endpoint error', () => {
    const result = summarizeAiError(
      'AI provider returned HTTP 404 Not Found: <html><body><h1>404 Not Found</h1><p>nginx</p></body></html>',
    );

    expect(result.key).toBe('ai.error.notFound');
    expect(result.detail).toBe('AI provider returned HTTP 404 Not Found');
    expect(result.detail).not.toContain('<html>');

    expect(summarizeAiError(
      'AI provider returned HTTP 404 Not Found: &lt;html&gt;nginx&lt;/html&gt;',
    ).detail).toBe('AI provider returned HTTP 404 Not Found');
  });

  it('classifies authentication, rate-limit, and provider errors', () => {
    expect(summarizeAiError('AI provider returned HTTP 401 Unauthorized').key)
      .toBe('ai.error.authentication');
    expect(summarizeAiError('AI provider returned HTTP 429 Too Many Requests').key)
      .toBe('ai.error.rateLimited');
    expect(summarizeAiError('AI provider returned HTTP 503 Service Unavailable'))
      .toMatchObject({ key: 'ai.error.unavailable', variables: { status: 503 } });
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

  it('keeps the panel usable as an overlay in a narrow container', () => {
    expect(getAiPanelWidthBounds(375)).toEqual({ min: 320, max: 375 });
    expect(clampAiPanelWidth(0, 375)).toBe(320);
  });

  it('keeps compact mode controls accessible when the panel narrows', async () => {
    await initI18n('zh-CN');
    useAiStore.getState().setOpen(true);

    try {
      const { unmount } = render(createElement(AiPanel));
      const handle = screen.getByRole('separator', { name: '调整 AI 助手宽度' });
      const chatMode = screen.getByRole('button', { name: '问答' });
      const commandMode = screen.getByRole('button', { name: '生成命令' });
      const agentMode = screen.getByRole('button', { name: '诊断 Agent' });

      expect(chatMode).toHaveTextContent('问答');
      expect(commandMode).toHaveTextContent('生成命令');
      expect(agentMode).toHaveTextContent('诊断 Agent');
      expect(chatMode.querySelector('svg')).toHaveAttribute('data-icon', 'inline-start');
      expect(commandMode.querySelector('svg')).toHaveAttribute('data-icon', 'inline-start');
      expect(agentMode.querySelector('svg')).toHaveAttribute('data-icon', 'inline-start');

      fireEvent.keyDown(handle, { key: 'ArrowRight' });

      expect(chatMode).not.toHaveTextContent('问答');
      expect(commandMode).not.toHaveTextContent('生成命令');
      expect(agentMode).not.toHaveTextContent('诊断 Agent');
      expect(chatMode.querySelector('svg')).not.toHaveAttribute('data-icon');
      expect(commandMode.querySelector('svg')).not.toHaveAttribute('data-icon');
      expect(agentMode.querySelector('svg')).not.toHaveAttribute('data-icon');
      expect(screen.getByText('我能帮你处理什么？')).toBeInTheDocument();
      unmount();
    } finally {
      useAiStore.getState().setOpen(false);
    }
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

      act(() => {
        frames.splice(0).forEach((callback) => callback(0));
      });

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

  it('does not remeasure the panel container while stream content updates', async () => {
    await initI18n('en-US');
    useAiStore.getState().clear();
    useAiStore.getState().beginRequest({
      requestId: 'layout-stream',
      task: 'chat',
      userContent: 'Hello',
      providerId: 'provider-1',
    });

    const { container, unmount } = render(
      createElement('div', null, createElement(AiPanel)),
    );
    const wrapper = container.firstElementChild as HTMLElement;
    const measure = vi.spyOn(wrapper, 'getBoundingClientRect');

    try {
      act(() => useAiStore.getState().appendDelta('layout-stream', 'Response'));

      expect(measure).not.toHaveBeenCalled();
      expect(screen.getByText('Response')).toBeInTheDocument();
    } finally {
      unmount();
      useAiStore.getState().clear();
      useAiStore.getState().setOpen(false);
    }
  });
});

describe('AI panel compact and context behavior', () => {
  it('uses a modal drawer instead of an inline overlay on narrow screens', async () => {
    const initialWidth = window.innerWidth;
    const initialMatchMedia = window.matchMedia;
    let unmount: (() => void) | undefined;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 375, writable: true });
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn().mockReturnValue({
        matches: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }),
    });
    useAiStore.getState().setOpen(true);

    try {
      ({ unmount } = render(createElement(AiPanel)));
      await waitFor(() => expect(document.body.querySelector('[data-slot="drawer-content"]')).toBeInTheDocument());
      expect(document.body.querySelector('[data-slot="drawer-overlay"]')).toBeInTheDocument();
      expect(screen.queryByRole('separator', { name: /AI assistant width|调整 AI 助手宽度/i })).toBeNull();
    } finally {
      unmount?.();
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: initialWidth, writable: true });
      Object.defineProperty(window, 'matchMedia', { configurable: true, value: initialMatchMedia });
      useAiStore.getState().setOpen(false);
    }
  });

  it('stops a diagnostic run when terminal context is disabled and keeps a transparent re-enable action', async () => {
    await initI18n('zh-CN');
    useAppStore.getState().setActiveSection('terminal');
    useTerminalStore.setState({
      sessions: [{
        sessionId: 'agent-session',
        title: 'Server',
        host: 'example.com',
        port: 22,
        username: 'root',
        status: 'connected',
        conversationId: 'agent-conversation',
        conversationStartedAt: '2026-08-22T09:00:00.000Z',
      }],
      activeSessionId: 'agent-session',
    });
    useAiStore.getState().setOpen(true);

    const { unmount } = render(createElement(AiPanel));
    try {
      fireEvent.click(screen.getByRole('button', { name: '诊断 Agent' }));
      act(() => {
        useAgentStore.getState().beginRun(
          'agent-context-request',
          'Diagnose the server',
          'agent-session',
          'root@example.com',
        );
      });

      fireEvent.click(await screen.findByRole('button', { name: /当前终端已附加/ }));

      expect(useAgentStore.getState().run?.phase).toBe('cancelled');
      const enableContext = await screen.findByRole('button', {
        name: '单击可重新附加此上下文。',
      });
      expect(enableContext).toHaveClass('hover:bg-accent');
      expect(enableContext).not.toHaveClass('bg-background');
    } finally {
      unmount();
      useAgentStore.getState().clear();
      useTerminalStore.setState({ sessions: [], activeSessionId: null });
      useAppStore.getState().setActiveSection('workbench');
      useAiStore.getState().setOpen(false);
    }
  });
});

describe('clear conversation dialog', () => {
  it('closes after the conversation is cleared', async () => {
    await initI18n('en-US');
    useAiStore.getState().clear();
    useAiStore.getState().beginRequest({
      requestId: 'clear-dialog',
      task: 'chat',
      userContent: 'Hello',
      providerId: 'provider-1',
    });
    useAiStore.getState().appendDelta('clear-dialog', 'Response');
    useAiStore.getState().completeRequest('clear-dialog');

    const { unmount } = render(createElement(AiPanel));
    const clearLabel = /Clear conversation|清空对话/;

    try {
      fireEvent.click(screen.getByRole('button', { name: clearLabel }));
      const dialog = await screen.findByRole('alertdialog');
      fireEvent.click(within(dialog).getByRole('button', { name: clearLabel }));

      await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
      expect(useAiStore.getState().messages).toHaveLength(0);
    } finally {
      unmount();
      useAiStore.getState().clear();
      useAiStore.getState().setOpen(false);
    }
  });
});

describe('conversation history', () => {
  it('opens an archived terminal conversation as read-only', async () => {
    await initI18n('en-US');
    useTerminalStore.setState({ sessions: [], activeSessionId: null });
    useAiStore.getState().clear();
    useAiStore.getState().hydrateSessions([{
      conversation: {
        id: 'archived-conversation',
        startedAt: '2026-08-22T09:00:00.000Z',
        updatedAt: '2026-08-22T09:01:00.000Z',
        title: 'root@archived.example.com',
        archived: true,
        sessionId: 'closed-session',
        host: 'archived.example.com',
        port: 22,
        username: 'root',
      },
      messages: [message('archived-message', 'user', 'Preserved question', {
        conversationId: 'archived-conversation',
        sessionId: 'closed-session',
      }), message('archived-command', 'assistant', '```bash\ndf -h\n```', {
        task: 'generateCommand',
        conversationId: 'archived-conversation',
        sessionId: 'closed-session',
      })],
    }]);
    useAiStore.getState().setOpen(true);

    const { unmount } = render(createElement(AiPanel));
    try {
      fireEvent.click(screen.getByRole('button', { name: 'Conversation history' }));
      fireEvent.click(await screen.findByText('root@archived.example.com'));

      expect(await screen.findByText('Preserved question')).toBeInTheDocument();
      expect(screen.getByText('df -h')).toBeInTheDocument();
      expect(screen.getByText(/只读方式保留|preserved as read-only/i)).toBeInTheDocument();
      expect(screen.getByRole('textbox')).toBeDisabled();
    } finally {
      unmount();
      useAiStore.getState().clear();
      useAiStore.getState().setOpen(false);
    }
  });
});

describe('AI composer status', () => {
  it('focuses the composer when the panel opens', async () => {
    await act(async () => {
      await initI18n('zh-CN');
      useAiStore.getState().setOpen(true);
    });
    const requestFrame = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      callback(0);
      return 1;
    });

    try {
      const { unmount } = render(createElement(AiPanel));
      expect(screen.getByRole('textbox')).toHaveFocus();
      unmount();
    } finally {
      useAiStore.getState().setOpen(false);
      requestFrame.mockRestore();
    }
  });

  it('keeps the missing-terminal guidance inside the composer', async () => {
    await act(async () => {
      await initI18n('zh-CN');
    });
    useAiStore.getState().setOpen(true);

    const { unmount } = render(createElement(AiPanel));
    fireEvent.click(screen.getByRole('button', { name: '诊断 Agent' }));

    const guidance = await screen.findByText(
      '诊断 Agent 需要先打开一个终端会话。',
    );
    expect(guidance.closest('[data-slot="input-group"]')).not.toBeNull();
    expect(guidance.parentElement).toHaveAttribute(
      'aria-live',
      'polite',
    );

    unmount();
    useAiStore.getState().setOpen(false);
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

  it('cancels an active diagnostic request when its run is stopped', () => {
    useAgentStore.getState().beginRun(
      'agent-stop-request',
      'diagnose',
      'session-1',
      'root@server',
    );
    const cancelBackend = vi.fn().mockResolvedValue(undefined);

    expect(stopActiveAgentRun(cancelBackend)).toBe('agent-stop-request');
    expect(useAgentStore.getState().run?.phase).toBe('cancelled');
    expect(cancelBackend).toHaveBeenCalledWith('agent-stop-request');
  });
});
