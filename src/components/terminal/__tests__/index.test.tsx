import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { act, render, screen, fireEvent, within } from '@testing-library/react';
import Terminal from '../index';
import { useAgentStore } from '@/stores/agentStore';
import { useTerminalStore } from '@/stores/terminalStore';
import { terminalRegistry } from '../registry/terminal-registry';

const mockConnect = vi.fn();

vi.mock('@/lib/terminal-workspace-persistence', () => ({
  clearTerminalWorkspace: vi.fn().mockResolvedValue(undefined),
  flushTerminalWorkspace: vi.fn().mockResolvedValue(undefined),
  stageTerminalWorkspace: vi.fn(),
}));

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
  }),
}));

vi.mock('../terminal-controller-layer', () => ({
  TerminalControllerLayer: () => null,
}));

vi.mock('../terminal-pane', () => ({
  TerminalPane: ({ activeSession }: { activeSession: { sessionId: string } | null }) => (
    <div data-testid="terminal-pane" data-session-id={activeSession?.sessionId} />
  ),
}));

vi.mock('../new-session-dialog', () => ({
  NewSessionDialog: ({
    open,
    onConnect,
  }: {
    open: boolean;
    onConnect: (profile: unknown) => Promise<void>;
  }) =>
    open ? (
      <button
        type="button"
        data-testid="new-session-dialog"
        onClick={() => void onConnect({ id: 'p1' })}
      >
        NewSessionDialog
      </button>
    ) : null,
}));

vi.mock('../terminal-context-menu', () => ({
  TerminalContextMenu: ({
    open,
    session,
    onSplit,
    onUnsplit,
  }: {
    open: boolean;
    session: { sessionId: string } | null;
    onSplit: (sessionId: string, direction: 'right' | 'bottom') => void;
    onUnsplit: () => void;
  }) => open && session ? (
    <div>
      <button type="button" onClick={() => onSplit(session.sessionId, 'right')}>split-right</button>
      <button type="button" onClick={() => onSplit(session.sessionId, 'bottom')}>split-down</button>
      <button type="button" onClick={onUnsplit}>unsplit</button>
    </div>
  ) : null,
}));

const initialState = useTerminalStore.getState();
const initialAgentState = useAgentStore.getState();

describe('Terminal', () => {
  beforeEach(() => {
    useTerminalStore.setState(initialState, true);
    useAgentStore.setState(initialAgentState, true);
    mockConnect.mockReset();
  });

  afterEach(async () => {
    await new Promise((resolve) => setTimeout(resolve, 60));
  });

  it('renders the empty state with a new-connection button when there are no sessions', () => {
    render(<Terminal />);

    expect(screen.getByText('terminal.empty')).toBeInTheDocument();
    expect(screen.getByText('terminal.openFromWorkbench')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'terminal.empty.open' }),
    ).toBeInTheDocument();
  });

  it('shows an active loading tab while a terminal connection is being created', () => {
    useTerminalStore.getState().beginConnectionAttempt({
      title: 'Pending Server', host: 'h', port: 22, username: 'u', profileId: 'p1',
    }, 'attempt-1');

    render(<Terminal />);

    const tab = screen.getByRole('tab', { name: /Pending Server/ });
    expect(tab).toHaveAttribute('aria-selected', 'true');
    expect(tab).toHaveAttribute('aria-busy', 'true');
    expect(within(tab).getByRole('status', { name: 'Loading' })).toBeInTheDocument();
    expect(screen.getByTestId('terminal-pane')).toHaveAttribute('data-session-id', 'attempt-1');
    expect(screen.queryByText('terminal.empty')).not.toBeInTheDocument();
  });

  it('adds the loading placeholder beside existing terminal tabs', () => {
    useTerminalStore.getState().addSession({
      sessionId: 's1', title: 'Session A', host: 'h', port: 22, username: 'u',
    });
    useTerminalStore.getState().beginConnectionAttempt({
      title: 'Session B', host: 'h', port: 22, username: 'u', profileId: 'p1',
    }, 'attempt-1');

    render(<Terminal />);

    expect(screen.getAllByRole('tab')).toHaveLength(2);
    expect(screen.getByRole('tab', { name: /Session A/ })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Session B/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  it('opens the new session dialog when the empty-state new-connection button is clicked', () => {
    render(<Terminal />);

    expect(screen.queryByTestId('new-session-dialog')).not.toBeInTheDocument();

    fireEvent.click(
      screen.getByRole('button', { name: 'terminal.empty.open' }),
    );

    expect(screen.getByTestId('new-session-dialog')).toBeInTheDocument();
  });

  it('passes the dialog-owning connection callback to the new session dialog', () => {
    render(<Terminal />);

    fireEvent.click(
      screen.getByRole('button', { name: 'terminal.empty.open' }),
    );
    fireEvent.click(screen.getByTestId('new-session-dialog'));

    expect(mockConnect).toHaveBeenCalledWith({ id: 'p1' });
  });

  it('toggles the new session dialog via the new-terminal-tab event', () => {
    render(<Terminal />);

    expect(screen.queryByTestId('new-session-dialog')).not.toBeInTheDocument();

    act(() => {
      document.dispatchEvent(new Event('termbridge:new-terminal-tab'));
    });
    expect(screen.getByTestId('new-session-dialog')).toBeInTheDocument();

    act(() => {
      document.dispatchEvent(new Event('termbridge:new-terminal-tab'));
    });
    expect(screen.queryByTestId('new-session-dialog')).not.toBeInTheDocument();
  });

  it('opens the terminal tab switcher event and activates the chosen tab', () => {
    useTerminalStore.getState().addSession({
      sessionId: 's1', title: 'Session A', host: 'one.example.com', port: 22, username: 'u',
    });
    useTerminalStore.getState().addSession({
      sessionId: 's2', title: 'Session B', host: 'two.example.com', port: 22, username: 'u',
    });
    useTerminalStore.getState().setActiveSession('s1');

    render(<Terminal />);
    act(() => {
      document.dispatchEvent(new Event('termbridge:switch-terminal-tab'));
    });

    expect(screen.getByTestId('terminal-tab-switcher')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('option', { name: /Session B/ }));
    expect(useTerminalStore.getState().activeSessionId).toBe('s2');
  });

  it('renders the terminal pane when there is an active session', () => {
    useTerminalStore.getState().addSession({
      sessionId: 's1',
      title: 'Session A',
      host: 'h',
      port: 22,
      username: 'u',
    });

    render(<Terminal />);

    expect(screen.getByTestId('terminal-pane')).toBeInTheDocument();
    expect(screen.queryByText('terminal.empty')).not.toBeInTheDocument();
  });

  it('shows the Agent control glow only while the Agent operates the visible terminal', () => {
    ['s1', 's2'].forEach((sessionId) => {
      useTerminalStore.getState().addSession({
        sessionId, title: sessionId, host: 'h', port: 22, username: 'u',
      });
    });
    useTerminalStore.getState().setActiveSession('s1');

    const { container } = render(<Terminal />);
    expect(container.querySelector('[data-agent-controlled="true"]')).toBeNull();

    act(() => {
      useAgentStore.getState().beginRun({
        requestId: 'agent-1',
        goal: 'inspect the terminal',
        providerId: 'provider-1',
        target: {
          kind: 'remote', sessionId: 's1', host: 'h', port: 22, username: 'u',
        },
        targetTitle: 's1',
        permissionMode: 'requestApproval',
      });
    });

    expect(container.querySelector('[data-agent-controlled="true"]'))
      .toHaveClass('agent-terminal-glow');

    act(() => useTerminalStore.getState().setActiveSession('s2'));
    expect(container.querySelector('[data-agent-controlled="true"]')).toBeNull();

    act(() => useAgentStore.getState().cancelRun('agent-1'));
    expect(container.querySelector('[data-agent-controlled="true"]')).toBeNull();
  });

  it('limits the Agent control glow to its target split pane', () => {
    ['s1', 's2'].forEach((sessionId) => {
      useTerminalStore.getState().addSession({
        sessionId, title: sessionId, host: 'h', port: 22, username: 'u',
      });
    });

    const { container } = render(<Terminal />);
    fireEvent.contextMenu(screen.getAllByRole('tab')[0], { clientX: 10, clientY: 20 });
    fireEvent.click(screen.getByRole('button', { name: 'split-right' }));

    act(() => {
      useAgentStore.getState().beginRun({
        requestId: 'agent-1',
        goal: 'inspect the terminal',
        providerId: 'provider-1',
        target: {
          kind: 'remote', sessionId: 's1', host: 'h', port: 22, username: 'u',
        },
        targetTitle: 's1',
        permissionMode: 'requestApproval',
      });
    });

    const targetGroup = container
      .querySelector('[data-session-tab="s1"]')
      ?.closest('[data-terminal-group]');
    const otherGroup = container
      .querySelector('[data-session-tab="s2"]')
      ?.closest('[data-terminal-group]');
    expect(targetGroup).toHaveAttribute('data-agent-controlled', 'true');
    expect(targetGroup).toHaveClass('agent-terminal-glow');
    expect(otherGroup).not.toHaveAttribute('data-agent-controlled');
  });

  it('focuses the terminal when its active tab is clicked', async () => {
    useTerminalStore.getState().addSession({
      sessionId: 's1', title: 'Session A', host: 'h', port: 22, username: 'u',
    });
    const focus = vi.fn();
    vi.spyOn(terminalRegistry, 'get').mockReturnValue({ focus } as never);

    render(<Terminal />);
    fireEvent.pointerDown(screen.getByRole('tab'), { button: 0 });
    await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));

    expect(focus).toHaveBeenCalledTimes(1);
  });

  it('uses native scrolling to switch across multiple terminals without a settle lock', async () => {
    ['s1', 's2', 's3'].forEach((sessionId) => {
      useTerminalStore.getState().addSession({
        sessionId, title: sessionId, host: 'h', port: 22, username: 'u',
      });
    });
    useTerminalStore.getState().setActiveSession('s1');

    const { container } = render(<Terminal />);
    const carousel = container.querySelector<HTMLElement>('[data-terminal-carousel]')!;
    Object.defineProperty(carousel, 'clientWidth', { configurable: true, value: 500 });

    // The horizontal event remains uncancelled so WKWebView owns momentum,
    // interruption, rubber-banding, and scroll snapping.
    expect(fireEvent.wheel(carousel, { deltaX: 24, deltaY: 2, deltaMode: 0 })).toBe(true);

    // Crossing page midpoints updates the selected tab immediately. A second
    // movement can continue to the next page before the first one settles.
    act(() => {
      carousel.scrollLeft = 280;
      fireEvent.scroll(carousel);
    });
    expect(useTerminalStore.getState().activeSessionId).toBe('s2');

    act(() => {
      carousel.scrollLeft = 1_020;
      fireEvent.scroll(carousel);
    });
    expect(useTerminalStore.getState().activeSessionId).toBe('s3');

    await act(async () => new Promise((resolve) => setTimeout(resolve, 120)));
    expect(screen.getAllByTestId('terminal-pane').map((pane) => pane.dataset.sessionId))
      .toEqual(['s3']);
  });

  it('keeps vertical trackpad scrolling inside the active terminal', () => {
    ['s1', 's2'].forEach((sessionId) => {
      useTerminalStore.getState().addSession({
        sessionId, title: sessionId, host: 'h', port: 22, username: 'u',
      });
    });
    useTerminalStore.getState().setActiveSession('s1');

    const { container } = render(<Terminal />);
    const carousel = container.querySelector<HTMLElement>('[data-terminal-carousel]')!;
    fireEvent.wheel(carousel, { deltaX: 12, deltaY: 80, deltaMode: 0 });

    expect(useTerminalStore.getState().activeSessionId).toBe('s1');
  });

  it('accepts a quick horizontal swipe with a small diagonal drift', async () => {
    ['s1', 's2'].forEach((sessionId) => {
      useTerminalStore.getState().addSession({
        sessionId, title: sessionId, host: 'h', port: 22, username: 'u',
      });
    });
    useTerminalStore.getState().setActiveSession('s1');

    const { container } = render(<Terminal />);
    const carousel = container.querySelector<HTMLElement>('[data-terminal-carousel]')!;
    Object.defineProperty(carousel, 'clientWidth', { configurable: true, value: 500 });
    fireEvent.wheel(carousel, { deltaX: 19, deltaY: 12, deltaMode: 0 });
    act(() => {
      carousel.scrollLeft = 500;
      fireEvent.scroll(carousel);
    });

    await act(async () => new Promise((resolve) => setTimeout(resolve, 120)));
    expect(useTerminalStore.getState().activeSessionId).toBe('s2');
  });

  it('switches only the split group under the trackpad gesture', async () => {
    ['s1', 's2', 's3'].forEach((sessionId) => {
      useTerminalStore.getState().addSession({
        sessionId, title: sessionId, host: 'h', port: 22, username: 'u',
      });
    });

    const { container } = render(<Terminal />);
    fireEvent.contextMenu(screen.getAllByRole('tab')[0], { clientX: 10, clientY: 20 });
    fireEvent.click(screen.getByRole('button', { name: 'split-right' }));

    const firstGroup = container.querySelector<HTMLElement>('[data-terminal-group="first"]')!;
    const firstCarousel = firstGroup.querySelector<HTMLElement>('[data-terminal-carousel]')!;
    Object.defineProperty(firstCarousel, 'clientWidth', { configurable: true, value: 500 });
    fireEvent.wheel(firstCarousel, { deltaX: -70, deltaY: 0, deltaMode: 0 });
    act(() => {
      firstCarousel.scrollLeft = 0;
      fireEvent.scroll(firstCarousel);
    });

    await act(async () => new Promise((resolve) => setTimeout(resolve, 120)));
    expect(useTerminalStore.getState().activeSessionId).toBe('s2');
    expect(within(firstGroup).getByRole('tab', { name: /s2/ }))
      .toHaveAttribute('aria-selected', 'true');
    const secondGroup = container.querySelector<HTMLElement>('[data-terminal-group="second"]')!;
    expect(within(secondGroup).getByRole('tab', { name: /s1/ }))
      .toHaveAttribute('aria-selected', 'true');
  });

  it('rubber-bands at the last terminal instead of wrapping', async () => {
    ['s1', 's2'].forEach((sessionId) => {
      useTerminalStore.getState().addSession({
        sessionId, title: sessionId, host: 'h', port: 22, username: 'u',
      });
    });
    useTerminalStore.getState().setActiveSession('s2');

    const { container } = render(<Terminal />);
    const carousel = container.querySelector<HTMLElement>('[data-terminal-carousel]')!;
    Object.defineProperty(carousel, 'clientWidth', { configurable: true, value: 500 });
    carousel.scrollLeft = 500;
    fireEvent.wheel(carousel, { deltaX: 24, deltaY: 0, deltaMode: 0 });

    expect(carousel).toHaveClass('snap-mandatory', 'overscroll-x-contain');
    await act(async () => new Promise((resolve) => setTimeout(resolve, 120)));
    expect(useTerminalStore.getState().activeSessionId).toBe('s2');
  });

  it('splits an inactive tab beside the active terminal from its context menu', () => {
    useTerminalStore.getState().addSession({
      sessionId: 's1', title: 'Session A', host: 'h', port: 22, username: 'u',
    });
    useTerminalStore.getState().addSession({
      sessionId: 's2', title: 'Session B', host: 'h', port: 22, username: 'u',
    });

    const { container } = render(<Terminal />);
    fireEvent.contextMenu(screen.getAllByRole('tab')[0], { clientX: 10, clientY: 20 });
    fireEvent.click(screen.getByRole('button', { name: 'split-right' }));

    expect(screen.getAllByTestId('terminal-pane')).toHaveLength(2);
    expect(screen.getAllByTestId('terminal-pane').map((pane) => pane.dataset.sessionId)).toEqual(['s2', 's1']);
    expect(container.querySelector('[data-direction="horizontal"]')).toBeInTheDocument();
    const groups = container.querySelectorAll<HTMLElement>('[data-terminal-group]');
    expect(groups).toHaveLength(2);
    expect(within(groups[0]).getAllByRole('tab')).toHaveLength(1);
    expect(within(groups[1]).getAllByRole('tab')).toHaveLength(1);
    expect(useTerminalStore.getState().activeSessionId).toBe('s1');
  });

  it('can split the active tab when another session is available', () => {
    ['s1', 's2'].forEach((sessionId) => {
      useTerminalStore.getState().addSession({
        sessionId, title: sessionId, host: 'h', port: 22, username: 'u',
      });
    });

    render(<Terminal />);
    fireEvent.contextMenu(screen.getAllByRole('tab')[1], { clientX: 10, clientY: 20 });
    fireEvent.click(screen.getByRole('button', { name: 'split-right' }));

    expect(screen.getAllByTestId('terminal-pane').map((pane) => pane.dataset.sessionId)).toEqual(['s1', 's2']);
    expect(useTerminalStore.getState().activeSessionId).toBe('s2');
  });

  it('keeps the bottom pane when the top pane is split left-to-right', () => {
    ['s1', 's2', 's3'].forEach((sessionId) => {
      useTerminalStore.getState().addSession({
        sessionId, title: sessionId, host: 'h', port: 22, username: 'u',
      });
    });

    const { container } = render(<Terminal />);
    fireEvent.contextMenu(screen.getAllByRole('tab')[0], { clientX: 10, clientY: 20 });
    fireEvent.click(screen.getByRole('button', { name: 'split-down' }));

    const topGroup = container.querySelector<HTMLElement>('[data-terminal-group="first"]')!;
    fireEvent.contextMenu(within(topGroup).getByRole('tab', { name: /s2/ }), {
      clientX: 10,
      clientY: 20,
    });
    fireEvent.click(screen.getByRole('button', { name: 'split-right' }));

    expect(screen.getAllByTestId('terminal-pane').map((pane) => pane.dataset.sessionId)).toEqual([
      's3',
      's2',
      's1',
    ]);
    expect(container.querySelectorAll('[data-terminal-group]')).toHaveLength(3);
    expect(container.querySelector('[data-direction="vertical"]')).toBeInTheDocument();
    expect(container.querySelector('[data-direction="horizontal"]')).toBeInTheDocument();
  });

  it('switches the matching group tab when the active session changes externally', () => {
    ['s1', 's2', 's3'].forEach((sessionId) => {
      useTerminalStore.getState().addSession({
        sessionId, title: sessionId, host: 'h', port: 22, username: 'u',
      });
    });
    useTerminalStore.getState().setActiveSession('s2');

    render(<Terminal />);
    fireEvent.contextMenu(screen.getAllByRole('tab')[0], { clientX: 10, clientY: 20 });
    fireEvent.click(screen.getByRole('button', { name: 'split-right' }));

    act(() => useTerminalStore.getState().setActiveSession('s3'));

    expect(screen.getAllByTestId('terminal-pane').map((pane) => pane.dataset.sessionId)).toEqual(['s3', 's1']);
  });

  it('keeps tab selection independent in each terminal group', () => {
    ['s1', 's2', 's3'].forEach((sessionId) => {
      useTerminalStore.getState().addSession({
        sessionId, title: sessionId, host: 'h', port: 22, username: 'u',
      });
    });
    useTerminalStore.getState().setActiveSession('s2');

    const { container } = render(<Terminal />);
    fireEvent.contextMenu(screen.getAllByRole('tab')[0], { clientX: 10, clientY: 20 });
    fireEvent.click(screen.getByRole('button', { name: 'split-right' }));

    const firstGroup = container.querySelector<HTMLElement>('[data-terminal-group="first"]')!;
    fireEvent.pointerDown(within(firstGroup).getByRole('tab', { name: /s3/ }), { button: 0 });

    expect(screen.getAllByTestId('terminal-pane').map((pane) => pane.dataset.sessionId)).toEqual(['s3', 's1']);
    expect(within(firstGroup).getAllByRole('tab')).toHaveLength(2);
  });

  it('adds a newly opened session to the focused terminal group', () => {
    ['s1', 's2'].forEach((sessionId) => {
      useTerminalStore.getState().addSession({
        sessionId, title: sessionId, host: 'h', port: 22, username: 'u',
      });
    });

    const { container } = render(<Terminal />);
    fireEvent.contextMenu(screen.getAllByRole('tab')[0], { clientX: 10, clientY: 20 });
    fireEvent.click(screen.getByRole('button', { name: 'split-right' }));
    act(() => useTerminalStore.getState().addSession({
      sessionId: 's3', title: 's3', host: 'h', port: 22, username: 'u',
    }));

    const secondGroup = container.querySelector<HTMLElement>('[data-terminal-group="second"]')!;
    expect(within(secondGroup).getAllByRole('tab')).toHaveLength(2);
    expect(within(secondGroup).getByRole('tab', { name: /s3/ })).toBeInTheDocument();
    expect(screen.getAllByTestId('terminal-pane').map((pane) => pane.dataset.sessionId)).toEqual(['s2', 's3']);
  });

  it('moves focus between split groups via the pane navigation event', async () => {
    ['s1', 's2'].forEach((sessionId) => {
      useTerminalStore.getState().addSession({
        sessionId, title: sessionId, host: 'h', port: 22, username: 'u',
      });
    });
    const focus = vi.fn();
    vi.spyOn(terminalRegistry, 'get').mockReturnValue({ focus } as never);

    render(<Terminal />);
    fireEvent.contextMenu(screen.getAllByRole('tab')[0], { clientX: 10, clientY: 20 });
    fireEvent.click(screen.getByRole('button', { name: 'split-right' }));
    // s1 was moved into the right group, which now owns the focus.
    expect(useTerminalStore.getState().activeSessionId).toBe('s1');

    const navigate = (direction: string): void => {
      act(() => {
        document.dispatchEvent(new CustomEvent('termbridge:navigate-terminal-pane', {
          detail: { direction },
        }));
      });
    };

    navigate('left');
    expect(useTerminalStore.getState().activeSessionId).toBe('s2');

    // No group further left: navigation is a no-op.
    navigate('left');
    expect(useTerminalStore.getState().activeSessionId).toBe('s2');

    navigate('right');
    expect(useTerminalStore.getState().activeSessionId).toBe('s1');

    await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    expect(focus).toHaveBeenCalled();
  });

  it('moves a pinned tab to the front of its split group', () => {
    ['s1', 's2', 's3'].forEach((sessionId) => {
      useTerminalStore.getState().addSession({
        sessionId, title: sessionId, host: 'h', port: 22, username: 'u',
      });
    });

    const { container } = render(<Terminal />);
    fireEvent.contextMenu(screen.getAllByRole('tab')[0], { clientX: 10, clientY: 20 });
    fireEvent.click(screen.getByRole('button', { name: 'split-right' }));

    const firstGroup = container.querySelector<HTMLElement>('[data-terminal-group="first"]')!;
    const tabOrder = (): (string | null)[] => within(firstGroup)
      .getAllByRole('tab')
      .map((tab) => tab.getAttribute('data-session-tab'));
    expect(tabOrder()).toEqual(['s2', 's3']);

    act(() => useTerminalStore.getState().togglePin('s3'));
    expect(tabOrder()).toEqual(['s3', 's2']);

    // Unpinning keeps the stable order, matching the single-tab-bar behavior.
    act(() => useTerminalStore.getState().togglePin('s3'));
    expect(tabOrder()).toEqual(['s3', 's2']);
  });

  it('splits the focused tab via the pane split event', () => {
    ['s1', 's2'].forEach((sessionId) => {
      useTerminalStore.getState().addSession({
        sessionId, title: sessionId, host: 'h', port: 22, username: 'u',
      });
    });

    const { container } = render(<Terminal />);
    expect(screen.getAllByTestId('terminal-pane')).toHaveLength(1);

    act(() => {
      document.dispatchEvent(new CustomEvent('termbridge:split-terminal-pane', {
        detail: { direction: 'right' },
      }));
    });

    expect(screen.getAllByTestId('terminal-pane')).toHaveLength(2);
    expect(container.querySelector('[data-direction="horizontal"]')).toBeInTheDocument();
    // The active session (s2, last added) moved into the new right group.
    expect(screen.getAllByTestId('terminal-pane').map((pane) => pane.dataset.sessionId)).toEqual(['s1', 's2']);
  });

  it('keeps a reconnected session in its original split group', () => {
    ['s1', 's2', 's3'].forEach((sessionId) => {
      useTerminalStore.getState().addSession({
        sessionId, title: sessionId, host: 'h', port: 22, username: 'u',
      });
    });

    const { container } = render(<Terminal />);
    fireEvent.contextMenu(screen.getAllByRole('tab')[0], { clientX: 10, clientY: 20 });
    fireEvent.click(screen.getByRole('button', { name: 'split-right' }));

    const firstGroup = container.querySelector<HTMLElement>('[data-terminal-group="first"]')!;
    const secondGroup = container.querySelector<HTMLElement>('[data-terminal-group="second"]')!;
    fireEvent.pointerDown(within(firstGroup).getByRole('tab', { name: /s2/ }), { button: 0 });

    act(() => {
      useTerminalStore.getState().reconnectSession('s1', {
        sessionId: 's1-next',
        title: 's1-next',
        host: 'h',
        port: 22,
        username: 'u',
      });
    });

    expect(within(secondGroup).getByRole('tab', { name: /s1/ }))
      .toHaveAttribute('data-session-tab', 's1-next');
    expect(within(firstGroup).queryByRole('tab', { name: /s1/ })).toBeNull();
  });

  it('repairs restored duplicate group ids and allocates a fresh id for the next split', () => {
    useTerminalStore.getState().addRestoredSessions(
      ['s1', 's2', 's3'].map((sessionId) => ({
        sessionId,
        title: sessionId,
        host: 'h',
        port: 22,
        username: 'u',
        profileId: `profile-${sessionId}`,
      })),
      {
        kind: 'split',
        orientation: 'horizontal',
        first: {
          kind: 'group',
          id: 'group-3',
          sessionIds: ['s1', 's2'],
          activeSessionId: 's1',
        },
        second: {
          kind: 'group',
          id: 'group-3',
          sessionIds: ['s3'],
          activeSessionId: 's3',
        },
      },
    );

    const { container } = render(<Terminal />);
    const restoredIds = Array.from(
      container.querySelectorAll<HTMLElement>('[data-terminal-group]'),
      (element) => element.dataset.terminalGroup,
    );
    expect(new Set(restoredIds).size).toBe(2);

    const firstGroup = container.querySelector<HTMLElement>('[data-terminal-group="group-3"]')!;
    fireEvent.contextMenu(within(firstGroup).getByRole('tab', { name: /s2/ }), {
      clientX: 10,
      clientY: 20,
    });
    fireEvent.click(screen.getByRole('button', { name: 'split-right' }));

    const nextIds = Array.from(
      container.querySelectorAll<HTMLElement>('[data-terminal-group]'),
      (element) => element.dataset.terminalGroup,
    );
    expect(nextIds).toHaveLength(3);
    expect(new Set(nextIds).size).toBe(3);
  });

  it('does not create a split when the target pane is too small', () => {
    ['s1', 's2'].forEach((sessionId) => {
      useTerminalStore.getState().addSession({
        sessionId, title: sessionId, host: 'h', port: 22, username: 'u',
      });
    });

    const { container } = render(<Terminal />);
    const content = container.querySelector<HTMLElement>('[data-terminal-content]')!;
    vi.spyOn(content, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      width: 200,
      height: 500,
      right: 200,
      bottom: 500,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });

    fireEvent.contextMenu(screen.getAllByRole('tab')[0], { clientX: 10, clientY: 20 });
    fireEvent.click(screen.getByRole('button', { name: 'split-right' }));

    expect(screen.getAllByTestId('terminal-pane')).toHaveLength(1);
    expect(container.querySelector('[data-terminal-group]')).toBeNull();
  });
});
