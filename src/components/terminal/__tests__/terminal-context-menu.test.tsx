import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { TerminalContextMenu } from '../terminal-context-menu';
import { useTerminalStore } from '@/stores/terminalStore';
import { useProfileStore } from '@/stores/profileStore';
import type { TerminalSession } from '@/stores/terminalStore';

const mockConnect = vi.fn();

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
    connect: mockConnect,
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

vi.mock('@/lib/tauri', () => ({
  invokeCloseSession: vi.fn().mockResolvedValue(undefined),
}));

const initialTerminal = useTerminalStore.getState();
const initialProfile = useProfileStore.getState();

function makeSession(
  id: string,
  title: string,
  profileId?: string,
): TerminalSession {
  return {
    sessionId: id,
    title,
    host: 'host',
    port: 22,
    username: 'username',
    status: 'connected',
    profileId,
  };
}

function addSession(id: string, title: string, profileId?: string): void {
  useTerminalStore.getState().addSession(
    {
      sessionId: id,
      title,
      host: 'host',
      port: 22,
      username: 'username',
    },
    profileId,
  );
}

describe('TerminalContextMenu', () => {
  beforeEach(() => {
    useTerminalStore.setState(initialTerminal, true);
    useProfileStore.setState(initialProfile, true);
    mockConnect.mockReset();
    Object.assign(navigator, {
      clipboard: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    });
  });

  afterEach(() => {
    cleanup();
    useTerminalStore.setState(initialTerminal, true);
    useProfileStore.setState(initialProfile, true);
  });

  it('renders all menu items when open with a profiled session', () => {
    const session = makeSession('s1', 'A', 'p1');
    render(
      <TerminalContextMenu
        open
        x={10}
        y={10}
        session={session}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText('terminal.tab.pin')).toBeInTheDocument();
    expect(screen.getByText('common.rename')).toBeInTheDocument();
    expect(screen.getByText('common.duplicate')).toBeInTheDocument();
    expect(screen.getByText('terminal.tab.copyInfo')).toBeInTheDocument();
    expect(screen.getByText('common.close')).toBeInTheDocument();
    expect(
      screen.getByText('terminal.tab.closeOthers'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('terminal.tab.closeToRight'),
    ).toBeInTheDocument();
    expect(screen.getByText('terminal.tab.color')).toBeInTheDocument();
  });

  it('renders nothing when open is false', () => {
    const session = makeSession('s1', 'A', 'p1');
    const { container } = render(
      <TerminalContextMenu
        open={false}
        x={10}
        y={10}
        session={session}
        onClose={vi.fn()}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when session is null', () => {
    const { container } = render(
      <TerminalContextMenu
        open
        x={10}
        y={10}
        session={null}
        onClose={vi.fn()}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('close removes only the target session and calls invokeCloseSession', async () => {
    addSession('s1', 'A');
    addSession('s2', 'B');
    addSession('s3', 'C');
    const session = makeSession('s2', 'B');

    const { invokeCloseSession } = await import('@/lib/tauri');
    const onClose = vi.fn();
    render(
      <TerminalContextMenu
        open
        x={10}
        y={10}
        session={session}
        onClose={onClose}
      />,
    );

    fireEvent.click(screen.getByText('common.close'));

    expect(
      useTerminalStore.getState().sessions.map((s) => s.sessionId),
    ).toEqual(['s1', 's3']);
    expect(invokeCloseSession).toHaveBeenCalledWith('s2');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('close others leaves only the target session', () => {
    addSession('s1', 'A');
    addSession('s2', 'B');
    addSession('s3', 'C');
    const session = makeSession('s2', 'B');

    const onClose = vi.fn();
    render(
      <TerminalContextMenu
        open
        x={10}
        y={10}
        session={session}
        onClose={onClose}
      />,
    );

    fireEvent.click(screen.getByText('terminal.tab.closeOthers'));

    expect(
      useTerminalStore.getState().sessions.map((s) => s.sessionId),
    ).toEqual(['s2']);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('close others skips pinned sessions', () => {
    addSession('s1', 'A');
    addSession('s2', 'B');
    addSession('s3', 'C');
    useTerminalStore.getState().togglePin('s1');
    const session = makeSession('s2', 'B');

    const onClose = vi.fn();
    render(
      <TerminalContextMenu
        open
        x={10}
        y={10}
        session={session}
        onClose={onClose}
      />,
    );

    fireEvent.click(screen.getByText('terminal.tab.closeOthers'));

    expect(
      useTerminalStore.getState().sessions.map((s) => s.sessionId),
    ).toEqual(['s1', 's2']);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('close to the right removes sessions after the target', () => {
    addSession('s1', 'A');
    addSession('s2', 'B');
    addSession('s3', 'C');
    const session = makeSession('s1', 'A');

    const onClose = vi.fn();
    render(
      <TerminalContextMenu
        open
        x={10}
        y={10}
        session={session}
        onClose={onClose}
      />,
    );

    fireEvent.click(screen.getByText('terminal.tab.closeToRight'));

    expect(
      useTerminalStore.getState().sessions.map((s) => s.sessionId),
    ).toEqual(['s1']);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('close to the right skips pinned sessions', () => {
    addSession('s1', 'A');
    addSession('s2', 'B');
    addSession('s3', 'C');
    useTerminalStore.getState().togglePin('s3');
    const session = makeSession('s1', 'A');

    const onClose = vi.fn();
    render(
      <TerminalContextMenu
        open
        x={10}
        y={10}
        session={session}
        onClose={onClose}
      />,
    );

    fireEvent.click(screen.getByText('terminal.tab.closeToRight'));

    expect(
      useTerminalStore.getState().sessions.map((s) => s.sessionId),
    ).toEqual(['s3', 's1']);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('toggle pin pins and unpins the target session', () => {
    addSession('s1', 'A');
    const session = makeSession('s1', 'A');

    const onClose = vi.fn();
    const { rerender } = render(
      <TerminalContextMenu
        open
        x={10}
        y={10}
        session={session}
        onClose={onClose}
      />,
    );

    fireEvent.click(screen.getByText('terminal.tab.pin'));
    expect(
      useTerminalStore.getState().sessions.find((s) => s.sessionId === 's1')
        ?.pinned,
    ).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);

    rerender(
      <TerminalContextMenu
        open
        x={10}
        y={10}
        session={{
          ...session,
          pinned: true,
        }}
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByText('terminal.tab.unpin'));
    expect(
      useTerminalStore.getState().sessions.find((s) => s.sessionId === 's1')
        ?.pinned,
    ).toBe(false);
  });

  it('sets and clears tab color from the color picker', () => {
    addSession('s1', 'A');
    const session = makeSession('s1', 'A');
    const onClose = vi.fn();

    render(
      <TerminalContextMenu
        open
        x={10}
        y={10}
        session={session}
        onClose={onClose}
      />,
    );

    const colorButton = screen.getByRole('button', { name: '#ef4444' });
    fireEvent.click(colorButton);

    expect(
      useTerminalStore.getState().sessions.find((s) => s.sessionId === 's1')
        ?.color,
    ).toBe('#ef4444');
    expect(onClose).toHaveBeenCalledTimes(1);

    const clearButton = screen.getByRole('button', { name: 'terminal.tab.clearColor' });
    fireEvent.click(clearButton);

    expect(
      useTerminalStore.getState().sessions.find((s) => s.sessionId === 's1')
        ?.color,
    ).toBeUndefined();
  });

  it('duplicate is disabled when session has no profileId', () => {
    const session = makeSession('s1', 'A');
    render(
      <TerminalContextMenu
        open
        x={10}
        y={10}
        session={session}
        onClose={vi.fn()}
      />,
    );

    const duplicateButton = screen.getByText('common.duplicate').closest(
      'button',
    ) as HTMLButtonElement;
    expect(duplicateButton).toBeDisabled();
  });

  it('duplicate calls connect with the profile and closes', () => {
    useProfileStore.setState({
      profiles: [
        {
          id: 'p1',
          name: 'Alpha',
          host: 'h',
          port: 22,
          username: 'u',
          authMethod: 'password',
          createdAt: 0,
          updatedAt: 0,
        },
      ],
    });
    const session = makeSession('s1', 'A', 'p1');

    const onClose = vi.fn();
    render(
      <TerminalContextMenu
        open
        x={10}
        y={10}
        session={session}
        onClose={onClose}
      />,
    );

    fireEvent.click(screen.getByText('common.duplicate'));

    expect(mockConnect).toHaveBeenCalledTimes(1);
    expect(mockConnect.mock.calls[0][0].id).toBe('p1');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('copy info writes username@host:port to the clipboard and closes', () => {
    const session = makeSession('s1', 'A', 'p1');

    const onClose = vi.fn();
    render(
      <TerminalContextMenu
        open
        x={10}
        y={10}
        session={session}
        onClose={onClose}
      />,
    );

    fireEvent.click(screen.getByText('terminal.tab.copyInfo'));

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      'username@host:22',
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('rename opens the prompt dialog with the session title as default', () => {
    const session = makeSession('s1', 'My Tab', 'p1');

    render(
      <TerminalContextMenu
        open
        x={10}
        y={10}
        session={session}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText('common.rename'));

    expect(screen.getByDisplayValue('My Tab')).toBeInTheDocument();
  });

  it('clears the rename dialog state before the context menu is reopened', () => {
    const session = makeSession('s1', 'My Tab', 'p1');
    const onClose = vi.fn();
    const { rerender } = render(
      <TerminalContextMenu
        open
        x={10}
        y={10}
        session={session}
        onClose={onClose}
      />,
    );

    fireEvent.click(screen.getByText('common.rename'));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.getByDisplayValue('My Tab')).toBeInTheDocument();

    rerender(
      <TerminalContextMenu
        open={false}
        x={0}
        y={0}
        session={null}
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByText('common.cancel'));

    rerender(
      <TerminalContextMenu
        open
        x={20}
        y={20}
        session={session}
        onClose={onClose}
      />,
    );

    expect(screen.queryByDisplayValue('My Tab')).not.toBeInTheDocument();
    expect(screen.getByText('common.rename')).toBeInTheDocument();
  });

  it('closes on Escape key when open', () => {
    const session = makeSession('s1', 'A', 'p1');
    const onClose = vi.fn();
    render(
      <TerminalContextMenu
        open
        x={10}
        y={10}
        session={session}
        onClose={onClose}
      />,
    );

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes when the backdrop is clicked', () => {
    const session = makeSession('s1', 'A', 'p1');
    const onClose = vi.fn();
    render(
      <TerminalContextMenu
        open
        x={10}
        y={10}
        session={session}
        onClose={onClose}
      />,
    );

    const backdrop = document.body.querySelector(
      '.fixed.inset-0',
    ) as HTMLElement;
    expect(backdrop).not.toBeNull();
    fireEvent.click(backdrop);

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
