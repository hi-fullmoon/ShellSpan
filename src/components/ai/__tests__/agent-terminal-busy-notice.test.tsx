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
  it('keeps short commands silent and cancels pending feedback on return to the prompt', async () => {
    const { rerender } = render(<StrictMode><AgentTerminalBusyNotice disabled={false} /></StrictMode>);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    await elapse(100);
    rerender(<StrictMode>{null}</StrictMode>);
    await elapse(1050);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it.each(['en-US', 'zh-CN'] as const)('shows sustained activity without a warning or action in %s', async locale => {
    useAppStore.setState({ locale });
    await initI18n(locale);
    const { unmount } = render(<AgentTerminalBusyNotice disabled={false} onSwitchDirect={() => undefined} />);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    await elapse(1100);
    const notice = screen.getByRole('status');
    expect(notice).toHaveTextContent(t('agent.executionSurface.v1.runningComposerHint'));
    expect(notice).not.toHaveClass('text-app-warning');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    unmount();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('starts a fresh delay when the terminal or connection generation changes', async () => {
    const { rerender } = render(<AgentTerminalBusyNotice key="terminal-a:1" disabled={false} />);
    await elapse(700);
    rerender(<AgentTerminalBusyNotice key="terminal-b:1" disabled={false} />);
    await elapse(400);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    rerender(<AgentTerminalBusyNotice key="terminal-b:2" disabled={false} />);
    await elapse(700);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    await elapse(400);
    expect(screen.getByRole('status')).toHaveTextContent(t('agent.executionSurface.v1.runningComposerHint'));
  });

  it('shows a new runtime rejection immediately and supports keyboard switching', async () => {
    let switches = 0;
    const switchDirect = () => { switches++; };
    const { rerender } = render(<AgentTerminalBusyNotice disabled={false} onSwitchDirect={switchDirect} />);
    rerender(<AgentTerminalBusyNotice disabled={false} blockedAttempt="attempt-1" onSwitchDirect={switchDirect} />);
    expect(screen.getByRole('status')).toHaveTextContent(t('agent.executionSurface.v1.busyComposerHint'));
    expect(screen.getByRole('status')).toHaveClass('text-app-warning');
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
    expect(screen.getByRole('status')).toHaveTextContent(t('agent.executionSurface.v1.runningComposerHint'));
    rerender(<AgentTerminalBusyNotice disabled={false} blockedAttempt="new-attempt" />);
    expect(screen.getByRole('status')).toHaveTextContent(t('agent.executionSurface.v1.busyComposerHint'));
  });

  it('keeps the first new-session rejection visible and resets when navigating to another conversation', async () => {
    const context = {};
    const { rerender } = render(<AgentTerminalBusyNotice disabled={false} context={context} />);
    rerender(<AgentTerminalBusyNotice disabled={false} context={context} blockedAttempt="first-session-attempt" />);
    expect(screen.getByRole('status')).toHaveTextContent(t('agent.executionSurface.v1.busyComposerHint'));
    rerender(<AgentTerminalBusyNotice disabled={false} context={{}} blockedAttempt="historical-attempt" />);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    await elapse(1100);
    expect(screen.getByRole('status')).toHaveTextContent(t('agent.executionSurface.v1.runningComposerHint'));
  });

  it('keeps unavailable and initializing feedback immediate and resets the busy delay', async () => {
    const { rerender } = render(<AgentTerminalBusyNotice disabled={false} />);
    await elapse(1100);
    rerender(<AgentTerminalBusyNotice disabled={false} state="unavailable" />);
    expect(screen.getByRole('status')).toHaveTextContent(t('agent.executionSurface.v1.unavailableDescription'));
    rerender(<AgentTerminalBusyNotice disabled={false} state="initializing" />);
    expect(screen.getByRole('status')).toHaveTextContent(t('agent.executionSurface.v1.initializingDescription'));
    rerender(<AgentTerminalBusyNotice disabled={false} />);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});
