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

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 't', ctrlKey: true, bubbles: true }));

    expect(listener).toHaveBeenCalledOnce();
    document.removeEventListener('termbridge:new-terminal-tab', listener);
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
