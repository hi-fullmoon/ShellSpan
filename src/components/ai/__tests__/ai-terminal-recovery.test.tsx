import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it } from 'vitest';
import { AiWorkspaceRoot } from '../workspace/ai-workspace-root';
import { createAiComposerState } from '@/lib/ai/composer-machine';
import { terminalRecoveryView } from '@/test/fixtures/terminal-execution-recovery';
import { initI18n } from '@/locales';
import { useAppStore } from '@/stores/appStore';

afterEach(cleanup);

it.each([
  ['zh-CN', '终端执行已暂停', '停止任务', '重新连接终端', '终端未能确认控制输入，原命令可能已经执行。'],
  ['en-US', 'Terminal execution paused', 'Stop task', 'Reconnect terminal', 'The terminal did not confirm the control input. The original command may still have run.'],
] as const)('shows the cause and orders recovery actions in %s', async (locale, title, stop, reconnect, reason) => {
  useAppStore.setState({ locale });
  await initI18n(locale);
  const user = userEvent.setup();
  const actions: string[] = [];
  const view = terminalRecoveryView();
  const props = { scope: 'terminal' as const, canStartAgent: true,
    onStop: () => { actions.push('stop'); }, onReconnectTerminal: () => { actions.push('reconnect'); } };
  const { container, rerender } = render(<AiWorkspaceRoot {...props} view={view} />);
  const notice = screen.getByRole('status', { name: title });
  expect(notice).toHaveTextContent(reason);
  expect(notice).toHaveTextContent(locale === 'zh-CN' ? '系统不会自动重放命令' : 'Commands will not be replayed automatically');
  expect(notice.closest('[data-slot="ai-workspace-status-notices"]')).toBeInTheDocument();
  expect(within(notice).getByRole('button', { name: reconnect })).toBeDisabled();
  await user.click(within(notice).getByRole('button', { name: reconnect }));
  expect(actions).toEqual([]);
  await user.click(within(notice).getByRole('button', { name: stop }));
  expect(actions).toEqual(['stop']);
  rerender(<AiWorkspaceRoot {...props} view={view} composerState={createAiComposerState({ phase: 'error',
    lastError: { kind: 'terminal', message: 'Stop has not been confirmed', retryable: true } })} />);
  expect(within(notice).getByRole('button', { name: stop })).toBeEnabled();
  expect(within(notice).getByRole('button', { name: reconnect })).toBeDisabled();
  rerender(<AiWorkspaceRoot {...props} view={view} composerState={createAiComposerState({ phase: 'stopping' })} />);
  expect(within(notice).getAllByRole('button').every(button => button.hasAttribute('disabled'))).toBe(true);
  rerender(<AiWorkspaceRoot {...props} view={terminalRecoveryView('idle')} />);
  expect(notice).toHaveTextContent(locale === 'zh-CN' ? '任务已停止' : 'The task is stopped');
  expect(container.querySelector('.ai-composer-primary')).toBeDisabled();
  expect(within(notice).queryByRole('button', { name: stop })).toBeNull();
  const reconnectButton = within(notice).getByRole('button', { name: reconnect });
  expect(reconnectButton).toBeEnabled();
  reconnectButton.focus();
  await user.keyboard('{Enter}');
  expect(actions).toEqual(['stop', 'reconnect']);
  rerender(<AiWorkspaceRoot {...props} view={terminalRecoveryView('idle')} terminalReconnecting />);
  expect(within(notice).getByRole('button')).toBeDisabled();
  expect(within(notice).getByRole('button')).toHaveAttribute('aria-busy', 'true');
  const resumed = { ...terminalRecoveryView('idle'), recovery: { status: 'none' as const } };
  rerender(<AiWorkspaceRoot {...props} view={resumed} />);
  expect(container.querySelector('[data-terminal-recovery-notice]')).toBeNull();
});

it('offers no terminal recovery actions in read-only history', async () => {
  useAppStore.setState({ locale: 'en-US' });
  await initI18n('en-US');
  const { container } = render(<AiWorkspaceRoot scope="terminal" view={terminalRecoveryView()}
    readOnlySession historicalTargetUnavailable />);
  expect(container.querySelector('[data-terminal-recovery-notice]')).toBeNull();
  expect(container.querySelector('[data-ai-running-indicator]')).toBeNull();
});
