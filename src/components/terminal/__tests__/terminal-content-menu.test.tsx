import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { TerminalContentMenu } from '../terminal-content-menu';
import { terminalRegistry } from '../registry/terminal-registry';
import { agentTerminalLeaseState } from '../agent-terminal-lease-state';
import { useTerminalStore } from '@/stores/terminalStore';
import { useProfileStore } from '@/stores/profileStore';

const mockReconnect = vi.fn();

vi.mock('@/hooks/useI18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
    ready: true,
    locale: 'en-US',
    setLocale: () => {},
  }),
}));

vi.mock('@/hooks/useReconnectSession', () => ({
  useReconnectSession: () => mockReconnect,
}));

vi.mock('@/lib/ipc/tauri', async (importActual) => ({
  ...await importActual<typeof import('@/lib/ipc/tauri')>(),
  isTauriRuntime: () => false,
  invokeGetSessionStatus: vi.fn().mockResolvedValue({ sessionId: 's1', status: 'connected' }),
  invokeMarkSessionReady: vi.fn().mockResolvedValue(undefined),
  invokeResizeSession: vi.fn().mockResolvedValue(undefined),
  listenToSshData: vi.fn().mockResolvedValue(() => {}),
  listenToSshStatus: vi.fn().mockResolvedValue(() => {}),
  listenToSshClosed: vi.fn().mockResolvedValue(() => {}),
}));

const initialTerminal = useTerminalStore.getState();
const initialProfile = useProfileStore.getState();

describe('TerminalContentMenu reconnect', () => {
  beforeEach(() => {
    useTerminalStore.setState(initialTerminal, true);
    useProfileStore.setState(initialProfile, true);
    agentTerminalLeaseState.clearAll();
    terminalRegistry.disposeAll();
    mockReconnect.mockReset();
    useProfileStore.setState({
      profiles: [{
        id: 'p1',
        name: 'Prod',
        host: '8.216.9.10',
        port: 22,
        username: 'root',
        authMethod: 'password',
        createdAt: 0,
        updatedAt: 0,
      }],
    });
    useTerminalStore.getState().addSession(
      { sessionId: 's1', title: 'Prod', host: '8.216.9.10', port: 22, username: 'root' },
      'p1',
    );
    useTerminalStore.getState().setStatus('s1', { sessionId: 's1', status: 'connected' });
  });

  afterEach(() => {
    cleanup();
    terminalRegistry.disposeAll();
    agentTerminalLeaseState.clearAll();
    useTerminalStore.setState(initialTerminal, true);
    useProfileStore.setState(initialProfile, true);
  });

  it('shows reconnect while connected and triggers fresh reconnect immediately when no Agent task is active', () => {
    const controller = terminalRegistry.create('s1', vi.fn(), vi.fn(), () => 'connected', vi.fn());
    const session = useTerminalStore.getState().sessions[0] ?? null;

    render(
      <TerminalContentMenu session={session} terminal={controller.terminal} onPaste={vi.fn()} onSearch={vi.fn()}>
        <div data-testid="terminal-surface">surface</div>
      </TerminalContentMenu>,
    );

    fireEvent.contextMenu(screen.getByTestId('terminal-surface'));
    const item = screen.getByRole('menuitem', { name: 'terminal.menu.reconnect' });
    expect(item).not.toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(item);

    expect(mockReconnect).toHaveBeenCalledWith('s1', false, { resetBuffer: true });
  });

  it('requires confirmation before reconnecting when an Agent task owns the terminal', () => {
    const controller = terminalRegistry.create('s1', vi.fn(), vi.fn(), () => 'connected', vi.fn());
    const session = useTerminalStore.getState().sessions[0] ?? null;
    agentTerminalLeaseState.set({
      sessionId: 's1',
      agentSessionId: 'agent-1',
      taskId: 'task-1',
      operationId: 'op-1',
      acquiredAtUnixMs: 1,
      state: 'acquired',
      terminalOwned: true,
      inputBlocked: true,
      takeoverRequested: false,
      takeoverFailed: false,
      requestTakeover: vi.fn(),
    });

    render(
      <TerminalContentMenu session={session} terminal={controller.terminal} onPaste={vi.fn()} onSearch={vi.fn()}>
        <div data-testid="terminal-surface">surface</div>
      </TerminalContentMenu>,
    );

    fireEvent.contextMenu(screen.getByTestId('terminal-surface'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'terminal.menu.reconnect' }));

    expect(mockReconnect).not.toHaveBeenCalled();
    expect(screen.getByText('terminal.menu.reconnectConfirmTitle')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'terminal.menu.reconnect' }));
    expect(mockReconnect).toHaveBeenCalledWith('s1', false, { resetBuffer: true });
  });
});
