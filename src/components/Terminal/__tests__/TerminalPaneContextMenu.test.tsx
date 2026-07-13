import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { TerminalPaneContextMenu } from '../TerminalPaneContextMenu';
import type { TerminalSession } from '@/stores/terminalStore';

vi.mock('@/hooks/useI18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
    ready: true,
    locale: 'en-US',
    setLocale: () => {},
  }),
}));

vi.mock('@/lib/tauri', () => ({
  invokeWriteSession: vi.fn().mockResolvedValue(undefined),
}));

function makeSession(status: TerminalSession['status'] = 'connected'): TerminalSession {
  return {
    sessionId: 's1',
    title: 'A',
    host: 'host',
    port: 22,
    username: 'username',
    status,
  };
}

function makeTerminal(selection = '') {
  return {
    getSelection: vi.fn().mockReturnValue(selection),
    selectAll: vi.fn(),
    clear: vi.fn(),
    write: vi.fn(),
  } as unknown as import('@xterm/xterm').Terminal;
}

describe('TerminalPaneContextMenu', () => {
  beforeEach(() => {
    Object.assign(navigator, {
      clipboard: {
        writeText: vi.fn().mockResolvedValue(undefined),
        readText: vi.fn().mockResolvedValue('pasted text'),
      },
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('renders all menu items when open', () => {
    render(
      <TerminalPaneContextMenu
        open
        x={10}
        y={10}
        session={makeSession()}
        terminal={makeTerminal('selection')}
        onClose={vi.fn()}
        onCopyFeedback={vi.fn()}
        onFind={vi.fn()}
      />,
    );

    expect(screen.getByText('terminal.contextMenu.copy')).toBeInTheDocument();
    expect(screen.getByText('terminal.contextMenu.paste')).toBeInTheDocument();
    expect(screen.getByText('terminal.contextMenu.selectAll')).toBeInTheDocument();
    expect(screen.getByText('terminal.contextMenu.clear')).toBeInTheDocument();
    expect(screen.getByText('terminal.contextMenu.find')).toBeInTheDocument();
  });

  it('renders nothing when closed', () => {
    const { container } = render(
      <TerminalPaneContextMenu
        open={false}
        x={10}
        y={10}
        session={makeSession()}
        terminal={makeTerminal()}
        onClose={vi.fn()}
        onCopyFeedback={vi.fn()}
        onFind={vi.fn()}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('disables copy when there is no selection', () => {
    render(
      <TerminalPaneContextMenu
        open
        x={10}
        y={10}
        session={makeSession()}
        terminal={makeTerminal('')}
        onClose={vi.fn()}
        onCopyFeedback={vi.fn()}
        onFind={vi.fn()}
      />,
    );

    const copyButton = screen.getByText('terminal.contextMenu.copy').closest(
      'button',
    ) as HTMLButtonElement;
    expect(copyButton).toBeDisabled();
  });

  it('copies selection to clipboard and closes', async () => {
    const terminal = makeTerminal('selected text');
    const onClose = vi.fn();
    const onCopyFeedback = vi.fn();

    render(
      <TerminalPaneContextMenu
        open
        x={10}
        y={10}
        session={makeSession()}
        terminal={terminal}
        onClose={onClose}
        onCopyFeedback={onCopyFeedback}
        onFind={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText('terminal.contextMenu.copy'));

    await vi.waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith('selected text');
    });
    expect(onCopyFeedback).toHaveBeenCalledWith('copied');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('pastes clipboard text into the session and closes', async () => {
    const terminal = makeTerminal();
    const onClose = vi.fn();
    const { invokeWriteSession } = await import('@/lib/tauri');

    render(
      <TerminalPaneContextMenu
        open
        x={10}
        y={10}
        session={makeSession('connected')}
        terminal={terminal}
        onClose={onClose}
        onCopyFeedback={vi.fn()}
        onFind={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText('terminal.contextMenu.paste'));

    await vi.waitFor(() => {
      expect(invokeWriteSession).toHaveBeenCalledWith('s1', 'pasted text');
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('writes pasted text to terminal when session is disconnected', async () => {
    const terminal = makeTerminal();
    const onClose = vi.fn();

    render(
      <TerminalPaneContextMenu
        open
        x={10}
        y={10}
        session={makeSession('disconnected')}
        terminal={terminal}
        onClose={onClose}
        onCopyFeedback={vi.fn()}
        onFind={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText('terminal.contextMenu.paste'));

    await vi.waitFor(() => {
      expect(terminal.write).toHaveBeenCalledWith('pasted text');
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('selects all and closes', () => {
    const terminal = makeTerminal();
    const onClose = vi.fn();

    render(
      <TerminalPaneContextMenu
        open
        x={10}
        y={10}
        session={makeSession()}
        terminal={terminal}
        onClose={onClose}
        onCopyFeedback={vi.fn()}
        onFind={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText('terminal.contextMenu.selectAll'));

    expect(terminal.selectAll).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('clears terminal and closes', () => {
    const terminal = makeTerminal();
    const onClose = vi.fn();

    render(
      <TerminalPaneContextMenu
        open
        x={10}
        y={10}
        session={makeSession()}
        terminal={terminal}
        onClose={onClose}
        onCopyFeedback={vi.fn()}
        onFind={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText('terminal.contextMenu.clear'));

    expect(terminal.clear).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('opens find and closes', () => {
    const terminal = makeTerminal();
    const onClose = vi.fn();
    const onFind = vi.fn();

    render(
      <TerminalPaneContextMenu
        open
        x={10}
        y={10}
        session={makeSession()}
        terminal={terminal}
        onClose={onClose}
        onCopyFeedback={vi.fn()}
        onFind={onFind}
      />,
    );

    fireEvent.click(screen.getByText('terminal.contextMenu.find'));

    expect(onFind).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on Escape key', () => {
    const onClose = vi.fn();
    render(
      <TerminalPaneContextMenu
        open
        x={10}
        y={10}
        session={makeSession()}
        terminal={makeTerminal()}
        onClose={onClose}
        onCopyFeedback={vi.fn()}
        onFind={vi.fn()}
      />,
    );

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
