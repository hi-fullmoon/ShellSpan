import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsPanel } from '../settings-panel';
import { DEFAULT_SHORTCUTS, useAppStore } from '@/stores/appStore';
import type { ShortcutBindings } from '@/types';

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
      petdexEnabled: false,
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
    for (const titleKey of [
      'settings.appearance.title',
      'settings.general.title',
      'settings.terminal.title',
      'settings.sftp.title',
      'settings.shortcuts.title',
    ]) {
      expect(screen.getByRole('tab', { name: titleKey })).toBeInTheDocument();
    }

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
    expect(screen.getByText('settings.appearance.petdex.title')).toBeInTheDocument();
    expect(screen.getByRole('switch', {
      name: 'settings.appearance.petdex.enabled',
    })).not.toBeChecked();
    expect(screen.getByRole('button', {
      name: 'settings.appearance.petdex.testAction',
    })).toBeDisabled();
    expect(screen.getByRole('switch', {
      name: 'settings.appearance.petdex.enabled',
    })).toHaveAttribute(
      'aria-describedby',
      'petdex-integration-description petdex-privacy-description',
    );
    expect(screen.getByRole('status', {
      name: 'settings.appearance.petdex.statusAnnouncement',
    })).toHaveAttribute('aria-live', 'polite');
    expect(screen.getByRole('status', {
      name: 'settings.appearance.petdex.statusAnnouncement',
    })).toHaveAttribute('aria-atomic', 'true');
    expect(screen.getByRole('button', {
      name: 'settings.appearance.petdex.feedbackAction',
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
    openSection('settings.appearance.title');
    const toggle = screen.getByRole('switch', {
      name: 'settings.appearance.petdex.enabled',
    });

    fireEvent.click(toggle);

    expect(useAppStore.getState().petdexEnabled).toBe(true);
    expect(petdexMocks.configure).toHaveBeenCalledWith(true);
    const testButton = screen.getByRole('button', {
      name: 'settings.appearance.petdex.testAction',
    });
    expect(testButton).toBeEnabled();

    fireEvent.click(testButton);

    expect(await screen.findByText('settings.appearance.petdex.status.connected')).toBeInTheDocument();
    expect(petdexMocks.testConnection).toHaveBeenCalledTimes(1);

    fireEvent.click(toggle);
    expect(useAppStore.getState().petdexEnabled).toBe(false);
    expect(petdexMocks.configure).toHaveBeenLastCalledWith(false);
    expect(testButton).toBeDisabled();
    expect(screen.getByText('settings.appearance.petdex.status.notDetected')).toBeInTheDocument();
  });

  it('opens voluntary feedback only after a user action and without reading the opt-in state', async () => {
    render(<SettingsPanel />);
    openSection('settings.appearance.title');

    expect(useAppStore.getState().petdexEnabled).toBe(false);
    expect(petdexFeedbackMocks.open).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', {
      name: 'settings.appearance.petdex.feedbackAction',
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

  it('uses the built-in horizontal scroll area for the top tabs', async () => {
    render(<SettingsPanel />);
    await waitFor(() => {});

    const tabList = screen.getByRole('tablist', { name: 'settings.sectionNavigation' });
    const tabScroller = tabList.closest('[data-slot="scroll-area"]');

    expect(tabScroller).toBeInTheDocument();
    expect(tabScroller).toHaveClass('h-8', 'w-full');
    expect(tabList).toHaveClass('min-w-max');
    expect(tabList).not.toHaveClass('group-data-horizontal/tabs:h-9');
    expect(tabList).not.toHaveClass('overflow-x-auto');
  });

  it('keeps settings inputs and selects at 32px', async () => {
    render(<SettingsPanel />);
    await waitFor(() => {});

    const settingsPage = screen.getByText('workbench.settings.title').closest('[data-slot="workbench-page"]');

    expect(settingsPage).toHaveClass(
      '[&_[data-slot=input]]:h-8',
      '[&_[data-slot=input-group]]:h-8',
      '[&_[data-slot=select-trigger]]:h-8',
    );
  });

  it('sizes the AI provider layout from the settings pane instead of the window', async () => {
    render(<SettingsPanel />);
    await waitFor(() => {});
    openSection('settings.ai.title');

    const providerCard = screen.getByText('settings.ai.providers').closest('[data-slot="card"]');
    const providerColumn = providerCard?.parentElement;
    const providerLayout = providerColumn?.parentElement;
    const section = providerLayout?.parentElement;
    const firstFormRow = screen.getByText('settings.ai.providerName').closest('[data-slot="field"]')?.parentElement;

    expect(section).toHaveClass('@container');
    expect(providerColumn).toHaveClass('contents', '@min-[44rem]:flex', '@min-[44rem]:flex-col');
    expect(providerLayout).toHaveClass('@min-[44rem]:grid-cols-[15rem_minmax(0,1fr)]');
    expect(providerLayout).not.toHaveClass('lg:grid-cols-[15rem_minmax(0,1fr)]');
    expect(firstFormRow).toHaveClass('@min-[36rem]:grid-cols-2');
    expect(firstFormRow).not.toHaveClass('sm:grid-cols-2');
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
