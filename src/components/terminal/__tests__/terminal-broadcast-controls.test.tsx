import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { useTerminalBroadcastStore } from '@/stores/terminalBroadcastStore';
import { useTerminalStore, type TerminalSession } from '@/stores/terminalStore';
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

    fireEvent.click(within(dialog).getByRole('button', { name: 'terminal.broadcast.selectAll' }));
    expect(confirm).toBeEnabled();

    fireEvent.click(within(dialog).getByRole('button', { name: 'terminal.broadcast.clearSelection' }));
    expect(confirm).toBeDisabled();

    act(() => {
      useTerminalStore.setState({ sessions: [] });
    });
    expect(within(dialog).getByText('terminal.broadcast.empty')).toBeInTheDocument();
  });
});
