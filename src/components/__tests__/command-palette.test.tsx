import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CommandPalette,
  buildCommandPaletteItems,
  findEnabledItemIndex,
  loadCommandPaletteBookmarks,
  type CommandPaletteItem,
} from '@/components/command-palette';
import { initI18n } from '@/locales';
import { useAppStore } from '@/stores/appStore';
import { usePortForwardStore } from '@/stores/portForwardStore';
import { useProfileStore } from '@/stores/profileStore';
import { useSftpStore, type SftpConnection } from '@/stores/sftpStore';
import { useTerminalStore } from '@/stores/terminalStore';
import type { ConnectionProfile, SftpBookmarkRow } from '@/types';

const { invokeListSftpBookmarks } = vi.hoisted(() => ({
  invokeListSftpBookmarks: vi.fn().mockResolvedValue([]),
}));

vi.mock('@/lib/tauri', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/tauri')>()),
  invokeListSftpBookmarks,
}));

const profile: ConnectionProfile = {
  id: 'profile-1',
  name: 'Production API',
  host: 'api.example.test',
  port: 22,
  username: 'deploy',
  authMethod: 'password',
  portForwards: [{
    id: 'forward-1',
    name: 'Database',
    kind: 'local',
    localPort: 15432,
    remoteHost: '127.0.0.1',
    remotePort: 5432,
    autoStart: false,
  }],
  quickActions: [
    {
      id: 'directory-1',
      kind: 'directory',
      label: 'Open releases',
      path: '/srv/releases',
      target: 'sftp',
    },
    {
      id: 'command-1',
      kind: 'command',
      label: 'Check status',
      command: 'systemctl status api',
    },
  ],
  createdAt: 1,
  updatedAt: 1,
};

const terminalSession = {
  sessionId: 'session-1',
  title: 'API shell',
  host: 'api.example.test',
  port: 22,
  username: 'deploy',
  status: 'connected' as const,
  profileId: profile.id,
};

function buildOptions(
  overrides: Partial<Parameters<typeof buildCommandPaletteItems>[0]> = {},
): Parameters<typeof buildCommandPaletteItems>[0] {
  return {
    profiles: [profile],
    terminalSessions: [terminalSession],
    activeTerminalSessionId: terminalSession.sessionId,
    sftpConnections: [],
    bookmarks: [],
    portForwardRuntimes: [],
    label: (key) => key,
    navigate: vi.fn(),
    openSettings: vi.fn(),
    connect: vi.fn(),
    openHostTool: vi.fn(),
    switchTerminal: vi.fn(),
    switchSftp: vi.fn(),
    openBookmark: vi.fn(),
    runQuickAction: vi.fn(),
    splitTerminal: vi.fn(),
    startForward: vi.fn(),
    ...overrides,
  };
}

describe('CommandPalette', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    invokeListSftpBookmarks.mockResolvedValue([]);
    await initI18n('en-US');
    useAppStore.setState({
      locale: 'en-US',
      activeSection: 'workbench',
      activeWorkbenchTab: 'connections',
      activeSettingsSection: 'general',
    });
    useProfileStore.setState({ profiles: [profile], initialized: true });
    useTerminalStore.setState({
      sessions: [terminalSession],
      activeSessionId: null,
    });
    useSftpStore.setState({ connections: [], activeConnectionId: null });
    usePortForwardStore.setState({ runtimes: [], initialized: true });
  });

  it('builds every roadmap action family without losing its host target', () => {
    const connect = vi.fn();
    const openBookmark = vi.fn();
    const runQuickAction = vi.fn();
    const startForward = vi.fn();
    const bookmark: SftpBookmarkRow = {
      id: 'bookmark-1',
      host: profile.host,
      port: profile.port,
      username: profile.username,
      path: '/var/log/api',
      side: 'remote',
      createdAt: 1,
    };
    const sftpConnection = {
      id: 'sftp-1',
      title: 'Omega browser',
      connection: {
        host: profile.host,
        port: profile.port,
        username: profile.username,
        authMethod: profile.authMethod,
      },
    } as SftpConnection;
    const items = buildCommandPaletteItems(buildOptions({
      terminalSessions: [terminalSession, { ...terminalSession, sessionId: 'session-2' }],
      sftpConnections: [sftpConnection],
      bookmarks: [{ profileId: profile.id, bookmark }],
      connect,
      openBookmark,
      runQuickAction,
      startForward,
    }));

    items.find((item) => item.id === 'profile-sftp-profile-1')?.run();
    items.find((item) => item.id === 'bookmark-profile-1-bookmark-1')?.run();
    items.find((item) => item.id === 'quick-action-profile-1-directory-1')?.run();
    items.find((item) => item.id === 'forward-profile-1-forward-1')?.run();

    expect(connect).toHaveBeenCalledWith('profile-1', 'sftp');
    expect(openBookmark).toHaveBeenCalledWith(profile, bookmark);
    expect(runQuickAction).toHaveBeenCalledWith(profile, profile.quickActions?.[0]);
    expect(startForward).toHaveBeenCalledWith(profile, 'forward-1');
    expect(items.map((item) => item.group)).toEqual(expect.arrayContaining([
      'navigation',
      'connection',
      'session',
      'bookmark',
      'quickAction',
      'forward',
      'settings',
    ]));
    expect(items.some((item) => item.id === 'navigation-runbooks')).toBe(false);
  });

  it('deduplicates bookmark loads by endpoint and retains a usable profile target', async () => {
    invokeListSftpBookmarks.mockResolvedValueOnce([{
      id: 'bookmark-1',
      host: profile.host,
      port: profile.port,
      username: profile.username,
      path: '/srv/api',
      side: 'remote',
      createdAt: 1,
    }]);

    const loaded = await loadCommandPaletteBookmarks([
      profile,
      { ...profile, id: 'profile-2', name: 'Same endpoint' },
    ]);

    expect(invokeListSftpBookmarks).toHaveBeenCalledOnce();
    expect(loaded).toEqual([
      expect.objectContaining({ profileId: 'profile-1' }),
      expect.objectContaining({ profileId: 'profile-2' }),
    ]);
  });

  it('disables snippets without a connected terminal and skips disabled rows by keyboard', () => {
    const items = buildCommandPaletteItems(buildOptions({ terminalSessions: [] }));
    expect(items.find((item) => item.id === 'quick-action-profile-1-command-1')).toMatchObject({
      disabled: true,
    });

    const keyboardItems = [
      { id: 'enabled-1', disabled: false },
      { id: 'disabled', disabled: true },
      { id: 'enabled-2', disabled: false },
    ] as CommandPaletteItem[];
    expect(findEnabledItemIndex(keyboardItems, 0, 1)).toBe(2);
    expect(findEnabledItemIndex(keyboardItems, 2, -1)).toBe(0);
  });

  it('opens from the global event, filters by host, and dispatches the selected action', async () => {
    const connectListener = vi.fn();
    document.addEventListener('shellspan:connect-profile', connectListener);
    render(<CommandPalette />);

    act(() => document.dispatchEvent(new Event('shellspan:open-command-palette')));
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'api.example sftp' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(connectListener).toHaveBeenCalledOnce());
    const event = connectListener.mock.calls[0][0] as CustomEvent;
    expect(event.detail).toEqual({ profileId: 'profile-1', target: 'sftp' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    document.removeEventListener('shellspan:connect-profile', connectListener);
  });

  it('loads and searches saved bookmarks across profiles when opened', async () => {
    invokeListSftpBookmarks.mockResolvedValueOnce([{
      id: 'bookmark-1',
      host: profile.host,
      port: profile.port,
      username: profile.username,
      path: '/var/log/api',
      label: 'API logs',
      side: 'remote',
      createdAt: 1,
    }]);
    render(<CommandPalette />);

    act(() => document.dispatchEvent(new Event('shellspan:open-command-palette')));
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'API logs' } });

    await waitFor(() => {
      expect(screen.getByText(/API logs/)).toBeInTheDocument();
    });
  });

  it('switches to existing terminal and SFTP sessions', async () => {
    const sftpConnection = {
      id: 'sftp-1',
      title: 'Omega browser',
      connection: {
        host: profile.host,
        port: profile.port,
        username: profile.username,
        authMethod: profile.authMethod,
      },
    } as SftpConnection;
    useSftpStore.setState({ connections: [sftpConnection], activeConnectionId: null });
    render(<CommandPalette />);

    act(() => document.dispatchEvent(new Event('shellspan:open-command-palette')));
    let input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'API shell' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(useTerminalStore.getState().activeSessionId).toBe('session-1'));
    expect(useAppStore.getState().activeSection).toBe('terminal');

    act(() => document.dispatchEvent(new Event('shellspan:open-command-palette')));
    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());
    input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'Omega browser' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(useSftpStore.getState().activeConnectionId).toBe('sftp-1'));
    expect(useAppStore.getState().activeSection).toBe('sftp');
  });

  it('opens the exact settings section selected from search', async () => {
    useAppStore.setState({ activeSection: 'terminal' });
    render(<CommandPalette />);
    act(() => document.dispatchEvent(new Event('shellspan:open-command-palette')));
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'Keyboard shortcuts' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => {
      expect(useAppStore.getState()).toMatchObject({
        activeSection: 'terminal',
        activeSettingsSection: 'shortcuts',
        settingsDialogOpen: true,
      });
    });
  });
});
