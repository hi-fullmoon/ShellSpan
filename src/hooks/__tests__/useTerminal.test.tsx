// @vitest-environment jsdom

import { useEffect, useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { waitFor } from '@testing-library/react';
import { render } from '../../test-utils';
import { useTerminal, type UseTerminalOptions } from '../useTerminal';

const mockState = vi.hoisted(() => {
  const state: {
    keyEventHandler: ((event: KeyboardEvent) => boolean) | undefined;
    terminalInstances: Array<{
      options: Record<string, unknown> & { disableStdin?: boolean };
      writes: string[];
      writeCalls: string[];
      selection: string;
      onDataHandler?: (data: string) => void;
      onSelectionChangeHandler?: () => void;
    }>;
  } = {
    keyEventHandler: undefined,
    terminalInstances: [],
  };
  return state;
});

const { MockTerminal, MockFitAddon, MockSearchAddon } = vi.hoisted(() => {
  class MockSearchAddon {
    decorationsCleared = 0;
    findNextCalls: Array<{ term: string; options?: Record<string, unknown> }> = [];
    findPreviousCalls: Array<{ term: string; options?: Record<string, unknown> }> = [];
    clearDecorations() {
      this.decorationsCleared++;
    }
    findNext(term: string, options?: Record<string, unknown>) {
      this.findNextCalls.push({ term, options });
    }
    findPrevious(term: string, options?: Record<string, unknown>) {
      this.findPreviousCalls.push({ term, options });
    }
  }

  class MockFitAddon {
    fitCalls = 0;
    fit() {
      this.fitCalls++;
    }
  }

  class MockTerminal {
    options: Record<string, unknown> & { disableStdin?: boolean };
    writes: string[];
    writeCalls: string[];
    selection: string;
    onDataHandler?: (data: string) => void;
    onSelectionChangeHandler?: () => void;
    element?: HTMLDivElement;
    cols = 120;
    rows = 32;

    constructor(options: Record<string, unknown> & { disableStdin?: boolean }) {
      this.options = { ...options };
      this.writes = [];
      this.writeCalls = [];
      this.selection = '';
      this.element = document.createElement('div');
      mockState.terminalInstances.push(this);
    }

    loadAddon() {}

    open() {}

    attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean) {
      mockState.keyEventHandler = handler;
    }

    write(message: string) {
      this.writeCalls.push(message);
    }

    writeln(message: string) {
      this.writes.push(message);
    }

    focus() {}

    onData(handler: (data: string) => void) {
      this.onDataHandler = handler;
      return { dispose: () => {} };
    }

    onSelectionChange(handler: () => void) {
      this.onSelectionChangeHandler = handler;
      return { dispose: () => {} };
    }

    getSelection() {
      return this.selection;
    }

    selectAll() {}

    clear() {}

    dispose() {}

    refresh() {}
  }

  return { MockTerminal, MockFitAddon, MockSearchAddon };
});

vi.mock('@xterm/xterm', () => ({
  Terminal: MockTerminal,
}));

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: MockFitAddon,
}));

vi.mock('@xterm/addon-search', () => ({
  SearchAddon: MockSearchAddon,
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

vi.mock('../../lib/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('../../lib/tauri', () => ({
  isTauriRuntime: () => false,
}));

function TestHarness({
  props,
  onTerminal,
}: {
  props: UseTerminalOptions;
  onTerminal?: (terminal: (typeof mockState.terminalInstances)[number]) => void;
}) {
  const { shellRef } = useTerminal(props);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const terminal = mockState.terminalInstances[mockState.terminalInstances.length - 1];
    if (terminal) {
      onTerminal?.(terminal);
      setReady(true);
    }
  }, [onTerminal]);

  return <div ref={shellRef} data-ready={ready} data-testid="terminal-shell" />;
}

describe('useTerminal', () => {
  beforeEach(() => {
    mockState.terminalInstances.length = 0;
    mockState.keyEventHandler = undefined;
    vi.clearAllMocks();
    document.documentElement.dataset.theme = 'dark';
    globalThis.ResizeObserver = class {
      observe() {}
      disconnect() {}
      unobserve() {}
    } as typeof ResizeObserver;
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    });
  });

  const defaultProps = (): UseTerminalOptions => ({
    sessionId: 'session-1',
    status: 'disconnected',
    active: true,
    fontSize: 14,
    lineHeight: 1.25,
    terminalTheme: 'default',
    cursorStyle: 'block',
    cursorBlink: true,
    copyOnSelect: false,
    onOpenSearch: vi.fn(),
    onCloseSearch: vi.fn(),
    onCopyFeedback: vi.fn(),
  });

  it('creates a terminal with the provided options', async () => {
    render(<TestHarness props={defaultProps()} />);

    await waitFor(() => {
      expect(mockState.terminalInstances).toHaveLength(1);
    });

    expect(mockState.terminalInstances[0]?.options).toMatchObject({
      fontSize: 14,
      lineHeight: 1.25,
      cursorBlink: true,
      disableStdin: false,
    });
  });

  it('updates terminal options when preferences change', async () => {
    const { rerender } = render(<TestHarness props={defaultProps()} />);

    await waitFor(() => {
      expect(mockState.terminalInstances).toHaveLength(1);
    });

    const terminal = mockState.terminalInstances[0];
    expect(terminal?.options.fontSize).toBe(14);

    rerender(
      <TestHarness
        props={{
          ...defaultProps(),
          fontSize: 16,
          lineHeight: 1.5,
          terminalTheme: 'dracula',
          cursorStyle: 'line',
          cursorBlink: false,
        }}
      />,
    );

    await waitFor(() => {
      expect(terminal?.options.fontSize).toBe(16);
      expect(terminal?.options.lineHeight).toBe(1.5);
      expect(terminal?.options.cursorBlink).toBe(false);
    });
  });

  it('updates disableStdin when session status changes', async () => {
    const { rerender } = render(<TestHarness props={{ ...defaultProps(), status: 'connected' }} />);

    await waitFor(() => {
      expect(mockState.terminalInstances).toHaveLength(1);
    });

    const terminal = mockState.terminalInstances[0];
    expect(terminal?.options.disableStdin).toBe(false);

    rerender(<TestHarness props={{ ...defaultProps(), status: 'connecting' }} />);

    await waitFor(() => {
      expect(terminal?.options.disableStdin).toBe(true);
    });
  });

  it('copies selection to clipboard when copyOnSelect is enabled', async () => {
    const onCopyFeedback = vi.fn();
    render(<TestHarness props={{ ...defaultProps(), copyOnSelect: true, onCopyFeedback }} />);

    await waitFor(() => {
      expect(mockState.terminalInstances).toHaveLength(1);
    });

    const terminal = mockState.terminalInstances[0];
    terminal!.selection = 'selected-text';
    terminal?.onSelectionChangeHandler?.();

    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith('selected-text');
    });
    expect(onCopyFeedback).toHaveBeenCalledWith('copied');
  });

  it('does not copy selection when copyOnSelect is disabled', async () => {
    render(<TestHarness props={defaultProps()} />);

    await waitFor(() => {
      expect(mockState.terminalInstances).toHaveLength(1);
    });

    const terminal = mockState.terminalInstances[0];
    terminal!.selection = 'selected-text';
    terminal?.onSelectionChangeHandler?.();

    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
  });

  it('opens search on Ctrl+F and prevents xterm default', async () => {
    const onOpenSearch = vi.fn();
    render(<TestHarness props={{ ...defaultProps(), onOpenSearch }} />);

    await waitFor(() => {
      expect(mockState.keyEventHandler).toBeTypeOf('function');
    });

    const event = new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true });
    const prevented = !mockState.keyEventHandler?.(event);

    expect(onOpenSearch).toHaveBeenCalledTimes(1);
    expect(prevented).toBe(true);
  });

  it('closes search on Escape and prevents xterm default', async () => {
    const onCloseSearch = vi.fn();
    render(<TestHarness props={{ ...defaultProps(), onCloseSearch }} />);

    await waitFor(() => {
      expect(mockState.keyEventHandler).toBeTypeOf('function');
    });

    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true });
    const prevented = !mockState.keyEventHandler?.(event);

    expect(onCloseSearch).toHaveBeenCalledTimes(1);
    expect(prevented).toBe(true);
  });

  it('ignores keyboard events when inactive', async () => {
    const onOpenSearch = vi.fn();
    render(<TestHarness props={{ ...defaultProps(), active: false, onOpenSearch }} />);

    await waitFor(() => {
      expect(mockState.keyEventHandler).toBeTypeOf('function');
    });

    const event = new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true });
    const prevented = !mockState.keyEventHandler?.(event);

    expect(onOpenSearch).not.toHaveBeenCalled();
    expect(prevented).toBe(false);
  });

  it('applies the light theme when document theme is light', async () => {
    document.documentElement.dataset.theme = 'light';

    render(<TestHarness props={defaultProps()} />);

    await waitFor(() => {
      expect(mockState.terminalInstances).toHaveLength(1);
    });

    expect(mockState.terminalInstances[0]?.options).toMatchObject({
      theme: expect.objectContaining({
        background: '#f8fafc',
        foreground: '#0f172a',
      }),
    });
  });
});
