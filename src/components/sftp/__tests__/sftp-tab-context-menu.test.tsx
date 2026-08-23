import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { SftpTabContextMenu } from '../sftp-tab-context-menu';
import { useSftpStore, type SftpConnection } from '@/stores/sftpStore';
import { useProfileStore } from '@/stores/profileStore';
import { useTransferStore } from '@/stores/transferStore';

vi.mock('@/hooks/useI18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

const initialSftp = useSftpStore.getState();
const initialProfile = useProfileStore.getState();

const connection = {
  id: 'sftp-1',
  title: 'SFTP Tab',
  connection: {
    host: 'h',
    port: 22,
    username: 'u',
    authMethod: 'password',
  },
  pinned: true,
  profileId: 'profile-1',
} as SftpConnection;

describe('SftpTabContextMenu', () => {
  beforeEach(() => {
    useSftpStore.setState(initialSftp, true);
    useTransferStore.setState({ operations: [] });
    useProfileStore.setState(initialProfile, true);
    useProfileStore.setState({
      profiles: [
        {
          id: 'profile-1',
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
  });

  afterEach(() => {
    useSftpStore.setState(initialSftp, true);
    useProfileStore.setState(initialProfile, true);
  });
  it.each([
    ['common.close', 'sftp.tab.closeConfirmTitle'],
    ['sftp.tab.closeOthers', 'sftp.tab.closeOthersConfirmTitle'],
    ['sftp.tab.closeToRight', 'sftp.tab.closeToRightConfirmTitle'],
  ])(
    'shows the confirmation for %s after the parent closes the context menu',
    (menuItem, dialogTitle) => {
      const onClose = vi.fn();
      const { rerender } = render(
        <SftpTabContextMenu
          open
          x={10}
          y={10}
          connection={connection}
          onClose={onClose}
        />,
      );

      fireEvent.click(screen.getByText(menuItem));
      rerender(
        <SftpTabContextMenu
          open={false}
          x={0}
          y={0}
          connection={null}
          onClose={onClose}
        />,
      );

      expect(screen.getByText(dialogTitle)).toBeInTheDocument();
      expect(onClose).toHaveBeenCalledTimes(1);
    },
  );

  it('clears the rename dialog state before the context menu is reopened', () => {
    const onClose = vi.fn();
    const { rerender } = render(
      <SftpTabContextMenu
        open
        x={10}
        y={10}
        connection={connection}
        onClose={onClose}
      />,
    );

    fireEvent.click(screen.getByText('common.rename'));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.getByDisplayValue('SFTP Tab')).toBeInTheDocument();

    rerender(
      <SftpTabContextMenu
        open={false}
        x={0}
        y={0}
        connection={null}
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByText('common.cancel'));

    rerender(
      <SftpTabContextMenu
        open
        x={20}
        y={20}
        connection={connection}
        onClose={onClose}
      />,
    );

    expect(screen.queryByDisplayValue('SFTP Tab')).not.toBeInTheDocument();
    expect(screen.getByText('common.rename')).toBeInTheDocument();
  });

  it('duplicates the connection after the source tab and inherits pin state', () => {
    useSftpStore.setState({
      connections: [
        {
          ...connection,
          sessionId: 'c1',
          localPath: '',
          remotePath: '',
          localEntries: [],
          remoteEntries: [],
          localLoading: false,
          remoteLoading: false,
          localPane: { pathInput: '', filterQuery: '', selectedPaths: [], batchMode: false },
          remotePane: { pathInput: '', filterQuery: '', selectedPaths: [], batchMode: false },
          remoteBookmarks: { local: [], remote: [] },
          splitRatio: 0.5,
        },
        {
          id: 'sftp-2',
          sessionId: 'c2',
          title: 'Second',
          connection: connection.connection,
          profileId: 'profile-1',
          localPath: '',
          remotePath: '',
          localEntries: [],
          remoteEntries: [],
          localLoading: false,
          remoteLoading: false,
          localPane: { pathInput: '', filterQuery: '', selectedPaths: [], batchMode: false },
          remotePane: { pathInput: '', filterQuery: '', selectedPaths: [], batchMode: false },
          remoteBookmarks: { local: [], remote: [] },
          splitRatio: 0.5,
        },
      ],
      activeConnectionId: 'sftp-1',
    });

    const onClose = vi.fn();
    render(
      <SftpTabContextMenu
        open
        x={10}
        y={10}
        connection={useSftpStore.getState().connections[0]}
        onClose={onClose}
      />,
    );

    fireEvent.click(screen.getByText('common.duplicate'));

    const ids = useSftpStore.getState().connections.map((c) => c.id);
    expect(ids).toEqual(['sftp-1', expect.any(String), 'sftp-2']);
    expect(useSftpStore.getState().connections[1]).toMatchObject({
      title: 'Alpha',
      pinned: true,
      profileId: 'profile-1',
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
