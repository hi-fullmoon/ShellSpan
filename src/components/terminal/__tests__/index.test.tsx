import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import Terminal from '../index';
import { useTerminalStore } from '@/stores/terminalStore';
import { useAppStore } from '@/stores/appStore';

const mockConnect = vi.fn();

vi.mock('@/hooks/useI18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
    ready: true,
    locale: 'en-US',
    setLocale: () => {},
  }),
}));

vi.mock('@/hooks/useConnectSession', () => ({
  useConnectSession: () => ({
    connect: mockConnect,
    hostKeyDialog: {
      open: false,
      host: '',
      port: 22,
      mismatch: false,
      onTrust: () => {},
    },
    closeHostKeyDialog: vi.fn(),
  }),
}));

vi.mock('../terminal-controller-layer', () => ({
  TerminalControllerLayer: () => null,
}));

vi.mock('../terminal-pane', () => ({
  TerminalPane: () => <div data-testid="terminal-pane" />,
}));

vi.mock('../new-tab-menu', () => ({
  NewTabMenu: ({
    open,
    onConnect,
  }: {
    open: boolean;
    onConnect: (profile: unknown) => Promise<void>;
  }) =>
    open ? (
      <button
        type="button"
        data-testid="new-tab-menu"
        onClick={() => void onConnect({ id: 'p1' })}
      >
        NewTabMenu
      </button>
    ) : null,
}));

vi.mock('../terminal-context-menu', () => ({
  TerminalContextMenu: () => null,
}));

vi.mock('../host-key-dialog', () => ({
  HostKeyDialog: () => null,
}));

const initialState = useTerminalStore.getState();

describe('Terminal', () => {
  beforeEach(() => {
    useTerminalStore.setState(initialState, true);
    mockConnect.mockReset();
  });

  afterEach(async () => {
    await new Promise((resolve) => setTimeout(resolve, 60));
  });

  it('renders the empty state with a new-connection button when there are no sessions', () => {
    render(<Terminal />);

    expect(screen.getByText('terminal.empty')).toBeInTheDocument();
    expect(screen.getByText('terminal.openFromWorkbench')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'terminal.empty.newConnection' }),
    ).toBeInTheDocument();
  });

  it('opens the new tab menu when the empty-state new-connection button is clicked', () => {
    render(<Terminal />);

    expect(screen.queryByTestId('new-tab-menu')).not.toBeInTheDocument();

    fireEvent.click(
      screen.getByRole('button', { name: 'terminal.empty.newConnection' }),
    );

    expect(screen.getByTestId('new-tab-menu')).toBeInTheDocument();
  });

  it('passes the dialog-owning connection callback to the new tab menu', () => {
    render(<Terminal />);

    fireEvent.click(
      screen.getByRole('button', { name: 'terminal.empty.newConnection' }),
    );
    fireEvent.click(screen.getByTestId('new-tab-menu'));

    expect(mockConnect).toHaveBeenCalledWith({ id: 'p1' });
  });

  it('toggles the new tab menu with Ctrl/Cmd+K keyboard shortcut', () => {
    useAppStore.setState({ activeSection: 'terminal' });

    render(<Terminal />);

    expect(screen.queryByTestId('new-tab-menu')).not.toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'k', metaKey: true });

    expect(screen.getByTestId('new-tab-menu')).toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'k', ctrlKey: true });

    expect(screen.queryByTestId('new-tab-menu')).not.toBeInTheDocument();
  });

  it('renders the terminal pane when there is an active session', () => {
    useTerminalStore.getState().addSession({
      sessionId: 's1',
      title: 'Session A',
      host: 'h',
      port: 22,
      username: 'u',
    });

    render(<Terminal />);

    expect(screen.getByTestId('terminal-pane')).toBeInTheDocument();
    expect(screen.queryByText('terminal.empty')).not.toBeInTheDocument();
  });
});
