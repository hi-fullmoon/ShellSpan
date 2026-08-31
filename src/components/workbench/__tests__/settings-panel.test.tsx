import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsPanel } from '../settings-panel';
import { DEFAULT_SHORTCUTS, useAppStore } from '@/stores/appStore';
import type { ShortcutBindings } from '@/types';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

const petdexMocks = vi.hoisted(() => ({
  configure: vi.fn(),
  getStatus: vi.fn(),
  listen: vi.fn(),
  testConnection: vi.fn(),
}));

const petdexFeedbackMocks = vi.hoisted(() => ({
  open: vi.fn(),
}));

vi.mock('@/lib/petdex', () => ({
  configurePetdex: petdexMocks.configure,
  getPetdexStatus: petdexMocks.getStatus,
  listenToPetdexStatus: petdexMocks.listen,
  testPetdexConnection: petdexMocks.testConnection,
}));

vi.mock('@/lib/petdex-feedback', () => ({
  openPetdexPhase3Feedback: petdexFeedbackMocks.open,
}));

vi.mock('@/hooks/useI18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
    locale: 'zh-CN',
    setLocale: vi.fn(),
  }),
}));

vi.mock('@/hooks/useTheme', () => ({
  useTheme: () => ({
    theme: 'system',
    resolvedTheme: 'light',
    setTheme: vi.fn(),
  }),
}));

describe('SettingsPanel', () => {
  beforeEach(() => {
    petdexMocks.configure.mockReset().mockResolvedValue('notDetected');
    petdexMocks.getStatus.mockReset().mockResolvedValue('notDetected');
    petdexMocks.listen.mockReset().mockResolvedValue(vi.fn());
    petdexMocks.testConnection.mockReset().mockResolvedValue('connected');
    petdexFeedbackMocks.open.mockReset().mockResolvedValue(undefined);
    useAppStore.setState({
      activeSettingsSection: 'general',
      petdexBackendEnabled: false,
      petdexEnabled: false,
      petdexRequestedEnabled: null,
      petdexConfiguring: false,
      shortcuts: { ...DEFAULT_SHORTCUTS },
    });
  });

  const openSection = (titleKey: string): void => {
    fireEvent.click(screen.getByRole('tab', { name: titleKey }));
  };

  it('renders one section at a time with tab navigation', async () => {
    render(<SettingsPanel />);
    await waitFor(() => {});

    expect(screen.getByText('workbench.settings.title')).toBeInTheDocument();
    const sectionTitleKeys = [
      'settings.general.title',
      'settings.appearance.title',
      'settings.terminal.title',
      'settings.sftp.title',
      'settings.ai.title',
      'settings.shortcuts.title',
      'settings.experimental.title',
    ];
    for (const titleKey of sectionTitleKeys) {
      expect(screen.getByRole('tab', { name: titleKey })).toBeInTheDocument();
    }
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(sectionTitleKeys);

    // General is the default section.
    expect(screen.getByText('settings.general.update')).toBeInTheDocument();
    expect(screen.getByText('settings.general.startupSection')).toBeInTheDocument();
    expect(screen.getByText('settings.general.startupUpdateCheck')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'settings.general.checkUpdate' }),
    ).toBeInTheDocument();
    expect(screen.queryByText('settings.terminal.fontSize')).not.toBeInTheDocument();
    expect(screen.getAllByRole('switch')).toHaveLength(3);

    openSection('settings.appearance.title');
    expect(screen.getByText('settings.appearance.theme')).toBeInTheDocument();
    expect(screen.getByText('settings.appearance.language')).toBeInTheDocument();
    expect(
      screen.getByRole('combobox', { name: 'settings.appearance.theme' }),
    ).toHaveTextContent('theme.system');
    expect(
      screen.getByRole('combobox', { name: 'settings.appearance.language' }),
    ).toHaveTextContent('locale.zh-CN');
    expect(screen.queryByText('settings.experimental.petdex.title')).not.toBeInTheDocument();

    openSection('settings.experimental.title');
    expect(screen.getByText('settings.experimental.description')).toBeInTheDocument();
    expect(screen.getByText('settings.experimental.petdex.title')).toBeInTheDocument();
    expect(screen.getByRole('switch', {
      name: 'settings.experimental.petdex.enabled',
    })).not.toBeChecked();
    expect(screen.getByRole('button', {
      name: 'settings.experimental.petdex.testAction',
    })).toBeDisabled();
    expect(screen.getByRole('switch', {
      name: 'settings.experimental.petdex.enabled',
    })).toHaveAttribute(
      'aria-describedby',
      'petdex-integration-description petdex-privacy-description',
    );
    expect(screen.getByRole('status', {
      name: 'settings.experimental.petdex.statusAnnouncement',
    })).toHaveAttribute('aria-live', 'polite');
    expect(screen.getByRole('status', {
      name: 'settings.experimental.petdex.statusAnnouncement',
    })).toHaveAttribute('aria-atomic', 'true');
    expect(screen.getByRole('button', {
      name: 'settings.experimental.petdex.feedbackAction',
    })).toHaveAttribute('aria-describedby', 'petdex-feedback-description');
    expect(petdexFeedbackMocks.open).not.toHaveBeenCalled();

    openSection('settings.general.title');
    expect(screen.getByText('settings.general.startupSection')).toBeInTheDocument();
    expect(screen.getByText('settings.general.startupUpdateCheck')).toBeInTheDocument();
    expect(screen.getByText('settings.general.update')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'settings.general.checkUpdate' }),
    ).toBeInTheDocument();
    expect(screen.queryByText('settings.appearance.theme')).not.toBeInTheDocument();
    expect(screen.getAllByRole('switch')).toHaveLength(3);

    openSection('settings.terminal.title');
    expect(screen.getByText('settings.terminal.fontSize')).toBeInTheDocument();
    expect(screen.getByText('settings.terminal.fontFamily')).toBeInTheDocument();
    expect(screen.getByText('settings.terminal.cursorStyle')).toBeInTheDocument();
    expect(screen.getByText('settings.terminal.cursorBlink')).toBeInTheDocument();
    expect(screen.getByText('settings.terminal.copyOnSelect')).toBeInTheDocument();
    expect(screen.getByText('settings.terminal.scrollback')).toBeInTheDocument();
    expect(screen.getAllByRole('switch')).toHaveLength(8);

    openSection('settings.sftp.title');
    expect(screen.getByText('settings.sftp.showHiddenFiles')).toBeInTheDocument();
    expect(screen.getAllByRole('switch')).toHaveLength(3);

    openSection('settings.shortcuts.title');
    expect(screen.getByText('settings.shortcuts.resetAll')).toBeInTheDocument();
  });

  it('persists the opt-in and exposes a user-triggered test result', async () => {
    render(<SettingsPanel />);
    openSection('settings.experimental.title');
    const toggle = screen.getByRole('switch', {
      name: 'settings.experimental.petdex.enabled',
    });

    fireEvent.click(toggle);

    expect(useAppStore.getState()).toMatchObject({
      petdexEnabled: false,
      petdexRequestedEnabled: true,
      petdexConfiguring: true,
    });
    await waitFor(() => {
      expect(useAppStore.getState()).toMatchObject({
        petdexEnabled: true,
        petdexRequestedEnabled: null,
        petdexConfiguring: false,
      });
    });
    expect(petdexMocks.configure).toHaveBeenCalledWith(true);
    const testButton = screen.getByRole('button', {
      name: 'settings.experimental.petdex.testAction',
    });
    expect(testButton).toBeEnabled();

    fireEvent.click(testButton);

    expect(await screen.findByText('settings.experimental.petdex.status.connected')).toBeInTheDocument();
    expect(petdexMocks.testConnection).toHaveBeenCalledTimes(1);

    fireEvent.click(toggle);
    await waitFor(() => {
      expect(useAppStore.getState().petdexEnabled).toBe(false);
    });
    expect(petdexMocks.configure).toHaveBeenLastCalledWith(false);
    expect(testButton).toBeDisabled();
    expect(screen.getByText('settings.experimental.petdex.status.notDetected')).toBeInTheDocument();
  });

  it('does not let an older status snapshot overwrite a newer event', async () => {
    const snapshot = deferred<'notDetected'>();
    let emitStatus: ((status: 'connected') => void) | undefined;
    petdexMocks.getStatus.mockReturnValue(snapshot.promise);
    petdexMocks.listen.mockImplementation(async (callback) => {
      emitStatus = callback;
      return vi.fn();
    });
    useAppStore.setState({ activeSettingsSection: 'experimental' });

    render(<SettingsPanel />);
    await waitFor(() => expect(petdexMocks.getStatus).toHaveBeenCalledTimes(1));
    act(() => emitStatus?.('connected'));
    await act(async () => {
      snapshot.resolve('notDetected');
      await snapshot.promise;
    });

    expect(screen.getByText('settings.experimental.petdex.status.connected')).toBeInTheDocument();
    expect(
      screen.queryByText('settings.experimental.petdex.status.notDetected'),
    ).not.toBeInTheDocument();
  });

  it('rolls back a failed disable request and shows a finite error state', async () => {
    useAppStore.setState({
      activeSettingsSection: 'experimental',
      petdexBackendEnabled: true,
      petdexEnabled: true,
    });
    petdexMocks.configure.mockRejectedValueOnce(new Error('sensitive backend detail'));

    render(<SettingsPanel />);
    const toggle = screen.getByRole('switch', {
      name: 'settings.experimental.petdex.enabled',
    });
    fireEvent.click(toggle);

    await waitFor(() => expect(toggle).toBeChecked());
    expect(useAppStore.getState()).toMatchObject({
      petdexEnabled: true,
      petdexRequestedEnabled: null,
      petdexConfiguring: false,
    });
    expect(
      await screen.findByText('settings.experimental.petdex.status.connectionError'),
    ).toBeInTheDocument();
    expect(screen.queryByText('sensitive backend detail')).not.toBeInTheDocument();
  });

  it('opens voluntary feedback only after a user action and without reading the opt-in state', async () => {
    render(<SettingsPanel />);
    openSection('settings.experimental.title');

    expect(useAppStore.getState().petdexEnabled).toBe(false);
    expect(petdexFeedbackMocks.open).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', {
      name: 'settings.experimental.petdex.feedbackAction',
    }));

    expect(petdexFeedbackMocks.open).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().petdexEnabled).toBe(false);
  });

  it('resets the shared settings viewport when switching sections', async () => {
    render(<SettingsPanel />);
    await waitFor(() => {});

    const contentScroller = screen.getByRole('tabpanel').closest('[data-slot="scroll-area"]');
    const viewport = contentScroller?.querySelector(
      '[data-slot="scroll-area-viewport"]',
    ) as HTMLDivElement;
    viewport.scrollTop = 240;

    openSection('settings.terminal.title');

    expect(viewport.scrollTop).toBe(0);
  });

  it('uses a stable vertical navigation inside the settings dialog', async () => {
    render(<SettingsPanel />);
    await waitFor(() => {});

    const tabList = screen.getByRole('tablist', { name: 'settings.sectionNavigation' });
    expect(screen.getByRole('dialog', { name: 'workbench.settings.title' })).toBeInTheDocument();
    expect(tabList).toHaveAttribute('aria-orientation', 'vertical');
    expect(tabList).toHaveClass('w-full', 'flex-col', 'items-stretch');
    expect(tabList.closest('aside')).toHaveClass('w-52');
  });

  it('keeps settings inputs and selects at 32px', async () => {
    render(<SettingsPanel />);
    await waitFor(() => {});

    const settingsDialog = screen.getByRole('dialog', { name: 'workbench.settings.title' });

    expect(settingsDialog).toHaveClass(
      '[&_[data-slot=input]]:h-8',
      '[&_[data-slot=input-group]]:h-8',
      '[&_[data-slot=select-trigger]]:h-8',
      '[&_[data-slot=select-trigger]]:min-w-36',
    );
    expect(settingsDialog).toHaveClass(
      'h-[min(52rem,calc(100vh-2rem))]',
      'w-[min(72rem,calc(100vw-2rem))]',
      'max-w-none',
    );
  });

  it('groups related settings into a responsive row card', async () => {
    render(<SettingsPanel />);
    await waitFor(() => {});

    const startupRow = screen
      .getByText('settings.general.startupSection')
      .closest('[data-slot="field"]');
    const updateRow = screen
      .getByText('settings.general.update')
      .closest('[data-slot="field"]');
    const settingsCard = startupRow?.closest('[data-slot="card"]');
    const settingsGroups = settingsCard?.closest('[data-slot="settings-groups"]');

    expect(startupRow).toHaveClass('min-h-20', '@min-[34rem]:flex-row');
    expect(settingsCard).toHaveAttribute('data-variant', 'outline');
    expect(updateRow?.closest('[data-slot="card"]')).toBe(settingsCard);
    expect(settingsCard?.querySelectorAll('[data-slot="separator"]')).toHaveLength(4);
    expect(settingsGroups).toHaveClass('flex-col', 'gap-6');

    openSection('settings.terminal.title');
    const terminalGroups = screen
      .getByRole('tabpanel', { name: 'settings.terminal.title' })
      .querySelectorAll('[data-slot="settings-group"]');

    expect(terminalGroups).toHaveLength(4);
    expect(Array.from(terminalGroups, (group) => group.querySelector('h3')?.textContent)).toEqual([
      'settings.terminal.groupAppearance',
      'settings.terminal.groupInteraction',
      'settings.terminal.groupSafety',
      'settings.terminal.groupSessions',
    ]);
  });

  it('reports close requests without changing the active app section', async () => {
    const onOpenChange = vi.fn();
    useAppStore.setState({ activeSection: 'terminal' });
    render(<SettingsPanel open onOpenChange={onOpenChange} />);

    fireEvent.click(screen.getByRole('button', { name: 'common.close' }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(useAppStore.getState().activeSection).toBe('terminal');
  });

  it('shows model providers as a full-width card list', async () => {
    render(<SettingsPanel />);
    await waitFor(() => {});
    openSection('settings.ai.title');

    const providerSection = screen.getByText('settings.ai.providers').closest('section');
    const providerColumn = providerSection?.parentElement;
    const providerLayout = providerColumn?.parentElement;
    const section = providerLayout?.parentElement;

    expect(section).toHaveClass('@container');
    expect(providerColumn).toHaveClass('contents');
    expect(providerLayout).toHaveClass('flex', 'flex-col');
    expect(providerLayout).not.toHaveClass('@min-[44rem]:grid-cols-[15rem_minmax(0,1fr)]');
    expect(providerSection).toHaveClass('flex', 'flex-col');
    expect(screen.getAllByRole('button', { name: 'settings.ai.editProvider' })).not.toHaveLength(0);
  });

  it('dims the settings panel behind the add-provider dialog', async () => {
    render(<SettingsPanel />);
    await waitFor(() => {});
    openSection('settings.ai.title');

    fireEvent.click(screen.getByRole('button', { name: 'settings.ai.addProvider' }));
    expect(await screen.findByRole('dialog', {
      name: 'settings.ai.addProviderTitle',
    })).toBeInTheDocument();

    const parentDialog = document.querySelector<HTMLElement>(
      '[data-slot="dialog-content"][data-nested-dialog-open]',
    );
    expect(parentDialog).toHaveClass(
      'data-[nested-dialog-open]:after:bg-black/20',
      'data-[nested-dialog-open]:after:backdrop-blur-[1px]',
      "data-[nested-dialog-open]:after:content-['']",
    );
  });

  it('renders when persisted shortcuts come from an older version', async () => {
    useAppStore.setState({
      shortcuts: {
        openWorkbench: 'mod+1',
        openTerminal: 'mod+2',
        openSftp: 'mod+3',
        openSettings: 'mod+,',
      } as ShortcutBindings,
    });

    expect(() => render(<SettingsPanel />)).not.toThrow();
    await waitFor(() => {});
    openSection('settings.shortcuts.title');
    expect(screen.getByText('settings.shortcuts.newTerminalTab')).toBeInTheDocument();
  });

  const openRecorder = async (actionLabel: string): Promise<HTMLElement> => {
    openSection('settings.shortcuts.title');
    const row = screen.getByText(actionLabel).parentElement!;
    fireEvent.click(within(row).getAllByRole('button')[0]);
    const prompt = await screen.findByText('settings.shortcuts.recordPrompt');
    return prompt.parentElement!;
  };

  it('records a bare key for leader sub-key actions', async () => {
    render(<SettingsPanel />);
    await waitFor(() => {});

    const captureArea = await openRecorder('settings.shortcuts.terminalFocusLeft');
    fireEvent.keyDown(captureArea, { key: 'u' });

    expect(useAppStore.getState().shortcuts.terminalFocusLeft).toBe('u');
    expect(screen.queryByText('settings.shortcuts.recordPrompt')).not.toBeInTheDocument();
  });

  it('rejects modifier chords when recording a leader sub-key', async () => {
    render(<SettingsPanel />);
    await waitFor(() => {});

    const captureArea = await openRecorder('settings.shortcuts.terminalSplitRight');
    fireEvent.keyDown(captureArea, { key: 'v', ctrlKey: true });

    // Unchanged and the recorder stays open.
    expect(useAppStore.getState().shortcuts.terminalSplitRight).toBe('v');
    expect(screen.getByText('settings.shortcuts.recordPrompt')).toBeInTheDocument();
  });

  it('shows a conflict when a leader sub-key duplicates another leader command', async () => {
    render(<SettingsPanel />);
    await waitFor(() => {});

    const captureArea = await openRecorder('settings.shortcuts.terminalFocusRight');
    fireEvent.keyDown(captureArea, { key: 'h' });

    expect(await screen.findByText('settings.shortcuts.conflict')).toBeInTheDocument();
    expect(useAppStore.getState().shortcuts.terminalFocusRight).toBe('l');
  });

  it('shows a conflict for a chord already used within the same scope', async () => {
    render(<SettingsPanel />);
    await waitFor(() => {});

    const captureArea = await openRecorder('settings.shortcuts.closeTerminalTab');
    fireEvent.keyDown(captureArea, { key: 'k', metaKey: true });

    expect(await screen.findByText('settings.shortcuts.conflict')).toBeInTheDocument();
  });

  it('allows a chord that is only used in a different section scope', async () => {
    render(<SettingsPanel />);
    await waitFor(() => {});

    // mod+k is taken by terminal's newTerminalTab; sftp scope may reuse it.
    const captureArea = await openRecorder('settings.shortcuts.newSftpConnection');
    fireEvent.keyDown(captureArea, { key: 'k', metaKey: true });

    expect(screen.queryByText('settings.shortcuts.conflict')).not.toBeInTheDocument();
    expect(useAppStore.getState().shortcuts.newSftpConnection).toBe('mod+k');
  });
});
