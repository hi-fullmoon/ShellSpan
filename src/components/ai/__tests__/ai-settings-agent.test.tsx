import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AiSettingsSection } from '../ai-settings-section';
import { useAiSettingsStore } from '@/stores/aiSettingsStore';
import { useAiStore } from '@/stores/aiStore';
import { useAgentStore } from '@/stores/agentStore';
import { useAppStore } from '@/stores/appStore';

const mocks = vi.hoisted(() => ({
  clearAgentConversationData: vi.fn(),
  flushAgentSessionPersistence: vi.fn(),
  invokeAgentRolloutPolicy: vi.fn(),
  invokeListAiModels: vi.fn(),
  invokeLoadPreferences: vi.fn(),
  invokeSavePreferences: vi.fn(),
  invokeSetAgentEnabled: vi.fn(),
  shutdown: vi.fn(),
  toast: vi.fn(),
}));

vi.mock('@/lib/tauri', () => ({
  invokeAgentRolloutPolicy: mocks.invokeAgentRolloutPolicy,
  invokeListAiModels: mocks.invokeListAiModels,
  invokeLoadPreferences: mocks.invokeLoadPreferences,
  invokeSavePreferences: mocks.invokeSavePreferences,
  invokeSetAgentEnabled: mocks.invokeSetAgentEnabled,
  isTauriRuntime: () => true,
}));

vi.mock('@/lib/agent-ui-controller', () => ({
  agentUiController: { shutdown: mocks.shutdown },
}));

vi.mock('@/lib/agent-sessions', () => ({
  clearAgentConversationData: mocks.clearAgentConversationData,
  flushAgentSessionPersistence: mocks.flushAgentSessionPersistence,
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
const initialApp = useAppStore.getState();

describe('M7 Agent settings management', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.invokeAgentRolloutPolicy.mockResolvedValue({
      stage: 'stable',
      featureEnabled: true,
      defaultAgentEnabled: true,
      defaultPermissionMode: 'requestApproval',
      availablePermissionModes: ['requestApproval', 'autoApproveReadOnly', 'fullAccess'],
      collectLocalDiagnostics: false,
    });
    mocks.invokeSetAgentEnabled.mockImplementation(async (enabled: boolean) => enabled);
    mocks.invokeLoadPreferences.mockResolvedValue([]);
    mocks.invokeSavePreferences.mockResolvedValue(undefined);
    mocks.invokeListAiModels.mockResolvedValue([]);
    mocks.shutdown.mockResolvedValue(undefined);
    mocks.flushAgentSessionPersistence.mockResolvedValue(undefined);
    mocks.clearAgentConversationData.mockResolvedValue(undefined);
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
    useAppStore.setState({ ...initialApp, operationHistoryCategory: 'all' }, true);
  });

  it('closes Agent safely and opens its filtered local operation history', async () => {
    render(<AiSettingsSection />);
    expect(await screen.findByText('settings.ai.agent.stage.stable')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('switch', { name: 'settings.ai.agent.enable' }));
    await waitFor(() => expect(mocks.invokeSetAgentEnabled).toHaveBeenCalledWith(false));
    expect(mocks.shutdown).toHaveBeenCalledOnce();
    expect(mocks.flushAgentSessionPersistence).toHaveBeenCalledOnce();
    expect(useAiSettingsStore.getState().agentEnabled).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'settings.ai.agent.viewHistory' }));
    expect(useAppStore.getState()).toMatchObject({
      activeSection: 'workbench',
      activeWorkbenchTab: 'history',
      operationHistoryCategory: 'agent',
    });
  });

  it('requires confirmation, cancels active work first, and clears every Agent lane', async () => {
    render(<AiSettingsSection />);
    await screen.findByText('settings.ai.agent.stage.stable');

    fireEvent.click(screen.getByRole('button', { name: 'settings.ai.agent.clearSessions' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(mocks.clearAgentConversationData).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', {
      name: 'settings.ai.agent.clearConfirm',
    }));

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
});
