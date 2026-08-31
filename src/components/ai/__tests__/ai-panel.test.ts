import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { initI18n } from '@/locales';
import { useAiStore } from '@/stores/aiStore';
import { useAppStore } from '@/stores/appStore';
import { useTerminalStore } from '@/stores/terminalStore';
import { useProfileStore } from '@/stores/profileStore';
import { useAiSettingsStore } from '@/stores/aiSettingsStore';
import { useAgentPermissionStore } from '@/stores/agentPermissionStore';
import { useAgentStore } from '@/stores/agentStore';
import { resetAgentProviderCapabilityCacheForTests } from '@/lib/agent-provider-capability';
import type { AiChatMessage, AiStreamEvent } from '@/types/ai';
import {
  AI_HISTORY_MAX_MESSAGE_BYTES,
  AI_REQUEST_MAX_MESSAGE_BYTES,
  aiUtf8ByteLength,
} from '@/lib/ai-request-budget';
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
  getAiPanelWidthBounds,
  retrySnapshotForMessage,
  sanitizeTerminalSelection,
  selectAgentConversationHistory,
  selectConversationHistory,
  shouldSubmitAiDraft,
  summarizeAiError,
} from '../ai-panel';

const tauriCoreMock = vi.hoisted(() => ({ invoke: vi.fn() }));
const tauriEventMock = vi.hoisted(() => ({
  listen: vi.fn(async (
    _event: string,
    _handler: (event: { payload: AiStreamEvent }) => void,
  ) => () => {}),
}));
const agentUiMock = vi.hoisted(() => ({
  connect: vi.fn(async () => {}),
  start: vi.fn(async () => 'agent-request'),
  stop: vi.fn(() => true),
  approve: vi.fn(() => true),
  reject: vi.fn(() => true),
  retry: vi.fn(async () => 'retry-request'),
  canRetry: vi.fn(() => false),
}));

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

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
  resetAgentProviderCapabilityCacheForTests();
  window.localStorage.removeItem('shellspan.aiPanelWidth');
  tauriCoreMock.invoke.mockReset();
  tauriCoreMock.invoke.mockResolvedValue(undefined);
  tauriEventMock.listen.mockClear();
  Object.values(agentUiMock).forEach((mock) => mock.mockClear());
  useAgentPermissionStore.getState().resetAll();
  useAgentStore.setState({ activeRequestId: undefined });
  useAgentStore.getState().clear();
});

describe('explicit AI modes', () => {
  it('shows and updates Kimi K3 thinking effort from the model menu', async () => {
    const previousApp = useAppStore.getState();
    const previousSettings = useAiSettingsStore.getState();
    await initI18n('en-US');
    useAppStore.setState({ locale: 'en-US' });
    useAiSettingsStore.setState({
      providers: [{
        id: 'kimi',
        name: 'Kimi Code',
        preset: 'kimi',
        kind: 'openAiCompatible',
        baseUrl: 'https://api.kimi.com/coding',
        model: 'k3',
        reasoningEffort: 'high',
        requiresApiKey: true,
      }],
      defaultProviderId: 'kimi',
    });
    useAiStore.getState().setOpen(true);

    const { unmount } = render(createElement(AiPanel));
    try {
      const providerSelector = await screen.findByRole('button', {
        name: 'Switch AI provider',
      });
      expect(providerSelector).toHaveTextContent('Kimi Code · k3 · High');

      fireEvent.click(providerSelector);
      fireEvent.click(await screen.findByRole('menuitemradio', { name: 'Max' }));
      await waitFor(() => expect(useAiSettingsStore.getState().providers[0])
        .toHaveProperty('reasoningEffort', 'max'));
    } finally {
      unmount();
      useAiStore.getState().setOpen(false);
      useAiSettingsStore.setState(previousSettings, true);
      useAppStore.setState(previousApp, true);
      await initI18n(previousApp.locale);
    }
  });

  it('keeps the Agent entry visible when the runtime rollout is unavailable', async () => {
    const previousApp = useAppStore.getState();
    await initI18n('en-US');
    useAppStore.setState({ locale: 'en-US' });
    useAiStore.getState().clear();
    useAiStore.getState().setOpen(true);
    const { unmount } = render(createElement(AiPanel));
    try {
      const modeSelector = await screen.findByRole('button', { name: 'AI mode' });
      expect(modeSelector).toBeEnabled();
      expect(modeSelector).toHaveTextContent('Ask');
      expect(screen.queryByRole('button', { name: 'Terminal permissions' })).not.toBeInTheDocument();

      fireEvent.click(modeSelector);
      const askOption = await screen.findByRole('menuitemradio', { name: /^Ask/ });
      expect(screen.getByRole('menu')).toHaveClass('w-64');
      expect(askOption).toHaveClass('py-1.5');
      expect(askOption).toHaveAttribute('aria-checked', 'true');
      const agentOption = screen.getByRole('menuitemradio', { name: /^Agent/ });
      expect(agentOption).toHaveClass('py-1.5');
      expect(agentOption).toHaveAttribute('aria-disabled', 'true');
      expect(agentOption).toHaveTextContent(/disabled by the current rollout policy/i);
    } finally {
      unmount();
      useAiStore.getState().clear();
      useAiStore.getState().setOpen(false);
      useAppStore.setState(previousApp, true);
      await initI18n(previousApp.locale);
    }
  });

  it('routes Ask only to AI and Agent only to the Agent coordinator while preserving the draft', async () => {
    const previousApp = useAppStore.getState();
    const previousTerminal = useTerminalStore.getState();
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    });
    tauriCoreMock.invoke.mockImplementation(async (command: string) => {
      if (command === 'agent_rollout_policy') {
        return {
          stage: 'stable',
          featureEnabled: true,
          defaultAgentEnabled: true,
          defaultPermissionMode: 'requestApproval',
          availablePermissionModes: ['requestApproval', 'autoApproveReadOnly', 'fullAccess'],
          collectLocalDiagnostics: false,
        };
      }
      if (command === 'agent_contract_status') {
        return {
          contractVersion: 2,
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
      const inputGroup = textbox.closest('[data-slot="input-group"]');
      expect(inputGroup).toHaveAttribute('data-mode', 'ask');
      expect(inputGroup).toHaveClass('bg-card');
      expect(screen.getByRole('button', { name: 'Send' })).toHaveClass(
        'bg-app-button',
        'text-app-button-text',
      );
      fireEvent.change(textbox, { target: { value: 'Explain nginx' } });
      fireEvent.click(screen.getByRole('button', { name: 'Send' }));
      await waitFor(() => expect(tauriCoreMock.invoke).toHaveBeenCalledWith(
        'ai_start_request',
        expect.anything(),
      ));
      expect(tauriCoreMock.invoke.mock.calls.find(([command]) => (
        command === 'ai_start_request'
      ))?.[1]).toMatchObject({ request: { task: 'ask' } });
      expect(agentUiMock.start).not.toHaveBeenCalled();
      act(() => {
        const requestId = useAiStore.getState().activeRequestId;
        if (requestId) useAiStore.getState().cancelRequest(requestId);
      });

      fireEvent.change(textbox, { target: { value: 'Verify nginx' } });
      const modeSelector = await screen.findByRole('button', { name: 'AI mode' });
      expect(modeSelector).toHaveTextContent('Ask');
      expect(modeSelector).toHaveClass('hover:bg-accent');
      expect(modeSelector).not.toHaveClass('bg-secondary');
      expect(modeSelector.querySelector('[data-slot="ai-mode-trigger-content"]')).toHaveClass(
        'items-center',
        'leading-none',
      );
      expect(screen.queryByRole('button', { name: 'Terminal permissions' })).not.toBeInTheDocument();
      fireEvent.click(modeSelector);
      const agentOption = await screen.findByRole('menuitemradio', { name: /^Agent/ });
      await waitFor(() => expect(agentOption).not.toHaveAttribute('aria-disabled', 'true'));
      fireEvent.click(agentOption);
      await waitFor(() => expect(modeSelector).toHaveTextContent('Agent'));
      expect(textbox).toHaveValue('Verify nginx');
      expect(inputGroup).toHaveAttribute('data-mode', 'agent');
      expect(inputGroup).toHaveAttribute('data-permission-mode', 'requestApproval');
      expect(inputGroup).toHaveClass(
        'border-app-warning/60',
        'has-[[data-slot=input-group-control]:focus-visible]:border-app-warning/80',
        'has-[[data-slot=input-group-control]:focus-visible]:ring-app-warning/30',
      );
      expect(screen.getByRole('button', { name: 'Terminal permissions' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Send' })).toHaveClass(
        'bg-app-warning',
        'text-app-primary-text',
      );

      fireEvent.click(screen.getByRole('button', { name: 'Terminal permissions' }));
      fireEvent.click(await screen.findByRole('menuitemradio', { name: /^Full access/ }));
      fireEvent.click(await screen.findByRole('button', { name: 'Enable full access' }));
      await waitFor(() => expect(inputGroup).toHaveAttribute('data-permission-mode', 'fullAccess'));
      expect(inputGroup).toHaveClass(
        'border-app-warning/60',
        'has-[[data-slot=input-group-control]:focus-visible]:border-app-warning/80',
        'has-[[data-slot=input-group-control]:focus-visible]:ring-app-warning/30',
      );
      expect(inputGroup).toHaveClass('bg-card');
      expect(inputGroup).toHaveClass('transition-none');
      fireEvent.click(screen.getByRole('button', { name: 'Send' }));
      await waitFor(() => expect(agentUiMock.start).toHaveBeenCalledWith(expect.objectContaining({
        goal: 'Verify nginx',
        target: expect.objectContaining({ sessionId: 'mode-session' }),
      })));
      expect(tauriCoreMock.invoke.mock.calls.filter(([command]) => command === 'ai_start_request'))
        .toHaveLength(1);
      act(() => useAgentStore.setState({ activeRequestId: 'agent-request' }));
      expect(screen.getByRole('button', { name: 'Stop Agent task' })).toHaveClass(
        'bg-app-warning',
        'text-app-primary-text',
      );
      act(() => useAgentStore.setState({ activeRequestId: undefined }));
      fireEvent.change(textbox, { target: { value: 'Draft the next question' } });
      fireEvent.click(modeSelector);
      fireEvent.click(await screen.findByRole('menuitemradio', { name: /^Ask/ }));
      expect(textbox).toHaveValue('Draft the next question');
      expect(modeSelector).toHaveTextContent('Ask');
      expect(inputGroup).toHaveAttribute('data-mode', 'ask');
      expect(inputGroup).not.toHaveClass('border-app-warning/60');
      expect(screen.queryByRole('button', { name: 'Terminal permissions' })).not.toBeInTheDocument();
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

  it('keeps pending Agent starts bound to the active conversation and cancellable', async () => {
    const previousApp = useAppStore.getState();
    const previousTerminal = useTerminalStore.getState();
    const previousSettings = useAiSettingsStore.getState();
    const previousTauriInternals = Object.getOwnPropertyDescriptor(window, '__TAURI_INTERNALS__');
    const pendingCreate = deferred<void>();
    const pendingConnect = deferred<void>();
    agentUiMock.connect
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockImplementationOnce(() => pendingConnect.promise);
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    });
    tauriCoreMock.invoke.mockImplementation((command: string) => {
      if (command === 'agent_rollout_policy') {
        return Promise.resolve({
          stage: 'stable',
          featureEnabled: true,
          defaultAgentEnabled: true,
          defaultPermissionMode: 'requestApproval',
          availablePermissionModes: ['requestApproval', 'autoApproveReadOnly', 'fullAccess'],
          collectLocalDiagnostics: false,
        });
      }
      if (command === 'agent_contract_status') {
        return Promise.resolve({
          contractVersion: 2,
          featureEnabled: true,
          agentAvailable: true,
          defaultPermissionMode: 'requestApproval',
          providerCapability: {
            support: 'supported',
            source: 'ollamaModelMetadata',
          },
        });
      }
      if (command === 'create_ai_session') return pendingCreate.promise;
      return Promise.resolve(undefined);
    });
    await initI18n('en-US');
    useAiSettingsStore.setState({
      providers: [{
        id: 'pending-agent-provider',
        name: 'Pending Agent provider',
        preset: 'ollama',
        kind: 'ollama',
        baseUrl: 'http://127.0.0.1:11434',
        model: 'qwen3',
        requiresApiKey: false,
      }],
      defaultProviderId: 'pending-agent-provider',
      agentEnabled: true,
    });
    useAiStore.getState().clear();
    useAiStore.getState().setOpen(true);
    useAppStore.setState({ activeSection: 'terminal', locale: 'en-US' });
    useTerminalStore.setState({
      sessions: [{
        sessionId: 'pending-agent-session',
        title: 'Pending Agent target',
        host: 'pending-agent.example.com',
        port: 22,
        username: 'root',
        status: 'connected',
        conversationId: 'pending-agent-conversation',
        conversationStartedAt: '2026-08-31T05:00:00.000Z',
      }],
      activeSessionId: 'pending-agent-session',
    });

    const { unmount } = render(createElement(AiPanel));
    try {
      const modeSelector = await screen.findByRole('button', { name: 'AI mode' });
      fireEvent.click(modeSelector);
      const agentOption = await screen.findByRole('menuitemradio', { name: /^Agent/ });
      await waitFor(() => expect(agentOption).not.toHaveAttribute('aria-disabled', 'true'));
      fireEvent.click(agentOption);
      await waitFor(() => expect(modeSelector).toHaveTextContent('Agent'));

      const textbox = screen.getByRole('textbox');
      fireEvent.change(textbox, { target: { value: 'Verify the current target' } });
      fireEvent.click(screen.getByRole('button', { name: 'Send' }));
      await waitFor(() => expect(tauriCoreMock.invoke).toHaveBeenCalledWith(
        'create_ai_session',
        expect.anything(),
      ));
      expect(screen.getByRole('button', { name: 'New conversation' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Conversation history' })).toBeDisabled();

      act(() => {
        useTerminalStore.getState().startNewConversation('pending-agent-session');
      });
      expect(useTerminalStore.getState().sessions[0]?.conversationId)
        .not.toBe('pending-agent-conversation');
      await act(async () => {
        pendingCreate.resolve(undefined);
        await pendingCreate.promise;
      });
      await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled());

      expect(agentUiMock.start).not.toHaveBeenCalled();
      expect(textbox).toHaveValue('Verify the current target');

      fireEvent.click(screen.getByRole('button', { name: 'Send' }));
      await waitFor(() => expect(tauriCoreMock.invoke.mock.calls.filter(([command]) => (
        command === 'create_ai_session'
      ))).toHaveLength(2));
      await waitFor(() => expect(agentUiMock.connect).toHaveBeenCalledTimes(3));
      expect(agentUiMock.start).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole('button', { name: 'Stop Agent task' }));
      expect(agentUiMock.stop).not.toHaveBeenCalled();
      await act(async () => {
        pendingConnect.resolve(undefined);
        await pendingConnect.promise;
      });
      await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled());
      expect(agentUiMock.start).not.toHaveBeenCalled();
      expect(textbox).toHaveValue('Verify the current target');

      const pendingStart = deferred<string>();
      agentUiMock.start.mockImplementationOnce(() => {
        useAgentStore.setState({ activeRequestId: 'pending-agent-request' });
        return pendingStart.promise;
      });
      fireEvent.click(screen.getByRole('button', { name: 'Send' }));
      await waitFor(() => expect(tauriCoreMock.invoke.mock.calls.filter(([command]) => (
        command === 'create_ai_session'
      ))).toHaveLength(3));
      await waitFor(() => expect(agentUiMock.start).toHaveBeenCalledTimes(1));
      expect(screen.getByRole('button', { name: 'Conversation history' })).toBeDisabled();

      fireEvent.click(screen.getByRole('button', { name: 'Stop Agent task' }));
      expect(agentUiMock.stop).toHaveBeenCalledWith('pending-agent-request');
      await act(async () => {
        pendingStart.resolve('pending-agent-request');
        await pendingStart.promise;
      });
      await waitFor(() => expect(agentUiMock.stop).toHaveBeenCalledTimes(2));
      act(() => useAgentStore.setState({ activeRequestId: undefined }));
      await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled());
      expect(textbox).toHaveValue('Verify the current target');
    } finally {
      pendingCreate.resolve(undefined);
      unmount();
      useAiStore.getState().clear();
      useAiStore.getState().setOpen(false);
      useAiSettingsStore.setState(previousSettings, true);
      useTerminalStore.setState(previousTerminal, true);
      useAppStore.setState(previousApp, true);
      if (previousTauriInternals) {
        Object.defineProperty(window, '__TAURI_INTERNALS__', previousTauriInternals);
      } else {
        Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
      }
      await initI18n(previousApp.locale);
    }
  });

  it('defers a remote capability probe until the user explicitly selects Agent', async () => {
    const previousApp = useAppStore.getState();
    const previousTerminal = useTerminalStore.getState();
    const previousSettings = useAiSettingsStore.getState();
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    });
    tauriCoreMock.invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'agent_rollout_policy') {
        return {
          stage: 'stable',
          featureEnabled: true,
          defaultAgentEnabled: true,
          defaultPermissionMode: 'requestApproval',
          availablePermissionModes: ['requestApproval', 'autoApproveReadOnly', 'fullAccess'],
          collectLocalDiagnostics: false,
        };
      }
      if (command === 'agent_contract_status') {
        const evidence = args?.evidence as { support?: string; source?: string } | undefined;
        return {
          contractVersion: 2,
          featureEnabled: true,
          agentAvailable: evidence?.support === 'supported',
          defaultPermissionMode: 'requestApproval',
          providerCapability: evidence ?? {
            support: 'unknown',
            source: 'ollamaModelMetadata',
          },
        };
      }
      if (command === 'agent_detect_provider_capability') {
        return { support: 'supported', source: 'ollamaModelMetadata' };
      }
      return undefined;
    });
    await initI18n('en-US');
    useAiSettingsStore.setState({ agentEnabled: true });
    useAiStore.getState().clear();
    useAiStore.getState().setOpen(true);
    useAppStore.setState({ activeSection: 'terminal', locale: 'en-US' });
    useTerminalStore.setState({
      sessions: [{
        sessionId: 'probe-session',
        title: 'Probe target',
        host: 'probe.example.com',
        port: 22,
        username: 'root',
        status: 'connected',
        conversationId: 'probe-conversation',
        conversationStartedAt: '2026-08-28T00:00:00.000Z',
      }],
      activeSessionId: 'probe-session',
    });

    const { unmount } = render(createElement(AiPanel));
    try {
      const providerSelector = screen.getByRole('button', { name: 'Switch AI provider' });
      expect(providerSelector.closest('header')).not.toBeNull();
      expect(providerSelector.closest('[data-slot="input-group"]')).toBeNull();

      const modeSelector = await screen.findByRole('button', { name: 'AI mode' });
      expect(tauriCoreMock.invoke.mock.calls.filter(([command]) => (
        command === 'agent_detect_provider_capability'
      ))).toHaveLength(0);

      fireEvent.click(modeSelector);
      const agentOption = await screen.findByRole('menuitemradio', { name: /^Agent/ });
      await waitFor(() => expect(agentOption).not.toHaveAttribute('aria-disabled', 'true'));
      fireEvent.click(agentOption);

      await waitFor(() => expect(tauriCoreMock.invoke.mock.calls.filter(([command]) => (
        command === 'agent_detect_provider_capability'
      ))).toHaveLength(1));
      await waitFor(() => expect(modeSelector).toHaveTextContent('Agent'));

      useAiSettingsStore.getState().updateProvider(
        useAiSettingsStore.getState().defaultProviderId,
        { model: 'changed-agent-model' },
      );
      await waitFor(() => expect(tauriCoreMock.invoke.mock.calls.filter(([command]) => (
        command === 'agent_detect_provider_capability'
      ))).toHaveLength(2));
      const probes = tauriCoreMock.invoke.mock.calls.filter(([command]) => (
        command === 'agent_detect_provider_capability'
      ));
      expect(probes[1]?.[1]).toMatchObject({
        provider: { model: 'changed-agent-model' },
      });
    } finally {
      unmount();
      delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
      useAiStore.getState().clear();
      useAiStore.getState().setOpen(false);
      useAppStore.setState(previousApp, true);
      useTerminalStore.setState(previousTerminal, true);
      useAiSettingsStore.setState(previousSettings, true);
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
            task: 'ask',
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

  it('keeps legacy generated-command records hidden from the Ask conversation', async () => {
    const previousApp = useAppStore.getState();
    const previousTerminal = useTerminalStore.getState();
    await initI18n('en-US');
    useAppStore.setState({ activeSection: 'terminal', locale: 'en-US' });
    useTerminalStore.setState({
      sessions: [{
        sessionId: 'manual-review-session',
        title: 'Service terminal',
        host: 'example.com',
        port: 22,
        username: 'root',
        status: 'connected',
        conversationId: 'manual-review-conversation',
        conversationStartedAt: '2026-08-29T00:00:00.000Z',
      }],
      activeSessionId: 'manual-review-session',
    });
    useAiStore.getState().clear();
    useAiStore.getState().beginRequest({
      requestId: 'manual-review-command',
      task: 'generateCommand',
      userContent: 'Restart the service',
      providerId: 'ollama',
      conversationId: 'manual-review-conversation',
      sessionId: 'manual-review-session',
    });
    useAiStore.getState().appendDelta(
      'manual-review-command',
      '```bash\nsystemctl restart nginx\n```',
    );
    useAiStore.getState().completeRequest('manual-review-command');
    useAiStore.getState().setOpen(true);

    const { unmount } = render(createElement(AiPanel));
    try {
      expect(screen.queryByText('systemctl restart nginx')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Insert into terminal' })).not.toBeInTheDocument();
    } finally {
      unmount();
      useAiStore.getState().clear();
      useAiStore.getState().setOpen(false);
      useAppStore.setState(previousApp, true);
      useTerminalStore.setState(previousTerminal, true);
      await initI18n(previousApp.locale);
    }
  });

  it('renders Ask code blocks without any terminal insertion action', async () => {
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
      requestId: 'ask-code-block',
      task: 'ask',
      userContent: 'How can I check disk usage?',
      providerId: 'provider-1',
    });
    useAiStore.getState().appendDelta('ask-code-block', 'This command reports disk usage:\n```bash\ndf -h\n```');
    useAiStore.getState().completeRequest('ask-code-block');
    useAiStore.getState().setOpen(true);

    const { unmount } = render(createElement(AiPanel));
    try {
      expect(await screen.findByText('df -h')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Insert into terminal' })).not.toBeInTheDocument();
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

describe('AI request resource feedback', () => {
  it('keeps an oversized current draft and does not invoke the backend', async () => {
    const previousApp = useAppStore.getState();
    const previousSettings = useAiSettingsStore.getState();
    await initI18n('en-US');
    useAppStore.setState({ locale: 'en-US' });
    useAiSettingsStore.setState({
      providers: [{
        id: 'bounded-provider',
        name: 'Bounded provider',
        preset: 'ollama',
        kind: 'ollama',
        baseUrl: 'http://127.0.0.1:11434',
        model: 'bounded-model',
        requiresApiKey: false,
      }],
      defaultProviderId: 'bounded-provider',
    });
    useAiStore.getState().clear();
    useAiStore.getState().setOpen(true);
    const oversized = 'x'.repeat(AI_REQUEST_MAX_MESSAGE_BYTES + 1);

    const { unmount } = render(createElement(AiPanel));
    try {
      const textbox = screen.getByRole('textbox');
      fireEvent.change(textbox, { target: { value: oversized } });
      fireEvent.click(screen.getByRole('button', { name: 'Send' }));

      expect(await screen.findByText('Message is too large to send')).toBeVisible();
      expect(screen.getByText(/Your draft has been kept/)).toBeVisible();
      expect(textbox).toHaveValue(oversized);
      expect(tauriCoreMock.invoke.mock.calls.some(([command]) => (
        command === 'ai_start_request'
      ))).toBe(false);
      expect(useAiStore.getState().messages).toHaveLength(0);
    } finally {
      unmount();
      useAiStore.getState().clear();
      useAiStore.getState().setOpen(false);
      useAiSettingsStore.setState(previousSettings, true);
      useAppStore.setState(previousApp, true);
      await initI18n(previousApp.locale);
    }
  });

  it('shows a persistent Marker while keeping omitted history visible locally', async () => {
    const previousApp = useAppStore.getState();
    const previousSettings = useAiSettingsStore.getState();
    await initI18n('en-US');
    useAppStore.setState({ locale: 'en-US' });
    useAiSettingsStore.setState({
      providers: [{
        id: 'bounded-provider',
        name: 'Bounded provider',
        preset: 'ollama',
        kind: 'ollama',
        baseUrl: 'http://127.0.0.1:11434',
        model: 'bounded-model',
        requiresApiKey: false,
      }],
      defaultProviderId: 'bounded-provider',
    });
    const history = Array.from({ length: 7 }, (_, index) => ([
      message(`bounded-${index}`, 'user', `old question ${index}`, { task: 'ask' }),
      message(`bounded-${index}`, 'assistant', `old answer ${index}`, { task: 'ask' }),
    ])).flat();
    useAiStore.setState({
      messages: history,
      conversations: [],
      loadedConversationIds: [],
      phase: 'idle',
      activeRequestId: undefined,
      activeTask: undefined,
      error: undefined,
      errorRequestId: undefined,
      open: true,
    });

    const { unmount } = render(createElement(AiPanel));
    try {
      expect(screen.getByText('old question 0')).toBeVisible();
      fireEvent.change(screen.getByRole('textbox'), { target: { value: 'new question' } });
      fireEvent.click(screen.getByRole('button', { name: 'Send' }));

      const notice = await screen.findByText(
        'Only the context sent to the model was shortened for this request. Your complete local conversation history is unchanged.',
      );
      expect(notice.closest('[data-slot="marker"]')).toBeInTheDocument();
      expect(screen.getByText('old question 0')).toBeVisible();
      expect(useAiStore.getState().messages.some((item) => (
        item.content === 'old question 0'
      ))).toBe(true);

      await waitFor(() => {
        const startCall = tauriCoreMock.invoke.mock.calls.find(([command]) => (
          command === 'ai_start_request'
        ));
        expect(startCall).toBeDefined();
        const args = startCall?.[1] as {
          request: { messages: Array<{ role: string; content: string }> };
        };
        expect(args.request.messages).toHaveLength(13);
        expect(args.request.messages.map((item) => item.content)).not.toContain('old question 0');
        expect(args.request.messages.map((item) => item.content)).toContain('old question 1');
        expect(args.request.messages[args.request.messages.length - 1]).toEqual({
          role: 'user',
          content: 'new question',
        });
      });
    } finally {
      unmount();
      useAiStore.getState().clear();
      useAiStore.getState().setOpen(false);
      useAiSettingsStore.setState(previousSettings, true);
      useAppStore.setState(previousApp, true);
      await initI18n(previousApp.locale);
    }
  });
});

describe('selectConversationHistory', () => {
  it('shares Ask and legacy chat history while keeping generated commands separate', () => {
    const messages = [
      message('chat-1', 'user', 'Explain this'),
      message('chat-1', 'assistant', 'Explanation'),
      message('ask-1', 'user', 'Explain this', { task: 'ask' }),
      message('ask-1', 'assistant', 'Read-only answer', { task: 'ask' }),
      message('command-1', 'user', 'Show disk usage', { task: 'generateCommand' }),
      message('command-1', 'assistant', '```bash\ndf -h\n```', { task: 'generateCommand' }),
    ];

    expect(selectConversationHistory(messages, 'ask').messages.map((item) => item.content))
      .toEqual(['Explain this', 'Explanation', 'Explain this', 'Read-only answer']);
    expect(selectConversationHistory(messages, 'generateCommand').messages.map((item) => item.content))
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

    expect(selectConversationHistory(messages, 'chat').messages.map((item) => item.content))
      .toEqual(['Good request', 'Good answer']);
  });

  it('preserves bounded historical terminal context with an untrusted-data boundary', () => {
    const longContext = `prefix-${'x'.repeat(9000)}`;
    const messages = [
      message('context', 'user', 'What failed?', {
        context: { label: 'root@server', content: longContext },
      }),
      message('context', 'assistant', 'The service failed.'),
    ];

    const [historicalUser] = selectConversationHistory(messages, 'explainTerminal').messages;
    expect(historicalUser.content).toContain('<historical_terminal_context_json>');
    expect(historicalUser.content).toContain('root@server');
    expect(historicalUser.content).not.toContain('prefix-');
    const serialized = historicalUser.content
      .split('<historical_terminal_context_json>\n')[1]
      ?.split('\n</historical_terminal_context_json>')[0];
    expect(serialized).toBeDefined();
    const boundedContext = JSON.parse(serialized!) as { content: string };
    expect(boundedContext.content).toContain('earlier terminal content omitted');
    expect(boundedContext.content).toMatch(/x+$/);
    expect(boundedContext.content).not.toContain('\uFFFD');
    expect(new TextEncoder().encode(boundedContext.content).byteLength).toBeLessThanOrEqual(8 * 1024);
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

    expect(selectConversationHistory(messages, 'chat').messages).toEqual([
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

    expect(selectConversationHistory(messages, 'chat', 'conversation-b').messages).toEqual([
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
        conversationId: 'conversation-a',
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
        conversationId: 'conversation-a',
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
        conversationId: 'conversation-b',
        role: 'user',
        content: 'Check B',
        status: 'completed',
        providerId: 'openai',
        target: targetB,
        toolCallIds: [],
      },
      {
        id: 'agent-a-previous-conversation',
        requestId: 'agent-a-old',
        conversationId: 'conversation-a-old',
        role: 'user',
        content: 'Previous A task',
        status: 'completed',
        providerId: 'openai',
        target: targetA,
        toolCallIds: [],
      },
    ], targetA, 'conversation-a').messages).toEqual([{ role: 'user', content: 'Check A' }]);
  });

  it('applies the shared UTF-8 message budget to Agent history', () => {
    const target = {
      kind: 'remote' as const,
      sessionId: 'session-agent-budget',
      host: 'budget.example.com',
      port: 22,
      username: 'root',
    };
    const longAnswer = `START-${'你😀'.repeat(20_000)}-END`;
    const history = selectAgentConversationHistory([
      {
        id: 'agent-budget-user',
        requestId: 'agent-budget',
        conversationId: 'conversation-agent-budget',
        role: 'user',
        content: 'Inspect the service',
        status: 'completed',
        providerId: 'openai',
        target,
        toolCallIds: [],
      },
      {
        id: 'agent-budget-assistant',
        requestId: 'agent-budget',
        conversationId: 'conversation-agent-budget',
        role: 'assistant',
        content: longAnswer,
        status: 'completed',
        providerId: 'openai',
        target,
        toolCallIds: [],
      },
    ], target, 'conversation-agent-budget', [{ role: 'user', content: 'Continue' }]);

    expect(history.metadata.truncatedMessages).toBe(1);
    expect(history.messages[1].content).toMatch(/^START-/);
    expect(history.messages[1].content).toMatch(/-END$/);
    expect(history.messages[1].content).not.toContain('\uFFFD');
    expect(aiUtf8ByteLength(history.messages[1].content)).toBeLessThanOrEqual(
      AI_HISTORY_MAX_MESSAGE_BYTES,
    );
    expect(longAnswer).toContain('你😀'.repeat(20_000));
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

  it('classifies request and provider response resource limits', () => {
    expect(summarizeAiError('AI request messages are too large').key)
      .toBe('ai.error.requestTooLarge');
    expect(summarizeAiError(
      'AI provider stream exceeded the 16 MiB response limit',
    ).key).toBe('ai.error.responseTooLarge');
    expect(summarizeAiError(
      'AI provider HTTP error body exceeded the 4 KiB response limit',
    ).key).toBe('ai.error.responseTooLarge');
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

  it('keeps the Ask composer controls accessible when the panel narrows', async () => {
    await initI18n('zh-CN');
    useAiStore.getState().setOpen(true);

    try {
      const { unmount } = render(createElement(AiPanel));
      const handle = screen.getByRole('separator', { name: '调整 AI 助手宽度' });
      const modeSelector = screen.getByRole('button', { name: 'AI 模式' });

      expect(modeSelector).toHaveTextContent('Ask');
      expect(screen.queryByRole('button', { name: '终端权限' })).not.toBeInTheDocument();

      fireEvent.keyDown(handle, { key: 'ArrowRight' });

      expect(modeSelector).toHaveTextContent('Ask');
      expect(screen.getByText('想问些什么？')).toBeInTheDocument();
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
      fireEvent.click(screen.getByRole('button', { name: 'Ask about terminal output' }));

      await waitFor(() => {
        const startCall = tauriCoreMock.invoke.mock.calls.find(([command]) => (
          command === 'ai_start_request'
        ));
        expect(startCall?.[1]).toMatchObject({
          request: {
            task: 'ask',
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

  it('keeps persisted messages visible when the atomic clear fails', async () => {
    const previousApp = useAppStore.getState();
    const previousTerminal = useTerminalStore.getState();
    await initI18n('en-US');
    useAppStore.setState({ activeSection: 'terminal', locale: 'en-US' });
    useTerminalStore.setState({
      sessions: [{
        sessionId: 'clear-failure-session',
        title: 'Clear failure target',
        host: 'clear.example.com',
        port: 22,
        username: 'root',
        status: 'connected',
        conversationId: 'clear-failure-conversation',
        conversationStartedAt: '2026-08-31T00:00:00.000Z',
      }],
      activeSessionId: 'clear-failure-session',
    });
    useAiStore.getState().clear();
    useAiStore.getState().hydrateSessions([{
      conversation: {
        id: 'clear-failure-conversation',
        startedAt: '2026-08-31T00:00:00.000Z',
        updatedAt: '2026-08-31T00:01:00.000Z',
        title: 'Clear failure target',
        archived: false,
        sessionId: 'clear-failure-session',
        host: 'clear.example.com',
        port: 22,
        username: 'root',
      },
      messages: [message('clear-failure', 'user', 'Keep me after failure', {
        conversationId: 'clear-failure-conversation',
        sessionId: 'clear-failure-session',
      })],
    }]);
    useAiStore.getState().setOpen(true);
    tauriCoreMock.invoke.mockImplementation((command: string) => (
      command === 'clear_ai_session_lane'
        ? Promise.reject(new Error('atomic replace failed'))
        : Promise.resolve(undefined)
    ));

    const { unmount } = render(createElement(AiPanel));
    const clearLabel = /Clear conversation|清空对话/;
    try {
      fireEvent.click(screen.getByRole('button', { name: clearLabel }));
      fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: clearLabel,
      }));

      await waitFor(() => expect(tauriCoreMock.invoke).toHaveBeenCalledWith(
        'clear_ai_session_lane',
        expect.objectContaining({ conversationId: 'clear-failure-conversation' }),
      ));
      expect(screen.getByText('Keep me after failure')).toBeInTheDocument();
      expect(useAiStore.getState().messages).toEqual([
        expect.objectContaining({ content: 'Keep me after failure' }),
      ]);
    } finally {
      unmount();
      useAiStore.getState().clear();
      useAiStore.getState().setOpen(false);
      useTerminalStore.setState(previousTerminal, true);
      useAppStore.setState(previousApp, true);
      await initI18n(previousApp.locale);
    }
  });

  it('blocks new submissions until an atomic clear finishes', async () => {
    const previousApp = useAppStore.getState();
    const previousTerminal = useTerminalStore.getState();
    await initI18n('en-US');
    useAppStore.setState({ activeSection: 'terminal', locale: 'en-US' });
    useTerminalStore.setState({
      sessions: [{
        sessionId: 'clear-pending-session',
        title: 'Clear pending target',
        host: 'clear-pending.example.com',
        port: 22,
        username: 'root',
        status: 'connected',
        conversationId: 'clear-pending-conversation',
        conversationStartedAt: '2026-08-31T00:00:00.000Z',
      }],
      activeSessionId: 'clear-pending-session',
    });
    useAiStore.getState().clear();
    useAiStore.getState().hydrateSessions([{
      conversation: {
        id: 'clear-pending-conversation',
        startedAt: '2026-08-31T00:00:00.000Z',
        updatedAt: '2026-08-31T00:01:00.000Z',
        title: 'Clear pending target',
        archived: false,
        sessionId: 'clear-pending-session',
        host: 'clear-pending.example.com',
        port: 22,
        username: 'root',
      },
      messages: [message('clear-pending', 'user', 'Clear only after commit', {
        conversationId: 'clear-pending-conversation',
        sessionId: 'clear-pending-session',
      })],
    }]);
    useAiStore.getState().setOpen(true);
    appendTerminalOutput('clear-pending-session', 'service is healthy\n');
    let finishClear: (() => void) | undefined;
    const pendingClear = new Promise<void>((resolve) => {
      finishClear = resolve;
    });
    tauriCoreMock.invoke.mockImplementation((command: string) => (
      command === 'clear_ai_session_lane' ? pendingClear : Promise.resolve(undefined)
    ));

    const { unmount } = render(createElement(AiPanel));
    const clearLabel = /Clear conversation|清空对话/;
    try {
      const textbox = screen.getByRole('textbox');
      fireEvent.change(textbox, { target: { value: 'Must wait for clear' } });
      expect(screen.getByRole('button', { name: 'Send' })).not.toBeDisabled();
      fireEvent.click(screen.getByRole('button', { name: clearLabel }));
      fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: clearLabel,
      }));

      await waitFor(() => expect(tauriCoreMock.invoke).toHaveBeenCalledWith(
        'clear_ai_session_lane',
        expect.objectContaining({ conversationId: 'clear-pending-conversation' }),
      ));
      expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
      expect(screen.getByRole('button', {
        name: 'Ask about terminal output',
      })).toBeDisabled();
      fireEvent.keyDown(textbox, { key: 'Enter', shiftKey: false, keyCode: 13 });
      expect(tauriCoreMock.invoke).not.toHaveBeenCalledWith(
        'ai_start_request',
        expect.anything(),
      );
      expect(screen.getByText('Clear only after commit')).toBeInTheDocument();

      await act(async () => finishClear?.());
      await waitFor(() => expect(screen.queryByText('Clear only after commit'))
        .not.toBeInTheDocument());
      expect(screen.getByRole('button', { name: 'Send' })).not.toBeDisabled();
    } finally {
      finishClear?.();
      unmount();
      useAiStore.getState().clear();
      useAiStore.getState().setOpen(false);
      clearTerminalOutput('clear-pending-session');
      useTerminalStore.setState(previousTerminal, true);
      useAppStore.setState(previousApp, true);
      await initI18n(previousApp.locale);
    }
  });
});

describe('conversation history', () => {
  it('starts a new conversation from the panel and preserves the previous one in history', async () => {
    const previousApp = useAppStore.getState();
    const previousTerminal = useTerminalStore.getState();
    await initI18n('en-US');
    useAppStore.setState({ activeSection: 'terminal', locale: 'en-US' });
    useTerminalStore.setState({
      sessions: [{
        sessionId: 'active-session',
        title: 'Active target',
        host: 'active.example.com',
        port: 22,
        username: 'root',
        status: 'connected',
        conversationId: 'active-conversation',
        conversationStartedAt: '2026-08-29T09:00:00.000Z',
      }],
      activeSessionId: 'active-session',
    });
    useAiStore.getState().clear();
    useAiStore.getState().hydrateSessions([{
      conversation: {
        id: 'active-conversation',
        startedAt: '2026-08-29T09:00:00.000Z',
        updatedAt: '2026-08-29T09:01:00.000Z',
        title: 'Active target',
        archived: false,
        sessionId: 'active-session',
        host: 'active.example.com',
        port: 22,
        username: 'root',
      },
      messages: [message('active-message', 'user', 'Previous question', {
        conversationId: 'active-conversation',
        sessionId: 'active-session',
      })],
    }]);
    useAiStore.getState().setOpen(true);

    const { unmount } = render(createElement(AiPanel));
    try {
      expect(screen.getByRole('button', { name: 'New conversation' })).toBeEnabled();
      fireEvent.click(screen.getByRole('button', { name: 'New conversation' }));

      expect(useTerminalStore.getState().sessions[0]?.conversationId)
        .not.toBe('active-conversation');
      expect(screen.queryByText('Previous question')).not.toBeInTheDocument();
      expect(useAiStore.getState().conversations[0]).toMatchObject({
        id: 'active-conversation',
        archived: true,
      });

      fireEvent.click(screen.getByRole('button', { name: 'Conversation history' }));
      expect(await screen.findAllByText('Active target')).toHaveLength(2);
    } finally {
      unmount();
      useAiStore.getState().clear();
      useAiStore.getState().setOpen(false);
      useTerminalStore.setState(previousTerminal, true);
      useAppStore.setState(previousApp, true);
      await initI18n(previousApp.locale);
    }
  });

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
      expect(screen.queryByText('df -h')).not.toBeInTheDocument();
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

  it('keeps a missing indexed history retryable and audits recovered-prefix loads', async () => {
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
      if (loadAttempts === 1) return Promise.resolve(null);
      return Promise.resolve({
        conversation,
        messages: [message('loaded-after-retry', 'user', 'Recovered history', {
          conversationId: conversation.id,
          sessionId: conversation.sessionId,
        })],
        recovery: {
          validRecords: 2,
          skippedBytes: 17,
          firstError: 'truncated JSONL tail',
        },
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
      expect(screen.getByText('Conversation history recovered with warnings')).toBeInTheDocument();
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

  it('shows history load failures in Agent mode and prevents submission', async () => {
    const previousApp = useAppStore.getState();
    const previousTerminal = useTerminalStore.getState();
    const previousSettings = useAiSettingsStore.getState();
    const previousTauriInternals = Object.getOwnPropertyDescriptor(window, '__TAURI_INTERNALS__');
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    });
    await initI18n('en-US');
    useAppStore.setState({ activeSection: 'terminal', locale: 'en-US' });
    useAiSettingsStore.setState({
      ...previousSettings,
      agentEnabled: true,
      providers: [{
        id: 'agent-load-provider',
        name: 'Agent load provider',
        preset: 'ollama',
        kind: 'ollama',
        baseUrl: 'http://127.0.0.1:11434',
        model: 'test-model',
        requiresApiKey: false,
      }],
      defaultProviderId: 'agent-load-provider',
    }, true);
    const conversation = {
      id: 'agent-load-failure',
      startedAt: '2026-08-31T02:00:00.000Z',
      updatedAt: '2026-08-31T02:01:00.000Z',
      title: 'Agent load target',
      archived: false,
      sessionId: 'agent-load-session',
      host: 'agent-load.example.com',
      port: 22,
      username: 'root',
    };
    useTerminalStore.setState({
      sessions: [{
        sessionId: conversation.sessionId,
        title: conversation.title,
        host: conversation.host,
        port: conversation.port,
        username: conversation.username,
        status: 'connected',
        conversationId: conversation.id,
        conversationStartedAt: conversation.startedAt,
      }],
      activeSessionId: conversation.sessionId,
    });
    useAiStore.getState().clear();
    useAiStore.getState().hydrateSessionIndex([conversation]);
    useAiStore.getState().setOpen(true);
    tauriCoreMock.invoke.mockImplementation((command: string) => {
      if (command === 'load_ai_session') return Promise.reject(new Error('corrupt session tail'));
      if (command === 'agent_rollout_policy') {
        return Promise.resolve({
          stage: 'stable',
          featureEnabled: true,
          defaultAgentEnabled: true,
          defaultPermissionMode: 'requestApproval',
          availablePermissionModes: ['requestApproval', 'autoApproveReadOnly', 'fullAccess'],
          collectLocalDiagnostics: false,
        });
      }
      if (command === 'agent_contract_status') {
        return Promise.resolve({
          contractVersion: 2,
          featureEnabled: true,
          agentAvailable: true,
          defaultPermissionMode: 'requestApproval',
          providerCapability: { support: 'supported', source: 'ollamaModelMetadata' },
        });
      }
      return Promise.resolve(undefined);
    });

    const { unmount } = render(createElement(AiPanel));
    try {
      expect(await screen.findByText('Conversation history unavailable')).toBeInTheDocument();
      fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Do not submit' } });
      const modeSelector = await screen.findByRole('button', { name: 'AI mode' });
      fireEvent.click(modeSelector);
      const agentOption = await screen.findByRole('menuitemradio', { name: /^Agent/ });
      await waitFor(() => expect(agentOption).not.toHaveAttribute('aria-disabled', 'true'));
      fireEvent.click(agentOption);

      await waitFor(() => expect(modeSelector).toHaveTextContent('Agent'));
      expect(screen.getByText('Conversation history unavailable')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    } finally {
      unmount();
      useAiStore.getState().clear();
      useAiStore.getState().setOpen(false);
      useAiSettingsStore.setState(previousSettings, true);
      useTerminalStore.setState(previousTerminal, true);
      useAppStore.setState(previousApp, true);
      if (previousTauriInternals) {
        Object.defineProperty(window, '__TAURI_INTERNALS__', previousTauriInternals);
      } else {
        Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
      }
      await initI18n(previousApp.locale);
    }
  });

  it('permanently deletes one archived conversation after confirmation', async () => {
    const previousApp = useAppStore.getState();
    const previousTerminal = useTerminalStore.getState();
    await initI18n('en-US');
    useAppStore.setState({ activeSection: 'workbench', locale: 'en-US' });
    useTerminalStore.setState({ sessions: [], activeSessionId: null });
    useAiStore.getState().clear();
    const conversation = {
      id: 'delete-one-history',
      startedAt: '2026-08-22T09:00:00.000Z',
      updatedAt: '2026-08-22T09:01:00.000Z',
      title: 'root@delete.example.com',
      archived: true,
      sessionId: 'closed-session',
      host: 'delete.example.com',
      port: 22,
      username: 'root',
    };
    useAiStore.getState().hydrateSessionIndex([conversation]);
    tauriCoreMock.invoke.mockImplementation((command: string) => (
      Promise.resolve(command === 'delete_ai_sessions' ? 1 : undefined)
    ));
    useAiStore.getState().setOpen(true);

    const { unmount } = render(createElement(AiPanel));
    try {
      fireEvent.click(screen.getByRole('button', { name: 'Conversation history' }));
      fireEvent.click(await screen.findByRole('button', {
        name: `Delete “${conversation.title}”`,
      }));
      const confirmation = await screen.findByRole('alertdialog');
      fireEvent.click(within(confirmation).getByRole('button', { name: 'Delete' }));

      await waitFor(() => expect(useAiStore.getState().conversations).toEqual([]));
      expect(tauriCoreMock.invoke).toHaveBeenCalledWith('delete_ai_sessions', {
        sessions: [{ id: conversation.id, startedAt: conversation.startedAt }],
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

  it('keeps bulk deletion out of the conversation-history dialog', async () => {
    const previousApp = useAppStore.getState();
    const previousTerminal = useTerminalStore.getState();
    await initI18n('en-US');
    useAppStore.setState({ activeSection: 'terminal', locale: 'en-US' });
    const currentConversation = {
      id: 'current-conversation',
      startedAt: '2026-08-30T09:00:00.000Z',
      updatedAt: '2026-08-30T09:01:00.000Z',
      title: 'Current target',
      archived: false,
      sessionId: 'current-session',
      host: 'current.example.com',
      port: 22,
      username: 'root',
    };
    const archivedConversations = [1, 2].map((index) => ({
      id: `archived-conversation-${index}`,
      startedAt: `2026-08-2${index}T09:00:00.000Z`,
      updatedAt: `2026-08-2${index}T09:01:00.000Z`,
      title: `Archived target ${index}`,
      archived: true,
      sessionId: `archived-session-${index}`,
      host: `archived-${index}.example.com`,
      port: 22,
      username: 'root',
    }));
    useTerminalStore.setState({
      sessions: [{
        sessionId: currentConversation.sessionId,
        title: currentConversation.title,
        host: currentConversation.host,
        port: currentConversation.port,
        username: currentConversation.username,
        status: 'connected',
        conversationId: currentConversation.id,
        conversationStartedAt: currentConversation.startedAt,
      }],
      activeSessionId: currentConversation.sessionId,
    });
    useAiStore.getState().clear();
    useAiStore.getState().hydrateSessionIndex([
      currentConversation,
      ...archivedConversations,
    ]);
    useAiStore.getState().setOpen(true);

    const { unmount } = render(createElement(AiPanel));
    try {
      fireEvent.click(screen.getByRole('button', { name: 'Conversation history' }));
      expect(await screen.findByText('Archived target 1')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Delete all history' })).not.toBeInTheDocument();
      expect(useAiStore.getState().conversations).toEqual([
        currentConversation,
        ...archivedConversations,
      ]);
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

describe('AI stream listener lifecycle', () => {
  function installTauriRuntime(
    startRequest?: (args: Record<string, unknown> | undefined) => Promise<void>,
  ): void {
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    });
    tauriCoreMock.invoke.mockImplementation(async (
      command: string,
      args?: Record<string, unknown>,
    ) => {
      if (command === 'agent_rollout_policy') {
        return {
          stage: 'stable',
          featureEnabled: true,
          defaultAgentEnabled: true,
          defaultPermissionMode: 'requestApproval',
          availablePermissionModes: ['requestApproval', 'autoApproveReadOnly', 'fullAccess'],
          collectLocalDiagnostics: false,
        };
      }
      if (command === 'agent_contract_status') {
        return {
          contractVersion: 2,
          featureEnabled: true,
          agentAvailable: true,
          defaultPermissionMode: 'requestApproval',
          providerCapability: {
            support: 'supported',
            source: 'ollamaModelMetadata',
          },
        };
      }
      if (command === 'ai_start_request' && startRequest) return startRequest(args);
      return undefined;
    });
  }

  async function preparePanel(
    startRequest?: (args: Record<string, unknown> | undefined) => Promise<void>,
  ): Promise<{
    previousApp: ReturnType<typeof useAppStore.getState>;
    previousSettings: ReturnType<typeof useAiSettingsStore.getState>;
  }> {
    const previousApp = useAppStore.getState();
    const previousSettings = useAiSettingsStore.getState();
    await initI18n('en-US');
    useAppStore.setState({ activeSection: 'workbench', locale: 'en-US' });
    useAiSettingsStore.setState({
      providers: [{
        id: 'listener-provider',
        name: 'Listener provider',
        preset: 'ollama',
        kind: 'ollama',
        baseUrl: 'http://127.0.0.1:11434',
        model: 'qwen3',
        requiresApiKey: false,
      }],
      defaultProviderId: 'listener-provider',
    });
    useAiStore.getState().clear();
    useAiStore.getState().setOpen(true);
    installTauriRuntime(startRequest);
    return { previousApp, previousSettings };
  }

  async function restorePanel(
    previousApp: ReturnType<typeof useAppStore.getState>,
    previousSettings: ReturnType<typeof useAiSettingsStore.getState>,
  ): Promise<void> {
    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    useAiStore.getState().clear();
    useAiStore.getState().setOpen(false);
    useAiSettingsStore.setState(previousSettings, true);
    useAppStore.setState(previousApp, true);
    await initI18n(previousApp.locale);
  }

  it('waits for the stream listener before invoking and cancels an invoked request on unmount', async () => {
    const listenerReady = deferred<() => void>();
    const unlisten = vi.fn();
    tauriEventMock.listen.mockImplementationOnce(() => listenerReady.promise);
    const { previousApp, previousSettings } = await preparePanel();
    const panel = render(createElement(AiPanel));
    try {
      fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Explain this' } });
      fireEvent.click(screen.getByRole('button', { name: 'Send' }));

      await waitFor(() => expect(useAiStore.getState().phase).toBe('streaming'));
      expect(tauriCoreMock.invoke.mock.calls.some(([command]) => (
        command === 'ai_start_request'
      ))).toBe(false);

      await act(async () => {
        listenerReady.resolve(unlisten);
        await listenerReady.promise;
      });
      await waitFor(() => expect(tauriCoreMock.invoke).toHaveBeenCalledWith(
        'ai_start_request',
        expect.anything(),
      ));
      const requestId = useAiStore.getState().activeRequestId;
      expect(requestId).toBeDefined();

      panel.unmount();
      expect(useAiStore.getState()).toMatchObject({
        phase: 'idle',
        activeRequestId: undefined,
      });
      expect(unlisten).toHaveBeenCalledTimes(1);
      await waitFor(() => expect(tauriCoreMock.invoke).toHaveBeenCalledWith(
        'ai_cancel_request',
        { requestId },
      ));
    } finally {
      panel.unmount();
      await restorePanel(previousApp, previousSettings);
    }
  });

  it('turns a listener setup rejection into a request failure without invoking the backend', async () => {
    const listenerReady = deferred<() => void>();
    tauriEventMock.listen.mockImplementationOnce(() => listenerReady.promise);
    const { previousApp, previousSettings } = await preparePanel();
    const panel = render(createElement(AiPanel));
    try {
      fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Explain this' } });
      fireEvent.click(screen.getByRole('button', { name: 'Send' }));
      listenerReady.reject(new Error('stream listener unavailable'));

      await waitFor(() => expect(useAiStore.getState()).toMatchObject({
        phase: 'error',
        activeRequestId: undefined,
        error: 'stream listener unavailable',
      }));
      expect(screen.getByText('Request failed')).toBeInTheDocument();
      expect(tauriCoreMock.invoke.mock.calls.some(([command]) => (
        command === 'ai_start_request'
      ))).toBe(false);
    } finally {
      panel.unmount();
      await restorePanel(previousApp, previousSettings);
    }
  });

  it('best-effort cancels a request when backend start rejects', async () => {
    const unlisten = vi.fn<() => void>();
    tauriEventMock.listen.mockImplementationOnce(async () => unlisten);
    const { previousApp, previousSettings } = await preparePanel(async () => {
      throw new Error('backend start failed');
    });
    const panel = render(createElement(AiPanel));
    try {
      fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Explain this' } });
      fireEvent.click(screen.getByRole('button', { name: 'Send' }));

      await waitFor(() => expect(useAiStore.getState()).toMatchObject({
        phase: 'error',
        activeRequestId: undefined,
        error: 'backend start failed',
      }));
      const requestId = useAiStore.getState().messages.find((message) => (
        message.role === 'user' && message.content === 'Explain this'
      ))?.requestId;
      expect(requestId).toBeDefined();
      expect(tauriCoreMock.invoke).toHaveBeenCalledWith(
        'ai_cancel_request',
        { requestId },
      );
    } finally {
      panel.unmount();
      await restorePanel(previousApp, previousSettings);
    }
  });

  it('recancels an old start that resolves after cancellation and a rapid replacement', async () => {
    const firstStart = deferred<void>();
    let startCount = 0;
    let streamHandler: ((event: { payload: AiStreamEvent }) => void) | undefined;
    const unlisten = vi.fn();
    tauriEventMock.listen.mockImplementationOnce(async (_event, handler) => {
      streamHandler = handler;
      return unlisten;
    });
    const { previousApp, previousSettings } = await preparePanel(async () => {
      startCount += 1;
      if (startCount === 1) await firstStart.promise;
    });
    const panel = render(createElement(AiPanel));
    try {
      fireEvent.change(screen.getByRole('textbox'), { target: { value: 'First request' } });
      fireEvent.click(screen.getByRole('button', { name: 'Send' }));
      await waitFor(() => expect(startCount).toBe(1));
      const firstRequestId = useAiStore.getState().activeRequestId!;

      fireEvent.click(screen.getByRole('button', { name: 'Stop generating' }));
      await waitFor(() => expect(tauriCoreMock.invoke.mock.calls.filter(([command, args]) => (
        command === 'ai_cancel_request'
        && (args as { requestId?: string } | undefined)?.requestId === firstRequestId
      ))).toHaveLength(1));

      fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Second request' } });
      fireEvent.click(screen.getByRole('button', { name: 'Send' }));
      await waitFor(() => expect(startCount).toBe(2));
      const secondRequestId = useAiStore.getState().activeRequestId!;
      expect(secondRequestId).not.toBe(firstRequestId);

      await act(async () => {
        firstStart.resolve();
        await firstStart.promise;
      });
      await waitFor(() => expect(tauriCoreMock.invoke.mock.calls.filter(([command, args]) => (
        command === 'ai_cancel_request'
        && (args as { requestId?: string } | undefined)?.requestId === firstRequestId
      ))).toHaveLength(2));
      expect(useAiStore.getState()).toMatchObject({
        phase: 'streaming',
        activeRequestId: secondRequestId,
      });

      act(() => {
        streamHandler?.({
          payload: { type: 'textDelta', requestId: firstRequestId, text: 'stale answer' },
        });
        streamHandler?.({ payload: { type: 'completed', requestId: firstRequestId } });
      });
      expect(useAiStore.getState()).toMatchObject({
        phase: 'streaming',
        activeRequestId: secondRequestId,
      });
      expect(useAiStore.getState().messages.find((message) => (
        message.id === `assistant-${secondRequestId}`
      ))).toMatchObject({ status: 'streaming', content: '' });

      act(() => {
        streamHandler?.({
          payload: { type: 'textDelta', requestId: secondRequestId, text: 'fresh answer' },
        });
        streamHandler?.({ payload: { type: 'completed', requestId: secondRequestId } });
      });
      expect(useAiStore.getState()).toMatchObject({
        phase: 'idle',
        activeRequestId: undefined,
      });
    } finally {
      panel.unmount();
      expect(unlisten).toHaveBeenCalledTimes(1);
      await restorePanel(previousApp, previousSettings);
    }
  });

  it('retires an unresolved listener on unmount and keeps its handler out of a remounted request', async () => {
    const firstReady = deferred<() => void>();
    const firstUnlisten = vi.fn();
    const secondUnlisten = vi.fn();
    let firstHandler: ((event: { payload: AiStreamEvent }) => void) | undefined;
    let secondHandler: ((event: { payload: AiStreamEvent }) => void) | undefined;
    tauriEventMock.listen
      .mockImplementationOnce((_event, handler) => {
        firstHandler = handler;
        return firstReady.promise;
      })
      .mockImplementationOnce(async (_event, handler) => {
        secondHandler = handler;
        return secondUnlisten;
      });
    const { previousApp, previousSettings } = await preparePanel();
    let panel = render(createElement(AiPanel));
    try {
      fireEvent.change(screen.getByRole('textbox'), { target: { value: 'First request' } });
      fireEvent.click(screen.getByRole('button', { name: 'Send' }));
      await waitFor(() => expect(useAiStore.getState().phase).toBe('streaming'));
      panel.unmount();
      expect(useAiStore.getState().phase).toBe('idle');

      await act(async () => {
        firstReady.resolve(firstUnlisten);
        await firstReady.promise;
      });
      expect(firstUnlisten).toHaveBeenCalledTimes(1);
      expect(tauriCoreMock.invoke.mock.calls.some(([command]) => (
        command === 'ai_start_request'
      ))).toBe(false);

      panel = render(createElement(AiPanel));
      await waitFor(() => expect(tauriEventMock.listen).toHaveBeenCalledTimes(2));
      fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Second request' } });
      fireEvent.click(screen.getByRole('button', { name: 'Send' }));
      await waitFor(() => expect(tauriCoreMock.invoke).toHaveBeenCalledWith(
        'ai_start_request',
        expect.anything(),
      ));
      const secondRequestId = useAiStore.getState().activeRequestId!;

      act(() => {
        firstHandler?.({ payload: { type: 'completed', requestId: secondRequestId } });
      });
      expect(useAiStore.getState().phase).toBe('streaming');

      act(() => {
        secondHandler?.({
          payload: { type: 'textDelta', requestId: secondRequestId, text: 'Second answer' },
        });
        secondHandler?.({ payload: { type: 'completed', requestId: secondRequestId } });
      });
      expect(useAiStore.getState()).toMatchObject({
        phase: 'idle',
        activeRequestId: undefined,
      });
    } finally {
      panel.unmount();
      expect(secondUnlisten).toHaveBeenCalledTimes(1);
      await restorePanel(previousApp, previousSettings);
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
