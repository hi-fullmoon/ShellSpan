import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useAppShortcuts } from '../useAppShortcuts';
import { DEFAULT_SHORTCUTS, useAppStore } from '@/stores/appStore';

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
});
