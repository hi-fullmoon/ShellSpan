import { afterEach, describe, expect, it, beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  configurePetdex: vi.fn(),
  loadPreferences: vi.fn(),
  savePreferences: vi.fn(),
}));

vi.mock('@/lib/petdex/petdex', () => ({ configurePetdex: mocks.configurePetdex }));
vi.mock('@/lib/ipc/tauri', () => ({
  invokeLoadPreferences: mocks.loadPreferences,
  invokeSavePreferences: mocks.savePreferences,
}));

import { DEFAULT_SHORTCUTS, mergeShortcutBindings, useAppStore } from '../appStore';

const initialState = useAppStore.getState();

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

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

  it('commits an explicit Petdex opt-in only after backend confirmation', async () => {
    expect(useAppStore.getState().petdexEnabled).toBe(false);

    const confirmation = useAppStore.getState().setPetdexEnabled(true);

    expect(useAppStore.getState()).toMatchObject({
      petdexEnabled: false,
      petdexRequestedEnabled: true,
      petdexConfiguring: true,
    });
    await expect(confirmation).resolves.toBe('notDetected');
    expect(useAppStore.getState().petdexEnabled).toBe(true);
    expect(mocks.configurePetdex).toHaveBeenCalledWith(true);
  });

  it('rolls back the requested state when backend confirmation fails', async () => {
    useAppStore.setState({ petdexBackendEnabled: true, petdexEnabled: true });
    mocks.configurePetdex.mockRejectedValueOnce(new Error('backend unavailable'));

    await expect(useAppStore.getState().setPetdexEnabled(false)).rejects.toThrow(
      'backend unavailable',
    );

    expect(useAppStore.getState()).toMatchObject({
      petdexEnabled: true,
      petdexRequestedEnabled: null,
      petdexConfiguring: false,
    });
  });

  it('serializes rapid changes and commits only the latest intent', async () => {
    const enable = deferred<'notDetected'>();
    const disable = deferred<'notDetected'>();
    mocks.configurePetdex
      .mockImplementationOnce(() => enable.promise)
      .mockImplementationOnce(() => disable.promise);

    const enabling = useAppStore.getState().setPetdexEnabled(true);
    await Promise.resolve();
    const disabling = useAppStore.getState().setPetdexEnabled(false);
    expect(useAppStore.getState()).toMatchObject({
      petdexEnabled: false,
      petdexRequestedEnabled: false,
      petdexConfiguring: true,
    });

    enable.resolve('notDetected');
    await enabling;
    expect(useAppStore.getState()).toMatchObject({
      petdexEnabled: false,
      petdexRequestedEnabled: false,
      petdexConfiguring: true,
    });

    await Promise.resolve();
    disable.resolve('notDetected');
    await disabling;
    expect(useAppStore.getState()).toMatchObject({
      petdexEnabled: false,
      petdexRequestedEnabled: null,
      petdexConfiguring: false,
    });
    expect(mocks.configurePetdex.mock.calls).toEqual([[true], [false]]);
  });

  it('rolls back to the actual backend state when the latest rapid change fails', async () => {
    const enable = deferred<'notDetected'>();
    const disable = deferred<'notDetected'>();
    mocks.configurePetdex
      .mockImplementationOnce(() => enable.promise)
      .mockImplementationOnce(() => disable.promise);

    const enabling = useAppStore.getState().setPetdexEnabled(true);
    await Promise.resolve();
    const disabling = useAppStore.getState().setPetdexEnabled(false);
    enable.resolve('notDetected');
    await enabling;
    expect(useAppStore.getState()).toMatchObject({
      petdexBackendEnabled: true,
      petdexEnabled: false,
      petdexRequestedEnabled: false,
    });

    await Promise.resolve();
    disable.reject(new Error('disable failed'));
    await expect(disabling).rejects.toThrow('disable failed');
    expect(useAppStore.getState()).toMatchObject({
      petdexBackendEnabled: true,
      petdexEnabled: true,
      petdexRequestedEnabled: null,
      petdexConfiguring: false,
    });
  });

  it('hydrates and persists the Petdex opt-in as a boolean preference', async () => {
    mocks.loadPreferences.mockResolvedValue([['petdexEnabled', 'true']]);

    await useAppStore.getState().hydrateFromDb();

    expect(useAppStore.getState().petdexEnabled).toBe(true);
    expect(mocks.configurePetdex).toHaveBeenCalledWith(true);

    vi.useFakeTimers();
    await useAppStore.getState().setPetdexEnabled(false);
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

  it('fails closed when a persisted Petdex opt-in cannot reach the backend', async () => {
    mocks.loadPreferences.mockResolvedValue([['petdexEnabled', 'true']]);
    mocks.configurePetdex.mockRejectedValueOnce(new Error('backend unavailable'));

    await useAppStore.getState().hydrateFromDb();

    expect(useAppStore.getState()).toMatchObject({
      initialized: true,
      petdexEnabled: false,
      petdexRequestedEnabled: null,
      petdexConfiguring: false,
    });
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
