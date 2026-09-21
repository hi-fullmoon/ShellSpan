import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentPermissionSelector } from '../agent-permission-selector';
import { useAgentPermissionStore } from '@/stores/agentPermissionStore';
import { useAiSettingsStore } from '@/stores/aiSettingsStore';
import { useTerminalStore } from '@/stores/terminalStore';

vi.mock('@/hooks/useI18n', () => ({
  useI18n: () => ({
    t: (key: string) => ({
      'agent.permission.composer.readOnly': '帮我批准',
      'agent.permission.composer.readOnlyDescription': '仅对检测到的风险操作请求批准。',
      'agent.permission.autoApproveReadOnly': '帮我批准',
      'agent.permission.autoApproveReadOnlyDescription': '仅对检测到的风险操作请求批准。',
      'agent.permission.recommended': '推荐',
      'agent.permission.highRisk': '高风险',
      'agent.permission.requestApproval': '请求批准',
      'agent.permission.requestApprovalDescription': '执行每项 Agent 工具操作时始终询问。',
      'agent.permission.fullAccess': '完全访问权限',
      'agent.permission.fullAccessSelected': '完全访问',
      'agent.permission.fullAccessDescription': '无需逐次批准即可在冻结工作区内执行操作；工作区外写入和未授权网络访问仍会被拦截。',
      'agent.permission.composer.fullAccess': '完全访问权限',
      'agent.permission.composer.fullAccessDescription': '冻结工作区内自动执行；工作区外写入仍会被拦截。',
      'agent.permission.fullAccessWarning': '工作区外写入、未授权网络访问和无法强制边界的 Shell 操作仍会被拦截或请求批准。',
      'agent.permission.fullAccessConfirm': '允许完全访问',
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
    useAiSettingsStore.setState({ agentPermissionMode: 'autoApproveReadOnly' });
    useTerminalStore.setState(initialTerminalState, true);
    useAgentPermissionStore.setState(initialPermissionState, true);
    connectSession();
  });

  it('exposes all three runtime modes and confirms full access for the named target', async () => {
    render(<AgentPermissionSelector sessionId="session-1" />);
    expect(useAgentPermissionStore.getState().getMode('session-1')).toBe('autoApproveReadOnly');
    fireEvent.click(screen.getByRole('button', { name: 'agent.permission' }));
    expect(await screen.findAllByRole('menuitemradio')).toHaveLength(3);
    expect(screen.getByText('推荐')).toBeVisible();
    expect(screen.getByRole('menuitemradio', { name: /^请求批准/ })).toBeVisible();
    fireEvent.click(await screen.findByRole('menuitemradio', { name: /^完全访问权限/ }));
    const warning = await screen.findByText('工作区外写入、未授权网络访问和无法强制边界的 Shell 操作仍会被拦截或请求批准。');
    expect(warning).toBeVisible();
    expect(screen.getByText('Production (operator@server.example.com:22)')).toBeVisible();
    const dialog = warning.closest('[role="alertdialog"]');
    expect(dialog?.querySelector('.lucide-shield-alert')).toBeInTheDocument();
    expect(dialog?.querySelector('[data-slot="alert-dialog-media"]')).toHaveClass(
      'bg-app-warning/10',
      'text-app-warning',
    );
    fireEvent.click(screen.getByRole('button', { name: '允许完全访问' }));
    expect(useAgentPermissionStore.getState().getMode('session-1')).toBe('fullAccess');
  });

  it('keeps permission selection reachable from the compact Composer variant', async () => {
    const { container } = render(<AgentPermissionSelector sessionId="session-1" variant="composer" />);
    expect(container.querySelector('[data-slot="agent-permission-selector"]')).toHaveAttribute(
      'data-variant',
      'composer',
    );
    expect(container.querySelector('[data-slot="agent-permission-trigger-content"]')).toHaveClass(
      'ai-composer-control-content',
      'inline-flex',
      'items-center',
      'gap-1',
      'leading-none',
    );
    fireEvent.click(screen.getByRole('button', { name: 'agent.permission.composerAria' }));
    const options = await screen.findAllByRole('menuitemradio');
    expect(options).toHaveLength(3);
    expect(options[0]).toHaveTextContent('帮我批准');
    expect(options[0]).toHaveTextContent('推荐');
    expect(options[1]).toHaveTextContent('请求批准');
    expect(options[2]).toHaveTextContent('完全访问权限');
    expect(options[2]).toHaveTextContent('高风险');
    for (const option of options) {
      expect(option).not.toHaveClass('focus:**:text-accent-foreground');
    }
    expect(screen.getByText('仅对检测到的风险操作请求批准。'))
      .toHaveClass('text-muted-foreground');
    expect(screen.getByText('高风险')).toHaveClass('text-destructive');
    expect(options[2].querySelector('.lucide-shield-alert')).toHaveClass('text-app-warning');
    expect(screen.getByRole('menuitemradio', { name: /^帮我批准/ })).toBeVisible();
    expect(screen.getByRole('menuitemradio', { name: /^完全访问权限/ })).toBeVisible();
    expect(screen.getByRole('menuitemradio', { name: '请求批准' })).toBeVisible();
    expect(screen.getByText('仅对检测到的风险操作请求批准。')).toBeVisible();
    expect(screen.getByText('冻结工作区内自动执行；工作区外写入仍会被拦截。')).toBeVisible();
    expect(screen.queryByText('工作区内修改')).toBeNull();
  });

  it('shows the concise full-access label in the Composer trigger after selection', async () => {
    const { container } = render(<AgentPermissionSelector sessionId="session-1" variant="composer" />);

    fireEvent.click(screen.getByRole('button', { name: 'agent.permission.composerAria' }));
    fireEvent.click(await screen.findByRole('menuitemradio', { name: /^完全访问权限/ }));
    fireEvent.click(await screen.findByRole('button', { name: '允许完全访问' }));

    await waitFor(() => {
      expect(container.querySelector('[data-slot="agent-permission-trigger-content"]'))
        .toHaveTextContent(/^完全访问$/);
    });
  });

  it('switches to request-approval mode through the Composer menu', async () => {
    render(<AgentPermissionSelector sessionId="session-1" variant="composer" />);
    fireEvent.click(screen.getByRole('button', { name: 'agent.permission.composerAria' }));
    fireEvent.click(await screen.findByRole('menuitemradio', { name: '请求批准' }));
    expect(useAgentPermissionStore.getState().getMode('session-1')).toBe('requestApproval');
  });

  it('closes an open full-access confirmation when the connection target changes', async () => {
    const { rerender } = render(<AgentPermissionSelector sessionId="session-1" />);
    fireEvent.click(screen.getByRole('button', { name: 'agent.permission' }));
    fireEvent.click(await screen.findByRole('menuitemradio', { name: /^完全访问权限/ }));
    expect(await screen.findByRole('alertdialog')).toBeVisible();

    useTerminalStore.getState().addSession({
      sessionId: 'session-2',
      title: 'Staging',
      host: 'staging.example.com',
      port: 22,
      username: 'deployer',
    }, 'profile-2');
    useTerminalStore.getState().setStatus('session-2', { sessionId: 'session-2', status: 'connected' });
    rerender(<AgentPermissionSelector sessionId="session-2" />);

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(useAgentPermissionStore.getState().getMode('session-2')).toBe('autoApproveReadOnly');
  });

  it('returns to the approve-for-me default and disables elevation after disconnect', async () => {
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
