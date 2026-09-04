import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AiWorkspaceRoot } from '@/components/ai/workspace/ai-workspace-root';
import { agentSessionView } from '@/lib/ai/agent-session-adapter';
import { createAiComposerState } from '@/lib/ai/composer-machine';
import { initI18n } from '@/locales';
import { useAppStore } from '@/stores/appStore';
import { agentSessionEventFixture, sessionEvent } from '@/test/fixtures/agent-session';

function waitingView(secondTurn = false) {
  const completedStep = agentSessionEventFixture.findIndex((event) => event.type === 'step/end');
  const events = agentSessionEventFixture.slice(0, completedStep + 1);
  const firstCall = events.find((event) => event.type === 'tool/call');
  if (!firstCall || firstCall.type !== 'tool/call') throw new Error('Missing tool fixture');
  const push = (draft: Parameters<typeof sessionEvent>[1]) => events.push(sessionEvent(events.length, draft));
  const turnId = secondTurn ? 'turn-2' : 'turn-1';
  const stepId = 'step-2';
  if (secondTurn) {
    push({ type: 'turn/end', turnId: 'turn-1', data: { reason: 'completed' } });
    push({ type: 'turn/start', turnId });
  }
  push({ type: 'step/start', turnId, stepId });
  const call = {
    ...firstCall.data.call,
    arguments: { command: 'systemctl restart nginx' },
    effect: 'stateChange' as const,
  };
  push({ type: 'tool/call', turnId, stepId, data: { call } });
  push({
    type: 'tool/approval', turnId, stepId,
    data: {
      requestId: 'request-2', callId: call.callId, approvalId: 'approval-2',
      status: 'requested', risk: 'stateChange', prompt: 'Restart nginx?',
    },
  });
  return agentSessionView({
    events, lastCommittedSeq: events.length - 1, hasTerminalEvent: false,
    snapshot: {
      header: { sessionId: 'session-fixture', taskId: 'task-fixture', goal: 'Check nginx', createdAtUnixMs: 1_000 },
      status: 'waiting', ended: false, archived: false, eventCount: events.length,
      surface: { generation: 0, messages: [] }, inbox: { nextTurn: [], nextStep: [] }, task: { evidence: [] },
      recovery: { kind: 'waitingApproval', status: 'none', summary: 'Waiting', lastCommittedSeq: events.length - 1 },
    },
  });
}

beforeEach(async () => {
  useAppStore.setState({ locale: 'en-US' });
  await initI18n('en-US');
});
afterEach(cleanup);

describe('approval identity across repeated tool calls', () => {
  it.each([false, true])('uses the pending command metadata (second turn: %s)', (secondTurn) => {
    const view = waitingView(secondTurn);
    expect(view.pendingApproval).toMatchObject({
      sessionId: 'session-fixture', turnId: secondTurn ? 'turn-2' : 'turn-1', stepId: 'step-2',
      requestId: 'request-2', callId: 'call-health', approvalId: 'approval-2',
      toolName: 'run_terminal_command', arguments: { command: 'systemctl restart nginx' },
      effect: 'stateChange', risk: 'stateChange', evidenceRefs: [],
    });
  });

  it('opens the pending command inside Turn Process instead of a previous same-ID command', async () => {
    const user = userEvent.setup();
    const view = waitingView();
    const onOpenTool = vi.fn();
    render(<AiWorkspaceRoot
      view={view}
      scope="terminal"
      composerState={createAiComposerState({
        phase: 'waitingApproval', runtimeStatus: 'waiting', waitingApproval: true, sessionId: 'session-fixture',
      })}
      onOpenTool={onOpenTool}
    />);
    await user.click(screen.getByRole('button', { name: 'View full parameters' }));
    expect(onOpenTool).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      kind: 'tool', sessionId: 'session-fixture', turnId: 'turn-1', stepId: 'step-2',
      callId: 'call-health', input: { command: 'systemctl restart nginx' }, effect: 'stateChange',
    }));
  });
});
