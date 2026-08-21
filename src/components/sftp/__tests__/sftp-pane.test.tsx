import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { SftpPane } from '../sftp-pane';
import { useSftpStore } from '@/stores/sftpStore';
import type { UseSftpPaneActionsResult } from '@/hooks/useSftpPaneActions';
import { useAppStore } from '@/stores/appStore';
import { invokeListLocalDirectory } from '@/lib/tauri';

vi.mock('@/hooks/useI18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
    locale: 'en-US',
  }),
}));

const fileListRenderProps = vi.hoisted(() => ({
  selectedPathsHistory: [] as unknown[],
}));

vi.mock('../sftp-file-list', () => ({
  SftpFileList: (props: {
    entries: Array<{ path: string; name: string; kind: string }>;
    selectedPaths?: string[];
    onDoubleClick?: (entry: { path: string; name: string; kind: string }) => void;
  }) => {
    fileListRenderProps.selectedPathsHistory.push(props.selectedPaths);
    return (
      <div data-testid="mock-file-list">
        {props.entries.map((entry) => (
          <div
            key={entry.path}
            data-testid={`entry-${entry.name}`}
            onDoubleClick={() => props.onDoubleClick?.(entry)}
          >
            {entry.name}
          </div>
        ))}
      </div>
    );
  },
}));

vi.mock('@/lib/tauri', () => ({
  invokeListLocalDirectory: vi.fn().mockResolvedValue({
    path: '/home',
    entries: [],
  }),
  invokeListRemoteDirectory: vi.fn().mockResolvedValue({
    path: '/remote',
    entries: [],
  }),
}));

const initialState = useSftpStore.getState();

function createMockActions(): UseSftpPaneActionsResult {
  return {
    createMode: null,
    renameTarget: undefined,
    permissionsTarget: undefined,
    propertiesTarget: undefined,
    previewTarget: undefined,
    previewContent: undefined,
    hasLocalClipboard: false,
    onOpen: vi.fn(),
    onOpenWithDefaultEditor: vi.fn().mockResolvedValue(undefined),
    onPreview: vi.fn().mockResolvedValue(undefined),
    onDownload: vi.fn().mockResolvedValue(undefined),
    onBatchDownload: vi.fn().mockResolvedValue(undefined),
    uploadWithPolicies: vi.fn().mockResolvedValue(undefined),
    copyWithPolicies: vi.fn().mockResolvedValue(undefined),
    onCopy: vi.fn(),
    onPaste: vi.fn().mockResolvedValue(undefined),
    onRename: vi.fn(),
    onDelete: vi.fn().mockResolvedValue(undefined),
    onCopyName: vi.fn().mockResolvedValue(undefined),
    onCopyPath: vi.fn().mockResolvedValue(undefined),
    onCopyContainingDirectory: vi.fn().mockResolvedValue(undefined),
    onNewFile: vi.fn(),
    onNewFolder: vi.fn(),
    onUploadFiles: vi.fn().mockResolvedValue(undefined),
    onUploadFolders: vi.fn().mockResolvedValue(undefined),
    onEditPermissions: vi.fn(),
    onProperties: vi.fn(),
    onToggleBookmark: vi.fn(),
    onRefresh: vi.fn().mockResolvedValue(undefined),
    onToggleBatchMode: vi.fn(),
    onCopyCurrentDirectoryPath: vi.fn().mockResolvedValue(undefined),
    setCreateMode: vi.fn(),
    setRenameTarget: vi.fn(),
    setPermissionsTarget: vi.fn(),
    setPropertiesTarget: vi.fn(),
    closePreview: vi.fn(),
    handleCreate: vi.fn().mockResolvedValue(undefined),
    handleRename: vi.fn().mockResolvedValue(undefined),
    handlePermissions: vi.fn().mockResolvedValue(undefined),
  };
}

describe('SftpPane', () => {
  beforeEach(() => {
    useSftpStore.setState(initialState, true);
    useAppStore.setState({ sftpShowHiddenFiles: true });
    fileListRenderProps.selectedPathsHistory.length = 0;
  });

  const createConnection = (): ReturnType<typeof useSftpStore.getState>['connections'][number] => {
    useSftpStore.getState().addConnection(
      {
        sessionId: 'c1',
        title: 'Test',
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
    return useSftpStore.getState().connections[0]!;
  };

  it('renders local pane title', () => {
    const connection = createConnection();
    render(
      <SftpPane
        connection={connection}
        side="local"
        actions={createMockActions()}
        selectedPaths={new Set()}
        onSelectedPathsChange={vi.fn()}
      />,
    );
    expect(screen.getByText('sftp.local')).toBeInTheDocument();
  });

  it('renders remote pane title', () => {
    const connection = createConnection();
    render(
      <SftpPane
        connection={connection}
        side="remote"
        actions={createMockActions()}
        selectedPaths={new Set()}
        onSelectedPathsChange={vi.fn()}
      />,
    );
    expect(screen.getByText('Test')).toBeInTheDocument();
  });

  it('renders the right pane as local with a source switch action', () => {
    const connection = createConnection();
    const onTitleClick = vi.fn();
    render(
      <SftpPane
        connection={connection}
        side="remote"
        localMode
        onTitleClick={onTitleClick}
        actions={createMockActions()}
        selectedPaths={new Set()}
        onSelectedPathsChange={vi.fn()}
      />,
    );

    expect(screen.getByText('sftp.local')).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole('button', { name: 'sftp.source.switch' }),
    );
    expect(onTitleClick).toHaveBeenCalledTimes(1);
  });

  it('renders file list', () => {
    const connection = createConnection();
    render(
      <SftpPane
        connection={connection}
        side="local"
        actions={createMockActions()}
        selectedPaths={new Set()}
        onSelectedPathsChange={vi.fn()}
      />,
    );
    expect(screen.getByTestId('mock-file-list')).toBeInTheDocument();
  });

  it('hides dotfiles when hidden files are disabled', () => {
    const connection = createConnection();
    connection.localEntries = [
      { path: '/home/visible.txt', name: 'visible.txt', kind: 'file' },
      { path: '/home/.env', name: '.env', kind: 'file' },
    ];
    useAppStore.setState({ sftpShowHiddenFiles: false });

    render(
      <SftpPane
        connection={connection}
        side="local"
        actions={createMockActions()}
        selectedPaths={new Set()}
        onSelectedPathsChange={vi.fn()}
      />,
    );

    expect(screen.getByTestId('entry-visible.txt')).toBeInTheDocument();
    expect(screen.queryByTestId('entry-.env')).not.toBeInTheDocument();
  });

  it('shows a host-key verification entry for an unknown remote host', () => {
    const connection = createConnection();
    connection.remoteError =
      'host key for 175.178.66.45:22 is not known — trust this host before connecting';
    const onVerifyHostKey = vi.fn();

    render(
      <SftpPane
        connection={connection}
        side="remote"
        actions={createMockActions()}
        selectedPaths={new Set()}
        onSelectedPathsChange={vi.fn()}
        onVerifyHostKey={onVerifyHostKey}
      />,
    );

    fireEvent.click(
      screen.getByRole('button', { name: 'sftp.hostKey.verify' }),
    );
    expect(onVerifyHostKey).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('common.retry')).not.toBeInTheDocument();
  });

  it('renders a log-style toolbar in remote batch selection mode', () => {
    const connection = createConnection();
    const entry = {
      path: '/remote/test.txt',
      name: 'test.txt',
      kind: 'file' as const,
      size: 100,
    };
    connection.remoteEntries = [entry];
    connection.remotePane.batchMode = true;
    connection.remotePane.selectedPaths = [entry.path];
    const actions = createMockActions();
    const onSelectedPathsChange = vi.fn();

    render(
      <SftpPane
        connection={connection}
        side="remote"
        actions={actions}
        selectedPaths={new Set([entry.path])}
        onSelectedPathsChange={onSelectedPathsChange}
      />,
    );

    expect(screen.getByText('sftp.selection.selectedCount')).toBeInTheDocument();
    expect(screen.getByText('common.cancel').closest('button')).toHaveClass('h-6');

    fireEvent.click(screen.getByText('sftp.selection.selectAll'));
    expect(onSelectedPathsChange).toHaveBeenCalledWith(new Set([entry.path]));

    fireEvent.click(screen.getByText('common.download'));
    expect(actions.onBatchDownload).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByText('common.delete'));
    expect(actions.onDelete).toHaveBeenCalledWith([entry]);

    fireEvent.click(screen.getByText('common.cancel'));
    expect(actions.onToggleBatchMode).toHaveBeenCalledTimes(1);
  });

  it('exits batch selection mode with Escape', () => {
    const connection = createConnection();
    connection.localPane.batchMode = true;
    const actions = createMockActions();

    render(
      <SftpPane
        connection={connection}
        side="local"
        actions={actions}
        selectedPaths={new Set()}
        onSelectedPathsChange={vi.fn()}
      />,
    );

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(actions.onToggleBatchMode).toHaveBeenCalledTimes(1);
  });

  it('opens and focuses the file filter with Cmd/Ctrl+F', () => {
    const connection = createConnection();
    render(
      <SftpPane
        connection={connection}
        side="local"
        actions={createMockActions()}
        selectedPaths={new Set()}
        onSelectedPathsChange={vi.fn()}
      />,
    );

    // Fire on an element inside the pane so the keydown bubbles to the root.
    fireEvent.keyDown(screen.getByText('sftp.local'), { key: 'f', metaKey: true });

    const input = screen.getByPlaceholderText('sftp.filter');
    expect(input.tabIndex).toBe(0);
    expect(input).toHaveFocus();
  });

  it('dismisses the file filter with Escape, clearing the query', () => {
    const connection = createConnection();
    render(
      <SftpPane
        connection={connection}
        side="local"
        actions={createMockActions()}
        selectedPaths={new Set()}
        onSelectedPathsChange={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'sftp.showFilter' }));
    const input = screen.getByPlaceholderText('sftp.filter');
    fireEvent.change(input, { target: { value: 'report' } });
    expect(input).toHaveValue('report');

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(input).toHaveValue('');
    expect(input.tabIndex).toBe(-1);
  });

  it('clears the filter query when the path changes', () => {
    const connection = createConnection();
    const { rerender } = render(
      <SftpPane
        connection={connection}
        side="local"
        actions={createMockActions()}
        selectedPaths={new Set()}
        onSelectedPathsChange={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'sftp.showFilter' }));
    const input = screen.getByPlaceholderText('sftp.filter');
    fireEvent.change(input, { target: { value: 'report' } });
    expect(input).toHaveValue('report');

    rerender(
      <SftpPane
        connection={{ ...connection, localPath: '/elsewhere' }}
        side="local"
        actions={createMockActions()}
        selectedPaths={new Set()}
        onSelectedPathsChange={vi.fn()}
      />,
    );

    expect(input).toHaveValue('');
  });

  it('clears the query when the filter is toggled closed via the icon', () => {
    const connection = createConnection();
    render(
      <SftpPane
        connection={connection}
        side="local"
        actions={createMockActions()}
        selectedPaths={new Set()}
        onSelectedPathsChange={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'sftp.showFilter' }));
    const input = screen.getByPlaceholderText('sftp.filter');
    fireEvent.change(input, { target: { value: 'report' } });

    fireEvent.click(screen.getByRole('button', { name: 'sftp.hideFilter' }));

    expect(input).toHaveValue('');
    expect(input.tabIndex).toBe(-1);
  });

  it('passes a referentially stable selectedPaths array to the file list', () => {
    const connection = createConnection();
    const selected = new Set(['/home/a.txt']);
    const { rerender } = render(
      <SftpPane
        connection={connection}
        side="local"
        actions={createMockActions()}
        selectedPaths={selected}
        onSelectedPathsChange={vi.fn()}
      />,
    );

    rerender(
      <SftpPane
        connection={connection}
        side="local"
        actions={createMockActions()}
        selectedPaths={selected}
        onSelectedPathsChange={vi.fn()}
      />,
    );

    const history = fileListRenderProps.selectedPathsHistory;
    expect(history.length).toBeGreaterThan(1);
    history.forEach((entry) => expect(entry).toBe(history[0]));
  });

  it('syncs the initial history entry and navigates back and forward exactly once', async () => {
    vi.mocked(invokeListLocalDirectory).mockImplementation((path?: string) =>
      Promise.resolve({
        path: path || '/home',
        entries:
          !path || path === '/home'
            ? [{ path: '/home/docs', name: 'docs', kind: 'directory' as const }]
            : [],
      }),
    );

    const connection = createConnection();
    const renderPane = (conn: typeof connection) => (
      <StrictMode>
        <SftpPane
          connection={conn}
          side="local"
          actions={createMockActions()}
          selectedPaths={new Set()}
          onSelectedPathsChange={vi.fn()}
        />
      </StrictMode>
    );
    const { container, rerender } = render(renderPane(connection));

    // The first load resolves the real path; once it lands on the connection
    // it must replace the empty mount-time history entry.
    await waitFor(() =>
      expect(useSftpStore.getState().connections[0]?.localPath).toBe('/home'),
    );
    rerender(renderPane(useSftpStore.getState().connections[0]!));

    fireEvent.doubleClick(screen.getByTestId('entry-docs'));
    await waitFor(() =>
      expect(vi.mocked(invokeListLocalDirectory)).toHaveBeenCalledWith('/home/docs'),
    );

    const backButton = container.querySelector('.lucide-chevron-left')!.closest('button')!;
    const forwardButton = container.querySelector('.lucide-chevron-right')!.closest('button')!;

    vi.mocked(invokeListLocalDirectory).mockClear();
    fireEvent.click(backButton);
    // Back lands on the real first path — not '' — and StrictMode does not
    // fire the navigation twice.
    expect(invokeListLocalDirectory).toHaveBeenCalledTimes(1);
    expect(invokeListLocalDirectory).toHaveBeenCalledWith('/home');

    fireEvent.click(forwardButton);
    expect(invokeListLocalDirectory).toHaveBeenCalledTimes(2);
    expect(invokeListLocalDirectory).toHaveBeenLastCalledWith('/home/docs');
  });
});
