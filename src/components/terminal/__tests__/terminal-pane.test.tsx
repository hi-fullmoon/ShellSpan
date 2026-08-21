import { describe, expect, it, beforeEach, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { COPY_ON_SELECT_DEBOUNCE_MS, TerminalPane } from '../terminal-pane';
import { resetTerminalLeader } from '../terminal-leader';
import { terminalRegistry } from '@/components/terminal/registry/terminal-registry';
import type { TerminalSession as TerminalSessionState } from '@/stores/terminalStore';
import { DEFAULT_SHORTCUTS, useAppStore } from '@/stores/appStore';

vi.mock('@/hooks/useI18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
    ready: true,
    locale: 'en-US',
    setLocale: () => {},
  }),
}));

vi.mock('@/hooks/useToast', () => ({
  useToast: () => ({
    success: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('@/components/terminal/registry/terminal-registry', () => ({
  terminalRegistry: {
    get: vi.fn(),
    create: vi.fn(),
    dispose: vi.fn(),
    disposeAll: vi.fn(),
    subscribe: vi.fn(() => () => {}),
  },
}));

function makeSession(
  overrides: Partial<TerminalSessionState> = {},
): TerminalSessionState {
  return {
    sessionId: 's1',
    title: 'session',
    host: 'h',
    port: 22,
    username: 'u',
    status: 'connected',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetTerminalLeader();
  useAppStore.setState({
    terminalCopyOnSelect: true,
    terminalMultiLinePasteWarning: true,
    terminalLargePasteWarning: true,
    terminalTrimTrailingWhitespace: true,
    terminalRightClickBehavior: 'paste',
    shortcuts: { ...DEFAULT_SHORTCUTS },
  });
  (terminalRegistry.get as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
  Object.assign(navigator, {
    clipboard: {
      writeText: vi.fn().mockResolvedValue(undefined),
      readText: vi.fn().mockResolvedValue(''),
    },
  });
});

function makeMockTerminal(selection = '') {
  const handlers: Array<(event: KeyboardEvent) => boolean> = [];
  const selectionHandlers: Array<() => void> = [];
  const terminal = {
    getSelection: vi.fn().mockReturnValue(selection),
    hasSelection: vi.fn().mockReturnValue(Boolean(selection)),
    clearSelection: vi.fn(),
    selectAll: vi.fn(),
    clear: vi.fn(),
    write: vi.fn(),
    paste: vi.fn(),
    element: document.createElement('div'),
    onSelectionChange: vi.fn((handler: () => void) => {
      selectionHandlers.push(handler);
      return { dispose: vi.fn() };
    }),
    attachCustomKeyEventHandler: vi.fn((handler) => {
      handlers.push(handler);
    }),
    getCustomKeyEventHandlers: () => handlers,
    getSelectionChangeHandlers: () => selectionHandlers,
  } as unknown as import('@xterm/xterm').Terminal & {
    getCustomKeyEventHandlers: () => Array<(event: KeyboardEvent) => boolean>;
    getSelectionChangeHandlers: () => Array<() => void>;
  };

  const controller = {
    terminal,
    searchAddon: {
      findNext: vi.fn(),
      findPrevious: vi.fn(),
      clearDecorations: vi.fn(),
    },
    attach: vi.fn(),
    detach: vi.fn(),
    focus: vi.fn(),
  };

  Object.assign(terminal, { __controller: controller });
  (terminalRegistry.get as ReturnType<typeof vi.fn>).mockReturnValue(controller);
  return terminal;
}

describe('TerminalPane', () => {
  it('renders the pane host without a search toggle button', () => {
    const { container } = render(<TerminalPane activeSession={makeSession()} />);
    expect(screen.queryByRole('button', { name: 'terminal.tab.search' })).not.toBeInTheDocument();
    expect(container.querySelector('div.h-full.w-full.p-0')).toBeInTheDocument();
  });

  it('opens the search bar via the keyboard shortcut and closes it', async () => {
    render(<TerminalPane activeSession={makeSession()} />);
    expect(screen.queryByPlaceholderText('terminal.search.placeholder')).toBeNull();
    act(() => document.dispatchEvent(new Event('termbridge:find-terminal')));
    const searchInput = screen.getByPlaceholderText('terminal.search.placeholder');
    expect(searchInput).toBeInTheDocument();
    expect(searchInput.parentElement).toHaveClass('border-t-0');
    await userEvent.click(screen.getByRole('button', { name: 'terminal.search.close' }));
    expect(screen.queryByPlaceholderText('terminal.search.placeholder')).toBeNull();
  });

  it('shows the connecting overlay when status is connecting', () => {
    render(<TerminalPane activeSession={makeSession({ status: 'connecting' })} />);
    const overlay = document.querySelector('div.absolute.inset-0.z-10');
    expect(overlay).not.toBeNull();
    expect(overlay).toHaveClass('bg-app-surface');
    expect(overlay?.querySelector('span')?.textContent ?? '').toMatch(/\.\.\.$/);
    expect(overlay?.querySelector('svg.animate-spin')).not.toBeNull();
  });

  it('hides the connecting overlay when status is not connecting', () => {
    render(<TerminalPane activeSession={makeSession({ status: 'connected' })} />);
    expect(document.querySelector('div.absolute.inset-0.z-10')).toBeNull();
  });

  it('keeps the connecting overlay for at least 600ms after a fast connect', () => {
    vi.useFakeTimers();
    try {
      const { rerender } = render(
        <TerminalPane activeSession={makeSession({ status: 'connecting' })} />,
      );
      expect(document.querySelector('div.absolute.inset-0.z-10')).not.toBeNull();

      rerender(<TerminalPane activeSession={makeSession({ status: 'connected' })} />);
      expect(document.querySelector('div.absolute.inset-0.z-10')).not.toBeNull();

      act(() => vi.advanceTimersByTime(600));
      expect(document.querySelector('div.absolute.inset-0.z-10')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('hides the connecting overlay immediately when the connection fails', () => {
    const { rerender } = render(
      <TerminalPane activeSession={makeSession({ status: 'connecting' })} />,
    );
    expect(document.querySelector('div.absolute.inset-0.z-10')).not.toBeNull();

    rerender(<TerminalPane activeSession={makeSession({ status: 'error' })} />);
    expect(document.querySelector('div.absolute.inset-0.z-10')).toBeNull();
  });

  it('shows reconnecting dots over the terminal without the loading spinner', () => {
    render(
      <TerminalPane
        activeSession={makeSession({ status: 'connecting', reconnecting: true })}
      />,
    );

    const indicator = screen.getByRole('status', {
      name: 'terminal.notice.reconnectingLabel',
    });
    expect(indicator).toHaveTextContent('terminal.notice.reconnectingLabel...');
    expect(indicator.querySelectorAll('.animate-pulse')).toHaveLength(3);
    expect(document.querySelector('svg.animate-spin')).toBeNull();
  });

  it('pastes clipboard text on right click', async () => {
    vi.mocked(navigator.clipboard.readText).mockResolvedValue('pasted text');
    const terminal = makeMockTerminal();
    render(<TerminalPane activeSession={makeSession()} />);
    const event = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
    });

    terminal.element?.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    await vi.waitFor(() => {
      expect(terminal.paste).toHaveBeenCalledWith('pasted text');
    });
  });

  it('confirms before pasting multiple lines', async () => {
    vi.mocked(navigator.clipboard.readText).mockResolvedValue('echo one\necho two');
    const terminal = makeMockTerminal();
    render(<TerminalPane activeSession={makeSession()} />);

    terminal.element?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));

    expect(await screen.findByText('terminal.pasteWarning.title')).toBeInTheDocument();
    expect(terminal.paste).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'terminal.pasteWarning.confirm' }));
    expect(terminal.paste).toHaveBeenCalledWith('echo one\necho two');
  });

  it('confirms a pending paste into the session where it started', async () => {
    vi.mocked(navigator.clipboard.readText).mockResolvedValue('echo one\necho two');
    const firstTerminal = makeMockTerminal();
    const firstController = (firstTerminal as typeof firstTerminal & { __controller: unknown }).__controller;
    const { rerender } = render(<TerminalPane activeSession={makeSession({ sessionId: 's1' })} />);

    firstTerminal.element?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    expect(await screen.findByText('terminal.pasteWarning.title')).toBeInTheDocument();

    const secondTerminal = makeMockTerminal();
    const secondController = (secondTerminal as typeof secondTerminal & { __controller: unknown }).__controller;
    (terminalRegistry.get as ReturnType<typeof vi.fn>).mockImplementation((sessionId: string) => (
      sessionId === 's1' ? firstController : secondController
    ));
    rerender(<TerminalPane activeSession={makeSession({ sessionId: 's2' })} />);

    await userEvent.click(screen.getByRole('button', { name: 'terminal.pasteWarning.confirm' }));

    expect(firstTerminal.paste).toHaveBeenCalledWith('echo one\necho two');
    expect(secondTerminal.paste).not.toHaveBeenCalled();
  });

  it('renders without an active session', () => {
    const { container } = render(<TerminalPane activeSession={null} />);
    expect(screen.queryByRole('button', { name: 'terminal.tab.search' })).not.toBeInTheDocument();
    expect(container.querySelector('div.h-full.w-full.p-0')).toBeInTheDocument();
  });

  it('copies selected text once the selection settles', () => {
    vi.useFakeTimers();
    try {
      const terminal = makeMockTerminal('selected text');
      render(<TerminalPane activeSession={makeSession()} />);

      terminal.getSelectionChangeHandlers()[0]?.();
      expect(navigator.clipboard.writeText).not.toHaveBeenCalled();

      act(() => {
        vi.advanceTimersByTime(COPY_ON_SELECT_DEBOUNCE_MS);
      });

      expect(navigator.clipboard.writeText).toHaveBeenCalledWith('selected text');
    } finally {
      vi.useRealTimers();
    }
  });

  it('trims trailing whitespace from copied lines', () => {
    vi.useFakeTimers();
    try {
      const terminal = makeMockTerminal('first  \nsecond\t');
      render(<TerminalPane activeSession={makeSession()} />);

      terminal.getSelectionChangeHandlers()[0]?.();
      act(() => {
        vi.advanceTimersByTime(COPY_ON_SELECT_DEBOUNCE_MS);
      });

      expect(navigator.clipboard.writeText).toHaveBeenCalledWith('first\nsecond');
    } finally {
      vi.useRealTimers();
    }
  });

  it('copies a selection on right click in copy-or-paste mode', async () => {
    useAppStore.setState({ terminalRightClickBehavior: 'copyPaste' });
    const terminal = makeMockTerminal('selected');
    render(<TerminalPane activeSession={makeSession()} />);

    terminal.element?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));

    await vi.waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith('selected');
    });
    expect(navigator.clipboard.readText).not.toHaveBeenCalled();
    expect(terminal.paste).not.toHaveBeenCalled();
  });

  it('does not copy selected text when copy on select is disabled', () => {
    useAppStore.setState({ terminalCopyOnSelect: false });
    const terminal = makeMockTerminal('selected text');
    render(<TerminalPane activeSession={makeSession()} />);

    terminal.getSelectionChangeHandlers()[0]?.();

    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
  });

  it('swallows sub-threshold mousemove so a tap-and-slide cannot extend the selection', () => {
    const terminal = makeMockTerminal();
    render(<TerminalPane activeSession={makeSession()} />);

    const downstream = vi.fn();
    document.addEventListener('mousemove', downstream);

    // macOS "tap to click": a light tap is a mousedown, and sliding slightly
    // while the finger is down is a held-button drag. A 6px drift must not
    // reach xterm's selection handler (registered on document after ours).
    terminal.element?.dispatchEvent(
      new MouseEvent('mousedown', { button: 0, buttons: 1, clientX: 100, clientY: 100, bubbles: true }),
    );
    document.dispatchEvent(
      new MouseEvent('mousemove', { button: 0, buttons: 1, clientX: 106, clientY: 100, bubbles: true }),
    );

    expect(downstream).not.toHaveBeenCalled();
    document.removeEventListener('mousemove', downstream);
  });

  it('clears a transient selection when a trackpad-like tap drift ends', () => {
    const terminal = makeMockTerminal();
    vi.mocked(terminal.hasSelection).mockReturnValue(true);
    render(<TerminalPane activeSession={makeSession()} />);

    terminal.element?.dispatchEvent(
      new MouseEvent('mousedown', { button: 0, buttons: 1, clientX: 100, clientY: 100, bubbles: true }),
    );
    document.dispatchEvent(
      new MouseEvent('mousemove', { button: 0, buttons: 1, clientX: 106, clientY: 100, bubbles: true }),
    );
    document.dispatchEvent(new MouseEvent('mouseup', { button: 0, buttons: 0, bubbles: true }));

    expect(terminal.clearSelection).toHaveBeenCalledTimes(1);
  });

  it('lets the selection extend once a drag crosses the threshold', () => {
    const terminal = makeMockTerminal();
    render(<TerminalPane activeSession={makeSession()} />);

    const downstream = vi.fn();
    document.addEventListener('mousemove', downstream);

    terminal.element?.dispatchEvent(
      new MouseEvent('mousedown', { button: 0, buttons: 1, clientX: 100, clientY: 100, bubbles: true }),
    );
    document.dispatchEvent(
      new MouseEvent('mousemove', { button: 0, buttons: 1, clientX: 110, clientY: 100, bubbles: true }),
    );

    expect(downstream).toHaveBeenCalledTimes(1);
    document.removeEventListener('mousemove', downstream);
  });

  it('does not suppress mousemove after the button was released outside the window', () => {
    const terminal = makeMockTerminal();
    render(<TerminalPane activeSession={makeSession()} />);

    const downstream = vi.fn();
    document.addEventListener('mousemove', downstream);

    terminal.element?.dispatchEvent(
      new MouseEvent('mousedown', { button: 0, buttons: 1, clientX: 100, clientY: 100, bubbles: true }),
    );
    // No mouseup was delivered (released outside), so buttons is 0 on the next
    // move and the stale drag state must self-heal instead of swallowing moves.
    document.dispatchEvent(
      new MouseEvent('mousemove', { button: 0, buttons: 0, clientX: 101, clientY: 100, bubbles: true }),
    );

    expect(downstream).toHaveBeenCalledTimes(1);
    document.removeEventListener('mousemove', downstream);
  });

  it('copies selection via keyboard shortcut on macOS', async () => {
    vi.stubGlobal('navigator', { ...navigator, platform: 'MacIntel' });
    const terminal = makeMockTerminal('selected text');
    render(<TerminalPane activeSession={makeSession()} />);

    const handler = terminal.getCustomKeyEventHandlers()[0];
    const event = new KeyboardEvent('keydown', {
      key: 'c',
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    const preventDefault = vi.spyOn(event, 'preventDefault');

    const result = handler(event);

    expect(result).toBe(false);
    expect(preventDefault).toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith('selected text');
    });

    vi.unstubAllGlobals();
  });

  it('copies selection via keyboard shortcut on Linux/Windows', async () => {
    vi.stubGlobal('navigator', { ...navigator, platform: 'Linux x86_64' });
    const terminal = makeMockTerminal('selected text');
    render(<TerminalPane activeSession={makeSession()} />);

    const handler = terminal.getCustomKeyEventHandlers()[0];
    const event = new KeyboardEvent('keydown', {
      key: 'C',
      ctrlKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    const preventDefault = vi.spyOn(event, 'preventDefault');

    const result = handler(event);

    expect(result).toBe(false);
    expect(preventDefault).toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith('selected text');
    });

    vi.unstubAllGlobals();
  });

  it('does not intercept copy shortcut when no text is selected', () => {
    vi.stubGlobal('navigator', { ...navigator, platform: 'MacIntel' });
    const terminal = makeMockTerminal('');
    render(<TerminalPane activeSession={makeSession()} />);

    const handler = terminal.getCustomKeyEventHandlers()[0];
    const event = new KeyboardEvent('keydown', {
      key: 'c',
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    const preventDefault = vi.spyOn(event, 'preventDefault');

    const result = handler(event);

    expect(result).toBe(true);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });

  it('consumes the leader chord and lets the leader engine dispatch commands', () => {
    const terminal = makeMockTerminal();
    render(<TerminalPane activeSession={makeSession()} />);
    const handler = terminal.getCustomKeyEventHandlers()[0];

    const navigate = vi.fn();
    document.addEventListener('termbridge:navigate-terminal-pane', navigate);

    const leader = new KeyboardEvent('keydown', {
      key: 'b',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    const leaderStop = vi.spyOn(leader, 'stopPropagation');
    expect(handler(leader)).toBe(false);
    expect(leader.defaultPrevented).toBe(true);
    expect(leaderStop).toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();

    const command = new KeyboardEvent('keydown', {
      key: 'h',
      bubbles: true,
      cancelable: true,
    });
    expect(handler(command)).toBe(false);
    expect(navigate).toHaveBeenCalledTimes(1);
    expect((navigate.mock.calls[0][0] as CustomEvent).detail.direction).toBe('left');

    document.removeEventListener('termbridge:navigate-terminal-pane', navigate);
  });

  it('passes through keys that are not part of a leader chord', () => {
    const terminal = makeMockTerminal();
    render(<TerminalPane activeSession={makeSession()} />);
    const handler = terminal.getCustomKeyEventHandlers()[0];

    // Bare control characters keep reaching the pty (e.g. Ctrl+L clears).
    expect(handler(new KeyboardEvent('keydown', { key: 'l', ctrlKey: true }))).toBe(true);
    expect(handler(new KeyboardEvent('keydown', { key: 'h', ctrlKey: true }))).toBe(true);
    expect(handler(new KeyboardEvent('keydown', { key: 'h' }))).toBe(true);
  });

  it('opens search via the configurable find binding', () => {
    useAppStore.getState().setShortcut('findTerminal', 'ctrl+shift+f');
    const terminal = makeMockTerminal();
    render(<TerminalPane activeSession={makeSession()} />);
    const handler = terminal.getCustomKeyEventHandlers()[0];

    // The old default no longer triggers search at the pane level.
    expect(handler(new KeyboardEvent('keydown', { key: 'f', metaKey: true }))).toBe(true);
    expect(screen.queryByPlaceholderText('terminal.search.placeholder')).toBeNull();

    const event = new KeyboardEvent('keydown', {
      key: 'f',
      ctrlKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    let result: boolean | undefined;
    act(() => {
      result = handler(event);
    });
    expect(result).toBe(false);
    expect(event.defaultPrevented).toBe(true);
    expect(screen.getByPlaceholderText('terminal.search.placeholder')).toBeInTheDocument();
  });
});
