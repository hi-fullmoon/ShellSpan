import { describe, expect, it, beforeEach, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TerminalPane } from '../terminal-pane';
import { terminalRegistry } from '@/components/terminal/registry/terminal-registry';
import type { TerminalSession as TerminalSessionState } from '@/stores/terminalStore';
import { useAppStore } from '@/stores/appStore';

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
  useAppStore.setState({
    terminalCopyOnSelect: true,
    terminalMultiLinePasteWarning: true,
    terminalLargePasteWarning: true,
    terminalTrimTrailingWhitespace: true,
    terminalRightClickBehavior: 'paste',
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

  it('renders without an active session', () => {
    const { container } = render(<TerminalPane activeSession={null} />);
    expect(screen.queryByRole('button', { name: 'terminal.tab.search' })).not.toBeInTheDocument();
    expect(container.querySelector('div.h-full.w-full.p-0')).toBeInTheDocument();
  });

  it('copies selected text when the selection changes', async () => {
    const terminal = makeMockTerminal('selected text');
    render(<TerminalPane activeSession={makeSession()} />);

    terminal.getSelectionChangeHandlers()[0]?.();

    await vi.waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith('selected text');
    });
  });

  it('trims trailing whitespace from copied lines', async () => {
    const terminal = makeMockTerminal('first  \nsecond\t');
    render(<TerminalPane activeSession={makeSession()} />);

    terminal.getSelectionChangeHandlers()[0]?.();

    await vi.waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith('first\nsecond');
    });
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
});
