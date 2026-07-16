import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { TerminalTabBar } from '../terminal-tab-bar';
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

  it('does not render the + button when there are no sessions', () => {
    const onNewTabClick = vi.fn();
    render(<TerminalTabBar onNewTabClick={onNewTabClick} />);

    expect(screen.queryByTitle('terminal.newTab')).not.toBeInTheDocument();
  });

  it('starts renaming on double-click and commits on Enter', () => {
    addSession('s1', 'A');
    const updateTitleSpy = vi.spyOn(
      useTerminalStore.getState(),
      'updateTitle',
    );

    render(<TerminalTabBar />);

    const tab = screen.getByRole('tab');
    fireEvent.doubleClick(tab);

    const input = screen.getByDisplayValue('A');
    expect(input).toBeInTheDocument();
    expect(input).toHaveClass('p-0', 'leading-none');

    fireEvent.change(input, { target: { value: 'Renamed' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(updateTitleSpy).toHaveBeenCalledWith('s1', 'Renamed');
    expect(screen.queryByDisplayValue('Renamed')).not.toBeInTheDocument();
  });

  it('cancels renaming on Escape', () => {
    addSession('s1', 'A');
    const updateTitleSpy = vi.spyOn(
      useTerminalStore.getState(),
      'updateTitle',
    );

    render(<TerminalTabBar />);

    const tab = screen.getByRole('tab');
    fireEvent.doubleClick(tab);

    const input = screen.getByDisplayValue('A');
    fireEvent.change(input, { target: { value: 'Renamed' } });
    fireEvent.keyDown(input, { key: 'Escape' });

    expect(updateTitleSpy).not.toHaveBeenCalled();
    expect(screen.queryByDisplayValue('Renamed')).not.toBeInTheDocument();
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

    expect(reorderSpy).toHaveBeenCalledWith('s3', 0);
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

  it('shows a pin icon for pinned tabs and toggles pin on click', () => {
    addSession('s1', 'A');
    useTerminalStore.getState().togglePin('s1');

    const togglePinSpy = vi.spyOn(
      useTerminalStore.getState(),
      'togglePin',
    );

    render(<TerminalTabBar />);

    const pinButton = screen.getByLabelText('unpin');
    expect(pinButton).toBeInTheDocument();
    expect(pinButton.querySelector('svg')).toHaveClass('size-3');

    fireEvent.click(pinButton);
    expect(togglePinSpy).toHaveBeenCalledWith('s1');
  });

  it('shows a close button for unpinned tabs', () => {
    addSession('s1', 'A');

    render(<TerminalTabBar />);

    expect(screen.getByLabelText('close')).toBeInTheDocument();
    expect(screen.queryByLabelText('unpin')).not.toBeInTheDocument();
  });

  it('renders a colored bottom border on the active tab when the session has a color', () => {
    addSession('s1', 'A');
    useTerminalStore.getState().setTabColor('s1', '#ef4444');
    useTerminalStore.getState().setActiveSession('s1');

    render(<TerminalTabBar />);

    const tab = screen.getByRole('tab');
    expect(tab).not.toHaveStyle({ borderLeftColor: '#ef4444' });
    expect(tab.style.backgroundColor).toBe(
      'color-mix(in srgb, rgb(239, 68, 68) 15%, transparent)',
    );

    const indicator = screen.getByTestId('tab-active-indicator');
    expect(indicator).toHaveStyle({ backgroundColor: '#ef4444' });
  });

  it('renders the session color as the background on an inactive tab', () => {
    addSession('s1', 'A');
    addSession('s2', 'B');
    useTerminalStore.getState().setTabColor('s1', '#ef4444');
    useTerminalStore.getState().setActiveSession('s2');

    render(<TerminalTabBar />);

    expect(screen.getAllByRole('tab')[0].style.backgroundColor).toBe(
      'color-mix(in srgb, rgb(239, 68, 68) 8%, transparent)',
    );
  });
});
