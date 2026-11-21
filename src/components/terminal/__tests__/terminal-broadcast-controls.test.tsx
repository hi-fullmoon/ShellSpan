import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { useTerminalBroadcastStore } from '@/stores/terminalBroadcastStore';
import { useTerminalStore, type TerminalSession } from '@/stores/terminalStore';
import { agentTerminalLeaseState } from '../agent-terminal-lease-state';
import { TerminalBroadcastControls } from '../terminal-broadcast-controls';

vi.mock('@/hooks/useI18n', () => ({
  useI18n: () => ({
    t: (key: string, values?: Record<string, string | number>) => (
      values ? `${key}:${JSON.stringify(values)}` : key
    ),
  }),
}));

const originalTerminal = useTerminalStore.getState();

function makeSession(overrides: Partial<TerminalSession> & { sessionId: string; title: string }): TerminalSession {
  return {
    host: 'prod.example.com',
    port: 22,
    username: 'deploy',
    status: 'connected',
    ...overrides,
  };
}

describe('TerminalBroadcastControls', () => {
  beforeEach(() => {
    agentTerminalLeaseState.clearAll();
    useTerminalBroadcastStore.getState().configure('off');
    useTerminalStore.setState({
      sessions: [
        makeSession({ sessionId: 's1', title: 'Primary' }),
        makeSession({ sessionId: 's2', title: 'Replica' }),
        makeSession({ sessionId: 's3', title: 'Locked', readOnly: true }),
      ],
      workspaceSplit: null,
    });
  });

  afterEach(() => {
    agentTerminalLeaseState.clearAll();
    useTerminalBroadcastStore.getState().configure('off');
    useTerminalStore.setState(originalTerminal, true);
  });

  it('uses activeAll when no targets are skipped and switches to active when protected targets are skipped', () => {
    useTerminalBroadcastStore.getState().configure('custom', ['s1', 's2']);
    render(<TerminalBroadcastControls visible />);

    const alert = screen.getByRole('alert');
    expect(alert).toHaveClass('rounded-none', 'border-x-0', 'border-t-0');
    expect(alert).toHaveTextContent('terminal.broadcast.activeAll:{"count":2}');

    act(() => {
      useTerminalBroadcastStore.getState().configure('custom', ['s1', 's2', 's3']);
    });
    expect(screen.getByRole('alert')).toHaveTextContent('terminal.broadcast.active:{"count":2,"skipped":1}');
  });

  it('shows CompactDialogBody, protected badges, remote endpoints, select-all/clear, and empty state', () => {
    render(<TerminalBroadcastControls visible />);

    act(() => {
      document.dispatchEvent(new Event('shellspan:configure-terminal-broadcast'));
    });

    const dialog = screen.getByRole('dialog');
    expect(dialog.querySelector('.overflow-y-auto.overscroll-contain')).toBeInTheDocument();
    expect(dialog.querySelector('[data-slot="scroll-area"]')).toBeNull();
    expect(within(dialog).getByText('terminal.broadcast.protectedBadge')).toBeInTheDocument();
    expect(within(dialog).getAllByText('deploy@prod.example.com')).toHaveLength(3);

    const confirm = within(dialog).getByRole('button', { name: 'terminal.broadcast.useSelected' });
    expect(confirm).toBeDisabled();

    const lockedCheckbox = within(dialog).getByRole('checkbox', { name: /^Locked\b/ });
    expect(lockedCheckbox).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(lockedCheckbox);
    expect(lockedCheckbox).toHaveAttribute('aria-checked', 'false');

    fireEvent.click(within(dialog).getByRole('button', { name: 'terminal.broadcast.selectAll' }));
    expect(within(dialog).getByRole('checkbox', { name: /^Primary\b/ })).toHaveAttribute('aria-checked', 'true');
    expect(within(dialog).getByRole('checkbox', { name: /^Replica\b/ })).toHaveAttribute('aria-checked', 'true');
    expect(lockedCheckbox).toHaveAttribute('aria-checked', 'false');
    expect(confirm).toBeEnabled();

    fireEvent.click(within(dialog).getByRole('button', { name: 'terminal.broadcast.clearSelection' }));
    expect(confirm).toBeDisabled();

    act(() => {
      useTerminalStore.setState({ sessions: [] });
    });
    expect(within(dialog).getByText('terminal.broadcast.empty')).toBeInTheDocument();
  });

  it('requires at least two eligible sessions, tracks live Agent leases, and reflects active splitGroup mode on reopen', () => {
    useTerminalStore.setState({
      sessions: [
        makeSession({ sessionId: 's1', title: 'Primary' }),
        makeSession({ sessionId: 's2', title: 'Replica' }),
      ],
      workspaceSplit: {
        kind: 'split',
        orientation: 'horizontal',
        first: { kind: 'group', id: 'g1', sessionIds: ['s1'], activeSessionId: 's1' },
        second: { kind: 'group', id: 'g2', sessionIds: ['s2'], activeSessionId: 's2' },
      },
    });
    render(<TerminalBroadcastControls visible />);

    act(() => {
      document.dispatchEvent(new Event('shellspan:configure-terminal-broadcast'));
    });

    const dialog = screen.getByRole('dialog');
    const replicaCheckbox = within(dialog).getByRole('checkbox', { name: /^Replica\b/ });
    expect(replicaCheckbox).not.toHaveAttribute('aria-disabled', 'true');
    expect(within(dialog).queryByText('terminal.broadcast.protectedBadge')).toBeNull();

    act(() => {
      agentTerminalLeaseState.set({
        sessionId: 's2',
        agentSessionId: 'agent-1',
        taskId: 'task-1',
        operationId: 'op-1',
        acquiredAtUnixMs: 1_000,
        state: 'acquired',
        commandDisplay: 'ls',
        terminalOwned: true,
        inputBlocked: false,
        takeoverRequested: false,
        takeoverFailed: false,
        requestTakeover: vi.fn(),
      });
    });

    expect(within(dialog).getByText('terminal.broadcast.protectedBadge')).toBeInTheDocument();
    expect(replicaCheckbox).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(within(dialog).getByRole('button', { name: 'terminal.broadcast.selectAll' }));
    expect(within(dialog).getByRole('button', { name: 'terminal.broadcast.useSelected' })).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: 'terminal.broadcast.usePanes' })).toBeDisabled();

    act(() => {
      agentTerminalLeaseState.clear('s2', 'op-1');
    });
    expect(within(dialog).queryByText('terminal.broadcast.protectedBadge')).toBeNull();
    expect(replicaCheckbox).not.toHaveAttribute('aria-disabled', 'true');

    fireEvent.click(within(dialog).getByRole('button', { name: 'terminal.broadcast.usePanes' }));
    expect(useTerminalBroadcastStore.getState().mode).toBe('splitGroup');

    fireEvent.click(within(screen.getByRole('alert')).getByRole('button', { name: 'terminal.broadcast.configure' }));
    const reopened = screen.getByRole('dialog');
    expect(within(reopened).getByText('terminal.broadcast.mode.splitGroup')).toBeInTheDocument();
    expect(within(reopened).getByRole('checkbox', { name: /^Primary\b/ })).toHaveAttribute('aria-checked', 'true');
    expect(within(reopened).getByRole('checkbox', { name: /^Replica\b/ })).toHaveAttribute('aria-checked', 'true');
  });
});
