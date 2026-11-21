import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppShortcuts } from '../useAppShortcuts';
import { DEFAULT_SHORTCUTS, useAppStore } from '@/stores/appStore';
import { useTerminalStore } from '@/stores/terminalStore';
import { useAiPanelStore } from '@/stores/aiPanelStore';
import { useFocusStore } from '@/stores/focusStore';

describe('useAppShortcuts', () => {
  beforeEach(() => {
    useAppStore.setState({
      activeSection: 'workbench',
      activeWorkbenchTab: 'connections',
      shortcuts: { ...DEFAULT_SHORTCUTS },
    });
    useAiPanelStore.getState().setOpen(false);
  });

  it('navigates between app sections', () => {
    renderHook(() => useAppShortcuts());
    document.dispatchEvent(new KeyboardEvent('keydown', { key: '2', ctrlKey: true, bubbles: true }));
    expect(useAppStore.getState().activeSection).toBe('terminal');
  });

  it('opens the settings dialog without leaving the active section', () => {
    useAppStore.setState({ activeSection: 'terminal' });
    renderHook(() => useAppShortcuts());
    document.dispatchEvent(new KeyboardEvent('keydown', { key: ',', metaKey: true, bubbles: true }));
    expect(useAppStore.getState().activeSection).toBe('terminal');
    expect(useAppStore.getState().settingsDialogOpen).toBe(true);
  });

  it('opens the command palette through the configured global shortcut', () => {
    const listener = vi.fn();
    document.addEventListener('shellspan:open-command-palette', listener);
    renderHook(() => useAppShortcuts());

    document.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'p', ctrlKey: true, shiftKey: true, bubbles: true,
    }));

    expect(listener).toHaveBeenCalledOnce();
    document.removeEventListener('shellspan:open-command-palette', listener);
  });

  it('uses a customized binding immediately', () => {
    useAppStore.getState().setShortcut('openSftp', 'mod+shift+s');
    renderHook(() => useAppShortcuts());
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, shiftKey: true, bubbles: true }));
    expect(useAppStore.getState().activeSection).toBe('sftp');
  });

  it('does not open an AI panel in SFTP', () => {
    useAppStore.setState({ activeSection: 'sftp' });
    renderHook(() => useAppShortcuts());

    document.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'a', ctrlKey: true, shiftKey: true, bubbles: true,
    }));

    expect(useAiPanelStore.getState().panelOpenBySection).toEqual({
      workbench: false,
      terminal: false,
    });
  });

  it('dispatches terminal actions while the terminal is active', () => {
    useAppStore.setState({ activeSection: 'terminal' });
    const listener = vi.fn();
    document.addEventListener('shellspan:new-terminal-tab', listener);
    renderHook(() => useAppShortcuts());

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));

    expect(listener).toHaveBeenCalledOnce();
    document.removeEventListener('shellspan:new-terminal-tab', listener);
  });

  it('opens the terminal tab switcher with mod+shift+o only in the terminal section', () => {
    const listener = vi.fn();
    document.addEventListener('shellspan:switch-terminal-tab', listener);
    renderHook(() => useAppShortcuts());

    document.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'o', ctrlKey: true, shiftKey: true, bubbles: true,
    }));
    expect(listener).not.toHaveBeenCalled();

    useAppStore.setState({ activeSection: 'terminal' });
    document.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'o', ctrlKey: true, shiftKey: true, bubbles: true,
    }));
    expect(listener).toHaveBeenCalledOnce();

    document.removeEventListener('shellspan:switch-terminal-tab', listener);
  });

  it('scopes the same chord by section: mod+k toggles terminal vs sftp menus', () => {
    const terminalListener = vi.fn();
    const sftpListener = vi.fn();
    document.addEventListener('shellspan:new-terminal-tab', terminalListener);
    document.addEventListener('shellspan:new-sftp-connection', sftpListener);
    renderHook(() => useAppShortcuts());

    useAppStore.setState({ activeSection: 'sftp' });
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
    expect(sftpListener).toHaveBeenCalledOnce();
    expect(terminalListener).not.toHaveBeenCalled();

    useAppStore.setState({ activeSection: 'terminal' });
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
    expect(terminalListener).toHaveBeenCalledOnce();
    expect(sftpListener).toHaveBeenCalledOnce();

    document.removeEventListener('shellspan:new-terminal-tab', terminalListener);
    document.removeEventListener('shellspan:new-sftp-connection', sftpListener);
  });

  it('ignores leader bindings and leader sub-keys at the document level', () => {
    useAppStore.setState({ activeSection: 'terminal' });
    renderHook(() => useAppShortcuts());

    const leaderEvent = new KeyboardEvent('keydown', { key: 'b', ctrlKey: true, bubbles: true, cancelable: true });
    document.dispatchEvent(leaderEvent);
    expect(leaderEvent.defaultPrevented).toBe(false);

    const subKeyEvent = new KeyboardEvent('keydown', { key: 'h', bubbles: true, cancelable: true });
    document.dispatchEvent(subKeyEvent);
    expect(subKeyEvent.defaultPrevented).toBe(false);
  });

  it('cycles terminal tabs', () => {
    useAppStore.setState({ activeSection: 'terminal' });
    useTerminalStore.setState({
      sessions: [
        { sessionId: 's1', title: 'One', host: 'h', port: 22, username: 'u', status: 'connected' },
        { sessionId: 's2', title: 'Two', host: 'h', port: 22, username: 'u', status: 'connected' },
      ],
      activeSessionId: 's1',
    });
    renderHook(() => useAppShortcuts());

    document.dispatchEvent(new KeyboardEvent('keydown', { key: ']', ctrlKey: true, shiftKey: true, bubbles: true }));

    expect(useTerminalStore.getState().activeSessionId).toBe('s2');
  });

  it('opens keyboard shortcuts settings directly with mod+/', () => {
    useAppStore.setState({ activeSection: 'terminal', settingsDialogOpen: false, activeSettingsSection: 'general' });
    renderHook(() => useAppShortcuts());

    document.dispatchEvent(new KeyboardEvent('keydown', { key: '/', metaKey: true, bubbles: true }));

    expect(useAppStore.getState().settingsDialogOpen).toBe(true);
    expect(useAppStore.getState().activeSettingsSection).toBe('shortcuts');
  });

  it('toggles Focus Mode with mod+shift+f only when showFocusMode is enabled', () => {
    useFocusStore.setState({ enabled: false });
    useAppStore.setState({ showFocusMode: false, activeSection: 'terminal' });
    renderHook(() => useAppShortcuts());

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, shiftKey: true, bubbles: true }));
    expect(useFocusStore.getState().enabled).toBe(false);

    useAppStore.setState({ showFocusMode: true });
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, shiftKey: true, bubbles: true }));
    expect(useFocusStore.getState().enabled).toBe(true);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, shiftKey: true, bubbles: true }));
    expect(useFocusStore.getState().enabled).toBe(false);
  });

  it('dispatches new terminal actions while terminal is active', () => {
    useAppStore.setState({ activeSection: 'terminal' });
    const clearListener = vi.fn();
    const sendAiListener = vi.fn();
    document.addEventListener('shellspan:clear-terminal-screen', clearListener);
    document.addEventListener('shellspan:send-terminal-to-ai', sendAiListener);
    renderHook(() => useAppShortcuts());

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, shiftKey: true, bubbles: true }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'l', ctrlKey: true, shiftKey: true, bubbles: true }));
    expect(clearListener).toHaveBeenCalledOnce();
    expect(sendAiListener).toHaveBeenCalledOnce();

    document.removeEventListener('shellspan:clear-terminal-screen', clearListener);
    document.removeEventListener('shellspan:send-terminal-to-ai', sendAiListener);
  });

  it('dispatches new SFTP file shortcuts and toggles hidden files while SFTP is active', () => {
    useAppStore.setState({ activeSection: 'sftp', sftpShowHiddenFiles: false });
    const refreshListener = vi.fn();
    const newFolderListener = vi.fn();
    const focusPathListener = vi.fn();
    const parentListener = vi.fn();
    const openTerminalListener = vi.fn();
    document.addEventListener('shellspan:sftp-refresh', refreshListener);
    document.addEventListener('shellspan:sftp-new-folder', newFolderListener);
    document.addEventListener('shellspan:sftp-focus-path', focusPathListener);
    document.addEventListener('shellspan:sftp-parent-directory', parentListener);
    document.addEventListener('shellspan:sftp-open-terminal-here', openTerminalListener);
    renderHook(() => useAppShortcuts());

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'r', ctrlKey: true, bubbles: true }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', ctrlKey: true, shiftKey: true, bubbles: true }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: '>', ctrlKey: true, shiftKey: true, bubbles: true }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'l', ctrlKey: true, bubbles: true }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', ctrlKey: true, bubbles: true }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 't', ctrlKey: true, shiftKey: true, bubbles: true }));

    expect(refreshListener).toHaveBeenCalledOnce();
    expect(newFolderListener).toHaveBeenCalledOnce();
    expect(useAppStore.getState().sftpShowHiddenFiles).toBe(true);
    expect(focusPathListener).toHaveBeenCalledOnce();
    expect(parentListener).toHaveBeenCalledOnce();
    expect(openTerminalListener).toHaveBeenCalledOnce();

    document.removeEventListener('shellspan:sftp-refresh', refreshListener);
    document.removeEventListener('shellspan:sftp-new-folder', newFolderListener);
    document.removeEventListener('shellspan:sftp-focus-path', focusPathListener);
    document.removeEventListener('shellspan:sftp-parent-directory', parentListener);
    document.removeEventListener('shellspan:sftp-open-terminal-here', openTerminalListener);
  });
});
