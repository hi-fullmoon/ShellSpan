import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AiSettingsSection } from '../ai-settings-section';
import { useAiSettingsStore } from '@/stores/aiSettingsStore';

const mocks = vi.hoisted(() => ({
  archive: vi.fn(),
  cancel: vi.fn(),
  cleanupSandbox: vi.fn(),
  list: vi.fn(),
  localSandboxStatus: vi.fn(),
  sandboxStorageStats: vi.fn(),
  toast: vi.fn(),
}));

vi.mock('@/lib/ipc/tauri', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/ipc/tauri')>(),
  invokeArchiveAgentRuntimeSession: mocks.archive,
  invokeCancelAgentRuntime: mocks.cancel,
  invokeCleanupSandboxWorkspaces: mocks.cleanupSandbox,
  invokeListAgentRuntimeSessions: mocks.list,
  invokeLocalSandboxStatus: mocks.localSandboxStatus,
  invokeSandboxStorageStats: mocks.sandboxStorageStats,
  isTauriRuntime: () => true,
}));

vi.mock('@/hooks/useToast', () => ({
  useToast: () => ({ error: mocks.toast, success: mocks.toast }),
}));

vi.mock('@/hooks/useI18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

const initialSettings = useAiSettingsStore.getState();
const activeSession = {
  ended: false,
  archived: false,
  header: { sessionId: 'agent-session-1' },
};

describe('Agent Session settings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.list.mockResolvedValue({ sessions: [activeSession] });
    mocks.cancel.mockResolvedValue({ ...activeSession, ended: true });
    mocks.archive.mockResolvedValue({ ...activeSession, ended: true, archived: true });
    mocks.localSandboxStatus.mockResolvedValue({ supported: true, kind: 'macNono', supportsVisiblePty: true });
    mocks.sandboxStorageStats.mockResolvedValue({
      totalCount: 2,
      totalBytes: 4 * 1024 * 1024,
      activeCount: 1,
      activeBytes: 1024 * 1024,
      reclaimableCount: 1,
      reclaimableBytes: 3 * 1024 * 1024,
    });
    mocks.cleanupSandbox.mockResolvedValue({
      removedCount: 1,
      freedBytes: 3 * 1024 * 1024,
      failedCount: 0,
    });
    useAiSettingsStore.setState(initialSettings, true);
  });

  it('uses one Agent sandbox switch for local and SSH sandboxing', () => {
    const save = vi.fn().mockResolvedValue(undefined);
    useAiSettingsStore.setState({ initialized: true, setAgentSandboxEnabled: save });
    render(<AiSettingsSection />);
    const toggle = screen.getByRole('switch', { name: 'settings.ai.agent.sandbox' });
    expect(screen.getAllByRole('switch', { name: /sandbox/i })).toEqual([toggle]);
    expect(toggle).toHaveAccessibleDescription('settings.ai.agent.sandboxDescription');
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(toggle);
    expect(save).toHaveBeenCalledWith(true);
  });

  it('configures the running input behavior with readable labels in Agent settings', async () => {
    const user = userEvent.setup();
    render(<AiSettingsSection />);
    const select = screen.getByRole('combobox', { name: 'settings.ai.agent.busyPreference' });
    expect(select).toHaveTextContent('ai.workspace.queue.action');
    expect(select).toHaveAccessibleDescription('settings.ai.agent.busyPreferenceDescription');

    await user.click(select);
    await user.click(await screen.findByRole('option', { name: 'ai.workspace.steer.action' }));

    await waitFor(() => expect(useAiSettingsStore.getState().agentBusyPreference).toBe('steer'));
    expect(select).toHaveTextContent('ai.workspace.steer.action');
  });

  it('omits the Agent enable switch and permission notice while retaining session cleanup', () => {
    render(<AiSettingsSection />);

    expect(screen.queryByRole('switch', { name: 'settings.ai.agent.enable' })).not.toBeInTheDocument();
    expect(screen.queryByText('settings.ai.agent.enableDescription')).not.toBeInTheDocument();
    expect(screen.queryByText('settings.ai.agent.permissionTitle')).not.toBeInTheDocument();
    expect(screen.queryByText('settings.ai.agent.permissionDescription')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'settings.ai.agent.clearSessions' })).toBeEnabled();
    expect(mocks.list).not.toHaveBeenCalled();
    expect(mocks.cancel).not.toHaveBeenCalled();
    expect(mocks.archive).not.toHaveBeenCalled();
  });

  it('cancels then archives sessions through the typed runtime commands', async () => {
    render(<AiSettingsSection />);
    fireEvent.click(screen.getByRole('button', { name: 'settings.ai.agent.clearSessions' }));
    const confirmButton = screen.getByRole('button', { name: 'settings.ai.agent.clearConfirm' });
    const cancelButton = screen.getByRole('button', { name: 'common.cancel' });
    const dialog = screen.getByRole('alertdialog');

    expect(confirmButton).toHaveClass('h-8', 'bg-app-warning');
    expect(cancelButton).toHaveClass('h-8');
    expect(dialog.querySelector('.lucide-archive')).toBeInTheDocument();
    expect(dialog.querySelector('[data-slot="alert-dialog-media"]')).toHaveClass(
      'bg-app-warning/10',
      'text-app-warning',
    );

    fireEvent.click(confirmButton);

    await waitFor(() => expect(mocks.archive).toHaveBeenCalledWith({
      sessionId: 'agent-session-1',
    }));
    expect(mocks.cancel.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.archive.mock.invocationCallOrder[0]);
  });

  it('shows sandbox network policy on macOS and validates custom domain allowlist entries', async () => {
    const savePolicy = vi.fn().mockResolvedValue(undefined);
    useAiSettingsStore.setState({
      initialized: true,
      agentSandboxEnabled: true,
      agentSandboxNetworkMode: 'customAllowlist',
      agentSandboxNetworkAllowlist: ['registry.npmjs.org'],
      setAgentSandboxNetworkPolicy: savePolicy,
    });
    render(<AiSettingsSection />);

    const modeSelect = await screen.findByRole('combobox', { name: 'settings.ai.agent.sandboxNetwork' });
    expect(modeSelect).toHaveTextContent('settings.ai.agent.sandboxNetwork.customAllowlist');

    const input = screen.getByRole('textbox', { name: 'settings.ai.agent.sandboxAllowlist' });
    expect(input).toHaveValue('registry.npmjs.org');
    expect(input).toHaveClass('h-8');

    const saveButton = screen.getByRole('button', { name: 'common.save' });
    expect(saveButton).toHaveClass('h-8');

    fireEvent.change(input, { target: { value: 'https://bad.example.com, 127.0.0.1' } });
    expect(screen.getByRole('alert')).toHaveTextContent('settings.ai.agent.sandboxAllowlistInvalid');
    expect(saveButton).toBeDisabled();

    fireEvent.change(input, { target: { value: 'registry.npmmirror.com, *.corp.internal' } });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(saveButton).toBeEnabled();
    fireEvent.click(saveButton);

    await waitFor(() => expect(savePolicy).toHaveBeenCalledWith(
      'customAllowlist',
      ['registry.npmmirror.com', '*.corp.internal'],
    ));
  });

  it('hides macOS-only sandbox network controls on Windows and remote-only builds', async () => {
    mocks.localSandboxStatus.mockResolvedValue({ supported: true, kind: 'windowsAppContainer', supportsVisiblePty: false });
    useAiSettingsStore.setState({
      initialized: true,
      agentSandboxEnabled: true,
      agentSandboxNetworkMode: 'customAllowlist',
    });
    render(<AiSettingsSection />);

    await waitFor(() => {
      expect(screen.getByRole('switch', { name: 'settings.ai.agent.sandbox' }))
        .toHaveAccessibleDescription('settings.ai.agent.sandboxDescriptionWindows');
    });
    expect(screen.queryByRole('combobox', { name: 'settings.ai.agent.sandboxNetwork' })).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'settings.ai.agent.sandboxAllowlist' })).not.toBeInTheDocument();
  });

  it('displays sandbox workspace storage stats and cleans idle copies after confirmation', async () => {
    render(<AiSettingsSection />);

    const cleanupButton = await screen.findByRole('button', { name: 'settings.ai.agent.sandboxStorageCleanup' });
    await waitFor(() => expect(cleanupButton).toBeEnabled());
    expect(screen.getByText('settings.ai.agent.sandboxStorageSummary')).toBeInTheDocument();

    fireEvent.click(cleanupButton);
    const confirmButton = await screen.findByRole('button', { name: 'settings.ai.agent.sandboxStorageCleanupConfirm' });
    fireEvent.click(confirmButton);

    await waitFor(() => expect(mocks.cleanupSandbox).toHaveBeenCalledTimes(1));
  });
});
