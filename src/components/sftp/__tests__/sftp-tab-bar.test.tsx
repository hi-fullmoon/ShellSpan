import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SftpTabBar } from '../sftp-tab-bar';
import { useSftpStore } from '@/stores/sftpStore';
import { useTransferStore } from '@/stores/transferStore';

const translationSpy = vi.hoisted(() => vi.fn((key: string) => key));

vi.mock('@/hooks/useI18n', () => ({
  useI18n: () => ({
    t: translationSpy,
    locale: 'en-US',
  }),
}));

const initialState = useSftpStore.getState();

describe('SftpTabBar', () => {
  beforeEach(() => {
    useSftpStore.setState(initialState, true);
    useTransferStore.setState({ operations: [] });
    translationSpy.mockClear();
  });

  it('warns when closing a tab would interrupt an active transfer', () => {
    const id = addConnection('Busy connection');
    useTransferStore.getState().addOperation({
      operationId: 'busy-upload',
      kind: 'upload',
      ownerId: id,
      totalBytes: 10,
      processedBytes: 1,
      totalSteps: 1,
      completedSteps: 0,
      status: 'running',
    });
    render(<SftpTabBar />);

    fireEvent.click(screen.getByRole('button', { name: 'close' }));

    expect(screen.getByText('sftp.tab.closeTransferWarning')).toBeInTheDocument();
  });

  it('does not rerender for a progress-only transfer update', () => {
    const id = addConnection('Busy connection');
    useTransferStore.getState().addOperation({
      operationId: 'busy-upload',
      kind: 'upload',
      ownerId: id,
      totalBytes: 10,
      processedBytes: 1,
      totalSteps: 1,
      completedSteps: 0,
      status: 'running',
    });
    render(<SftpTabBar />);
    translationSpy.mockClear();

    act(() => {
      useTransferStore.getState().updateUpload({
        operationId: 'busy-upload',
        currentPath: '/tmp/archive.zip',
        totalBytes: 10,
        uploadedBytes: 5,
        totalSteps: 1,
        completedSteps: 0,
      });
    });

    expect(translationSpy).not.toHaveBeenCalled();
  });

  const addConnection = (title: string): string => {
    useSftpStore.getState().addConnection(
      {
        sessionId: title,
        title,
        host: 'h',
        port: 22,
        username: 'u',
      },
      {
        host: 'h',
        port: 22,
        username: 'u',
        authMethod: 'password',
      },
    );
    return useSftpStore.getState().connections[0]?.id ?? '';
  };

  it('renders connection tabs', () => {
    addConnection('Conn A');
    addConnection('Conn B');
    render(
      <SftpTabBar
        onNewTabClick={vi.fn()}
        onTabContextMenu={vi.fn()}
      />,
    );
    expect(screen.getByText('Conn A')).toBeInTheDocument();
    expect(screen.getByText('Conn B')).toBeInTheDocument();
    expect(screen.getAllByRole('tab')[1]).not.toHaveClass('shadow-md');
  });

  it('activates a tab when clicked', async () => {
    addConnection('Conn A');
    addConnection('Conn B');
    const connections = useSftpStore.getState().connections;
    const idB = connections[connections.length - 1]?.id ?? '';
    render(
      <SftpTabBar
        onNewTabClick={vi.fn()}
        onTabContextMenu={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByText('Conn B'));
    expect(useSftpStore.getState().activeConnectionId).toBe(idB);
  });

  it('activates a connection via pointerup fallback when its pointerdown was missed', () => {
    addConnection('Conn A');
    addConnection('Conn B');
    const connections = useSftpStore.getState().connections;
    const idA = connections[0]?.id ?? '';
    const idB = connections[1]?.id ?? '';
    render(
      <SftpTabBar
        onNewTabClick={vi.fn()}
        onTabContextMenu={vi.fn()}
      />,
    );

    const tabs = screen.getAllByRole('tab');
    fireEvent.pointerDown(tabs[0], { button: 0 });
    expect(useSftpStore.getState().activeConnectionId).toBe(idA);

    // The second tap's pointerdown is swallowed by WKWebView; only the release
    // reaches the tab. The fallback must still switch.
    fireEvent.pointerUp(tabs[1], { button: 0 });
    expect(useSftpStore.getState().activeConnectionId).toBe(idB);
  });

  it('does not activate a connection when a missed pointerdown releases on its close button', () => {
    addConnection('Conn A');
    addConnection('Conn B');
    const connections = useSftpStore.getState().connections;
    const idB = connections[1]?.id ?? '';
    render(
      <SftpTabBar
        onNewTabClick={vi.fn()}
        onTabContextMenu={vi.fn()}
      />,
    );

    const tabs = screen.getAllByRole('tab');
    fireEvent.pointerDown(tabs[1], { button: 0 });
    expect(useSftpStore.getState().activeConnectionId).toBe(idB);

    // If WKWebView drops the pointerdown for this tap, only the release reaches
    // the close button. The fallback activation handler must leave the active
    // connection alone so the button action does not also switch tabs.
    fireEvent.pointerUp(screen.getAllByRole('button', { name: 'close' })[0], { button: 0 });
    expect(useSftpStore.getState().activeConnectionId).toBe(idB);
  });

  it('shows separators between every pair of tabs', () => {
    addConnection('Conn A');
    addConnection('Conn B');
    addConnection('Conn C');
    addConnection('Conn D');
    const connections = useSftpStore.getState().connections;
    useSftpStore.getState().setActiveConnection(connections[1]?.id ?? null);

    render(<SftpTabBar />);

    const tabs = screen.getAllByRole('tab');
    const firstSeparator = tabs[0].querySelector('[data-tab-separator]');
    expect(firstSeparator).toBeInTheDocument();
    expect(firstSeparator).toHaveClass('right-[-3px]');
    expect(firstSeparator).not.toHaveClass('translate-x-1/2');
    expect(tabs[1].querySelector('[data-tab-separator]')).toBeInTheDocument();
    expect(tabs[2].querySelector('[data-tab-separator]')).toBeInTheDocument();
    expect(tabs[3].querySelector('[data-tab-separator]')).not.toBeInTheDocument();
  });

  it('closes a tab after confirming in the dialog', async () => {
    addConnection('Conn A');
    render(
      <SftpTabBar
        onNewTabClick={vi.fn()}
        onTabContextMenu={vi.fn()}
      />,
    );
    const closeButton = screen.getByRole('button', { name: 'close' });
    await userEvent.click(closeButton);
    // Connection is kept until the dialog is confirmed
    expect(useSftpStore.getState().connections).toHaveLength(1);

    await userEvent.click(screen.getByRole('button', { name: 'common.close' }));
    expect(useSftpStore.getState().connections).toHaveLength(0);
  });

  it('keeps the tab when the close confirmation is cancelled', async () => {
    addConnection('Conn A');
    render(
      <SftpTabBar
        onNewTabClick={vi.fn()}
        onTabContextMenu={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'close' }));
    await userEvent.click(screen.getByRole('button', { name: 'common.cancel' }));
    expect(useSftpStore.getState().connections).toHaveLength(1);
  });

  it('renders a compact pin icon for pinned tabs', () => {
    const connectionId = addConnection('Conn A');
    useSftpStore.getState().togglePin(connectionId);

    render(
      <SftpTabBar
        onNewTabClick={vi.fn()}
        onTabContextMenu={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: 'unpin' }).querySelector('svg')).toHaveClass(
      'size-3',
    );
  });

  it('calls onNewTabClick when empty tab bar space is double-clicked', async () => {
    addConnection('Conn A');
    const onNewTabClick = vi.fn();
    const { container } = render(
      <SftpTabBar
        onNewTabClick={onNewTabClick}
        onTabContextMenu={vi.fn()}
      />,
    );
    await userEvent.dblClick(container.firstChild as HTMLElement);
    expect(onNewTabClick).toHaveBeenCalled();
  });

  it('uses inset rounded tabs with a bordered active state', () => {
    addConnection('Conn A');
    addConnection('Conn B');
    const connections = useSftpStore.getState().connections;
    useSftpStore.getState().setActiveConnection(connections[0]?.id ?? null);

    const { container } = render(<SftpTabBar />);

    const tabs = screen.getAllByRole('tab');
    expect(container.firstChild).toHaveClass('h-10', 'bg-app-bg', 'px-1');
    expect(tabs[0]).toHaveClass('h-8', 'rounded-md', 'bg-app-tab-active', 'text-app-tab-accent');
    expect(tabs[1]).toHaveClass('bg-transparent', 'hover:bg-app-surface-muted');
  });

  it('renders a rounded accent border on the active tab', () => {
    addConnection('Conn A');
    addConnection('Conn B');
    const connections = useSftpStore.getState().connections;
    useSftpStore.getState().setActiveConnection(connections[0]?.id ?? null);

    render(<SftpTabBar />);

    const tabs = screen.getAllByRole('tab');
    const indicator = tabs[0].querySelector<HTMLElement>('[data-active-tab-indicator]');
    expect(indicator).not.toBeNull();
    expect(indicator).toHaveClass('inset-0', 'rounded-md', 'border-app-tab-accent');
  });

  it('does not render the accent border on inactive tabs', () => {
    addConnection('Conn A');
    addConnection('Conn B');
    const connections = useSftpStore.getState().connections;
    useSftpStore.getState().setActiveConnection(connections[0]?.id ?? null);

    render(<SftpTabBar />);

    const tabs = screen.getAllByRole('tab');
    expect(tabs[1].querySelector('[data-active-tab-indicator]')).toBeNull();
  });
});
