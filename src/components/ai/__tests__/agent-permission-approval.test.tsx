import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentPermissionSelector } from '../agent-permission-selector';
import { useAgentPermissionStore } from '@/stores/agentPermissionStore';
import { useTerminalStore } from '@/stores/terminalStore';

vi.mock('@/hooks/useI18n', () => ({
  useI18n: () => ({
    t: (key: string) => ({
      'agent.permission.composer.readOnly': '仅可查看',
      'agent.permission.composer.fullAccess': '完全权限',
    })[key] ?? key,
  }),
}));

const initialTerminalState = useTerminalStore.getState();
const initialPermissionState = useAgentPermissionStore.getState();

function connectSession(): void {
  useTerminalStore.getState().addSession({
    sessionId: 'session-1',
    title: 'Production',
    host: 'server.example.com',
    port: 22,
    username: 'operator',
  }, 'profile-1');
  useTerminalStore.getState().setStatus('session-1', { sessionId: 'session-1', status: 'connected' });
}

describe('Agent permission selector', () => {
  beforeEach(() => {
    useTerminalStore.setState(initialTerminalState, true);
    useAgentPermissionStore.setState(initialPermissionState, true);
    connectSession();
  });

  it('exposes only the two product modes and confirms full access', async () => {
    render(<AgentPermissionSelector sessionId="session-1" />);
    expect(useAgentPermissionStore.getState().getMode('session-1')).toBe('autoApproveReadOnly');
    fireEvent.click(screen.getByRole('button', { name: 'agent.permission' }));
    expect(await screen.findAllByRole('menuitemradio')).toHaveLength(2);
    expect(screen.queryByRole('menuitemradio', { name: /agent\.permission\.requestApproval/ })).toBeNull();
    fireEvent.click(await screen.findByRole('menuitemradio', { name: /agent\.permission\.fullAccess/ }));
    expect(await screen.findByText('agent.permission.fullAccessWarning')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'agent.permission.fullAccessConfirm' }));
    expect(useAgentPermissionStore.getState().getMode('session-1')).toBe('fullAccess');
  });

  it('keeps permission selection reachable from the compact Composer variant', async () => {
    const { container } = render(<AgentPermissionSelector sessionId="session-1" variant="composer" />);
    expect(container.querySelector('[data-slot="agent-permission-selector"]')).toHaveAttribute(
      'data-variant',
      'composer',
    );
    fireEvent.click(screen.getByRole('button', { name: 'agent.permission.composerAria' }));
    const options = await screen.findAllByRole('menuitemradio');
    expect(options.map((option) => option.textContent)).toEqual([
      '仅可查看',
      '完全权限',
    ]);
    expect(screen.queryByText('工作区内修改')).toBeNull();
    expect(screen.queryByRole('menuitemradio', { name: /agent\.permission\.requestApproval/ })).toBeNull();
  });

  it('returns to the read-only auto-approval default and disables elevation after disconnect', async () => {
    useAgentPermissionStore.getState().setMode('session-1', 'fullAccess');
    render(<AgentPermissionSelector sessionId="session-1" />);
    useTerminalStore.getState().setClosed('session-1', {
      sessionId: 'session-1',
      reasonKind: 'transport_disconnect',
      retryable: true,
    });

    await waitFor(() => {
      expect(useAgentPermissionStore.getState().getMode('session-1')).toBe('autoApproveReadOnly');
    });
    expect(screen.getByRole('button', { name: 'agent.permission' })).toBeDisabled();
  });
});
