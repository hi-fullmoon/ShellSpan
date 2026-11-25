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
  hasSandboxPtyPolicyDrifted,
  normalizeSandboxDomainRule,
  restartManagedSandboxTerminalIfOpen,
  validateSandboxAllowlistInput,
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
    // When the sandbox terminal is still connecting or running a foreground command, do not disrupt it.
    expect(await restartManagedSandboxTerminalIfOpen('agent-1')).toBe('busy');
    useTerminalStore.setState((state) => ({
      sessions: state.sessions.map((s) => (
        s.sessionId === 'sandbox-term-1' ? { ...s, status: 'connected', promptReady: false } : s
      )),
    }));
    expect(await restartManagedSandboxTerminalIfOpen('agent-1')).toBe('busy');
    expect(invokeOpenLocalSandboxTerminal).toHaveBeenCalledTimes(1);

    useTerminalStore.setState((state) => ({
      sessions: state.sessions.map((s) => (
        s.sessionId === 'sandbox-term-1' ? { ...s, status: 'connected', promptReady: true } : s
      )),
    }));
    expect(
      await restartManagedSandboxTerminalIfOpen('agent-1', {
        formatTitle: (shell) => `Sandbox · ${shell}`,
      }),
    ).toBe('restarted');
    expect(useTerminalStore.getState().sessions.map((s) => s.sessionId)).toEqual(['sandbox-term-2']);

    useTerminalStore.setState((state) => ({
      sessions: state.sessions.map((s) => (
        s.sessionId === 'sandbox-term-2' ? { ...s, status: 'connected', promptReady: true } : s
      )),
    }));
    expect(await restartManagedSandboxTerminalIfOpen('agent-1')).toBe('failed');
  });
});

describe('sandbox allowlist validation and policy drift detection', () => {
  it('validates domain rules and flags schemes, ports, IPs, and invalid wildcards', () => {
    expect(normalizeSandboxDomainRule('Registry.NPMjs.org.')).toBe('registry.npmjs.org');
    expect(normalizeSandboxDomainRule('*.corp.internal')).toBe('*.corp.internal');
    expect(normalizeSandboxDomainRule('https://registry.npmjs.org')).toBeNull();
    expect(normalizeSandboxDomainRule('127.0.0.1')).toBeNull();
    expect(normalizeSandboxDomainRule('*.com')).toBeNull();
    expect(normalizeSandboxDomainRule('localhost')).toBeNull();

    const parsed = validateSandboxAllowlistInput(
      'registry.npmmirror.com, https://bad.example.com, *.corp.internal; 10.0.0.1',
    );
    expect(parsed.valid).toEqual(['registry.npmmirror.com', '*.corp.internal']);
    expect(parsed.invalid).toEqual(['https://bad.example.com', '10.0.0.1']);
  });

  it('detects drift when custom allowlist domains change even if network mode stays customAllowlist', () => {
    const binding = {
      agentSessionId: 'agent-1',
      kind: 'macNono' as const,
      workspaceRoot: '/Users/demo/.shellspan/sandboxes/ws-1/workspace',
      policyDigest: 'digest-1',
      networkMode: 'customAllowlist' as const,
      allowedDomains: ['a.example.com', 'b.example.com'],
    };
    expect(hasSandboxPtyPolicyDrifted(binding, 'customAllowlist', ['b.example.com', 'a.example.com'])).toBe(false);
    expect(hasSandboxPtyPolicyDrifted(binding, 'customAllowlist', ['a.example.com'])).toBe(true);
    expect(hasSandboxPtyPolicyDrifted(binding, 'customAllowlist', ['a.example.com', 'b.example.com', 'c.example.com'])).toBe(true);
    expect(hasSandboxPtyPolicyDrifted(binding, 'devRegistries', ['a.example.com', 'b.example.com'])).toBe(true);
  });
});
