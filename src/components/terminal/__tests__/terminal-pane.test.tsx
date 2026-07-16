import { describe, expect, it, beforeEach, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TerminalPane } from '../terminal-pane';
import { terminalRegistry } from '@/components/terminal/registry/terminal-registry';
import type { TerminalSession as TerminalSessionState } from '@/stores/terminalStore';

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
  const terminal = {
    getSelection: vi.fn().mockReturnValue(selection),
    selectAll: vi.fn(),
    clear: vi.fn(),
    write: vi.fn(),
    element: document.createElement('div'),
    onSelectionChange: vi.fn().mockReturnValue({ dispose: vi.fn() }),
    attachCustomKeyEventHandler: vi.fn((handler) => {
      handlers.push(handler);
    }),
    getCustomKeyEventHandlers: () => handlers,
  } as unknown as import('@xterm/xterm').Terminal & {
    getCustomKeyEventHandlers: () => Array<(event: KeyboardEvent) => boolean>;
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
    fireEvent.keyDown(document, { key: 'f', ctrlKey: true });
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

  it('renders without an active session', () => {
    const { container } = render(<TerminalPane activeSession={null} />);
    expect(screen.queryByRole('button', { name: 'terminal.tab.search' })).not.toBeInTheDocument();
    expect(container.querySelector('div.h-full.w-full.p-0')).toBeInTheDocument();
  });

  it('does not copy on selection change', () => {
    makeMockTerminal('selected text');
    render(<TerminalPane activeSession={makeSession()} />);

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
