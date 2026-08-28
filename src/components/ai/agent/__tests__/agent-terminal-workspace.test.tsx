import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  makeAgentTerminalSnapshot,
  makePendingTerminalApprovalSnapshot,
  makeTerminalAction,
  makeTerminalApproval,
  makeTerminalObservation,
} from '@/test/agent-terminal-fixtures';
import { useAgentTerminalStore } from '@/stores/agentTerminalStore';
import type { AgentTerminalSnapshotV1 } from '@/lib/agent-terminal-control';
import xtermSource from '../agent-terminal-xterm.tsx?raw';
import hookSource from '../use-agent-terminal.ts?raw';
import { AgentTerminalWorkspace } from '../agent-terminal-workspace';
import type { AgentTerminalTransportV1 } from '../use-agent-terminal';

const xtermHarness = vi.hoisted(() => ({
  data: 'x',
  focus: vi.fn(),
}));

vi.mock('@/hooks/useI18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

vi.mock('../agent-terminal-xterm', async () => {
  const React = await import('react');
  return {
    AgentTerminalXtermV1: React.forwardRef((props: {
      disabled: boolean;
      onData: (data: string) => void;
      onTransportHint: (hint: string) => void;
    }, ref) => {
      React.useImperativeHandle(ref, () => ({ focus: xtermHarness.focus }));
      return (
        <div data-testid="agent-xterm-harness">
          <button
            type="button"
            disabled={props.disabled}
            onClick={() => props.onData(xtermHarness.data)}
          >
            xterm-input
          </button>
          <button type="button" onClick={() => props.onTransportHint('disconnected')}>
            xterm-transport-event
          </button>
        </div>
      );
    }),
  };
});

function transportFor(
  getSnapshot: AgentTerminalTransportV1['getSnapshot'],
  overrides: Partial<AgentTerminalTransportV1> = {},
): AgentTerminalTransportV1 {
  const fallback = makeAgentTerminalSnapshot();
  return {
    getSnapshot,
    resolveApproval: vi.fn(async () => fallback),
    takeoverAndWrite: vi.fn(async () => makeAgentTerminalSnapshot({
      controlState: 'user',
      lastSequence: 1,
      leaseEpoch: 2,
      leaseRevision: 2,
    })),
    returnControl: vi.fn(async () => fallback),
    pause: vi.fn(async () => makeAgentTerminalSnapshot({
      controlState: 'paused',
      lastSequence: 1,
      leaseEpoch: 2,
      leaseRevision: 2,
    })),
    stop: vi.fn(async () => makeAgentTerminalSnapshot({
      controlState: 'stopped',
      lastSequence: 1,
      leaseEpoch: 2,
      leaseRevision: 2,
    })),
    ...overrides,
  };
}

describe('AgentTerminalWorkspace', () => {
  beforeEach(() => {
    useAgentTerminalStore.getState().reset();
    xtermHarness.data = 'x';
    xtermHarness.focus.mockReset();
  });

  it('resyncs on every mount and treats transport events only as refresh hints', async () => {
    const disconnected = makeAgentTerminalSnapshot({
      controlState: 'disconnected',
      lastSequence: 3,
      leaseEpoch: 2,
      leaseRevision: 2,
    });
    const getSnapshot = vi.fn(async () => disconnected);
    const transport = transportFor(getSnapshot);
    const first = render(<AgentTerminalWorkspace runId="run-1" transport={transport} />);
    expect(await screen.findByText('ai.agentTerminal.statusTitle')).toBeInTheDocument();
    expect(getSnapshot).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'xterm-transport-event' }));
    await waitFor(() => expect(getSnapshot).toHaveBeenCalledTimes(2));
    expect(useAgentTerminalStore.getState().snapshotsByRunId['run-1'].controlState)
      .toBe('disconnected');
    first.unmount();

    render(<AgentTerminalWorkspace runId="run-1" transport={transport} />);
    await waitFor(() => expect(getSnapshot).toHaveBeenCalledTimes(3));
    expect(transport.returnControl).not.toHaveBeenCalled();
  });

  it('uses atomic takeover for the first Agent-owner key and the same narrow path for user input', async () => {
    let sequence = 0;
    const takeoverAndWrite = vi.fn<AgentTerminalTransportV1['takeoverAndWrite']>(async () => {
      sequence += 1;
      return makeAgentTerminalSnapshot({
        controlState: 'user',
        lastSequence: sequence,
        leaseEpoch: 2,
        leaseRevision: sequence + 1,
      });
    });
    const transport = transportFor(
      vi.fn(async () => makeAgentTerminalSnapshot()),
      { takeoverAndWrite },
    );
    render(<AgentTerminalWorkspace runId="run-1" transport={transport} />);
    const input = await screen.findByRole('button', { name: 'xterm-input' });

    xtermHarness.data = 'a';
    fireEvent.click(input);
    await waitFor(() => expect(takeoverAndWrite).toHaveBeenCalledTimes(1));
    expect(takeoverAndWrite.mock.calls[0][0]).toMatchObject({
      schemaVersion: 1,
      runId: 'run-1',
      data: 'a',
    });
    await waitFor(() => expect(
      useAgentTerminalStore.getState().snapshotsByRunId['run-1'].leaseOwner,
    ).toBe('user'));

    xtermHarness.data = 'b';
    fireEvent.click(input);
    await waitFor(() => expect(takeoverAndWrite).toHaveBeenCalledTimes(2));
    expect(takeoverAndWrite.mock.calls[1][0].data).toBe('b');
  });

  it('does not optimistically forge owner after a takeover race or failure', async () => {
    const initial = makeAgentTerminalSnapshot();
    const getSnapshot = vi.fn(async () => initial);
    const takeoverAndWrite = vi.fn(async () => Promise.reject({
      code: 'leaseRejected',
      message: 'takeover lost the authority race',
    }));
    const transport = transportFor(getSnapshot, { takeoverAndWrite });
    render(<AgentTerminalWorkspace runId="run-1" transport={transport} />);
    fireEvent.click(await screen.findByRole('button', { name: 'xterm-input' }));
    await waitFor(() => expect(getSnapshot).toHaveBeenCalledTimes(2));
    expect(useAgentTerminalStore.getState().snapshotsByRunId['run-1'].leaseOwner)
      .toBe('agent');
    expect(screen.queryByText('ai.agentTerminal.youControl')).not.toBeInTheDocument();
  });

  it('confirms button takeover, then waits for a real first key instead of inventing a PTY byte', async () => {
    const takeoverAndWrite = vi.fn(async () => makeAgentTerminalSnapshot({
      controlState: 'user',
      lastSequence: 1,
      leaseEpoch: 2,
      leaseRevision: 2,
    }));
    const transport = transportFor(
      vi.fn(async () => makeAgentTerminalSnapshot()),
      { takeoverAndWrite },
    );
    render(<AgentTerminalWorkspace runId="run-1" transport={transport} />);
    fireEvent.click(await screen.findByRole('button', { name: 'ai.agentTerminal.takeoverNow' }));
    expect(screen.getByText('ai.agentTerminal.takeoverConfirmDescription')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'ai.agentTerminal.takeoverAndFocus' }));
    expect(takeoverAndWrite).not.toHaveBeenCalled();
    await waitFor(() => expect(xtermHarness.focus).toHaveBeenCalledOnce());
    xtermHarness.data = 'real-first-key';
    fireEvent.click(screen.getByRole('button', { name: 'xterm-input' }));
    await waitFor(() => expect(takeoverAndWrite).toHaveBeenCalledOnce());
  });

  it('returns control only from active User ownership and shows capture rotation', async () => {
    const initial = makeAgentTerminalSnapshot({
      controlState: 'user',
      captureEpoch: 4,
      leaseEpoch: 2,
      leaseRevision: 3,
    });
    const returned = makeAgentTerminalSnapshot({
      controlState: 'agent',
      lastSequence: 2,
      captureEpoch: 5,
      leaseEpoch: 4,
      leaseRevision: 5,
      actions: [makeTerminalAction({
        actionId: 'user-return-1',
        actionKind: 'terminal.returnControl',
        actionDigest: 'sha256-v1:return',
        state: 'completed',
        risk: null,
        approvalId: null,
        observationId: null,
      })],
    });
    const returnControl = vi.fn(async () => returned);
    const transport = transportFor(vi.fn(async () => initial), { returnControl });
    render(<AgentTerminalWorkspace runId="run-1" transport={transport} />);
    fireEvent.click(await screen.findByRole('button', { name: 'ai.agentTerminal.returnControl' }));
    const confirm = screen.getAllByRole('button', { name: 'ai.agentTerminal.returnControl' });
    fireEvent.click(confirm[confirm.length - 1]);
    await waitFor(() => expect(returnControl).toHaveBeenCalledOnce());
    expect(await screen.findByText('ai.agentTerminal.captureRotatedTitle')).toBeInTheDocument();
  });

  it('shows only an exactly bound unexpired approval and resolves it once through AlertDialog', async () => {
    const nowMs = Date.now();
    const pending = makePendingTerminalApprovalSnapshot(nowMs);
    const resolved = makeAgentTerminalSnapshot({
      lastSequence: 2,
      currentObservation: pending.currentObservation,
      actions: [makeTerminalAction({ state: 'awaitingObservation' })],
    });
    const resolveApproval = vi.fn(async () => resolved);
    const transport = transportFor(vi.fn(async () => pending), { resolveApproval });
    render(<AgentTerminalWorkspace runId="run-1" transport={transport} />);

    fireEvent.click(await screen.findByRole('button', { name: 'ai.agentTerminal.approve' }));
    expect(screen.getByText('ai.agentTerminal.approvalConfirmDescription')).toBeInTheDocument();
    const actions = screen.getAllByRole('button', { name: 'ai.agentTerminal.approve' });
    fireEvent.click(actions[actions.length - 1]);
    await waitFor(() => expect(resolveApproval).toHaveBeenCalledOnce());
    expect(screen.queryByRole('button', { name: 'ai.agentTerminal.approve' }))
      .not.toBeInTheDocument();
  });

  it('hides expired, stale-bound, sensitive, and unsupported approval paths', async () => {
    const nowMs = Date.now();
    const expired = makePendingTerminalApprovalSnapshot(nowMs, {
      pendingApproval: makeTerminalApproval(nowMs, { expiresAtMs: nowMs - 1 }),
    });
    const expiredTransport = transportFor(vi.fn(async () => expired));
    const first = render(<AgentTerminalWorkspace runId="run-1" transport={expiredTransport} />);
    expect(await screen.findByText('ai.agentTerminal.approvalUnavailableTitle'))
      .toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'ai.agentTerminal.approve' }))
      .not.toBeInTheDocument();
    first.unmount();
    useAgentTerminalStore.getState().reset();

    const handoff = makeAgentTerminalSnapshot({
      controlState: 'handoffRequired',
      lastSequence: 2,
      currentObservation: makeTerminalObservation({
        promptClass: 'password',
        redactedTranscript: 'Password: [REDACTED]',
      }),
      actions: [makeTerminalAction({
        state: 'handoffRequired',
        approvalId: null,
      })],
    });
    render(<AgentTerminalWorkspace runId="run-1" transport={transportFor(
      vi.fn(async () => handoff),
    )} />);
    expect(await screen.findByText('ai.agentTerminal.handoffNoApproval')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'ai.agentTerminal.approve' }))
      .not.toBeInTheDocument();
  });

  it('never places secret onData in React/store/DOM/log surfaces or generic write code', async () => {
    const secret = 'otp-938271-secret';
    const takeoverAndWrite = vi.fn(async () => makeAgentTerminalSnapshot({
      controlState: 'user',
      lastSequence: 1,
      leaseEpoch: 2,
      leaseRevision: 2,
    }));
    const transport = transportFor(
      vi.fn(async () => makeAgentTerminalSnapshot({
        controlState: 'handoffRequired',
        currentObservation: makeTerminalObservation({ promptClass: 'otp' }),
      })),
      { takeoverAndWrite },
    );
    render(<AgentTerminalWorkspace runId="run-1" transport={transport} />);
    xtermHarness.data = secret;
    fireEvent.click(await screen.findByRole('button', { name: 'xterm-input' }));
    await waitFor(() => expect(takeoverAndWrite).toHaveBeenCalledOnce());
    expect(JSON.stringify(useAgentTerminalStore.getState())).not.toContain(secret);
    expect(document.body.textContent).not.toContain(secret);
    expect(xtermSource).not.toContain('invokeWriteSession');
    expect(xtermSource).not.toContain('appendTerminalOutput');
    expect(hookSource).not.toContain('invokeWriteSession');
    expect(hookSource).not.toContain('write_session');
  });

  it('keeps unknownEffect explicit and routes pause/stop through narrow commands', async () => {
    const unknown = makeAgentTerminalSnapshot({
      controlState: 'handoffRequired',
      lastSequence: 3,
      actions: [makeTerminalAction({
        state: 'unknownEffect',
        approvalId: null,
        verification: {
          obligationId: 'obligation-1',
          actionId: 'action-1',
          state: 'inconclusive',
          evidenceId: null,
          evidenceDigest: null,
          independent: false,
        },
      })],
    });
    const paused = makeAgentTerminalSnapshot({
      controlState: 'paused',
      lastSequence: 4,
      leaseEpoch: 2,
      leaseRevision: 2,
      actions: unknown.actions,
    });
    const stopped = makeAgentTerminalSnapshot({
      controlState: 'stopped',
      lastSequence: 5,
      leaseEpoch: 3,
      leaseRevision: 3,
      actions: unknown.actions,
    });
    const pause = vi.fn(async () => paused);
    const stop = vi.fn(async () => stopped);
    const transport = transportFor(vi.fn(async () => unknown), { pause, stop });
    render(<AgentTerminalWorkspace runId="run-1" transport={transport} />);
    expect(await screen.findByText('ai.agentTerminal.unknownEffectTitle')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'ai.agentTerminal.pause' }));
    await waitFor(() => expect(pause).toHaveBeenCalledOnce());

    useAgentTerminalStore.getState().installSnapshot(unknown);
    fireEvent.click(screen.getByRole('button', { name: 'ai.agentTerminal.stop' }));
    expect(screen.getByText('ai.agentTerminal.stopConfirmDescription')).toBeInTheDocument();
    const stopButtons = screen.getAllByRole('button', { name: 'ai.agentTerminal.stop' });
    fireEvent.click(stopButtons[stopButtons.length - 1]);
    await waitFor(() => expect(stop).toHaveBeenCalledOnce());
  });

  it('does not mount a normal terminal when no bound AgentPty snapshot exists', async () => {
    const error = { code: 'runNotFound', message: 'no dedicated binding' };
    const transport = transportFor(vi.fn(async () => Promise.reject(error)));
    render(<AgentTerminalWorkspace runId="run-1" transport={transport} />);
    expect(await screen.findByText('no dedicated binding')).toBeInTheDocument();
    expect(screen.queryByTestId('agent-xterm-harness')).not.toBeInTheDocument();
    expect(transport.takeoverAndWrite).not.toHaveBeenCalled();
  });
});
