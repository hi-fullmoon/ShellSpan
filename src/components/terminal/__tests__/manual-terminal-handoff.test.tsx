import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { initI18n } from '@/locales';
import { useAppStore } from '@/stores/appStore';
import { useAgentQuestionStore } from '@/stores/agentQuestionStore';
import { useTerminalStore } from '@/stores/terminalStore';
import { AiQuestionPanel } from '@/components/ai/workspace/ai-question-panel';
import type { AnswerQuestionInput } from '@/types/agent-question';
import type { AgentSessionEvent, LiveTerminalManualHandoff } from '@/types/agent-session';
import capture from '@/tests/fixtures/manual-terminal-handoff.json';
import displayCapture from '@/tests/fixtures/terminal-display-recovery.json';
import type { ClosedEvent } from '@/types';
import { agentTerminalLeaseState } from '../agent-terminal-lease-state';
import { createAgentTerminalLeaseCoordinator } from '../terminal-controller-layer';
import { TerminalPane } from '../terminal-pane';

// Captured by the Rust user_operation_journal_keeps_the_execution_barrier_across_restart test.
const { live, resumed } = capture as {
  live: LiveTerminalManualHandoff[];
  resumed: AgentSessionEvent;
};
const waiting = live[0].handoff;
const initialTerminals = useTerminalStore.getState();
if (displayCapture.closed.reasonKind !== 'transport_disconnect') {
  throw new Error('Expected a broker transport disconnect');
}
const closedTransport: ClosedEvent = {
  ...displayCapture.closed,
  identity: displayCapture.closed.identity ?? undefined,
  reasonKind: displayCapture.closed.reasonKind,
};

beforeEach(async () => {
  useAppStore.setState({ locale: 'zh-CN', activeSection: 'terminal' });
  await initI18n('zh-CN');
});
afterEach(() => {
  cleanup();
  agentTerminalLeaseState.clearAll();
  useAgentQuestionStore.setState({ drafts: {}, handoffControls: {} });
  useTerminalStore.setState(initialTerminals, true);
});

it('restores the terminal handoff after refresh without replaying the turn', () => {
  const previous = createAgentTerminalLeaseCoordinator();
  previous.restoreLiveManualHandoffs(live);
  previous.dispose();
  useTerminalStore.setState(initialTerminals, true);
  expect(agentTerminalLeaseState.get(waiting.sessionId)).toBeUndefined();

  const refreshed = createAgentTerminalLeaseCoordinator();
  refreshed.restoreLiveManualHandoffs(live);
  const { sessions, activeSessionId } = useTerminalStore.getState();
  const terminal = sessions.find((session) => session.sessionId === waiting.sessionId);
  expect(terminal).toMatchObject({ status: 'connecting', restoreDisplay: true, terminalSessionId: live[0].terminal.terminalSessionId });
  expect(activeSessionId).toBe(waiting.sessionId);
  render(<TerminalPane activeSession={terminal ?? null} />);
  const handoffBar = screen.getByTestId('agent-terminal-lease-bar');
  expect(handoffBar).toHaveTextContent('等待你在终端操作');
  expect(handoffBar).not.toHaveTextContent('输入锁定');
  expect(handoffBar).toHaveAttribute('data-layout', 'banner');
  expect(handoffBar.nextElementSibling?.querySelector('[data-terminal-measure-session]')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '查看任务' })).toBeNull();
  expect(screen.queryByRole('button', { name: '停止并接管' })).toBeNull();
  expect(agentTerminalLeaseState.blocksUserInput(waiting.sessionId)).toBe(false);
  expect(agentTerminalLeaseState.get(waiting.sessionId)).toMatchObject({
    agentSessionId: waiting.agentSessionId, operationId: `turn:${waiting.turnId}`,
  });

  act(() => {
    refreshed.handleSession(resumed);
    refreshed.restoreLiveManualHandoffs(live);
  });
  expect(agentTerminalLeaseState.blocksUserInput(waiting.sessionId)).toBe(true);
  expect(screen.getByTestId('agent-terminal-lease-bar')).toHaveTextContent('输入锁定');
  expect(screen.getByTestId('agent-terminal-lease-bar')).toHaveAttribute('data-layout', 'floating');
  expect(screen.getByRole('button', { name: '停止并接管' })).toBeVisible();
  act(() => refreshed.dispose());
});

it('discards an in-flight handoff snapshot when completion arrives first', () => {
  const refreshed = createAgentTerminalLeaseCoordinator();
  refreshed.handleSession(resumed);
  refreshed.restoreLiveManualHandoffs(live);
  expect(agentTerminalLeaseState.get(waiting.sessionId)).toBeUndefined();
  expect(useTerminalStore.getState().sessions).toHaveLength(0);
  refreshed.dispose();
});

it('rejects a handoff snapshot that arrives after the transport closes', () => {
  const refreshed = createAgentTerminalLeaseCoordinator();
  expect(closedTransport.sessionId).toBe(waiting.sessionId);
  refreshed.handleTerminalClosed(closedTransport);
  refreshed.restoreLiveManualHandoffs(live);
  expect(useTerminalStore.getState().sessions).toHaveLength(0);
  expect(agentTerminalLeaseState.get(waiting.sessionId)).toBeUndefined();
  refreshed.dispose();
});

it('clears the handoff on a live disconnect and keeps the tab disconnected', () => {
  const refreshed = createAgentTerminalLeaseCoordinator();
  refreshed.restoreLiveManualHandoffs(live);
  refreshed.handleTerminalClosed(closedTransport);
  refreshed.restoreLiveManualHandoffs(live);
  expect(useTerminalStore.getState().sessions.find((session) => session.sessionId === waiting.sessionId)?.status).toBe('disconnected');
  expect(agentTerminalLeaseState.get(waiting.sessionId)).toBeUndefined();
  refreshed.dispose();
});

it('links terminal lease bar actions to the active manual handoff card', async () => {
  const refreshed = createAgentTerminalLeaseCoordinator();
  refreshed.restoreLiveManualHandoffs(live);
  const terminal = useTerminalStore.getState().sessions.find((session) => session.sessionId === waiting.sessionId) ?? null;
  const submissions: AnswerQuestionInput[] = [];
  render(
    <>
      <TerminalPane activeSession={terminal} />
      <AiQuestionPanel
        question={{
          identity: {
            sessionId: waiting.agentSessionId,
            turnId: waiting.turnId,
            stepId: 'step-1',
            requestId: 'request-1',
            callId: 'call-1',
            questionRequestId: 'question-1',
          },
          questions: [{
            id: 'manual',
            question: 'Restart nginx',
            multi_select: false,
            user_action: {
              instructions: 'Run `sudo systemctl restart nginx`.',
              verification_command: 'systemctl is-active --quiet nginx',
            },
          }],
          status: 'pending',
          answers: [],
          firstSeq: 0,
          lastSeq: 1,
          timestamp: '2026-10-31T00:00:00Z',
        }}
        onAnswer={async (input) => { submissions.push(input); }}
      />
    </>,
  );

  const leaseBar = screen.getByTestId('agent-terminal-lease-bar');
  const issueButton = leaseBar.querySelector<HTMLButtonElement>('.agent-terminal-handoff-issue');
  const completeButton = leaseBar.querySelector<HTMLButtonElement>('.agent-terminal-handoff-complete');
  expect(issueButton).toHaveTextContent('遇到问题');
  expect(completeButton).toHaveTextContent('继续验证');

  fireEvent.click(issueButton!);
  expect(screen.getByRole('textbox')).toBeVisible();

  fireEvent.click(completeButton!);
  await waitFor(() => expect(submissions).toHaveLength(1));
  expect(submissions[0]).toMatchObject({ action: 'completed', answers: [] });
  act(() => refreshed.dispose());
});
