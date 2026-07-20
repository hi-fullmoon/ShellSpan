import { describe, expect, it, beforeEach } from 'vitest';
import { DEFAULT_SHORTCUTS, useAppStore } from '../appStore';

const initialState = useAppStore.getState();

describe('appStore', () => {
  beforeEach(() => {
    useAppStore.setState(initialState, true);
  });

  it('defaults to workbench section', () => {
    expect(useAppStore.getState().activeSection).toBe('workbench');
  });

  it('sets active section', () => {
    useAppStore.getState().setActiveSection('terminal');
    expect(useAppStore.getState().activeSection).toBe('terminal');
  });

  it('defaults to connections workbench tab', () => {
    expect(useAppStore.getState().activeWorkbenchTab).toBe('connections');
  });

  it('sets active workbench tab', () => {
    useAppStore.getState().setActiveWorkbenchTab('settings');
    expect(useAppStore.getState().activeWorkbenchTab).toBe('settings');
  });

  it('customizes and resets shortcuts', () => {
    useAppStore.getState().setShortcut('openTerminal', 'mod+shift+t');
    expect(useAppStore.getState().shortcuts.openTerminal).toBe('mod+shift+t');

    useAppStore.getState().resetShortcut('openTerminal');
    expect(useAppStore.getState().shortcuts.openTerminal).toBe(DEFAULT_SHORTCUTS.openTerminal);
  });

  it('updates terminal preferences', () => {
    useAppStore.getState().setTerminalFontSize(16);
    useAppStore.getState().setTerminalFontFamily('consolas');
    useAppStore.getState().setTerminalCursorBlink(false);
    useAppStore.getState().setTerminalCursorStyle('bar');
    useAppStore.getState().setTerminalCopyOnSelect(false);
    useAppStore.getState().setTerminalScrollback(50000);

    expect(useAppStore.getState()).toMatchObject({
      terminalFontSize: 16,
      terminalFontFamily: 'consolas',
      terminalCursorBlink: false,
      terminalCursorStyle: 'bar',
      terminalCopyOnSelect: false,
      terminalScrollback: 50000,
    });
  });

  it('updates startup and SFTP preferences', () => {
    useAppStore.getState().setStartupSection('sftp');
    useAppStore.getState().setSftpShowHiddenFiles(false);

    expect(useAppStore.getState()).toMatchObject({
      startupSection: 'sftp',
      sftpShowHiddenFiles: false,
    });
  });
});
