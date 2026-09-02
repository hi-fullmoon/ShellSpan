import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, act, within } from '@testing-library/react';
import { TerminalTabBar } from '../terminal-tab-bar';
import { useTerminalStore } from '@/stores/terminalStore';

vi.mock('@/lib/tauri', () => ({
  invokeCloseSession: vi.fn().mockResolvedValue(undefined),
  invokeArchiveAiSession: vi.fn().mockResolvedValue(undefined),
  invokeCancelAiRequest: vi.fn().mockResolvedValue(undefined),
  invokeListAgentRuntimeSessions: vi.fn().mockResolvedValue({
    sessions: [],
    nextCursor: null,
  }),
  invokeCancelAgentRuntime: vi.fn().mockResolvedValue(undefined),
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
    expect(tabs[1]).not.toHaveClass('shadow-md');
    // Tabs activate on pointerdown (browser-tab behavior), not click.
    fireEvent.pointerDown(tabs[1], { button: 0 });
    expect(useTerminalStore.getState().activeSessionId).toBe('s2');
  });

  it('renders a connection placeholder as a busy tab without tab actions', () => {
    useTerminalStore.getState().beginConnectionAttempt({
      title: 'Pending Server', host: 'h', port: 22, username: 'u',
    }, 'attempt-1');
    const onTabContextMenu = vi.fn();

    render(<TerminalTabBar onTabContextMenu={onTabContextMenu} />);

    const tab = screen.getByRole('tab', { name: /Pending Server/ });
    expect(tab).toHaveAttribute('aria-busy', 'true');
    expect(within(tab).getByRole('status', { name: 'Loading' })).toBeInTheDocument();
    expect(within(tab).queryByRole('button')).not.toBeInTheDocument();

    fireEvent.contextMenu(tab, { clientX: 10, clientY: 20 });
    expect(onTabContextMenu).not.toHaveBeenCalled();
  });

  it('activates a tab via pointerup fallback when its pointerdown was missed', () => {
    addSession('s1', 'A');
    addSession('s2', 'B');
    render(<TerminalTabBar />);

    const tabs = screen.getAllByRole('tab');
    // First tap lands on s1 and records the last pointerdown target.
    fireEvent.pointerDown(tabs[0], { button: 0 });
    expect(useTerminalStore.getState().activeSessionId).toBe('s1');

    // macOS tap-to-click can swallow the second tap's pointerdown entirely;
    // only its release reaches the tab. The fallback must still switch.
    fireEvent.pointerUp(tabs[1], { button: 0 });
    expect(useTerminalStore.getState().activeSessionId).toBe('s2');
  });

  it('does not activate a tab when a missed pointerdown releases on its close button', () => {
    addSession('s1', 'A');
    addSession('s2', 'B');
    render(<TerminalTabBar />);

    const tabs = screen.getAllByRole('tab');
    fireEvent.pointerDown(tabs[1], { button: 0 });
    expect(useTerminalStore.getState().activeSessionId).toBe('s2');

    // If WKWebView drops the pointerdown for this tap, only the release reaches
    // the close button. The fallback activation handler must leave the active
    // session alone so the button action does not also switch tabs.
    fireEvent.pointerUp(screen.getAllByLabelText('close')[0], { button: 0 });
    expect(useTerminalStore.getState().activeSessionId).toBe('s2');
  });

  it('does not activate on pointerup when the pointerdown landed on the same tab', () => {
    addSession('s1', 'A');
    addSession('s2', 'B');
    render(<TerminalTabBar />);

    const tabs = screen.getAllByRole('tab');
    fireEvent.pointerDown(tabs[0], { button: 0 });
    fireEvent.pointerUp(tabs[0], { button: 0 });

    // s1 activated on pointerdown; the matching pointerup is a no-op.
    expect(useTerminalStore.getState().activeSessionId).toBe('s1');
  });

  it('does not activate a tab when a reorder drag ends on it', () => {
    addSession('s1', 'A');
    addSession('s2', 'B');
    render(<TerminalTabBar />);

    document.body.classList.add('tab-dragging');
    try {
      const tabs = screen.getAllByRole('tab');
      fireEvent.pointerDown(tabs[0], { button: 0 });
      // A release that lands on another tab during a drag is a drop, not a
      // click: the active session must not switch.
      fireEvent.pointerUp(tabs[1], { button: 0 });
      expect(useTerminalStore.getState().activeSessionId).toBe('s1');
    } finally {
      document.body.classList.remove('tab-dragging');
    }
  });

  it('activates a tab on pointerup when the preceding pointerdown was outside any tab', () => {
    addSession('s1', 'A');
    render(<TerminalTabBar />);

    const outside = document.createElement('div');
    document.body.appendChild(outside);
    try {
      fireEvent.pointerDown(outside, { button: 0 });
      const tab = screen.getAllByRole('tab')[0];
      fireEvent.pointerUp(tab, { button: 0 });
      expect(useTerminalStore.getState().activeSessionId).toBe('s1');
    } finally {
      document.body.removeChild(outside);
    }
  });

  it('shows separators between every pair of tabs', () => {
    addSession('s1', 'A');
    addSession('s2', 'B');
    addSession('s3', 'C');
    addSession('s4', 'D');
    useTerminalStore.getState().setActiveSession('s2');

    render(<TerminalTabBar />);

    const tabs = screen.getAllByRole('tab');
    const firstSeparator = tabs[0].querySelector('[data-tab-separator]');
    expect(firstSeparator).toBeInTheDocument();
    expect(firstSeparator).toHaveClass('right-[-4px]');
    expect(firstSeparator).not.toHaveClass('translate-x-1/2');
    expect(tabs[1].querySelector('[data-tab-separator]')).toBeInTheDocument();
    expect(tabs[2].querySelector('[data-tab-separator]')).toBeInTheDocument();
    expect(tabs[3].querySelector('[data-tab-separator]')).not.toBeInTheDocument();
  });

  it('replaces the separator with an aligned insert indicator in the tab gap', () => {
    addSession('s1', 'A');
    addSession('s2', 'B');

    const { rerender } = render(<TerminalTabBar externalInsertIndex={1} />);

    let tabs = screen.getAllByRole('tab');
    const separator = tabs[0].querySelector('[data-tab-separator]');
    const gapIndicator = tabs[1].querySelector('[data-drop-indicator="left"]');
    expect(separator).not.toBeInTheDocument();
    expect(gapIndicator).toHaveClass('left-[-3.5px]', '-translate-x-1/2');

    rerender(<TerminalTabBar externalInsertIndex={0} />);
    tabs = screen.getAllByRole('tab');
    const leadingIndicator = tabs[0].querySelector('[data-drop-indicator="left"]');
    expect(leadingIndicator).toHaveClass('left-[-3.5px]', '-translate-x-1/2');
    expect(tabs[0].querySelector('[data-tab-separator]')).toHaveClass('right-[-4px]');

    rerender(<TerminalTabBar externalInsertIndex={2} />);
    tabs = screen.getAllByRole('tab');
    const trailingIndicator = tabs[1].querySelector('[data-drop-indicator="right"]');
    expect(trailingIndicator).toHaveClass('right-[-3.5px]', 'translate-x-1/2');

    rerender(<TerminalTabBar externalInsertIndex={null} />);
    expect(document.querySelector('[data-drop-indicator]')).not.toBeInTheDocument();
  });

  it('close button asks for confirmation before removing a session', () => {
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
    // Session is kept until the dialog is confirmed
    expect(useTerminalStore.getState().sessions.some((s) => s.sessionId === 's1')).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'common.close' }));
    const state = useTerminalStore.getState();
    expect(state.sessions.some((s) => s.sessionId === 's1')).toBe(false);
    expect(state.activeSessionId).toBe('s2');
  });

  it('keeps the session when the close confirmation is cancelled', () => {
    addSession('s1', 'A');
    render(<TerminalTabBar />);

    fireEvent.click(screen.getByLabelText('close'));
    fireEvent.click(screen.getByRole('button', { name: 'common.cancel' }));

    expect(useTerminalStore.getState().sessions.some((s) => s.sessionId === 's1')).toBe(true);
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

  it('fires onNewTabClick when empty tab bar space is double-clicked', () => {
    addSession('s1', 'A');
    const onNewTabClick = vi.fn();
    const { container } = render(<TerminalTabBar onNewTabClick={onNewTabClick} />);

    fireEvent.doubleClick(container.querySelector('[data-terminal-tab-bar]')!);
    expect(onNewTabClick).toHaveBeenCalledTimes(1);
  });

  it('uses inset rounded tabs with a bordered active state', () => {
    addSession('s1', 'A');
    addSession('s2', 'B');
    useTerminalStore.getState().setActiveSession('s1');
    const { container } = render(<TerminalTabBar />);

    expect(container.querySelector('[data-terminal-tab-bar]')).toHaveClass('h-10', 'bg-app-bg', 'px-1');
    expect(screen.getAllByRole('tab')[0]).toHaveClass('h-8', 'rounded-md', 'bg-app-tab-active', 'text-app-tab-accent');
    expect(screen.getAllByRole('tab')[1]).toHaveClass('bg-transparent', 'hover:bg-app-surface-muted');

    expect(screen.queryByRole('button', { name: 'terminal.newTab' })).not.toBeInTheDocument();
  });

  it('does not fire onNewTabClick when a tab itself is double-clicked', () => {
    addSession('s1', 'A');
    const onNewTabClick = vi.fn();
    render(<TerminalTabBar onNewTabClick={onNewTabClick} />);

    fireEvent.doubleClick(screen.getByRole('tab'));
    expect(onNewTabClick).not.toHaveBeenCalled();
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
        pointerType: 'mouse',
        clientX: 250,
        clientY: 10,
      });
      // The first move must clear the PointerSensor's 10px activation
      // distance, or the drag never starts and the drop is a no-op.
      fireEvent.pointerMove(document, { pointerType: 'mouse', buttons: 1, clientX: 262, clientY: 10 });
      fireEvent.pointerMove(document, { pointerType: 'mouse', buttons: 1, clientX: 50, clientY: 10 });
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

  it('hands a tab drop to the split target without reordering tabs', async () => {
    addSession('s1', 'A');
    addSession('s2', 'B');
    const onTabDragEnd = vi.fn().mockReturnValue(true);
    const reorderSpy = vi.spyOn(useTerminalStore.getState(), 'reorderSessions');

    render(<TerminalTabBar onTabDragEnd={onTabDragEnd} />);
    const tabs = screen.getAllByRole('tab');
    tabs[0].getBoundingClientRect = vi.fn(() => ({
      left: 0, right: 100, top: 0, bottom: 24, x: 0, y: 0,
      width: 100, height: 24, toJSON: () => ({}),
    }));
    tabs[1].getBoundingClientRect = vi.fn(() => ({
      left: 100, right: 200, top: 0, bottom: 24, x: 100, y: 0,
      width: 100, height: 24, toJSON: () => ({}),
    }));

    await act(async () => {
      fireEvent.pointerDown(tabs[0], {
        button: 0,
        isPrimary: true,
        pointerType: 'mouse',
        clientX: 50,
        clientY: 10,
      });
      fireEvent.pointerMove(document, { pointerType: 'mouse', buttons: 1, clientX: 60, clientY: 10 });
      fireEvent.pointerMove(document, { pointerType: 'mouse', buttons: 1, clientX: 60, clientY: 160 });
    });
    await act(async () => {
      fireEvent.pointerUp(document, { clientX: 60, clientY: 160 });
    });

    expect(onTabDragEnd).toHaveBeenCalled();
    expect(onTabDragEnd.mock.calls[0][0]).toBe('s1');
    expect(reorderSpy).not.toHaveBeenCalled();
  });

  it('keeps a pinned tab pinned when reordered within the pinned region', async () => {
    addSession('s1', 'A');
    addSession('s2', 'B');
    addSession('s3', 'C');
    useTerminalStore.getState().togglePin('s1');
    useTerminalStore.getState().togglePin('s2');

    render(<TerminalTabBar />);

    const tabs = screen.getAllByRole('tab');
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
      fireEvent.pointerDown(tabs[0], {
        button: 0,
        isPrimary: true,
        pointerType: 'mouse',
        clientX: 50,
        clientY: 10,
      });
      fireEvent.pointerMove(document, { pointerType: 'mouse', buttons: 1, clientX: 62, clientY: 10 });
      fireEvent.pointerMove(document, { pointerType: 'mouse', buttons: 1, clientX: 180, clientY: 10 });
    });
    await act(async () => {
      fireEvent.pointerUp(document, { clientX: 180, clientY: 10 });
    });

    const state = useTerminalStore.getState();
    expect(state.sessions.map((s) => s.sessionId)).toEqual(['s2', 's1', 's3']);
    expect(state.sessions.find((s) => s.sessionId === 's1')?.pinned).toBe(true);
  });

  it('unpins a pinned tab when dropped into the unpinned region', async () => {
    addSession('s1', 'A');
    addSession('s2', 'B');
    addSession('s3', 'C');
    useTerminalStore.getState().togglePin('s1');
    useTerminalStore.getState().togglePin('s2');

    render(<TerminalTabBar />);

    const tabs = screen.getAllByRole('tab');
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
      fireEvent.pointerDown(tabs[0], {
        button: 0,
        isPrimary: true,
        pointerType: 'mouse',
        clientX: 50,
        clientY: 10,
      });
      fireEvent.pointerMove(document, { pointerType: 'mouse', buttons: 1, clientX: 62, clientY: 10 });
      fireEvent.pointerMove(document, { pointerType: 'mouse', buttons: 1, clientX: 260, clientY: 10 });
    });
    await act(async () => {
      fireEvent.pointerUp(document, { clientX: 260, clientY: 10 });
    });

    const state = useTerminalStore.getState();
    expect(state.sessions.map((s) => s.sessionId)).toEqual(['s2', 's3', 's1']);
    expect(state.sessions.find((s) => s.sessionId === 's1')?.pinned).toBe(false);
    expect(state.sessions.find((s) => s.sessionId === 's2')?.pinned).toBe(true);
  });

  it('forces the default cursor via a body class while dragging', async () => {
    addSession('s1', 'A');
    addSession('s2', 'B');

    render(<TerminalTabBar />);
    const tabs = screen.getAllByRole('tab');
    tabs[0].getBoundingClientRect = vi.fn(() => ({
      left: 0, right: 100, top: 0, bottom: 24, x: 0, y: 0,
      width: 100, height: 24, toJSON: () => ({}),
    }));
    tabs[1].getBoundingClientRect = vi.fn(() => ({
      left: 100, right: 200, top: 0, bottom: 24, x: 100, y: 0,
      width: 100, height: 24, toJSON: () => ({}),
    }));

    expect(document.body.classList.contains('tab-dragging')).toBe(false);

    await act(async () => {
      fireEvent.pointerDown(tabs[0], {
        button: 0,
        isPrimary: true,
        pointerType: 'mouse',
        clientX: 50,
        clientY: 10,
      });
      fireEvent.pointerMove(document, { pointerType: 'mouse', buttons: 1, clientX: 62, clientY: 10 });
      fireEvent.pointerMove(document, { pointerType: 'mouse', buttons: 1, clientX: 150, clientY: 10 });
    });
    expect(document.body.classList.contains('tab-dragging')).toBe(true);
    const overlayTab = Array.from(document.querySelectorAll<HTMLElement>('[data-session-tab="s1"]'))
      .find((tab) => tab !== tabs[0]);
    expect(overlayTab?.parentElement?.style.transform)
      .toContain('translate3d(152px, 12px, 0)');

    await act(async () => {
      fireEvent.pointerUp(document, { pointerType: 'mouse', clientX: 150, clientY: 10 });
    });
    expect(document.body.classList.contains('tab-dragging')).toBe(false);
  });

  it('does not start a drag when a trackpad tap is followed by a buttonless move', async () => {
    addSession('s1', 'A');
    addSession('s2', 'B');
    useTerminalStore.getState().setActiveSession('s2');
    const reorderSpy = vi.spyOn(useTerminalStore.getState(), 'reorderSessions');

    render(<TerminalTabBar />);
    const tabs = screen.getAllByRole('tab');

    await act(async () => {
      // Tap-to-click: the pointerdown arrives, but WKWebView can drop the
      // pointerup. The next move reports no buttons held, so it must end the
      // pending interaction instead of starting a drag.
      fireEvent.pointerDown(tabs[0], {
        button: 0,
        isPrimary: true,
        pointerType: 'mouse',
        clientX: 50,
        clientY: 10,
      });
      fireEvent.pointerMove(document, { pointerType: 'mouse', buttons: 0, clientX: 150, clientY: 10 });
      fireEvent.pointerMove(document, { pointerType: 'mouse', buttons: 0, clientX: 250, clientY: 10 });
    });

    expect(reorderSpy).not.toHaveBeenCalled();
    // The tap still activates the tab via pointerdown.
    expect(useTerminalStore.getState().activeSessionId).toBe('s1');
    expect(useTerminalStore.getState().sessions.map((s) => s.sessionId)).toEqual(['s1', 's2']);
  });

  it('does not initiate a drag when clicking the close button (pointerDown stopped)', () => {
    addSession('s1', 'A');
    addSession('s2', 'B');
    useTerminalStore.getState().setActiveSession('s2');

    render(<TerminalTabBar />);

    const closeButtons = screen.getAllByLabelText('close');
    fireEvent.pointerDown(closeButtons[0], { clientX: 5, clientY: 5 });
    fireEvent.click(closeButtons[0]);
    fireEvent.click(screen.getByRole('button', { name: 'common.close' }));

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

  it('renders the session color as the background on the active tab', () => {
    addSession('s1', 'A');
    useTerminalStore.getState().setTabColor('s1', '#ef4444');
    useTerminalStore.getState().setActiveSession('s1');

    render(<TerminalTabBar />);

    const tab = screen.getByRole('tab');
    expect(tab.style.backgroundColor).toBe(
      'color-mix(in srgb, rgb(239, 68, 68) 25%, transparent)',
    );
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

  it('renders a rounded accent border on the active tab', () => {
    addSession('s1', 'A');
    useTerminalStore.getState().setActiveSession('s1');

    render(<TerminalTabBar />);

    const indicator = screen.getByRole('tab').querySelector<HTMLElement>('[data-active-tab-indicator]');
    expect(indicator).not.toBeNull();
    expect(indicator).toHaveClass('inset-0', 'rounded-md', 'border-app-tab-accent');
    expect(indicator?.style.borderColor).toBe('');
  });

  it('uses the session color for the active border when set', () => {
    addSession('s1', 'A');
    useTerminalStore.getState().setTabColor('s1', '#ef4444');
    useTerminalStore.getState().setActiveSession('s1');

    render(<TerminalTabBar />);

    const indicator = screen.getByRole('tab').querySelector<HTMLElement>('[data-active-tab-indicator]');
    expect(indicator).not.toBeNull();
    expect(indicator?.style.borderColor).toBe('rgb(239, 68, 68)');
  });

  it('does not render the accent border on inactive tabs', () => {
    addSession('s1', 'A');
    addSession('s2', 'B');
    useTerminalStore.getState().setActiveSession('s2');

    render(<TerminalTabBar />);

    expect(screen.getAllByRole('tab')[0].querySelector('[data-active-tab-indicator]')).toBeNull();
  });
});
