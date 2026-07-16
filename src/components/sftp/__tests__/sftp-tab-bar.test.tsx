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

  it('closes a tab when close button is clicked', async () => {
    addConnection('Conn A');
    render(
      <SftpTabBar
        onNewTabClick={vi.fn()}
        onTabContextMenu={vi.fn()}
      />,
    );
    const closeButton = screen.getByRole('button', { name: 'close' });
    await userEvent.click(closeButton);
    expect(useSftpStore.getState().connections).toHaveLength(0);
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

    expect(screen.getByRole('textbox')).toHaveClass('p-0');
  });
});
