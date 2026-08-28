import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AgentTerminalSnapshotV1,
  TerminalResolveApprovalRequestV1,
  TerminalRunControlRequestV1,
  TerminalTakeoverAndWriteRequestV1,
} from '@/lib/agent-terminal-control';
import { useAgentTerminalStore } from '@/stores/agentTerminalStore';
import {
  makeAgentTerminalSnapshot,
  makePendingTerminalApprovalSnapshot,
  makeTerminalAction,
  makeTerminalObservation,
} from '@/test/agent-terminal-fixtures';
import { AgentTerminalWorkspace } from '../agent-terminal-workspace';
import type { AgentTerminalTransportV1 } from '../use-agent-terminal';

const xtermHarness = vi.hoisted(() => ({
  data: 'x',
  focus: vi.fn(),
}));

vi.mock('@/hooks/useI18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
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
        <div data-testid="acceptance-xterm">
          <button
            type="button"
            disabled={props.disabled}
            onClick={() => props.onData(xtermHarness.data)}
          >
            acceptance-xterm-input
          </button>
          <button
            type="button"
            onClick={() => props.onTransportHint('disconnected')}
          >
            acceptance-transport-hint
          </button>
        </div>
      );
    }),
  };
});

type NarrowCommand =
  | 'agent_terminal_get_snapshot'
  | 'agent_terminal_resolve_approval'
  | 'agent_terminal_takeover_and_write'
  | 'agent_terminal_return_control'
  | 'agent_terminal_pause'
  | 'agent_terminal_stop';

class MockedNarrowTauriIpc implements AgentTerminalTransportV1 {
  snapshot: AgentTerminalSnapshotV1;

  readonly durableState: Array<{ command: NarrowCommand; clientActionId?: string }> = [];

  readonly effectCount = { userWrites: 0, approvals: 0 };

  getCount = 0;

  throwUnknownAfterNextEffect = false;

  failNextTakeover = false;

  private readonly cached = new Map<string, AgentTerminalSnapshotV1>();

  constructor(snapshot = makeAgentTerminalSnapshot()) {
    this.snapshot = snapshot;
  }

  private record(command: NarrowCommand, clientActionId?: string): void {
    this.durableState.push({ command, clientActionId });
  }

  private clone(): AgentTerminalSnapshotV1 {
    return structuredClone(this.snapshot);
  }

  getSnapshot = async (): Promise<AgentTerminalSnapshotV1> => {
    this.getCount += 1;
    this.record('agent_terminal_get_snapshot');
    return this.clone();
  };

  takeoverAndWrite = async (
    request: TerminalTakeoverAndWriteRequestV1,
  ): Promise<AgentTerminalSnapshotV1> => {
    this.record('agent_terminal_takeover_and_write', request.clientActionId);
    if (this.failNextTakeover) {
      this.failNextTakeover = false;
      throw { code: 'leaseRejected', message: 'authority changed before takeover' };
    }
    const cached = this.cached.get(request.clientActionId);
    if (cached) return structuredClone(cached);
    this.effectCount.userWrites += 1;
    this.snapshot = makeAgentTerminalSnapshot({
      controlState: 'user',
      lastSequence: this.snapshot.lastSequence + 1,
      captureEpoch: this.snapshot.captureEpoch,
      leaseEpoch: this.snapshot.leaseEpoch + 1,
      leaseRevision: this.snapshot.leaseRevision + 1,
    });
    this.cached.set(request.clientActionId, this.clone());
    if (this.throwUnknownAfterNextEffect) {
      this.throwUnknownAfterNextEffect = false;
      throw new Error('mock transport lost the authoritative response');
    }
    return this.clone();
  };

  returnControl = async (
    request: TerminalRunControlRequestV1,
  ): Promise<AgentTerminalSnapshotV1> => {
    this.record('agent_terminal_return_control', request.clientActionId);
    const cached = this.cached.get(request.clientActionId);
    if (cached) return structuredClone(cached);
    this.snapshot = makeAgentTerminalSnapshot({
      controlState: 'agent',
      lastSequence: this.snapshot.lastSequence + 1,
      captureEpoch: this.snapshot.captureEpoch + 1,
      leaseEpoch: this.snapshot.leaseEpoch + 2,
      leaseRevision: this.snapshot.leaseRevision + 2,
    });
    this.cached.set(request.clientActionId, this.clone());
    return this.clone();
  };

  resolveApproval = async (
    request: TerminalResolveApprovalRequestV1,
  ): Promise<AgentTerminalSnapshotV1> => {
    this.record('agent_terminal_resolve_approval', request.clientActionId);
    const cached = this.cached.get(request.clientActionId);
    if (cached) return structuredClone(cached);
    if (request.approvalId !== this.snapshot.pendingApproval?.approvalId) {
      throw { code: 'bindingMismatch', message: 'approval binding changed' };
    }
    if (this.snapshot.pendingApproval.expiresAtMs <= Date.now()) {
      throw { code: 'approvalExpired', message: 'approval expired' };
    }
    this.effectCount.approvals += 1;
    const currentObservation = this.snapshot.currentObservation;
    const action = makeTerminalAction({
      state: request.decision === 'approve' ? 'awaitingObservation' : 'rejected',
    });
    this.snapshot = makeAgentTerminalSnapshot({
      lastSequence: this.snapshot.lastSequence + 1,
      currentObservation,
      actions: [action],
      pendingApproval: null,
    });
    this.cached.set(request.clientActionId, this.clone());
    if (this.throwUnknownAfterNextEffect) {
      this.throwUnknownAfterNextEffect = false;
      throw new Error('mock transport lost the authoritative approval response');
    }
    return this.clone();
  };

  pause = async (request: TerminalRunControlRequestV1): Promise<AgentTerminalSnapshotV1> => {
    this.record('agent_terminal_pause', request.clientActionId);
    this.snapshot = makeAgentTerminalSnapshot({
      controlState: 'paused',
      lastSequence: this.snapshot.lastSequence + 1,
      leaseEpoch: this.snapshot.leaseEpoch + 1,
      leaseRevision: this.snapshot.leaseRevision + 1,
    });
    return this.clone();
  };

  stop = async (request: TerminalRunControlRequestV1): Promise<AgentTerminalSnapshotV1> => {
    this.record('agent_terminal_stop', request.clientActionId);
    this.snapshot = makeAgentTerminalSnapshot({
      controlState: 'stopped',
      lastSequence: this.snapshot.lastSequence + 1,
      leaseEpoch: this.snapshot.leaseEpoch + 1,
      leaseRevision: this.snapshot.leaseRevision + 1,
    });
    return this.clone();
  };
}

describe('Agent terminal phase-5 deterministic cross-layer acceptance', () => {
  beforeEach(() => {
    useAgentTerminalStore.getState().reset();
    xtermHarness.data = 'x';
    xtermHarness.focus.mockReset();
  });

  it('flows snapshot to UI to mocked narrow IPC to authoritative takeover and rotated return', async () => {
    const ipc = new MockedNarrowTauriIpc();
    ipc.throwUnknownAfterNextEffect = true;
    render(<AgentTerminalWorkspace runId="run-1" transport={ipc} />);
    const input = await screen.findByRole('button', { name: 'acceptance-xterm-input' });
    xtermHarness.data = 'first-key';
    fireEvent.click(input);
    await waitFor(() => expect(
      useAgentTerminalStore.getState().snapshotsByRunId['run-1'].leaseOwner,
    ).toBe('user'));
    expect(ipc.effectCount.userWrites).toBe(1);
    expect(ipc.durableState.filter(
      (entry) => entry.command === 'agent_terminal_takeover_and_write',
    )).toHaveLength(2);

    xtermHarness.data = 'second-key';
    fireEvent.click(input);
    await waitFor(() => expect(ipc.effectCount.userWrites).toBe(2));
    const beforeCapture = ipc.snapshot.captureEpoch;
    fireEvent.click(screen.getByRole('button', { name: 'ai.agentTerminal.returnControl' }));
    const returnButtons = screen.getAllByRole('button', {
      name: 'ai.agentTerminal.returnControl',
    });
    fireEvent.click(returnButtons[returnButtons.length - 1]);
    await waitFor(() => expect(ipc.snapshot.captureEpoch).toBe(beforeCapture + 1));
    expect(useAgentTerminalStore.getState().snapshotsByRunId['run-1'].leaseOwner).toBe('agent');
  });

  it('makes approval approve or reject single-use and hides expiry or replay paths', async () => {
    const future = 4_000_000_000_000;
    const approveIpc = new MockedNarrowTauriIpc(makePendingTerminalApprovalSnapshot(future - 1_000));
    approveIpc.throwUnknownAfterNextEffect = true;
    const approved = render(<AgentTerminalWorkspace runId="run-1" transport={approveIpc} />);
    fireEvent.click(await screen.findByRole('button', { name: 'ai.agentTerminal.approve' }));
    const approveButtons = screen.getAllByRole('button', { name: 'ai.agentTerminal.approve' });
    fireEvent.click(approveButtons[approveButtons.length - 1]);
    await waitFor(() => expect(approveIpc.effectCount.approvals).toBe(1));
    expect(approveIpc.durableState.filter(
      (entry) => entry.command === 'agent_terminal_resolve_approval',
    )).toHaveLength(2);
    expect(screen.queryByRole('button', { name: 'ai.agentTerminal.approve' }))
      .not.toBeInTheDocument();
    approved.unmount();
    useAgentTerminalStore.getState().reset();

    const rejectIpc = new MockedNarrowTauriIpc(makePendingTerminalApprovalSnapshot(future - 1_000));
    const rejected = render(<AgentTerminalWorkspace runId="run-1" transport={rejectIpc} />);
    fireEvent.click(await screen.findByRole('button', { name: 'ai.agentTerminal.reject' }));
    const rejectButtons = screen.getAllByRole('button', { name: 'ai.agentTerminal.reject' });
    fireEvent.click(rejectButtons[rejectButtons.length - 1]);
    await waitFor(() => expect(rejectIpc.snapshot.actions[0].state).toBe('rejected'));
    expect(rejectIpc.effectCount.approvals).toBe(1);
    rejected.unmount();
    useAgentTerminalStore.getState().reset();

    const expired = makePendingTerminalApprovalSnapshot(1, {
      pendingApproval: {
        ...makePendingTerminalApprovalSnapshot(1).pendingApproval!,
        issuedAtMs: 1,
        expiresAtMs: 2,
      },
    });
    render(<AgentTerminalWorkspace
      runId="run-1"
      transport={new MockedNarrowTauriIpc(expired)}
    />);
    expect(await screen.findByText('ai.agentTerminal.approvalUnavailableTitle'))
      .toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'ai.agentTerminal.approve' }))
      .not.toBeInTheDocument();
  });

  it('keeps sensitive and unsupported observations handoff-only with zero approval', async () => {
    for (const [promptClass, surface] of [
      ['password', 'linePrompt'],
      ['passphrase', 'linePrompt'],
      ['mfa', 'linePrompt'],
      ['otp', 'linePrompt'],
      ['token', 'linePrompt'],
      ['credential', 'linePrompt'],
      ['unknownSensitive', 'linePrompt'],
      ['unknown', 'fullScreen'],
      ['unknown', 'editor'],
      ['unknown', 'installer'],
      ['unknown', 'unknown'],
    ] as const) {
      const ipc = new MockedNarrowTauriIpc(makeAgentTerminalSnapshot({
        controlState: 'handoffRequired',
        lastSequence: 2,
        currentObservation: makeTerminalObservation({ promptClass, surface }),
        actions: [makeTerminalAction({ state: 'handoffRequired', approvalId: null })],
      }));
      const view = render(<AgentTerminalWorkspace runId="run-1" transport={ipc} />);
      expect(await screen.findByText('ai.agentTerminal.handoffNoApproval')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'ai.agentTerminal.approve' }))
        .not.toBeInTheDocument();
      expect(ipc.effectCount.approvals).toBe(0);
      view.unmount();
      useAgentTerminalStore.getState().reset();
    }
  });

  it('disconnect reconnect remount pause and stop stay fail closed', async () => {
    const ipc = new MockedNarrowTauriIpc(makeAgentTerminalSnapshot({
      controlState: 'disconnected',
      lastSequence: 3,
      leaseEpoch: 2,
      leaseRevision: 2,
    }));
    const first = render(<AgentTerminalWorkspace runId="run-1" transport={ipc} />);
    await screen.findByText('ai.agentTerminal.statusTitle');
    fireEvent.click(screen.getByRole('button', { name: 'acceptance-transport-hint' }));
    await waitFor(() => expect(ipc.getCount).toBe(2));
    expect(ipc.snapshot.leaseOwner).toBe('unowned');
    first.unmount();
    const remounted = render(<AgentTerminalWorkspace runId="run-1" transport={ipc} />);
    await waitFor(() => expect(ipc.getCount).toBe(3));
    expect(ipc.durableState.some(
      (entry) => entry.command === 'agent_terminal_return_control',
    )).toBe(false);

    remounted.unmount();
    useAgentTerminalStore.getState().reset();
    ipc.snapshot = makeAgentTerminalSnapshot({ lastSequence: 4, leaseRevision: 4 });
    render(<AgentTerminalWorkspace runId="run-1" transport={ipc} />);
    await waitFor(() => expect(
      useAgentTerminalStore.getState().snapshotsByRunId['run-1']?.controlState,
    ).toBe('agent'));
    fireEvent.click(await screen.findByRole('button', { name: 'ai.agentTerminal.pause' }));
    await waitFor(() => expect(ipc.snapshot.controlState).toBe('paused'));
    fireEvent.click(screen.getByRole('button', { name: 'ai.agentTerminal.stop' }));
    const stopButtons = screen.getAllByRole('button', { name: 'ai.agentTerminal.stop' });
    fireEvent.click(stopButtons[stopButtons.length - 1]);
    await waitFor(() => expect(ipc.snapshot.controlState).toBe('stopped'));
    expect(ipc.snapshot.leaseOwner).toBe('unowned');
  });

  it('resyncs errors, never renders unknownEffect as success, and persists no raw secret', async () => {
    const unknown = makeAgentTerminalSnapshot({
      controlState: 'handoffRequired',
      lastSequence: 5,
      actions: [makeTerminalAction({ state: 'unknownEffect', approvalId: null })],
    });
    const ipc = new MockedNarrowTauriIpc(unknown);
    const first = render(<AgentTerminalWorkspace runId="run-1" transport={ipc} />);
    expect(await screen.findByText('ai.agentTerminal.unknownEffectTitle')).toBeInTheDocument();
    expect(screen.queryByText('ai.agentTerminal.verified')).not.toBeInTheDocument();
    first.unmount();
    useAgentTerminalStore.getState().reset();

    ipc.snapshot = makeAgentTerminalSnapshot();
    ipc.failNextTakeover = true;
    render(<AgentTerminalWorkspace runId="run-1" transport={ipc} />);
    const secret = 'otp-phase5-938271';
    xtermHarness.data = secret;
    fireEvent.click(await screen.findByRole('button', { name: 'acceptance-xterm-input' }));
    await waitFor(() => expect(ipc.getCount).toBeGreaterThanOrEqual(3));
    expect(JSON.stringify(ipc.durableState)).not.toContain(secret);
    expect(JSON.stringify(useAgentTerminalStore.getState())).not.toContain(secret);
    expect(document.body.textContent).not.toContain(secret);
    expect(ipc.durableState.every((entry) => entry.command.startsWith('agent_terminal_')))
      .toBe(true);
  });
});
