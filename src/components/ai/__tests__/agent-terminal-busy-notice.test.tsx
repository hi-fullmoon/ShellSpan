import { StrictMode } from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initI18n, t } from '@/locales';
import { useAppStore } from '@/stores/appStore';
import { AgentTerminalBusyNotice } from '../agent-terminal-busy-notice';

async function elapse(ms: number): Promise<void> {
  await act(async () => { await new Promise(resolve => setTimeout(resolve, ms)); });
}

beforeEach(async () => {
  useAppStore.setState({ locale: 'en-US' });
  await initI18n('en-US');
});
afterEach(cleanup);

describe('terminal busy feedback', () => {
  it.each(['en-US', 'zh-CN'] as const)('shows both glibc versions when Direct is available in %s', async locale => {
    useAppStore.setState({ locale });
    await initI18n(locale);
    render(<AgentTerminalBusyNotice disabled={false} state="unavailable" glibcMismatch={{ actual: '2.27', minimum: '2.28' }} />);
    const notice = screen.getByRole('status');
    expect(notice).toHaveTextContent('glibc');
    expect(notice).toHaveTextContent('2.27');
    expect(notice).toHaveTextContent('2.28');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('keeps short commands silent before and after returning to the prompt', async () => {
    const { rerender } = render(<StrictMode><AgentTerminalBusyNotice disabled={false} /></StrictMode>);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    await elapse(100);
    rerender(<StrictMode>{null}</StrictMode>);
    await elapse(1050);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it.each(['en-US', 'zh-CN'] as const)('keeps sustained activity silent in %s', async locale => {
    useAppStore.setState({ locale });
    await initI18n(locale);
    const { unmount } = render(<AgentTerminalBusyNotice disabled={false} onSwitchDirect={() => undefined} />);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    await elapse(1100);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    unmount();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('stays silent when the terminal or connection generation changes', async () => {
    const { rerender } = render(<AgentTerminalBusyNotice key="terminal-a:1" disabled={false} />);
    await elapse(700);
    rerender(<AgentTerminalBusyNotice key="terminal-b:1" disabled={false} />);
    await elapse(400);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    rerender(<AgentTerminalBusyNotice key="terminal-b:2" disabled={false} />);
    await elapse(700);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    await elapse(400);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('shows a new runtime rejection immediately and supports keyboard switching', async () => {
    let switches = 0;
    const switchDirect = () => { switches++; };
    const { rerender } = render(<AgentTerminalBusyNotice disabled={false} onSwitchDirect={switchDirect} />);
    rerender(<AgentTerminalBusyNotice disabled={false} blockedAttempt="attempt-1" onSwitchDirect={switchDirect} />);
    expect(screen.getByRole('status')).toHaveTextContent(t('agent.executionSurface.v1.busyComposerHint'));
    expect(screen.getByRole('status')).toHaveClass('text-app-warning');
    expect(screen.getByRole('status')).toHaveAttribute('data-size', 'sm');
    expect(screen.getByRole('status').querySelector(':scope > svg')).toHaveAttribute('aria-hidden', 'true');
    const button = screen.getByRole('button', { name: t('agent.executionSurface.v1.switchDirect') });
    expect(button).toHaveClass('h-6');
    button.focus();
    await userEvent.keyboard('{Enter}');
    expect(switches).toBe(1);
    rerender(<AgentTerminalBusyNotice disabled blockedAttempt="attempt-1" onSwitchDirect={switchDirect} />);
    expect(button).toBeDisabled();
    await userEvent.click(button);
    expect(switches).toBe(1);
  });

  it('does not reuse a historical rejection as a new blocking event', async () => {
    const { rerender } = render(<AgentTerminalBusyNotice disabled={false} blockedAttempt="old-attempt" />);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    await elapse(1100);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    rerender(<AgentTerminalBusyNotice disabled={false} blockedAttempt="new-attempt" />);
    expect(screen.getByRole('status')).toHaveTextContent(t('agent.executionSurface.v1.busyComposerHint'));
  });

  it('hides resolved rejections and shows subsequent rejections without a switch action in Focus', () => {
    const { rerender } = render(<AgentTerminalBusyNotice disabled={false} focusMode />);
    rerender(<AgentTerminalBusyNotice disabled={false} focusMode blockedAttempt="attempt-1" />);
    expect(screen.getByRole('status')).toHaveTextContent(t('focus.terminalBusy'));
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    rerender(<AgentTerminalBusyNotice disabled={false} focusMode blockedAttempt={null} />);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    rerender(<AgentTerminalBusyNotice disabled={false} focusMode blockedAttempt="attempt-2" />);
    expect(screen.getByRole('status')).toHaveTextContent(t('focus.terminalBusy'));
  });

  it('keeps the first new-session rejection visible and resets when navigating to another conversation', async () => {
    const context = {};
    const { rerender } = render(<AgentTerminalBusyNotice disabled={false} context={context} />);
    rerender(<AgentTerminalBusyNotice disabled={false} context={context} blockedAttempt="first-session-attempt" />);
    expect(screen.getByRole('status')).toHaveTextContent(t('agent.executionSurface.v1.busyComposerHint'));
    rerender(<AgentTerminalBusyNotice disabled={false} context={{}} blockedAttempt="historical-attempt" />);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    await elapse(1100);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('shows failure feedback immediately but keeps normal initialization silent', async () => {
    const { rerender } = render(<AgentTerminalBusyNotice disabled={false} />);
    await elapse(1100);
    rerender(<AgentTerminalBusyNotice disabled={false} state="unavailable" />);
    expect(screen.getByRole('status')).toHaveTextContent(t('agent.executionSurface.v1.unavailableDescription'));
    rerender(<AgentTerminalBusyNotice disabled={false} state="initializing" />);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    rerender(<AgentTerminalBusyNotice disabled={false} />);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('offers Direct after initialization times out and resets for a new connection', async () => {
    let switches = 0;
    const { rerender } = render(<StrictMode><AgentTerminalBusyNotice key="connection-1" disabled={false}
      state="initializing" onSwitchDirect={() => { switches++; }} /></StrictMode>);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    await elapse(15_100);
    expect(screen.getByRole('status')).toHaveTextContent(t('agent.executionSurface.v1.initializationTimeoutDescription'));
    await userEvent.click(screen.getByRole('button', { name: t('agent.executionSurface.v1.switchDirect') }));
    expect(switches).toBe(1);
    rerender(<AgentTerminalBusyNotice key="connection-2" disabled={false} state="initializing" />);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    rerender(<AgentTerminalBusyNotice key="connection-2" disabled={false} state="unavailable" />);
    expect(screen.getByRole('status')).toHaveTextContent(t('agent.executionSurface.v1.unavailableDescription'));
    rerender(<AgentTerminalBusyNotice key="connection-2" disabled={false} state="initializing" />);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  }, 20_000);

  it('points Focus users to the Terminal Agent panel when setup times out or commands are unavailable', async () => {
    const { rerender } = render(<AgentTerminalBusyNotice disabled={false} focusMode state="initializing" />);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    await elapse(15_100);
    expect(screen.getByRole('status')).toHaveTextContent(t('focus.terminalInitializationTimeout'));
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    rerender(<AgentTerminalBusyNotice disabled={false} focusMode state="unavailable" />);
    expect(screen.getByRole('status')).toHaveTextContent(t('focus.terminalCommandsUnavailable'));
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  }, 20_000);

  it('clears the initialization timer when the terminal becomes ready', async () => {
    const { rerender } = render(<AgentTerminalBusyNotice disabled={false} state="initializing" />);
    await elapse(100);
    rerender(<>{null}</>);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('offers terminal reconnect instead of disabled Direct switch when recovery is required', async () => {
    let reconnects = 0;
    render(<AgentTerminalBusyNotice
      disabled
      state="recoveryRequired"
      reconnectDisabled={false}
      onSwitchDirect={() => undefined}
      onReconnectTerminal={() => { reconnects++; }}
    />);
    expect(screen.getByRole('status')).toHaveTextContent(t('agent.executionSurface.v1.recoveryRequiredDescription'));
    expect(screen.queryByRole('button', { name: t('agent.executionSurface.v1.switchDirect') })).not.toBeInTheDocument();
    const button = screen.getByRole('button', { name: t('ai.workspace.status.reconnect') });
    expect(button).toBeEnabled();
    await userEvent.click(button);
    expect(reconnects).toBe(1);
  });

  it('explains that execution mode is locked by an uncertain outcome instead of offering disabled Direct switch', async () => {
    let reconnects = 0;
    render(<AgentTerminalBusyNotice
      disabled
      state="unavailable"
      switchDirectLockedByUncertain
      reconnectDisabled={false}
      onSwitchDirect={() => undefined}
      onReconnectTerminal={() => { reconnects++; }}
    />);
    expect(screen.getByRole('status')).toHaveTextContent(t('agent.executionSurface.v1.unavailableLockedDescription'));
    expect(screen.queryByRole('button', { name: t('agent.executionSurface.v1.switchDirect') })).not.toBeInTheDocument();
    const button = screen.getByRole('button', { name: t('ai.workspace.status.reconnect') });
    expect(button).toBeEnabled();
    await userEvent.click(button);
    expect(reconnects).toBe(1);
  });
});
