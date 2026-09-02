import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AiSettingsSection } from '../ai-settings-section';
import { useAiSettingsStore } from '@/stores/aiSettingsStore';
import { useAiStore } from '@/stores/aiStore';
import { useAgentStore } from '@/stores/agentStore';
import { useTerminalStore } from '@/stores/terminalStore';

const mocks = vi.hoisted(() => ({
  clearAgentConversationData: vi.fn(),
  deletePersistedAiConversations: vi.fn(),
  flushAgentSessionPersistence: vi.fn(),
  invokeAgentRolloutPolicy: vi.fn(),
  invokeDeleteAiApiKey: vi.fn(),
  invokeHasAiApiKey: vi.fn(),
  invokeListAiModels: vi.fn(),
  invokeLoadPreferences: vi.fn(),
  invokeSavePreferences: vi.fn(),
  invokeSetAgentEnabled: vi.fn(),
  invokeStoreAiApiKey: vi.fn(),
  shutdown: vi.fn(),
  toast: vi.fn(),
}));

vi.mock('@/lib/tauri', () => ({
  invokeAgentRolloutPolicy: mocks.invokeAgentRolloutPolicy,
  invokeDeleteAiApiKey: mocks.invokeDeleteAiApiKey,
  invokeHasAiApiKey: mocks.invokeHasAiApiKey,
  invokeListAiModels: mocks.invokeListAiModels,
  invokeLoadPreferences: mocks.invokeLoadPreferences,
  invokeSavePreferences: mocks.invokeSavePreferences,
  invokeSetAgentEnabled: mocks.invokeSetAgentEnabled,
  invokeStoreAiApiKey: mocks.invokeStoreAiApiKey,
  isTauriRuntime: () => true,
}));

vi.mock('@/lib/agent-ui-controller', () => ({
  agentUiController: { shutdown: mocks.shutdown },
}));

vi.mock('@/lib/agent-sessions', () => ({
  clearAgentConversationData: mocks.clearAgentConversationData,
  flushAgentSessionPersistence: mocks.flushAgentSessionPersistence,
}));

vi.mock('@/lib/ai-sessions', () => ({
  deletePersistedAiConversations: mocks.deletePersistedAiConversations,
}));

vi.mock('@/hooks/useToast', () => ({
  useToast: () => ({ error: mocks.toast, success: mocks.toast }),
}));

vi.mock('@/hooks/useI18n', () => ({
  useI18n: () => ({
    t: (key: string, variables?: Record<string, string | number>) => variables
      ? `${key}:${Object.values(variables).join(':')}`
      : key,
  }),
}));

const initialAiSettings = useAiSettingsStore.getState();
const initialAi = useAiStore.getState();
const initialAgent = useAgentStore.getState();
const initialTerminal = useTerminalStore.getState();

describe('M7 Agent settings management', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.invokeAgentRolloutPolicy.mockResolvedValue({
      stage: 'stable',
      featureEnabled: true,
      defaultAgentEnabled: true,
      defaultPermissionMode: 'requestApproval',
      availablePermissionModes: ['requestApproval', 'autoApproveReadOnly', 'fullAccess'],
    });
    mocks.invokeSetAgentEnabled.mockImplementation(async (enabled: boolean) => enabled);
    mocks.invokeDeleteAiApiKey.mockResolvedValue(undefined);
    mocks.invokeHasAiApiKey.mockResolvedValue(true);
    mocks.invokeLoadPreferences.mockResolvedValue([]);
    mocks.invokeSavePreferences.mockResolvedValue(undefined);
    mocks.invokeListAiModels.mockResolvedValue([]);
    mocks.invokeStoreAiApiKey.mockResolvedValue(undefined);
    mocks.shutdown.mockResolvedValue(undefined);
    mocks.flushAgentSessionPersistence.mockResolvedValue(undefined);
    mocks.clearAgentConversationData.mockResolvedValue(undefined);
    mocks.deletePersistedAiConversations.mockResolvedValue(1);
    useAiSettingsStore.setState({ ...initialAiSettings, agentEnabled: true }, true);
    useAiStore.setState({
      ...initialAi,
      conversations: [
        {
          id: 'conversation-a',
          startedAt: '2026-08-29T00:00:00.000Z',
          updatedAt: '2026-08-29T00:01:00.000Z',
          title: 'A',
          archived: false,
          host: 'a.example.test',
          port: 22,
          username: 'operator',
        },
        {
          id: 'conversation-b',
          startedAt: '2026-08-29T01:00:00.000Z',
          updatedAt: '2026-08-29T01:01:00.000Z',
          title: 'B',
          archived: true,
          host: 'b.example.test',
          port: 22,
          username: 'operator',
        },
      ],
    }, true);
    useAgentStore.setState(initialAgent, true);
    useTerminalStore.setState({
      ...initialTerminal,
      activeSessionId: 'terminal-a',
      sessions: [
        {
          sessionId: 'terminal-a',
          title: 'A',
          host: 'a.example.test',
          port: 22,
          username: 'operator',
          status: 'connected',
          conversationId: 'conversation-a',
          conversationStartedAt: '2026-08-29T00:00:00.000Z',
        },
      ],
    }, true);
  });

  it('closes Agent safely when the feature is disabled', async () => {
    render(<AiSettingsSection />);
    expect(await screen.findByText('settings.ai.agent.stage.stable')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('switch', { name: 'settings.ai.agent.enable' }));
    await waitFor(() => expect(mocks.invokeSetAgentEnabled).toHaveBeenCalledWith(false));
    expect(mocks.shutdown).toHaveBeenCalledOnce();
    expect(mocks.flushAgentSessionPersistence).toHaveBeenCalledOnce();
    expect(useAiSettingsStore.getState().agentEnabled).toBe(false);
  });

  it('places model settings first and uses outlined destructive actions', async () => {
    const [firstProvider] = useAiSettingsStore.getState().providers;
    useAiSettingsStore.setState({
      providers: [
        firstProvider,
        { ...firstProvider, id: 'secondary-provider', name: 'Secondary' },
      ],
    });
    render(<AiSettingsSection />);
    await screen.findByText('settings.ai.agent.stage.stable');

    const providersHeading = screen.getByText('settings.ai.providers');
    const agentHeading = screen.getByText('settings.ai.agent.title');
    const historyHeading = screen.getByText('ai.history');
    expect(providersHeading.compareDocumentPosition(agentHeading)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(agentHeading.compareDocumentPosition(historyHeading)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);

    for (const heading of [providersHeading, agentHeading, historyHeading]) {
      const group = heading.closest('[data-slot="settings-group"]');
      expect(group).not.toBeNull();
      expect(group?.querySelector('[data-slot="card"]')).not.toBeNull();
      expect(group?.querySelector('[data-slot="card-header"]')).toBeNull();
    }

    const providerCards = screen.getAllByRole('button', { name: 'settings.ai.editProvider' });
    expect(providerCards).toHaveLength(2);
    const clearSessions = screen.getByRole('button', { name: 'settings.ai.agent.clearSessions' });
    const deleteHistory = screen.getByRole('button', { name: 'ai.history.deleteAll' });
    fireEvent.click(providerCards[0]);
    const providerDialog = await screen.findByRole('dialog');
    const deleteProvider = within(providerDialog).getByRole('button', {
      name: 'settings.ai.deleteProvider',
    });
    for (const button of [deleteProvider, clearSessions, deleteHistory]) {
      expect(button).toHaveClass('border-destructive', 'bg-transparent', 'text-destructive');
      expect(button).not.toHaveClass('bg-destructive');
    }
  });

  it('requires confirmation, cancels active work first, and clears every Agent lane', async () => {
    render(<AiSettingsSection />);
    await screen.findByText('settings.ai.agent.stage.stable');

    fireEvent.click(screen.getByRole('button', { name: 'settings.ai.agent.clearSessions' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(mocks.clearAgentConversationData).not.toHaveBeenCalled();
    const cancelButton = within(dialog).getByRole('button', { name: 'common.cancel' });
    const confirmButton = within(dialog).getByRole('button', {
      name: 'settings.ai.agent.clearConfirm',
    });
    for (const button of [cancelButton, confirmButton]) {
      expect(button).toHaveClass('h-8', 'px-2.5', 'text-xs');
    }
    fireEvent.click(confirmButton);

    await waitFor(() => expect(mocks.clearAgentConversationData).toHaveBeenCalledTimes(2));
    expect(mocks.shutdown.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.clearAgentConversationData.mock.invocationCallOrder[0]);
    expect(mocks.clearAgentConversationData).toHaveBeenNthCalledWith(
      1,
      'conversation-a',
      '2026-08-29T00:00:00.000Z',
    );
    expect(mocks.clearAgentConversationData).toHaveBeenNthCalledWith(
      2,
      'conversation-b',
      '2026-08-29T01:00:00.000Z',
    );
  });

  it('keeps thinking effort out of provider setup and preserves its stored value', async () => {
    const user = userEvent.setup();
    const kimi = {
      id: 'kimi',
      name: 'Kimi Code',
      preset: 'kimi' as const,
      kind: 'openAiCompatible' as const,
      baseUrl: 'https://api.kimi.com/coding',
      model: 'k3',
      reasoningEffort: 'high' as const,
      requiresApiKey: true,
    };
    useAiSettingsStore.setState({ providers: [kimi], defaultProviderId: kimi.id });

    render(<AiSettingsSection />);
    await user.click(screen.getByRole('button', { name: 'settings.ai.editProvider' }));
    expect(screen.queryByRole('combobox', {
      name: 'settings.ai.reasoningEffort',
    })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'common.save' }));
    await waitFor(() => expect(useAiSettingsStore.getState().providers[0]).toHaveProperty(
      'reasoningEffort',
      'high',
    ));
  });

  it('moves bulk conversation-history deletion into settings and preserves current sessions', async () => {
    useAiStore.setState({
      conversations: [
        ...useAiStore.getState().conversations,
        {
          id: 'workbench-current',
          startedAt: '2026-08-29T02:00:00.000Z',
          updatedAt: '2026-08-29T02:01:00.000Z',
          title: 'Workbench conversation',
          archived: false,
          scope: 'workbench',
          host: '',
          port: 0,
          username: '',
        },
      ],
      activeWorkbenchConversationId: 'workbench-current',
    });
    render(<AiSettingsSection />);
    await screen.findByText('settings.ai.agent.stage.stable');

    expect(screen.getByText('ai.history.description:1')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'ai.history.deleteAll' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(mocks.deletePersistedAiConversations).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole('button', { name: 'ai.history.deleteAll' }));

    await waitFor(() => expect(mocks.deletePersistedAiConversations).toHaveBeenCalledOnce());
    expect(mocks.deletePersistedAiConversations).toHaveBeenCalledWith([
      expect.objectContaining({ id: 'conversation-b' }),
    ]);
    expect(useAiStore.getState().conversations.map((conversation) => conversation.id)).toEqual([
      'conversation-a',
      'workbench-current',
    ]);
    expect(mocks.toast).toHaveBeenCalledWith('ai.history.deleted:1');
  });

  it('shows a compact empty-history status when there is nothing to clear', async () => {
    useAiStore.setState({
      conversations: useAiStore.getState().conversations.filter((conversation) => (
        conversation.id === 'conversation-a'
      )),
    });

    render(<AiSettingsSection />);
    await screen.findByText('settings.ai.agent.stage.stable');

    expect(screen.getByText('ai.history.description:0')).toBeInTheDocument();
    expect(screen.getByText('ai.history.empty')).toHaveAttribute('data-slot', 'badge');
    expect(screen.queryByRole('button', { name: 'ai.history.deleteAll' })).not.toBeInTheDocument();
  });
});
