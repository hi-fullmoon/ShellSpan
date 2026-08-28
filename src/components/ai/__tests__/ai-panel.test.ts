import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { initI18n } from '@/locales';
import { useAiStore } from '@/stores/aiStore';
import { useAppStore } from '@/stores/appStore';
import { useTerminalStore } from '@/stores/terminalStore';
import { useProfileStore } from '@/stores/profileStore';
import type { AiChatMessage } from '@/types/ai';
import {
  appendTerminalOutput,
  clearTerminalOutput,
} from '@/lib/terminal-output-buffer';
import {
  AiPanel,
  LIVE_TERMINAL_CONTEXT_MAX_LATENCY_MS,
  canStartAiRequest,
  cancelActiveAiRequests,
  clampAiPanelWidth,
  extractSingleLineCommand,
  getAiPanelWidthBounds,
  isMessageBoundToTerminal,
  retrySnapshotForMessage,
  sanitizeTerminalSelection,
  selectAgentConversationHistory,
  selectConversationHistory,
  shouldCompactAiModeControls,
  shouldSubmitAiDraft,
  summarizeAiError,
} from '../ai-panel';

const tauriCoreMock = vi.hoisted(() => ({ invoke: vi.fn() }));
const tauriEventMock = vi.hoisted(() => ({ listen: vi.fn(async () => () => {}) }));
const agentUiMock = vi.hoisted(() => ({
  connect: vi.fn(async () => {}),
  start: vi.fn(async () => 'agent-request'),
  stop: vi.fn(() => true),
  approve: vi.fn(() => true),
  reject: vi.fn(() => true),
  retry: vi.fn(async () => 'retry-request'),
  canRetry: vi.fn(() => false),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: tauriCoreMock.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: tauriEventMock.listen }));
vi.mock('@/lib/agent-ui-controller', () => ({
  agentUiController: agentUiMock,
  agentTargetFromSession: (session: {
    sessionId: string;
    profileId?: string;
    host: string;
    port: number;
    username: string;
  }) => ({
    kind: session.host === 'local' && session.port === 0 ? 'local' : 'remote',
    sessionId: session.sessionId,
    ...(session.profileId ? { profileId: session.profileId } : {}),
    host: session.host,
    port: session.port,
    username: session.username,
  }),
}));

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
  tauriCoreMock.invoke.mockReset();
  tauriCoreMock.invoke.mockResolvedValue(undefined);
  tauriEventMock.listen.mockClear();
  Object.values(agentUiMock).forEach((mock) => mock.mockClear());
});

describe('extractSingleLineCommand', () => {
  it('extracts a single-line fenced shell command', () => {
    expect(extractSingleLineCommand('Use this:\n```bash\ndf -h\n```')).toBe('df -h');
  });

  it('rejects multi-line command blocks so insertion cannot execute earlier lines', () => {
    expect(extractSingleLineCommand('```bash\ncd /tmp\nrm file\n```')).toBeUndefined();
  });
});

describe('explicit AI modes', () => {
  it('keeps the experimental Agent entry visible but disabled by default', async () => {
    const previousApp = useAppStore.getState();
    await initI18n('en-US');
    useAppStore.setState({ locale: 'en-US' });
    useAiStore.getState().clear();
    useAiStore.getState().setOpen(true);
    const { unmount } = render(createElement(AiPanel));
    try {
      const agentMode = await screen.findByRole('button', { name: 'Agent' });
      expect(agentMode).toBeDisabled();
      expect(agentMode).toHaveAttribute('aria-describedby', 'agent-mode-availability');
      expect(screen.getByText(/experimental Agent feature is off/i)).toHaveClass('sr-only');
    } finally {
      unmount();
      useAiStore.getState().clear();
      useAiStore.getState().setOpen(false);
      useAppStore.setState(previousApp, true);
      await initI18n(previousApp.locale);
    }
  });

  it('routes Chat and Generate command only to AI, and Agent only to the Agent coordinator', async () => {
    const previousApp = useAppStore.getState();
    const previousTerminal = useTerminalStore.getState();
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    });
    tauriCoreMock.invoke.mockImplementation(async (command: string) => {
      if (command === 'agent_contract_status') {
        return {
          contractVersion: 1,
          featureEnabled: true,
          agentAvailable: true,
          defaultPermissionMode: 'requestApproval',
          providerCapability: {
            support: 'supported',
            source: 'ollamaModelMetadata',
          },
        };
      }
      return undefined;
    });
    await initI18n('en-US');
    useAiStore.getState().clear();
    useAiStore.getState().setOpen(true);
    useAppStore.setState({ activeSection: 'terminal', locale: 'en-US' });
    useTerminalStore.setState({
      sessions: [{
        sessionId: 'mode-session',
        title: 'Mode target',
        host: 'mode.example.com',
        port: 22,
        username: 'root',
        status: 'connected',
        conversationId: 'mode-conversation',
        conversationStartedAt: '2026-08-28T00:00:00.000Z',
      }],
      activeSessionId: 'mode-session',
    });

    const { unmount } = render(createElement(AiPanel));
    try {
      const textbox = screen.getByRole('textbox');
      fireEvent.change(textbox, { target: { value: 'Explain nginx' } });
      fireEvent.click(screen.getByRole('button', { name: 'Send' }));
      await waitFor(() => expect(tauriCoreMock.invoke).toHaveBeenCalledWith(
        'ai_start_request',
        expect.anything(),
      ));
      expect(agentUiMock.start).not.toHaveBeenCalled();
      act(() => {
        const requestId = useAiStore.getState().activeRequestId;
        if (requestId) useAiStore.getState().cancelRequest(requestId);
      });

      fireEvent.click(screen.getByRole('button', { name: 'Generate command' }));
      fireEvent.change(textbox, { target: { value: 'Show disk usage' } });
      fireEvent.click(screen.getByRole('button', { name: 'Send' }));
      await waitFor(() => {
        const starts = tauriCoreMock.invoke.mock.calls.filter(([command]) => (
          command === 'ai_start_request'
        ));
        expect(starts).toHaveLength(2);
        expect(starts[1]?.[1]).toMatchObject({ request: { task: 'generateCommand' } });
      });
      expect(agentUiMock.start).not.toHaveBeenCalled();
      act(() => {
        const requestId = useAiStore.getState().activeRequestId;
        if (requestId) useAiStore.getState().cancelRequest(requestId);
      });

      const agentMode = await screen.findByRole('button', { name: 'Agent' });
      await waitFor(() => expect(agentMode).toBeEnabled());
      fireEvent.click(agentMode);
      fireEvent.change(textbox, { target: { value: 'Verify nginx' } });
      fireEvent.click(screen.getByRole('button', { name: 'Send' }));
      await waitFor(() => expect(agentUiMock.start).toHaveBeenCalledWith(expect.objectContaining({
        goal: 'Verify nginx',
        target: expect.objectContaining({ sessionId: 'mode-session' }),
      })));
      expect(tauriCoreMock.invoke.mock.calls.filter(([command]) => command === 'ai_start_request'))
        .toHaveLength(2);
    } finally {
      unmount();
      delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
      useAiStore.getState().clear();
      useAiStore.getState().setOpen(false);
      useAppStore.setState(previousApp, true);
      useTerminalStore.setState(previousTerminal, true);
      await initI18n(previousApp.locale);
    }
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
    expect(isMessageBoundToTerminal({}, 'conversation-1', 'new-session')).toBe(false);
    expect(isMessageBoundToTerminal(
      { sessionId: 'new-session' },
      undefined,
      'new-session',
    )).toBe(true);
  });

  it('retries with the original context and the reconnected terminal identity', () => {
    const context = { label: 'root@example.com', content: 'original evidence' };
    expect(retrySnapshotForMessage(
      {
        context,
        conversationId: 'conversation-1',
        sessionId: 'old-session',
      },
      [{ conversationId: 'conversation-1', sessionId: 'new-session' }],
    )).toEqual({
      context,
      conversationId: 'conversation-1',
      sessionId: 'new-session',
    });
  });

  it('wires the failed request snapshot into retry instead of reading new terminal output', async () => {
    const previousApp = useAppStore.getState();
    const previousTerminal = useTerminalStore.getState();
    const originalContext = { label: 'root@example.com', content: 'original evidence' };
    await initI18n('en-US');
    useAppStore.setState({ activeSection: 'terminal', locale: 'en-US' });
    useTerminalStore.setState({
      sessions: [{
        sessionId: 'reconnected-session',
        title: 'Server',
        host: 'example.com',
        port: 22,
        username: 'root',
        status: 'connected',
        conversationId: 'retry-conversation',
        conversationStartedAt: '2026-08-25T09:00:00.000Z',
      }],
      activeSessionId: 'reconnected-session',
    });
    useAiStore.getState().clear();
    useAiStore.getState().beginRequest({
      requestId: 'failed-request',
      task: 'explainTerminal',
      userContent: 'Explain the failure',
      providerId: 'ollama',
      conversationId: 'retry-conversation',
      sessionId: 'disconnected-session',
      context: originalContext,
    });
    useAiStore.getState().failRequest('failed-request', 'AI provider request timed out');
    useAiStore.getState().setOpen(true);

    const { unmount } = render(createElement(AiPanel));
    try {
      const errorTitle = await screen.findByText('Request failed');
      const alert = errorTitle.closest('[role="alert"]');
      expect(alert).not.toBeNull();
      fireEvent.click(within(alert as HTMLElement).getByRole('button', { name: 'Retry' }));

      await waitFor(() => {
        const startCall = tauriCoreMock.invoke.mock.calls.find(([command]) => (
          command === 'ai_start_request'
        ));
        expect(startCall?.[1]).toMatchObject({
          request: {
            task: 'explainTerminal',
            context: originalContext,
          },
        });
      });
      const retryRequestId = useAiStore.getState().activeRequestId;
      expect(useAiStore.getState().messages.find((item) => (
        item.requestId === retryRequestId && item.role === 'user'
      ))).toMatchObject({
        context: originalContext,
        conversationId: 'retry-conversation',
        sessionId: 'reconnected-session',
      });
    } finally {
      unmount();
      useAiStore.getState().clear();
      useAiStore.getState().setOpen(false);
      useAppStore.setState(previousApp, true);
      useTerminalStore.setState(previousTerminal, true);
      await initI18n(previousApp.locale);
    }
  });

  it('warns about commands outside the read-only allowlist and exposes one copy action', async () => {
    const previousApp = useAppStore.getState();
    const previousTerminal = useTerminalStore.getState();
    await initI18n('en-US');
    useAppStore.setState({ activeSection: 'workbench', locale: 'en-US' });
    useTerminalStore.setState({ sessions: [], activeSessionId: null });
    useAiStore.getState().clear();
    useAiStore.getState().beginRequest({
      requestId: 'manual-review-command',
      task: 'generateCommand',
      userContent: 'Restart the service',
      providerId: 'ollama',
    });
    useAiStore.getState().appendDelta(
      'manual-review-command',
      '```bash\nsystemctl restart nginx\n```',
    );
    useAiStore.getState().completeRequest('manual-review-command');
    useAiStore.getState().setOpen(true);

    const { unmount } = render(createElement(AiPanel));
    try {
      fireEvent.click(screen.getByRole('button', { name: 'Generate command' }));

      expect(await screen.findByText('Manual command review required')).toBeInTheDocument();
      expect(screen.getAllByRole('button', { name: 'Copy' })).toHaveLength(1);
      expect(screen.queryByRole('button', { name: 'Insert into terminal' })).toBeNull();
    } finally {
      unmount();
      useAiStore.getState().clear();
      useAiStore.getState().setOpen(false);
      useAppStore.setState(previousApp, true);
      useTerminalStore.setState(previousTerminal, true);
      await initI18n(previousApp.locale);
    }
  });

  it('does not offer to insert an unbound command from a non-terminal section', async () => {
    const previousApp = useAppStore.getState();
    const previousTerminal = useTerminalStore.getState();
    await initI18n('en-US');
    useAppStore.setState({ activeSection: 'workbench', locale: 'en-US' });
    useTerminalStore.setState({
      sessions: [{
        sessionId: 'background-session',
        title: 'Background terminal',
        host: 'example.com',
        port: 22,
        username: 'root',
        status: 'connected',
        conversationId: 'background-conversation',
        conversationStartedAt: '2026-08-22T09:00:00.000Z',
      }],
      activeSessionId: 'background-session',
    });
    useAiStore.getState().clear();
    useAiStore.getState().beginRequest({
      requestId: 'unbound-command',
      task: 'generateCommand',
      userContent: 'Show disk usage',
      providerId: 'provider-1',
    });
    useAiStore.getState().appendDelta('unbound-command', '```bash\ndf -h\n```');
    useAiStore.getState().completeRequest('unbound-command');
    useAiStore.getState().setOpen(true);

    const { unmount } = render(createElement(AiPanel));
    try {
      fireEvent.click(screen.getByRole('button', { name: 'Generate command' }));
      expect(await screen.findByRole('button', { name: 'Insert into terminal' })).toBeDisabled();
    } finally {
      unmount();
      useAiStore.getState().clear();
      useAiStore.getState().setOpen(false);
      useAppStore.setState(previousApp, true);
      useTerminalStore.setState(previousTerminal, true);
      await initI18n(previousApp.locale);
    }
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

  it('keeps Agent history in its own exact-target lane', () => {
    const targetA = {
      kind: 'remote' as const,
      sessionId: 'session-a',
      host: 'a.example.com',
      port: 22,
      username: 'root',
    };
    const targetB = { ...targetA, sessionId: 'session-b' };
    expect(selectAgentConversationHistory([
      {
        id: 'agent-a-user',
        requestId: 'agent-a',
        role: 'user',
        content: 'Check A',
        status: 'completed',
        providerId: 'openai',
        target: targetA,
        toolCallIds: [],
      },
      {
        id: 'agent-a-tool-only',
        requestId: 'agent-a',
        role: 'assistant',
        content: '',
        status: 'completed',
        providerId: 'openai',
        target: targetA,
        toolCallIds: ['call-a'],
      },
      {
        id: 'agent-b-user',
        requestId: 'agent-b',
        role: 'user',
        content: 'Check B',
        status: 'completed',
        providerId: 'openai',
        target: targetB,
        toolCallIds: [],
      },
    ], targetA)).toEqual([{ role: 'user', content: 'Check A' }]);
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
    expect(shouldCompactAiModeControls(400, 'en-US')).toBe(true);
    expect(shouldCompactAiModeControls(440, 'en-US')).toBe(false);
    expect(shouldCompactAiModeControls(400, 'zh-CN')).toBe(false);
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

      expect(chatMode).toHaveTextContent('问答');
      expect(commandMode).toHaveTextContent('生成命令');
      expect(chatMode.querySelector('svg')).toHaveAttribute('data-icon', 'inline-start');
      expect(commandMode.querySelector('svg')).toHaveAttribute('data-icon', 'inline-start');
      expect(chatMode.querySelector('svg')).toHaveClass('-translate-y-px');
      expect(commandMode.querySelector('svg')).toHaveClass('-translate-y-px');

      fireEvent.keyDown(handle, { key: 'ArrowRight' });

      expect(chatMode).not.toHaveTextContent('问答');
      expect(commandMode).not.toHaveTextContent('生成命令');
      expect(chatMode.querySelector('svg')).not.toHaveAttribute('data-icon');
      expect(commandMode.querySelector('svg')).not.toHaveAttribute('data-icon');
      expect(chatMode.querySelector('svg')).not.toHaveClass('-translate-y-px');
      expect(commandMode.querySelector('svg')).not.toHaveClass('-translate-y-px');
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
      expect(handle).toHaveClass('w-1', '-left-0.5');
      expect(container.querySelector('[data-slot="ai-panel-resize-indicator"]')).toHaveClass(
        'w-px',
        'group-hover:w-1',
        'group-hover:delay-200',
        'group-data-[resizing]:w-1',
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
  it('reads the latest redacted context when manually sending before a live refresh', async () => {
    const previousApp = useAppStore.getState();
    const previousTerminal = useTerminalStore.getState();
    await initI18n('en-US');
    useAiStore.getState().clear();
    useAppStore.setState({ activeSection: 'terminal', locale: 'en-US' });
    useTerminalStore.setState({
      sessions: [{
        sessionId: 'manual-latest',
        title: 'Manual latest',
        host: 'manual.example.com',
        port: 22,
        username: 'root',
        status: 'connected',
      }],
      activeSessionId: 'manual-latest',
    });
    appendTerminalOutput('manual-latest', 'initial\n');
    useAiStore.getState().setOpen(true);
    const pendingFrames = new Map<number, FrameRequestCallback>();
    let nextFrameId = 0;
    const requestFrame = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      nextFrameId += 1;
      pendingFrames.set(nextFrameId, callback);
      return nextFrameId;
    });
    const cancelFrame = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((frameId) => {
      pendingFrames.delete(frameId);
    });

    const { unmount } = render(createElement(AiPanel));
    try {
      act(() => {
        appendTerminalOutput(
          'manual-latest',
          'password=manual-send-secret\nlatest-before-send\n',
        );
      });
      fireEvent.click(screen.getByRole('button', { name: 'Analyze terminal' }));

      await waitFor(() => {
        const startCall = tauriCoreMock.invoke.mock.calls.find(([command]) => (
          command === 'ai_start_request'
        ));
        expect(startCall?.[1]).toMatchObject({
          request: {
            context: {
              content: expect.stringContaining('latest-before-send'),
            },
          },
        });
        expect(startCall?.[1].request.context.content).toContain('password=[REDACTED]');
        expect(startCall?.[1].request.context.content).not.toContain('manual-send-secret');
      });
    } finally {
      unmount();
      useAiStore.getState().clear();
      useAiStore.getState().setOpen(false);
      clearTerminalOutput('manual-latest');
      useAppStore.setState(previousApp, true);
      useTerminalStore.setState(previousTerminal, true);
      requestFrame.mockRestore();
      cancelFrame.mockRestore();
      await initI18n(previousApp.locale);
    }
  });

  it('coalesces only active-session output and flushes the trailing update within 50ms', async () => {
    const previousApp = useAppStore.getState();
    const previousTerminal = useTerminalStore.getState();
    await initI18n('en-US');
    useAppStore.setState({ activeSection: 'terminal', locale: 'en-US' });
    useTerminalStore.setState({
      sessions: [
        {
          sessionId: 'live-active',
          title: 'Active',
          host: 'active.example.com',
          port: 22,
          username: 'root',
          status: 'connected',
        },
        {
          sessionId: 'live-background',
          title: 'Background',
          host: 'background.example.com',
          port: 22,
          username: 'root',
          status: 'connected',
        },
      ],
      activeSessionId: 'live-active',
    });
    appendTerminalOutput('live-active', 'initial\n');
    appendTerminalOutput('live-background', 'background initial\n');
    useAiStore.getState().setOpen(true);

    vi.useFakeTimers();
    let nextFrameId = 0;
    const frames = new Map<number, FrameRequestCallback>();
    const requestFrame = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      nextFrameId += 1;
      frames.set(nextFrameId, callback);
      return nextFrameId;
    });
    const cancelFrame = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((frameId) => {
      frames.delete(frameId);
    });
    const flushFrames = (): void => {
      for (const [frameId, callback] of [...frames]) {
        frames.delete(frameId);
        callback(0);
      }
    };

    const { unmount } = render(createElement(AiPanel));
    try {
      act(flushFrames);
      expect(screen.getByRole('button', {
        name: /root@active\.example\.com · Latest 1 lines/,
      })).toBeInTheDocument();

      act(() => appendTerminalOutput('live-background', 'background ignored\n'));
      expect(frames).toHaveLength(0);

      act(() => {
        appendTerminalOutput('live-active', 'next\n');
        appendTerminalOutput('live-active', 'password=latest-secret\n');
      });
      expect(frames).toHaveLength(1);
      expect(screen.getByRole('button', {
        name: /root@active\.example\.com · Latest 1 lines/,
      })).toBeInTheDocument();

      act(() => vi.advanceTimersByTime(LIVE_TERMINAL_CONTEXT_MAX_LATENCY_MS - 1));
      expect(screen.getByRole('button', {
        name: /root@active\.example\.com · Latest 1 lines/,
      })).toBeInTheDocument();
      act(() => vi.advanceTimersByTime(1));
      expect(frames).toHaveLength(0);
      expect(screen.getByRole('button', {
        name: /root@active\.example\.com · Latest 3 lines/,
      })).toBeInTheDocument();

      act(() => useTerminalStore.getState().setActiveSession('live-background'));
      expect(screen.getByRole('button', {
        name: /root@background\.example\.com · Latest 2 lines/,
      })).toBeInTheDocument();
      act(() => appendTerminalOutput('live-active', 'old active output\n'));
      expect(frames).toHaveLength(0);
      act(() => appendTerminalOutput('live-background', 'new active output\n'));
      expect(frames).toHaveLength(1);

      act(() => useAiStore.getState().setOpen(false));
      act(flushFrames);
      act(() => appendTerminalOutput('live-background', 'closed panel output\n'));
      expect(frames).toHaveLength(0);
    } finally {
      unmount();
      useAiStore.getState().setOpen(false);
      clearTerminalOutput('live-active');
      clearTerminalOutput('live-background');
      useAppStore.setState(previousApp, true);
      useTerminalStore.setState(previousTerminal, true);
      requestFrame.mockRestore();
      cancelFrame.mockRestore();
      vi.useRealTimers();
      await initI18n(previousApp.locale);
    }
  });

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
    const previousApp = useAppStore.getState();
    await initI18n('en-US');
    useAppStore.setState({ locale: 'en-US' });
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
      useAppStore.setState(previousApp, true);
      await initI18n(previousApp.locale);
    }
  });

  it('keeps a failed history load retryable instead of caching an empty session', async () => {
    const previousApp = useAppStore.getState();
    const previousTerminal = useTerminalStore.getState();
    await initI18n('en-US');
    useAppStore.setState({ activeSection: 'workbench', locale: 'en-US' });
    useTerminalStore.setState({ sessions: [], activeSessionId: null });
    useAiStore.getState().clear();
    const conversation = {
      id: 'retryable-history',
      startedAt: '2026-08-22T09:00:00.000Z',
      updatedAt: '2026-08-22T09:01:00.000Z',
      title: 'root@retry.example.com',
      archived: true,
      sessionId: 'closed-session',
      host: 'retry.example.com',
      port: 22,
      username: 'root',
    };
    useAiStore.getState().hydrateSessionIndex([conversation]);
    let loadAttempts = 0;
    tauriCoreMock.invoke.mockImplementation((command: string) => {
      if (command !== 'load_ai_session') return Promise.resolve(undefined);
      loadAttempts += 1;
      if (loadAttempts === 1) return Promise.reject(new Error('temporary read failure'));
      return Promise.resolve({
        conversation,
        messages: [message('loaded-after-retry', 'user', 'Recovered history', {
          conversationId: conversation.id,
          sessionId: conversation.sessionId,
        })],
      });
    });
    useAiStore.getState().setOpen(true);

    const { unmount } = render(createElement(AiPanel));
    try {
      fireEvent.click(screen.getByRole('button', { name: 'Conversation history' }));
      fireEvent.click(await screen.findByText(conversation.title));

      const loadFailure = await screen.findByText('Conversation history unavailable');
      expect(useAiStore.getState().loadedConversationIds).not.toContain(conversation.id);
      const alert = loadFailure.closest('[role="alert"]');
      expect(alert).not.toBeNull();
      fireEvent.click(within(alert as HTMLElement).getByRole('button', { name: 'Retry' }));

      expect(await screen.findByText('Recovered history')).toBeInTheDocument();
      expect(useAiStore.getState().loadedConversationIds).toContain(conversation.id);
      expect(loadAttempts).toBe(2);
    } finally {
      unmount();
      useAiStore.getState().clear();
      useAiStore.getState().setOpen(false);
      useAppStore.setState(previousApp, true);
      useTerminalStore.setState(previousTerminal, true);
      await initI18n(previousApp.locale);
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

});

describe('cancelActiveAiRequests', () => {
  beforeEach(() => {
    useAiStore.getState().clear();
  });

  it('immediately clears the loading state and cancels the backend request', () => {
    useAiStore.getState().beginRequest({
      requestId: 'chat-request',
      task: 'chat',
      userContent: 'hello',
      providerId: 'provider-1',
    });
    const cancelBackend = vi.fn().mockResolvedValue(undefined);

    expect(cancelActiveAiRequests(cancelBackend)).toEqual(['chat-request']);

    expect(useAiStore.getState()).toMatchObject({
      phase: 'idle',
      activeRequestId: undefined,
    });
    expect(useAiStore.getState().messages.some((message) => (
      message.requestId === 'chat-request' && message.status === 'streaming'
    ))).toBe(false);
    expect(cancelBackend).toHaveBeenCalledTimes(1);
    expect(cancelBackend).toHaveBeenCalledWith('chat-request');
  });
});
