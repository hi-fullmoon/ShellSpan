import { describe, expect, it, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TerminalTabBar } from './TerminalTabBar';
import { useTerminalStore } from '@/stores/terminalStore';

vi.mock('@/lib/tauri', () => ({
  invokeCloseSession: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/hooks/useI18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
    ready: true,
    locale: 'en-US',
    setLocale: () => {},
  }),
}));

const initialState = useTerminalStore.getState();

function addSession(id: string, title: string): void {
  useTerminalStore.getState().addSession({
    sessionId: id,
    title,
    host: 'h',
    port: 22,
    username: 'u',
  });
}

describe('TerminalTabBar', () => {
  beforeEach(() => {
    useTerminalStore.setState(initialState, true);
  });

  it('renders tabs and switches active session on click', () => {
    addSession('s1', 'A');
    addSession('s2', 'B');
    render(<TerminalTabBar />);

    expect(screen.getByText('A')).toBeInTheDocument();
    expect(screen.getByText('B')).toBeInTheDocument();

    const tabs = screen.getAllByRole('tab');
    fireEvent.click(tabs[1]);
    expect(useTerminalStore.getState().activeSessionId).toBe('s2');
  });

  it('close button removes a session without activating the tab', () => {
    addSession('s1', 'A');
    addSession('s2', 'B');
    useTerminalStore.getState().setActiveSession('s2');

    render(
      <TerminalTabBar
        onNewTabClick={vi.fn()}
        onTabContextMenu={vi.fn()}
      />,
    );

    const closeButtons = screen.getAllByLabelText('close');
    expect(closeButtons[0]).toHaveAttribute('aria-label', 'close');

    fireEvent.click(closeButtons[0]);
    const state = useTerminalStore.getState();
    expect(state.sessions.some((s) => s.sessionId === 's1')).toBe(false);
    expect(state.activeSessionId).toBe('s2');
  });

  it('opens the context menu on right-click with session and coords', () => {
    addSession('s1', 'A');
    addSession('s2', 'B');
    const onTabContextMenu = vi.fn();

    render(<TerminalTabBar onTabContextMenu={onTabContextMenu} />);

    const tabs = screen.getAllByRole('tab');
    fireEvent.contextMenu(tabs[0], { clientX: 10, clientY: 20 });

    expect(onTabContextMenu).toHaveBeenCalledTimes(1);
    const [session, x, y] = onTabContextMenu.mock.calls[0];
    expect(session.sessionId).toBe('s1');
    expect(x).toBe(10);
    expect(y).toBe(20);
  });

  it('fires onNewTabClick when the + button is pressed', () => {
    addSession('s1', 'A');
    const onNewTabClick = vi.fn();
    render(<TerminalTabBar onNewTabClick={onNewTabClick} />);

    fireEvent.click(screen.getByTitle('terminal.newTab'));
    expect(onNewTabClick).toHaveBeenCalledTimes(1);
  });
});
