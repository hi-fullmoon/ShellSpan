import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
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

  afterEach(async () => {
    await new Promise((resolve) => setTimeout(resolve, 60));
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

  it('reorders sessions via drag-to-reorder (s3 onto s1 -> [s3,s1,s2])', async () => {
    addSession('s1', 'A');
    addSession('s2', 'B');
    addSession('s3', 'C');
    useTerminalStore.getState().setActiveSession('s3');

    const reorderSpy = vi.spyOn(
      useTerminalStore.getState(),
      'reorderSessions',
    );

    render(<TerminalTabBar />);

    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(3);

    const setRect = (el: HTMLElement, left: number, width: number): void => {
      el.getBoundingClientRect = vi.fn(() => ({
        left,
        right: left + width,
        top: 0,
        bottom: 24,
        x: left,
        y: 0,
        width,
        height: 24,
        toJSON: () => ({}),
      }));
    };
    setRect(tabs[0], 0, 100);
    setRect(tabs[1], 100, 100);
    setRect(tabs[2], 200, 100);

    await act(async () => {
      fireEvent.pointerDown(tabs[2], {
        button: 0,
        isPrimary: true,
        clientX: 250,
        clientY: 10,
      });
      fireEvent.pointerMove(document, { clientX: 260, clientY: 10 });
      fireEvent.pointerMove(document, { clientX: 50, clientY: 10 });
    });
    await act(async () => {
      fireEvent.pointerUp(document, { clientX: 50, clientY: 10 });
    });

    expect(reorderSpy).toHaveBeenCalledWith('s3', 's1');
    expect(useTerminalStore.getState().sessions.map((s) => s.sessionId)).toEqual([
      's3',
      's1',
      's2',
    ]);
    expect(useTerminalStore.getState().activeSessionId).toBe('s3');
  });

  it('does not initiate a drag when clicking the close button (pointerDown stopped)', () => {
    addSession('s1', 'A');
    addSession('s2', 'B');
    useTerminalStore.getState().setActiveSession('s2');

    render(<TerminalTabBar />);

    const closeButtons = screen.getAllByLabelText('close');
    fireEvent.pointerDown(closeButtons[0], { clientX: 5, clientY: 5 });
    fireEvent.click(closeButtons[0]);

    const state = useTerminalStore.getState();
    expect(state.sessions.some((s) => s.sessionId === 's1')).toBe(false);
    expect(state.sessions.map((s) => s.sessionId)).toEqual(['s2']);
  });
});
