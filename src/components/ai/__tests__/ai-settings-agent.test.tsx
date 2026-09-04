import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AiSettingsSection } from '../ai-settings-section';
import { useAiSettingsStore } from '@/stores/aiSettingsStore';

const mocks = vi.hoisted(() => ({
  archive: vi.fn(),
  cancel: vi.fn(),
  list: vi.fn(),
  toast: vi.fn(),
}));

vi.mock('@/lib/tauri', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/tauri')>(),
  invokeArchiveAgentRuntimeSession: mocks.archive,
  invokeCancelAgentRuntime: mocks.cancel,
  invokeListAgentRuntimeSessions: mocks.list,
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
    useAiSettingsStore.setState(initialSettings, true);
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
    fireEvent.click(screen.getByRole('button', { name: 'settings.ai.agent.clearConfirm' }));

    await waitFor(() => expect(mocks.archive).toHaveBeenCalledWith({
      sessionId: 'agent-session-1',
    }));
    expect(mocks.cancel.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.archive.mock.invocationCallOrder[0]);
  });
});
