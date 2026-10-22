import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useAppShortcuts } from '@/hooks/useAppShortcuts';
import { DEFAULT_SHORTCUTS, mergeShortcutBindings, useAppStore } from '@/stores/appStore';
import { DndContext } from '@dnd-kit/core';
import { SftpPane } from '../sftp-pane';
import { useSftpPaneActions } from '@/hooks/useSftpPaneActions';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { SftpConnection, SftpSide } from '@/stores/sftpStore';
import { changeLocale, t } from '@/locales';
import { useSftpStore } from '@/stores/sftpStore';
import { findShortcutConflict } from '@/lib/shortcuts';
import { SftpTabSwitcher } from '../sftp-tab-switcher';
import { SftpTabBar } from '../sftp-tab-bar';

function Workspace() {
  useAppShortcuts();
  return <><SftpTabBar /><SftpTabSwitcher /></>;
}

function press(key: string, shiftKey = false) {
  fireEvent.keyDown(document.activeElement ?? document, { key, ctrlKey: true, shiftKey });
}

function Pane({ connection, side }: { connection: SftpConnection; side: SftpSide }) {
  const actions = useSftpPaneActions(connection, side, true);
  return <SftpPane connection={connection} side={side} localMode actions={actions}
    selectedPaths={new Set(connection[side === 'local' ? 'localPane' : 'remotePane'].selectedPaths)}
    onSelectedPathsChange={(paths) => useSftpStore.getState().setPaneState(connection.id, side, { selectedPaths: [...paths] })} />;
}

function DualPaneWorkspace() {
  const connection = useSftpStore((state) => state.connections.find((item) => item.id === state.activeConnectionId));
  useAppShortcuts();
  return connection && <TooltipProvider><DndContext><Pane connection={connection} side="local" /><Pane connection={connection} side="remote" /></DndContext></TooltipProvider>;
}

describe('SFTP shortcuts', () => {
  beforeEach(async () => {
    useAppStore.setState({ locale: 'en-US', activeSection: 'sftp', shortcuts: { ...DEFAULT_SHORTCUTS }, sftpHideSingleTabBar: true });
    await changeLocale('en-US');
    useSftpStore.setState({ connections: [], activeConnectionId: null });
    useSftpStore.getState().addLocalConnection();
  });

  it('checks SFTP and global conflicts while allowing terminal bindings', () => {
    expect(findShortcutConflict(DEFAULT_SHORTCUTS, 'findSftp', 'mod+w')).toBe('closeSftpTab');
    expect(findShortcutConflict(DEFAULT_SHORTCUTS, 'findSftp', 'mod+2')).toBe('openTerminal');
    for (const action of ['findSftp', 'closeSftpTab', 'switchSftpTab', 'nextSftpTab', 'previousSftpTab'] as const) {
      expect(findShortcutConflict(DEFAULT_SHORTCUTS, action, DEFAULT_SHORTCUTS[action])).toBeNull();
    }
  });

  it('detects literal Control overlapping a portable binding', () => {
    expect(findShortcutConflict({ ...DEFAULT_SHORTCUTS, closeSftpTab: 'ctrl+b' }, 'findSftp', 'mod+b')).toBe('closeSftpTab');
    expect(findShortcutConflict(DEFAULT_SHORTCUTS, 'openSettings', 'mod+b')).toBe('terminalLeader');
  });

  it('preserves older custom bindings when new defaults conflict', () => {
    const merged = mergeShortcutBindings({ newSftpConnection: 'mod+f', openSettings: 'mod+w' });
    expect(merged.newSftpConnection).toBe('mod+f');
    expect(merged.openSettings).toBe('mod+w');
    expect(merged.findSftp).toBe('');
    expect(merged.closeSftpTab).toBe('');
    expect(mergeShortcutBindings(merged)).toEqual(merged);
  });

  it('opens only the focused pane and Escape clears only that pane', async () => {
    useAppStore.getState().setShortcut('findSftp', 'mod+shift+f');
    render(<DualPaneWorkspace />);
    const filters = screen.getAllByRole('textbox', { name: t('sftp.filter') });
    expect(filters).toHaveLength(2);
    for (const input of filters) {
      const pane = input.closest('[data-sftp-pane]') as HTMLElement;
      act(() => within(pane).getByRole('button', { name: t('sftp.showFilter') }).focus());
      press('f');
      expect(input).toHaveAttribute('tabindex', '-1');
      press('f', true);
      expect(input).toHaveFocus();
      fireEvent.change(input, { target: { value: 'directory' } });
    }
    expect(filters[0]).toHaveValue('directory');
    expect(filters[1]).toHaveValue('directory');
    fireEvent.keyDown(filters[1], { key: 'Escape' });
    expect(filters[1]).toHaveValue('');
    expect(filters[1]).toHaveAttribute('tabindex', '-1');
    expect(filters[0]).toHaveValue('directory');
    expect(filters[0]).toHaveAttribute('tabindex', '0');
  });

  it('keeps the confirmation target fixed and blocks all SFTP actions until cancellation', () => {
    const first = useSftpStore.getState().activeConnectionId!;
    useSftpStore.getState().addLocalConnection();
    const target = useSftpStore.getState().activeConnectionId!;
    render(<Workspace />);
    press('w');
    const alert = screen.getByRole('alertdialog');
    fireEvent.keyDown(alert, { key: '}', ctrlKey: true, shiftKey: true });
    expect(useSftpStore.getState().activeConnectionId).toBe(target);
    fireEvent.keyDown(alert, { key: 'o', ctrlKey: true, shiftKey: true });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.keyDown(alert, { key: 'w', ctrlKey: true });
    expect(useSftpStore.getState().connections.map((connection) => connection.id)).toEqual([first, target]);
    const buttons = within(alert).getAllByRole('button');
    fireEvent.click(buttons[0]);
    expect(useSftpStore.getState().connections).toHaveLength(2);
  });

  it('dispatches only the configured search binding and ignores dialogs and composition', () => {
    let requests = 0;
    const onSearch = () => { requests++; };
    document.addEventListener('shellspan:find-sftp', onSearch);
    try {
      render(<Workspace />);
      act(() => useAppStore.getState().setShortcut('findSftp', 'mod+shift+f'));
      press('f');
      expect(requests).toBe(0);
      press('f', true);
      expect(requests).toBe(1);
      fireEvent.keyDown(document, { key: 'f', ctrlKey: true, shiftKey: true, isComposing: true });
      expect(requests).toBe(1);
      press('o', true);
      fireEvent.keyDown(screen.getByRole('dialog'), { key: 'f', ctrlKey: true, shiftKey: true });
      expect(requests).toBe(1);
    } finally {
      document.removeEventListener('shellspan:find-sftp', onSearch);
    }
  });

  it('cycles tabs in both directions with wraparound and respects the active section', () => {
    const first = useSftpStore.getState().activeConnectionId;
    useSftpStore.getState().addLocalConnection();
    const second = useSftpStore.getState().activeConnectionId;
    render(<Workspace />);
    press('}', true);
    expect(useSftpStore.getState().activeConnectionId).toBe(first);
    press('{', true);
    expect(useSftpStore.getState().activeConnectionId).toBe(second);
    act(() => useAppStore.setState({ activeSection: 'terminal' }));
    press(']', true);
    expect(useSftpStore.getState().activeConnectionId).toBe(second);
  });

  it('uses a changed list binding immediately, filters tabs and selects with Enter', () => {
    const first = useSftpStore.getState().activeConnectionId!;
    useSftpStore.getState().updateTitle(first, 'Documents');
    useSftpStore.getState().addLocalConnection();
    render(<Workspace />);
    act(() => useAppStore.getState().setShortcut('switchSftpTab', 'mod+shift+l'));
    press('o', true);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    press('l', true);
    const dialog = screen.getByRole('dialog');
    expect(dialog.className).toContain('min-h-0');
    expect(within(dialog).getByText(/L$/)).toBeInTheDocument();
    const input = within(dialog).getByRole('searchbox');
    fireEvent.change(input, { target: { value: 'Documents' } });
    expect(within(dialog).getAllByRole('option')).toHaveLength(1);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(useSftpStore.getState().activeConnectionId).toBe(first);
  });

  it('keeps close confirmation and cancellation when the single tab bar is hidden', () => {
    const id = useSftpStore.getState().activeConnectionId;
    render(<Workspace />);
    press('w');
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(useSftpStore.getState().activeConnectionId).toBe(id);
    fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Escape' });
    expect(useSftpStore.getState().activeConnectionId).toBe(id);
  });

  it('removes only the confirmed tab after explicit confirmation', () => {
    const first = useSftpStore.getState().activeConnectionId;
    useSftpStore.getState().addLocalConnection();
    render(<Workspace />);
    press('w');
    const alert = screen.getByRole('alertdialog');
    expect(useSftpStore.getState().connections).toHaveLength(2);
    fireEvent.click(within(alert).getByRole('button', { name: t('common.close') }));
    expect(useSftpStore.getState().connections.map((connection) => connection.id)).toEqual([first]);
  });
});
