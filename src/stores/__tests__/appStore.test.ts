import { afterEach, describe, expect, it, beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  configurePetdex: vi.fn(),
  loadPreferences: vi.fn(),
  savePreferences: vi.fn(),
}));

vi.mock('@/lib/petdex', () => ({ configurePetdex: mocks.configurePetdex }));
vi.mock('@/lib/tauri', () => ({
  invokeLoadPreferences: mocks.loadPreferences,
  invokeSavePreferences: mocks.savePreferences,
}));

import { DEFAULT_SHORTCUTS, mergeShortcutBindings, useAppStore } from '../appStore';

const initialState = useAppStore.getState();

describe('appStore', () => {
  beforeEach(() => {
    vi.useRealTimers();
    mocks.configurePetdex.mockReset().mockResolvedValue('notDetected');
    mocks.loadPreferences.mockReset().mockResolvedValue([]);
    mocks.savePreferences.mockReset().mockResolvedValue(undefined);
    useAppStore.setState(initialState, true);
  });

  afterEach(() => {
    vi.useRealTimers();
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

  it('keeps Petdex disabled by default and synchronizes explicit opt-in', () => {
    expect(useAppStore.getState().petdexEnabled).toBe(false);

    useAppStore.getState().setPetdexEnabled(true);

    expect(useAppStore.getState().petdexEnabled).toBe(true);
    expect(mocks.configurePetdex).toHaveBeenCalledWith(true);
  });

  it('hydrates and persists the Petdex opt-in as a boolean preference', async () => {
    mocks.loadPreferences.mockResolvedValue([['petdexEnabled', 'true']]);

    await useAppStore.getState().hydrateFromDb();

    expect(useAppStore.getState().petdexEnabled).toBe(true);
    expect(mocks.configurePetdex).toHaveBeenCalledWith(true);

    vi.useFakeTimers();
    useAppStore.getState().setPetdexEnabled(false);
    await vi.advanceTimersByTimeAsync(500);

    expect(mocks.savePreferences).toHaveBeenCalledWith(
      expect.arrayContaining([['petdexEnabled', 'false']]),
    );
  });

  it('opens settings without replacing the current workspace context', () => {
    useAppStore.getState().setActiveSection('terminal');
    useAppStore.getState().openSettings('shortcuts');

    expect(useAppStore.getState()).toMatchObject({
      activeSection: 'terminal',
      activeSettingsSection: 'shortcuts',
      settingsDialogOpen: true,
    });

    useAppStore.getState().setSettingsDialogOpen(false);
    expect(useAppStore.getState().settingsDialogOpen).toBe(false);
  });

  it('routes a new connection request to the workbench until it is consumed', () => {
    useAppStore.getState().setActiveSection('terminal');
    useAppStore.getState().setActiveWorkbenchTab('logs');

    useAppStore.getState().requestNewConnection();

    expect(useAppStore.getState()).toMatchObject({
      activeSection: 'workbench',
      activeWorkbenchTab: 'connections',
      pendingWorkbenchAction: 'newConnection',
    });

    useAppStore.getState().consumeWorkbenchAction('newConnection');
    expect(useAppStore.getState().pendingWorkbenchAction).toBeNull();
  });

  it('customizes and resets shortcuts', () => {
    useAppStore.getState().setShortcut('openTerminal', 'mod+shift+t');
    expect(useAppStore.getState().shortcuts.openTerminal).toBe('mod+shift+t');

    useAppStore.getState().resetShortcut('openTerminal');
    expect(useAppStore.getState().shortcuts.openTerminal).toBe(DEFAULT_SHORTCUTS.openTerminal);
  });

  it('fills shortcuts added after an older persisted configuration', () => {
    expect(mergeShortcutBindings({
      openWorkbench: 'mod+9',
      openTerminal: 'mod+2',
      openSftp: 'mod+3',
      openSettings: 'mod+,',
    })).toEqual({
      ...DEFAULT_SHORTCUTS,
      openWorkbench: 'mod+9',
    });
  });

  it('rejects invalid persisted shortcut values', () => {
    expect(mergeShortcutBindings({ openWorkbench: 42, findTerminal: '' })).toEqual(
      DEFAULT_SHORTCUTS,
    );
  });

  it('upgrades a stored legacy default to the new default', () => {
    // mod+t was the old newTerminalTab default; treat it as uncustomized.
    expect(mergeShortcutBindings({ newTerminalTab: 'mod+t' })).toEqual(DEFAULT_SHORTCUTS);
    // A genuinely customized binding is kept.
    expect(mergeShortcutBindings({ newTerminalTab: 'mod+shift+n' })).toEqual({
      ...DEFAULT_SHORTCUTS,
      newTerminalTab: 'mod+shift+n',
    });
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
    useAppStore.getState().setSftpConflictPolicy('skip');
    useAppStore.getState().setSftpRetryCount(3);
    useAppStore.getState().setSftpDownloadDirectory('/downloads');
    useAppStore.getState().setSftpCompletionNotification(false);

    expect(useAppStore.getState()).toMatchObject({
      startupSection: 'sftp',
      sftpShowHiddenFiles: false,
      sftpConflictPolicy: 'skip',
      sftpRetryCount: 3,
      sftpDownloadDirectory: '/downloads',
      sftpCompletionNotification: false,
    });
  });

  it('updates terminal safety and continuity preferences', () => {
    const state = useAppStore.getState();
    state.setTerminalColorScheme('solarizedDark');
    state.setTerminalMultiLinePasteWarning(false);
    state.setTerminalLargePasteWarning(false);
    state.setTerminalAutoReconnect(true);
    state.setConfirmBeforeExit(false);
    state.setRestoreWorkspace(false);
    state.setTerminalLineHeight(1.2);
    state.setTerminalLetterSpacing(1);
    state.setTerminalUrlDetection(false);
    state.setTerminalTrimTrailingWhitespace(false);
    state.setTerminalRightClickBehavior('copyPaste');
    state.setTerminalBellStyle('sound');

    expect(useAppStore.getState()).toMatchObject({
      terminalColorScheme: 'solarizedDark',
      terminalMultiLinePasteWarning: false,
      terminalLargePasteWarning: false,
      terminalAutoReconnect: true,
      confirmBeforeExit: false,
      restoreWorkspace: false,
      terminalLineHeight: 1.2,
      terminalLetterSpacing: 1,
      terminalUrlDetection: false,
      terminalTrimTrailingWhitespace: false,
      terminalRightClickBehavior: 'copyPaste',
      terminalBellStyle: 'sound',
    });
  });
});
