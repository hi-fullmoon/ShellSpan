import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const invokeLocalSandboxStatus = vi.fn();
const isLocalAgentSandboxPreview = vi.fn().mockResolvedValue(false);

vi.mock('@/hooks/usePlatform', () => ({
  usePlatform: () => 'macos',
}));

vi.mock('@/lib/ipc/tauri', () => ({
  invokeGetProfileSandbox: vi.fn().mockResolvedValue({ policy: null }),
  invokeLocalSandboxStatus: (...args: unknown[]) => invokeLocalSandboxStatus(...args),
  isLocalAgentSandboxPreview: (...args: unknown[]) => isLocalAgentSandboxPreview(...args),
  isTauriRuntime: () => true,
}));

import { useTerminalAgentExecution } from '../useTerminalAgentExecution';
import { useAiSettingsStore } from '@/stores/aiSettingsStore';
import { useTerminalStore, type TerminalSession } from '@/stores/terminalStore';

const originalTerminalState = useTerminalStore.getState();
const originalAiSettings = useAiSettingsStore.getState();

afterEach(() => {
  vi.clearAllMocks();
  useTerminalStore.setState(originalTerminalState, true);
  useAiSettingsStore.setState(originalAiSettings, true);
});

describe('useTerminalAgentExecution', () => {
  it('ignores stale local sandbox status responses after the last local terminal closes', async () => {
    let resolveFirst!: (value: { supported: boolean; kind?: 'macNono' }) => void;
    invokeLocalSandboxStatus
      .mockImplementationOnce(
        () => new Promise((resolve) => {
          resolveFirst = resolve;
        }),
      )
      .mockResolvedValueOnce({ supported: false });

    useAiSettingsStore.setState({ agentSandboxEnabled: true });

    const firstSession: TerminalSession = {
      sessionId: 'local-1',
      title: 'Local',
      host: 'local',
      port: 0,
      username: 'user',
      status: 'connected',
    };
    useTerminalStore.setState({ sessions: [firstSession], activeSessionId: 'local-1' });

    const { result, rerender } = renderHook(
      ({ terminal }: { terminal: TerminalSession | undefined }) => useTerminalAgentExecution(terminal),
      { initialProps: { terminal: firstSession as TerminalSession | undefined } },
    );

    await waitFor(() => {
      expect(invokeLocalSandboxStatus).toHaveBeenCalledTimes(1);
      expect(result.current.sandboxChecking).toBe(true);
    });

    // Close the last local session while the first probe is still in-flight.
    act(() => {
      useTerminalStore.setState({ sessions: [], activeSessionId: null });
    });
    rerender({ terminal: undefined });

    // Resolve the stale first probe after the local terminal was removed.
    await act(async () => {
      resolveFirst({ supported: true, kind: 'macNono' });
      await Promise.resolve();
    });

    // Open a new local session and verify a fresh probe runs and its result wins.
    const secondSession: TerminalSession = {
      ...firstSession,
      sessionId: 'local-2',
    };
    act(() => {
      useTerminalStore.setState({ sessions: [secondSession], activeSessionId: 'local-2' });
    });
    rerender({ terminal: secondSession });

    await waitFor(() => {
      expect(invokeLocalSandboxStatus).toHaveBeenCalledTimes(2);
      expect(result.current.sandboxChecking).toBe(false);
    });
    expect(result.current.localSandboxKind).toBeUndefined();
  });
});
