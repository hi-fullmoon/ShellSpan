import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentPermissionSelector } from '../agent-permission-selector';
import { useAgentPermissionStore } from '@/stores/agentPermissionStore';
import { useTerminalStore } from '@/stores/terminalStore';

vi.mock('@/hooks/useI18n', () => ({
  useI18n: () => ({
    t: (key: string) => ({
      'agent.permission.composer.readOnly': '仅可查看',
      'agent.permission.composer.readOnlyDescription': '修改、破坏性及敏感读取需要确认。',
      'agent.permission.composer.fullAccess': '完全权限',
      'agent.permission.composer.fullAccessDescription': '自动执行当前终端中的所有命令。',
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
    const warning = await screen.findByText('agent.permission.fullAccessWarning');
    expect(warning).toBeVisible();
    const dialog = warning.closest('[role="alertdialog"]');
    expect(dialog?.querySelector('.lucide-shield-alert')).toBeInTheDocument();
    expect(dialog?.querySelector('[data-slot="alert-dialog-media"]')).toHaveClass(
      'bg-app-warning/10',
      'text-app-warning',
    );
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
    expect(await screen.findByRole('menuitemradio', { name: '仅可查看' })).toBeVisible();
    expect(screen.getByRole('menuitemradio', { name: '完全权限' })).toBeVisible();
    expect(screen.getByText('修改、破坏性及敏感读取需要确认。')).toBeVisible();
    expect(screen.getByText('自动执行当前终端中的所有命令。')).toBeVisible();
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
