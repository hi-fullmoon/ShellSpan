import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { SftpPane } from '../sftp-pane';
import { useSftpStore } from '@/stores/sftpStore';
import type { UseSftpPaneActionsResult } from '@/hooks/useSftpPaneActions';

vi.mock('@/hooks/useI18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
    locale: 'en-US',
  }),
}));

vi.mock('../sftp-file-list', () => ({
  SftpFileList: ({
    entries,
    onDoubleClick,
  }: {
    entries: Array<{ path: string; name: string; kind: string }>;
    onDoubleClick?: (entry: { path: string; name: string; kind: string }) => void;
  }) => (
    <div data-testid="mock-file-list">
      {entries.map((entry) => (
        <div
          key={entry.path}
          data-testid={`entry-${entry.name}`}
          onDoubleClick={() => onDoubleClick?.(entry)}
        >
          {entry.name}
        </div>
      ))}
    </div>
  ),
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
    previewContent: undefined,
    uploadConflict: undefined,
    onOpen: vi.fn(),
    onOpenWithDefaultEditor: vi.fn().mockResolvedValue(undefined),
    onPreview: vi.fn().mockResolvedValue(undefined),
    onDownload: vi.fn().mockResolvedValue(undefined),
    onBatchDownload: vi.fn().mockResolvedValue(undefined),
    uploadWithPolicies: vi.fn().mockResolvedValue(undefined),
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
    setPreviewContent: vi.fn(),
    setUploadConflict: vi.fn(),
    handleCreate: vi.fn().mockResolvedValue(undefined),
    handleRename: vi.fn().mockResolvedValue(undefined),
    handlePermissions: vi.fn().mockResolvedValue(undefined),
  };
}

describe('SftpPane', () => {
  beforeEach(() => {
    useSftpStore.setState(initialState, true);
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
});
