import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import React from 'react';
import { useSftpStore } from '@/stores/sftpStore';
import { useSftpPaneActions, type UseSftpPaneActionsResult } from '@/hooks/useSftpPaneActions';
import { SftpContent } from '../index';

const paneRenderProps = vi.hoisted(() => ({
  history: [] as Array<{ side: string; selectedPaths: Set<string> }>,
}));

vi.mock('@/hooks/useI18n', () => ({
  useI18n: () => ({ t: (key: string) => key, locale: 'en-US' }),
}));

vi.mock('@/hooks/useSystemFileDrop', () => ({
  useSystemFileDrop: () => ({ dragActive: false, hoveredSide: null }),
}));

vi.mock('@/hooks/useSftpConnectionOpener', () => ({
  useSftpConnectionOpener: () => ({
    open: vi.fn(),
    verifyHostKey: vi.fn(),
    hostKeyDialog: { open: false },
    closeHostKeyDialog: vi.fn(),
  }),
}));

vi.mock('@/components/ui/split-pane', () => ({
  SplitPane: ({ left, right }: { left: React.ReactNode; right: React.ReactNode }) => (
    <div>
      <div data-testid="left-pane">{left}</div>
      <div data-testid="right-pane">{right}</div>
    </div>
  ),
}));

vi.mock('@/components/sftp/sftp-tab-bar', () => ({
  SftpTabBar: () => <div data-testid="sftp-tab-bar" />,
}));

vi.mock('@/components/sftp/sftp-dnd-context', () => ({
  SftpDndContext: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@/components/sftp/sftp-pane', () => ({
  SftpPane: React.forwardRef<HTMLDivElement, { side: string; selectedPaths: Set<string> }>(
    (props, _ref) => {
      paneRenderProps.history.push({ side: props.side, selectedPaths: props.selectedPaths });
      return <div data-testid={`sftp-pane-${props.side}`} />;
    },
  ),
}));

vi.mock('@/hooks/useSftpConnection', () => ({
  useSftpConnection: () => ({
    loadRemoteDirectory: vi.fn().mockResolvedValue(undefined),
    downloadRemotePaths: vi.fn(),
    invalidatePaneListingCache: vi.fn(),
  }),
}));

vi.mock('@/hooks/useLocalDirectory', () => ({
  useLocalDirectory: () => ({
    loadLocalDirectory: vi.fn().mockResolvedValue(undefined),
    openLocalPath: vi.fn().mockResolvedValue(undefined),
    previewLocalFile: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock('@/hooks/useSftpPaneActions', () => ({
  useSftpPaneActions: vi.fn(),
}));

vi.mock('@/lib/tauri', () => ({
  invokeListLocalDirectory: vi.fn().mockResolvedValue({ path: '/local', entries: [] }),
  invokeListRemoteDirectory: vi.fn().mockResolvedValue({ path: '/remote', entries: [] }),
}));

const initialState = useSftpStore.getState();

describe('SftpContent selection memoization', () => {
  beforeEach(() => {
    useSftpStore.setState(initialState, true);
    paneRenderProps.history.length = 0;
    vi.mocked(useSftpPaneActions).mockReturnValue({} as UseSftpPaneActionsResult);
  });

  it('passes referentially stable selection Sets to the panes across re-renders', () => {
    useSftpStore.getState().addConnection(
      { sessionId: 'c1', title: 'Test', host: 'h', port: 22, username: 'u' },
      { host: 'h', port: 22, username: 'u', authMethod: 'password' },
    );
    const connection = useSftpStore.getState().connections[0]!;

    const props = {
      connection,
      newConnectionMenuOpen: false,
      setNewConnectionMenuOpen: vi.fn(),
      tabContextMenu: null,
      setTabContextMenu: vi.fn(),
      openSftpConnection: vi.fn().mockResolvedValue(undefined),
      verifyHostKey: vi.fn().mockResolvedValue(undefined),
    } as const;

    const { rerender } = render(<SftpContent {...props} />);
    rerender(<SftpContent {...props} />);

    for (const side of ['local', 'remote']) {
      const renders = paneRenderProps.history.filter((entry) => entry.side === side);
      expect(renders.length).toBeGreaterThan(1);
      renders.forEach((entry) => expect(entry.selectedPaths).toBe(renders[0]!.selectedPaths));
    }
  });
});
