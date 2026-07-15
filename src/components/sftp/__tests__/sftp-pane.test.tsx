import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SftpPane } from '../sftp-pane';
import { useSftpStore } from '@/stores/sftpStore';

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
        selectedPaths={new Set()}
        onSelectedPathsChange={vi.fn()}
      />,
    );
    expect(screen.getByTestId('mock-file-list')).toBeInTheDocument();
  });

  it('toggles filter input visibility', () => {
    const connection = createConnection();
    render(
      <SftpPane
        connection={connection}
        side="local"
        selectedPaths={new Set()}
        onSelectedPathsChange={vi.fn()}
      />,
    );
    expect(screen.queryByPlaceholderText('sftp.filter')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('sftp.filter'));
    expect(screen.getByPlaceholderText('sftp.filter')).toBeInTheDocument();
  });

  it('updates filter query', () => {
    const connection = createConnection();
    render(
      <SftpPane
        connection={connection}
        side="local"
        selectedPaths={new Set()}
        onSelectedPathsChange={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText('sftp.filter'));
    const input = screen.getByPlaceholderText('sftp.filter');
    fireEvent.change(input, { target: { value: 'txt' } });
    expect(useSftpStore.getState().connections[0]?.localPane.filterQuery).toBe('txt');
  });
});
