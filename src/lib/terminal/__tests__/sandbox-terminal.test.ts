import { beforeEach, describe, expect, it, vi } from 'vitest';

const { invokeOpenLocalSandboxTerminal, isTauriRuntime } = vi.hoisted(() => ({
  invokeOpenLocalSandboxTerminal: vi.fn(),
  isTauriRuntime: vi.fn(() => true),
}));

vi.mock('@/lib/ipc/tauri', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ipc/tauri')>();
  return {
    ...actual,
    invokeOpenLocalSandboxTerminal,
    isTauriRuntime,
  };
});

import {
  ensureManagedSandboxTerminal,
  findManagedSandboxTerminal,
  restartManagedSandboxTerminalIfOpen,
} from '@/lib/terminal/sandbox-terminal';
import { useAgentPermissionStore } from '@/stores/agentPermissionStore';
import { useTerminalStore } from '@/stores/terminalStore';
import type { SessionSummary } from '@/types';

function sandboxSummary(sessionId: string, agentSessionId: string): SessionSummary {
  return {
    sessionId,
    title: 'zsh',
    host: 'local',
    port: 0,
    username: 'demo',
    terminalSessionId: `logical-${sessionId}`,
    terminalGeneration: 1,
    ptyInfo: {
      transportKind: 'localPty',
      inputMode: 'native-inline',
      sandboxBinding: {
        agentSessionId,
        kind: 'macNono',
        workspaceRoot: '/Users/demo/.shellspan/sandboxes/ws-1/workspace',
        policyDigest: 'digest-1',
        networkMode: 'blocked',
      },
    },
  };
}

describe('ensureManagedSandboxTerminal', () => {
  beforeEach(() => {
    invokeOpenLocalSandboxTerminal.mockReset();
    isTauriRuntime.mockReturnValue(true);
    useTerminalStore.setState({ sessions: [], activeSessionId: null });
    useAgentPermissionStore.setState({ preferences: {}, conversationSurfaces: {} });
  });

  it('opens a managed sandbox terminal tab, binds its conversation surface, and reuses it', async () => {
    const summary = sandboxSummary('sandbox-term-1', 'agent-1');
    invokeOpenLocalSandboxTerminal.mockResolvedValueOnce(summary);

    const opened = await ensureManagedSandboxTerminal('agent-1', {
      formatTitle: (shell) => `Sandbox · ${shell}`,
    });

    expect(opened?.sessionId).toBe('sandbox-term-1');
    expect(invokeOpenLocalSandboxTerminal).toHaveBeenCalledWith('agent-1', 120, 30, undefined);
    expect(useTerminalStore.getState().activeSessionId).toBe('sandbox-term-1');
    expect(useTerminalStore.getState().sessions[0]?.title).toBe('Sandbox · zsh');
    expect(useAgentPermissionStore.getState().conversationSurfaces['sandbox-term-1']).toEqual({
      agentSessionId: 'agent-1',
      surface: 'boundTerminal',
    });

    // Second call reuses the existing live sandbox terminal without invoking Tauri again.
    useTerminalStore.getState().setActiveSession(null);
    const reused = await ensureManagedSandboxTerminal('agent-1');
    expect(reused?.sessionId).toBe('sandbox-term-1');
    expect(invokeOpenLocalSandboxTerminal).toHaveBeenCalledTimes(1);
    expect(useTerminalStore.getState().activeSessionId).toBe('sandbox-term-1');
    expect(findManagedSandboxTerminal('agent-1')?.sessionId).toBe('sandbox-term-1');
  });

  it('replaces the previous sandbox terminal tab when restarting after policy drift', async () => {
    const first = sandboxSummary('sandbox-term-1', 'agent-1');
    const second = sandboxSummary('sandbox-term-2', 'agent-1');
    invokeOpenLocalSandboxTerminal.mockResolvedValueOnce(first).mockResolvedValueOnce(second);

    await ensureManagedSandboxTerminal('agent-1');
    const restarted = await ensureManagedSandboxTerminal('agent-1', {
      replacesSessionId: 'sandbox-term-1',
      formatTitle: (shell) => `Sandbox · ${shell}`,
    });

    expect(restarted?.sessionId).toBe('sandbox-term-2');
    expect(invokeOpenLocalSandboxTerminal).toHaveBeenLastCalledWith('agent-1', 120, 30, 'sandbox-term-1');
    expect(useTerminalStore.getState().sessions.map((s) => s.sessionId)).toEqual(['sandbox-term-2']);
    expect(useTerminalStore.getState().activeSessionId).toBe('sandbox-term-2');
  });

  it('auto-restarts an open managed sandbox terminal after allowlist update and degrades gracefully on failure', async () => {
    expect(await restartManagedSandboxTerminalIfOpen('agent-1')).toBe('not_open');

    const first = sandboxSummary('sandbox-term-1', 'agent-1');
    const second = sandboxSummary('sandbox-term-2', 'agent-1');
    invokeOpenLocalSandboxTerminal
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second)
      .mockRejectedValueOnce(new Error('busy'));

    await ensureManagedSandboxTerminal('agent-1');
    expect(
      await restartManagedSandboxTerminalIfOpen('agent-1', {
        formatTitle: (shell) => `Sandbox · ${shell}`,
      }),
    ).toBe('restarted');
    expect(useTerminalStore.getState().sessions.map((s) => s.sessionId)).toEqual(['sandbox-term-2']);

    expect(await restartManagedSandboxTerminalIfOpen('agent-1')).toBe('failed');
  });
});
