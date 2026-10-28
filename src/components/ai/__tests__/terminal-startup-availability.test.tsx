import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it } from 'vitest';
import userEvent from '@/test/composer-editor-user';
import { AiWorkspaceRoot } from '@/components/ai/workspace/ai-workspace-root';
import { useAiSessionController } from '@/components/ai/workspace/use-ai-session-controller';
import { initI18n, t } from '@/locales';
import { useAppStore } from '@/stores/appStore';
import { useTerminalStore } from '@/stores/terminalStore';

// Exercise the production controller and store without replacing IPC or adapters.
function StartupWorkspace() {
  const controller = useAiSessionController({ scope: 'terminal' });
  return <AiWorkspaceRoot mode="agent" scope="terminal" view={controller.view}
    canStartAgent={controller.canStartAgent}
    submissionDisabled={!controller.canStartAgent}
    agentUnavailableReason={controller.agentUnavailableReason}
    onSubmitGesture={controller.submit}
    defaultDraft="pwd" />;
}

beforeEach(() => {
  useTerminalStore.setState({ sessions: [], activeSessionId: null });
});

afterEach(() => {
  cleanup();
  useTerminalStore.setState({ sessions: [], activeSessionId: null });
});

it.each(['zh-CN', 'en-US'] as const)(
  'keeps terminal startup quiet while blocking submission and retaining the draft in %s',
  async locale => {
    useAppStore.setState({ locale });
    await initI18n(locale);
    const terminals = useTerminalStore.getState();
    const attemptId = terminals.beginConnectionAttempt({
      title: 'zsh', host: 'local', port: 0, username: '',
    });
    const { container } = render(<StartupWorkspace />);
    const notice = () => screen.queryByRole('status', { name: t('agent.availability.title') });
    const send = () => container.querySelector<HTMLButtonElement>('.ai-composer-primary')!;

    expect(notice()).not.toBeInTheDocument();
    expect(send()).toBeDisabled();
    expect(screen.getByRole('textbox')).toHaveTextContent('pwd');

    // Allow pending controller effects to settle before checking again.
    await act(async () => {});
    expect(notice()).not.toBeInTheDocument();

    for (const status of ['error', 'connecting', 'disconnected', 'connecting', 'connected'] as const) {
      act(() => useTerminalStore.setState(state => ({
        sessions: state.sessions.map(session => session.sessionId === attemptId
          ? { ...session, status } : session),
      })));
      if (status === 'error' || status === 'disconnected') {
        expect(notice()).toHaveTextContent(t('agent.availability.needsTerminal'));
        expect(send()).toBeDisabled();
      } else {
        await waitFor(() => expect(notice()).not.toBeInTheDocument());
        if (status === 'connecting') expect(send()).toBeDisabled();
        else expect(send()).toBeEnabled();
      }
      expect(screen.getByRole('textbox')).toHaveTextContent('pwd');
    }

    act(() => useTerminalStore.getState().removeSession(attemptId));
    await waitFor(() => expect(notice()).toHaveTextContent(t('agent.availability.needsTerminal')));
    expect(send()).toBeDisabled();
  },
);

it('blocks keyboard and pointer submission without a notice, then enables manual sending', async () => {
  await initI18n('en-US');
  const user = userEvent.setup();
  const sent: string[] = [];
  const props = {
    mode: 'agent' as const,
    scope: 'terminal' as const,
    view: null,
    defaultDraft: 'pwd',
    onSubmit: ({ content }: { content: string }) => { sent.push(content); },
  };
  const { container, rerender } = render(<AiWorkspaceRoot {...props} submissionDisabled />);
  const send = container.querySelector<HTMLButtonElement>('.ai-composer-primary')!;
  expect(screen.queryByRole('status', { name: t('agent.availability.title') })).not.toBeInTheDocument();
  expect(send).toBeDisabled();
  await user.click(send);
  await user.click(screen.getByRole('textbox'));
  await user.keyboard('{Enter}');
  expect(sent).toEqual([]);
  expect(screen.getByRole('textbox')).toHaveTextContent('pwd');

  rerender(<AiWorkspaceRoot {...props} submissionDisabled={false} />);
  expect(send).toBeEnabled();
  expect(sent).toEqual([]);
  await user.click(send);
  expect(sent).toEqual(['pwd']);
});
