import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import Terminal from '../index';
import { useTerminalStore } from '@/stores/terminalStore';

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

vi.mock('../TerminalControllerLayer', () => ({
  TerminalControllerLayer: () => null,
}));

vi.mock('../TerminalPane', () => ({
  TerminalPane: () => <div data-testid="terminal-pane" />,
}));

vi.mock('../NewTabMenu', () => ({
  NewTabMenu: ({ open }: { open: boolean }) =>
    open ? <div data-testid="new-tab-menu">NewTabMenu</div> : null,
}));

vi.mock('../TerminalContextMenu', () => ({
  TerminalContextMenu: () => null,
}));

vi.mock('../HostKeyDialog', () => ({
  HostKeyDialog: () => null,
}));

const initialState = useTerminalStore.getState();

describe('Terminal', () => {
  beforeEach(() => {
    useTerminalStore.setState(initialState, true);
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

  it('toggles the new tab menu with Ctrl/Cmd+K keyboard shortcut', () => {
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
