import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppShortcuts } from '../useAppShortcuts';
import { DEFAULT_SHORTCUTS, useAppStore } from '@/stores/appStore';
import { useTerminalStore } from '@/stores/terminalStore';

describe('useAppShortcuts', () => {
  beforeEach(() => {
    useAppStore.setState({
      activeSection: 'workbench',
      activeWorkbenchTab: 'connections',
      shortcuts: { ...DEFAULT_SHORTCUTS },
    });
  });

  it('navigates between app sections', () => {
    renderHook(() => useAppShortcuts());
    document.dispatchEvent(new KeyboardEvent('keydown', { key: '2', ctrlKey: true, bubbles: true }));
    expect(useAppStore.getState().activeSection).toBe('terminal');
  });

  it('opens the settings tab', () => {
    renderHook(() => useAppShortcuts());
    document.dispatchEvent(new KeyboardEvent('keydown', { key: ',', metaKey: true, bubbles: true }));
    expect(useAppStore.getState().activeSection).toBe('workbench');
    expect(useAppStore.getState().activeWorkbenchTab).toBe('settings');
  });

  it('opens the command palette through the configured global shortcut', () => {
    const listener = vi.fn();
    document.addEventListener('termbridge:open-command-palette', listener);
    renderHook(() => useAppShortcuts());

    document.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'p', ctrlKey: true, shiftKey: true, bubbles: true,
    }));

    expect(listener).toHaveBeenCalledOnce();
    document.removeEventListener('termbridge:open-command-palette', listener);
  });

  it('uses a customized binding immediately', () => {
    useAppStore.getState().setShortcut('openSftp', 'mod+shift+s');
    renderHook(() => useAppShortcuts());
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, shiftKey: true, bubbles: true }));
    expect(useAppStore.getState().activeSection).toBe('sftp');
  });

  it('dispatches terminal actions while the terminal is active', () => {
    useAppStore.setState({ activeSection: 'terminal' });
    const listener = vi.fn();
    document.addEventListener('termbridge:new-terminal-tab', listener);
    renderHook(() => useAppShortcuts());

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));

    expect(listener).toHaveBeenCalledOnce();
    document.removeEventListener('termbridge:new-terminal-tab', listener);
  });

  it('opens the terminal tab switcher with mod+shift+o only in the terminal section', () => {
    const listener = vi.fn();
    document.addEventListener('termbridge:switch-terminal-tab', listener);
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

    document.removeEventListener('termbridge:switch-terminal-tab', listener);
  });

  it('scopes the same chord by section: mod+k toggles terminal vs sftp menus', () => {
    const terminalListener = vi.fn();
    const sftpListener = vi.fn();
    document.addEventListener('termbridge:new-terminal-tab', terminalListener);
    document.addEventListener('termbridge:new-sftp-connection', sftpListener);
    renderHook(() => useAppShortcuts());

    useAppStore.setState({ activeSection: 'sftp' });
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
    expect(sftpListener).toHaveBeenCalledOnce();
    expect(terminalListener).not.toHaveBeenCalled();

    useAppStore.setState({ activeSection: 'terminal' });
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
    expect(terminalListener).toHaveBeenCalledOnce();
    expect(sftpListener).toHaveBeenCalledOnce();

    document.removeEventListener('termbridge:new-terminal-tab', terminalListener);
    document.removeEventListener('termbridge:new-sftp-connection', sftpListener);
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
});
