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
    useAiSettingsStore.setState({ ...initialSettings, agentEnabled: true }, true);
  });

  it('cancels every live runtime session when Agent is disabled', async () => {
    render(<AiSettingsSection />);
    fireEvent.click(screen.getByRole('switch', { name: 'settings.ai.agent.enable' }));

    await waitFor(() => expect(mocks.cancel).toHaveBeenCalledWith({
      sessionId: 'agent-session-1',
    }));
    expect(useAiSettingsStore.getState().agentEnabled).toBe(false);
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
