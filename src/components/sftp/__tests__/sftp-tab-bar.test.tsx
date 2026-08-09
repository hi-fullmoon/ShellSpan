import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SftpTabBar } from '../sftp-tab-bar';
import { useSftpStore } from '@/stores/sftpStore';

vi.mock('@/hooks/useI18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
    locale: 'en-US',
  }),
}));

const initialState = useSftpStore.getState();

describe('SftpTabBar', () => {
  beforeEach(() => {
    useSftpStore.setState(initialState, true);
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

  it('shows separators only between tabs that are not adjacent to the active tab', () => {
    addConnection('Conn A');
    addConnection('Conn B');
    addConnection('Conn C');
    addConnection('Conn D');
    const connections = useSftpStore.getState().connections;
    useSftpStore.getState().setActiveConnection(connections[1]?.id ?? null);

    render(<SftpTabBar />);

    const tabs = screen.getAllByRole('tab');
    expect(tabs[0].querySelector('[data-tab-separator]')).not.toBeInTheDocument();
    expect(tabs[1].querySelector('[data-tab-separator]')).not.toBeInTheDocument();
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

  it('calls onNewTabClick when plus button is clicked', async () => {
    addConnection('Conn A');
    const onNewTabClick = vi.fn();
    render(
      <SftpTabBar
        onNewTabClick={onNewTabClick}
        onTabContextMenu={vi.fn()}
      />,
    );
    const plusButton = screen.getByRole('button', { name: 'sftp.newTab' });
    await userEvent.click(plusButton);
    expect(onNewTabClick).toHaveBeenCalled();
  });

  it('removes input padding while renaming a tab', async () => {
    addConnection('Conn A');
    render(
      <SftpTabBar
        onNewTabClick={vi.fn()}
        onTabContextMenu={vi.fn()}
      />,
    );

    await userEvent.dblClick(screen.getByText('Conn A'));

    expect(screen.getByRole('textbox')).toHaveClass('p-0', 'leading-none');
  });

  it('renders a 1px top line with the theme color on the active tab', () => {
    addConnection('Conn A');
    addConnection('Conn B');
    const connections = useSftpStore.getState().connections;
    useSftpStore.getState().setActiveConnection(connections[0]?.id ?? null);

    render(<SftpTabBar />);

    const tabs = screen.getAllByRole('tab');
    const indicator = tabs[0].querySelector<HTMLElement>('[data-active-tab-indicator]');
    expect(indicator).not.toBeNull();
    expect(indicator?.className).toContain('bg-app-primary');
  });

  it('does not render the top line on inactive tabs', () => {
    addConnection('Conn A');
    addConnection('Conn B');
    const connections = useSftpStore.getState().connections;
    useSftpStore.getState().setActiveConnection(connections[0]?.id ?? null);

    render(<SftpTabBar />);

    const tabs = screen.getAllByRole('tab');
    expect(tabs[1].querySelector('[data-active-tab-indicator]')).toBeNull();
  });
});
