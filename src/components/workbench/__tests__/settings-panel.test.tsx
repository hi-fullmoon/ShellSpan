import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsPanel } from '../settings-panel';
import { DEFAULT_SHORTCUTS, useAppStore } from '@/stores/appStore';
import { useAiSettingsStore } from '@/stores/aiSettingsStore';
import { useUpdateStore } from '@/stores/updateStore';
import type { PetdexDiagnostic, ShortcutBindings } from '@/types';
import { Toaster } from '@/components/ui/sonner';
import { toast } from 'sonner';
import type { PetdexSettings } from '@/lib/petdex/messages';

const disabled: PetdexDiagnostic = { revision: 0, status: 'disabled', errorReason: null, targetAction: null, lastSuccessAt: null };
const connected: PetdexDiagnostic = { ...disabled, revision: 2, status: 'connected', targetAction: 'waving' };

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

vi.mock('@/lib/petdex/petdex', () => ({
  configurePetdex: petdexMocks.configure,
  getPetdexStatus: petdexMocks.getStatus,
  listenToPetdexStatus: petdexMocks.listen,
  testPetdexConnection: petdexMocks.testConnection,
}));

vi.mock('@/lib/petdex/messages', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/petdex/messages')>(),
  configurePetdexSettings: async (configuration: PetdexSettings) => ({
    effective: configuration,
    diagnostic: await petdexMocks.configure(configuration.enabled, configuration.categories),
    cleanupOutcome: 'notNeeded',
    messageDiagnostic: { revision: 1, status: 'disabled', acceptedCount: 0, lastAcceptedAt: null, usedSlotCount: 0, errorReason: null, unsupported: false, cleanupOutcome: 'notNeeded' },
  }),
}));

vi.mock('@/lib/feedback', () => ({
  openFeedback: petdexFeedbackMocks.open,
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
  it('toggles focus mode visibility from general settings', () => {
    useAppStore.getState().setShowFocusMode(false);
    render(<SettingsPanel />);
    const toggle = screen.getByRole('switch', { name: 'settings.general.showFocusMode' });
    expect(toggle).not.toBeChecked();
    fireEvent.click(toggle);
    expect(useAppStore.getState().showFocusMode).toBe(true);
    expect(toggle).toBeChecked();
    fireEvent.click(toggle);
    expect(useAppStore.getState().showFocusMode).toBe(false);
  });

  beforeEach(() => {
    petdexMocks.configure.mockReset().mockResolvedValue({ ...disabled, revision: 3 });
    petdexMocks.getStatus.mockReset().mockResolvedValue(disabled);
    petdexMocks.listen.mockReset().mockResolvedValue(vi.fn());
    petdexMocks.testConnection.mockReset().mockResolvedValue({ diagnostic: connected, preview: 'requested' });
    petdexFeedbackMocks.open.mockReset().mockResolvedValue(undefined);
    useAppStore.setState({
      activeSettingsSection: 'general',
      petdexBackendEnabled: false,
      petdexEnabled: false,
      petdexRequestedEnabled: null,
      petdexConfiguring: false,
      shortcuts: { ...DEFAULT_SHORTCUTS },
    });
    useUpdateStore.getState().reset();
  });

  const openSection = (titleKey: string): void => {
    fireEvent.click(screen.getByRole('tab', { name: titleKey }));
  };

  it('renders one section at a time with tab navigation', async () => {
    const toastCount = toast.getHistory().length;
    render(<SettingsPanel />);
    await waitFor(() => {});
    expect(toast.getHistory()).toHaveLength(toastCount);

    expect(screen.getByText('workbench.settings.title')).toBeInTheDocument();
    const sectionTitleKeys = [
      'settings.general.title',
      'settings.appearance.title',
      'settings.terminal.title',
      'settings.sftp.title',
      'settings.ai.title',
      'settings.shortcuts.title',
      'settings.experimental.title',
      'settings.feedback.title',
    ];
    for (const titleKey of sectionTitleKeys) {
      const tab = screen.getByRole('tab', { name: titleKey });
      expect(tab).toHaveAttribute('title', titleKey);
      expect(tab).toHaveClass('min-w-0', 'h-8');
      expect(within(tab).getByText(titleKey)).toHaveClass('min-w-0', 'truncate');
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
    expect(screen.getAllByRole('switch')).toHaveLength(4);

    openSection('settings.appearance.title');
    expect(screen.getByText('settings.appearance.theme')).toBeInTheDocument();
    expect(screen.getByText('settings.appearance.language')).toBeInTheDocument();
    const themeGroup = screen.getByRole('group', { name: 'settings.appearance.theme' });
    expect(within(themeGroup).getByRole('button', { name: 'theme.system' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(themeGroup).getByRole('button', { name: 'theme.light' })).toHaveAttribute('aria-pressed', 'false');
    expect(within(themeGroup).getByRole('button', { name: 'theme.dark' })).toHaveAttribute('aria-pressed', 'false');
    expect(
      screen.getByRole('combobox', { name: 'settings.appearance.language' }),
    ).toHaveTextContent('locale.zh-CN');
    expect(
      screen.getByRole('combobox', { name: 'settings.appearance.language' }),
    ).toHaveAttribute('data-variant', 'ghost');
    expect(screen.queryByText('settings.experimental.petdex.title')).not.toBeInTheDocument();

    openSection('settings.experimental.title');
    expect(screen.getByText('settings.experimental.description')).toBeInTheDocument();
    expect(screen.getByText('settings.experimental.petdex.title')).toBeInTheDocument();
    expect(screen.getByRole('switch', {
      name: 'settings.experimental.petdex.title',
    })).not.toBeChecked();
    expect(screen.getByRole('button', {
      name: 'settings.experimental.petdex.testAction',
    })).toBeDisabled();
    for (const category of ['ssh', 'sftp', 'ai']) {
      const toggle = screen.getByRole('switch', { name: `settings.experimental.petdex.category.${category}` });
      expect(toggle).toBeEnabled();
      expect(toggle).toHaveAttribute('aria-describedby', 'petdex-categories-description');
      expect(toggle).toHaveAttribute('data-size', 'default');
      if (category === 'ai') expect(toggle).not.toBeChecked();
      else expect(toggle).toBeChecked();
    }
    expect(screen.getByRole('switch', {
      name: 'settings.experimental.petdex.title',
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
    expect(screen.queryByRole('button', {
      name: 'settings.feedback.title',
    })).not.toBeInTheDocument();
    openSection('settings.feedback.title');
    expect(screen.getByRole('button', {
      name: 'settings.feedback.title',
    })).toHaveAttribute('aria-describedby', 'feedback-description');
    expect(screen.getByText('settings.feedback.reportTitle')).toBeInTheDocument();
    expect(screen.queryByText('settings.experimental.petdex.title')).not.toBeInTheDocument();
    expect(petdexFeedbackMocks.open).not.toHaveBeenCalled();

    openSection('settings.general.title');
    expect(screen.getByText('settings.general.startupSection')).toBeInTheDocument();
    expect(screen.getByText('settings.general.startupUpdateCheck')).toBeInTheDocument();
    expect(screen.getByText('settings.general.update')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'settings.general.checkUpdate' }),
    ).toBeInTheDocument();
    expect(screen.queryByText('settings.appearance.theme')).not.toBeInTheDocument();
    expect(screen.getAllByRole('switch')).toHaveLength(4);

    openSection('settings.terminal.title');
    expect(screen.getByText('settings.terminal.fontSize')).toBeInTheDocument();
    expect(screen.getByText('settings.terminal.fontFamily')).toBeInTheDocument();
    expect(screen.getByText('settings.terminal.cursorStyle')).toBeInTheDocument();
    expect(screen.getByText('settings.terminal.cursorBlink')).toBeInTheDocument();
    expect(screen.getByText('settings.terminal.copyOnSelect')).toBeInTheDocument();
    expect(screen.getByText('settings.terminal.scrollback')).toBeInTheDocument();
    const customFontInput = screen.getByRole('textbox', { name: 'settings.terminal.customFont' });
    expect(customFontInput).toBeInTheDocument();
    expect(customFontInput).toHaveClass('h-8');
    expect(customFontInput).toHaveAttribute('placeholder', 'JetBrains Mono');
    expect(screen.getByRole('switch', { name: 'settings.terminal.altClickMovesCursor' })).toBeChecked();
    expect(screen.getByRole('switch', { name: 'settings.terminal.osc52' })).toBeChecked();
    expect(screen.getByRole('combobox', { name: 'terminal.commandBlock.notifications' })).toBeInTheDocument();

    openSection('settings.sftp.title');
    expect(screen.getByText('settings.sftp.showHiddenFiles')).toBeInTheDocument();
    expect(screen.getAllByRole('switch')).toHaveLength(3);

    openSection('settings.shortcuts.title');
    expect(screen.getByText('settings.shortcuts.resetAll')).toBeInTheDocument();
  });

  it('persists the opt-in and exposes a user-triggered test result', async () => {
    petdexMocks.configure.mockResolvedValueOnce({ ...disabled, revision: 1, status: 'checking', targetAction: 'idle' });
    const view = render(<><SettingsPanel /><Toaster /></>);
    openSection('settings.experimental.title');
    const toggle = screen.getByRole('switch', {
      name: 'settings.experimental.petdex.title',
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
    expect(petdexMocks.configure).toHaveBeenCalledWith(true, { ssh: true, sftp: true, ai: false });
    const testButton = screen.getByRole('button', {
      name: 'settings.experimental.petdex.testAction',
    });
    expect(testButton).toBeEnabled();

    fireEvent.click(testButton);

    expect(await screen.findByText('settings.experimental.petdex.status.connected')).toBeInTheDocument();
    expect(petdexMocks.testConnection).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('settings.experimental.petdex.preview.requested')).toBeInTheDocument();
    view.rerender(<><SettingsPanel /><Toaster /></>);
    expect(screen.getAllByText('settings.experimental.petdex.preview.requested')).toHaveLength(1);

    fireEvent.click(toggle);
    await waitFor(() => {
      expect(useAppStore.getState().petdexEnabled).toBe(false);
    });
    expect(petdexMocks.configure).toHaveBeenLastCalledWith(false, { ssh: true, sftp: true, ai: false });
    expect(testButton).toBeDisabled();
    expect(screen.getByText('settings.experimental.petdex.status.disabled')).toBeInTheDocument();
  });

  it('does not let an older status snapshot overwrite a newer event', async () => {
    const snapshot = deferred<PetdexDiagnostic>();
    let emitStatus: ((status: PetdexDiagnostic) => void) | undefined;
    petdexMocks.getStatus.mockReturnValue(snapshot.promise);
    petdexMocks.listen.mockImplementation(async (callback) => {
      emitStatus = callback;
      return vi.fn();
    });
    useAppStore.setState({ activeSettingsSection: 'experimental' });

    render(<SettingsPanel />);
    await waitFor(() => expect(petdexMocks.getStatus).toHaveBeenCalledTimes(1));
    act(() => emitStatus?.(connected));
    await act(async () => {
      snapshot.resolve(disabled);
      await snapshot.promise;
    });

    expect(screen.getByText('settings.experimental.petdex.status.connected')).toBeInTheDocument();
    expect(
      screen.queryByText('settings.experimental.petdex.status.disabled'),
    ).not.toBeInTheDocument();
  });

  it('rolls back a failed disable request and shows one finite error toast', async () => {
    useAppStore.setState({
      activeSettingsSection: 'experimental',
      petdexBackendEnabled: true,
      petdexEnabled: true,
    });
    petdexMocks.configure.mockRejectedValueOnce(new Error('sensitive backend detail'));

    render(<><SettingsPanel /><Toaster /></>);
    const toggle = screen.getByRole('switch', {
      name: 'settings.experimental.petdex.title',
    });
    fireEvent.click(toggle);

    await waitFor(() => expect(toggle).toBeChecked());
    expect(useAppStore.getState()).toMatchObject({
      petdexEnabled: true,
      petdexRequestedEnabled: null,
      petdexConfiguring: false,
    });
    expect(
      await screen.findByText('settings.experimental.petdex.messages.saveFailed'),
    ).toBeInTheDocument();
    expect(screen.queryByText('sensitive backend detail')).not.toBeInTheDocument();
  });

  it('opens voluntary feedback only after a user action and without reading the opt-in state', async () => {
    render(<SettingsPanel />);
    openSection('settings.feedback.title');

    expect(useAppStore.getState().petdexEnabled).toBe(false);
    expect(petdexFeedbackMocks.open).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', {
      name: 'settings.feedback.title',
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
    expect(tabList).toHaveAttribute('data-variant', 'sidebar');
    expect(tabList).toHaveClass('w-full', 'flex-col', 'items-stretch');
    expect(tabList.closest('aside')).toHaveClass('min-h-0', 'w-36', '@min-[48rem]:w-52');
  });

  it('gives the selected settings menu a clear accent fill without an indicator or border', async () => {
    render(<SettingsPanel />);
    await waitFor(() => {});

    const generalTab = screen.getByRole('tab', { name: 'settings.general.title' });
    expect(generalTab).toHaveAttribute('data-active');
    expect(generalTab).toHaveClass(
      'group-data-[variant=sidebar]/tabs-list:data-active:bg-app-tab-active',
      'group-data-[variant=sidebar]/tabs-list:data-active:text-app-tab-accent',
      'group-data-[variant=sidebar]/tabs-list:data-active:font-semibold',
      'group-data-[variant=sidebar]/tabs-list:data-active:border-transparent',
      'group-data-[variant=sidebar]/tabs-list:data-active:hover:bg-app-tab-active',
      'group-data-[variant=sidebar]/tabs-list:data-active:hover:text-app-tab-accent',
    );
    expect(generalTab.className).not.toContain('border-app-tab-accent');
    expect(generalTab.className).not.toContain(
      'group-data-[variant=sidebar]/tabs-list:data-active:after:opacity-100',
    );

    openSection('settings.ai.title');
    expect(screen.getByRole('tab', { name: 'settings.ai.title' })).toHaveAttribute('data-active');
    expect(generalTab).not.toHaveAttribute('data-active');
  });

  it('keeps settings inputs and selects at 32px with inline ghost selects and distinct section surfaces', async () => {
    render(<SettingsPanel />);
    await waitFor(() => {});

    const settingsDialog = screen.getByRole('dialog', { name: 'workbench.settings.title' });
    const sidebar = screen.getByRole('tablist', { name: 'settings.sectionNavigation' }).closest('aside');
    const contentSection = screen.getByRole('tabpanel').closest('section');

    expect(settingsDialog).toHaveClass(
      'bg-background',
      '[&_[data-slot=card]]:border-[0.5px]',
      '[&_[data-slot=card]]:border-border/50',
      '[&_[data-slot=separator]]:border-t-[0.5px]',
      '[&_[data-slot=separator]]:border-border/40',
      '[&_[data-slot=input]]:h-8',
      '[&_[data-slot=input-group]]:h-8',
      '[&_[data-slot=select-trigger]]:h-8',
    );
    expect(sidebar).toHaveClass('bg-muted/35', 'border-r-[0.5px]', 'border-border/50');
    expect(contentSection).toHaveClass('bg-background');
    expect(settingsDialog).toHaveClass(
      'h-[min(52rem,calc(100vh-2rem))]',
      'w-[min(76rem,calc(100vw-2rem))]',
      'max-w-none',
    );
    expect(settingsDialog.className).not.toMatch(/(?:^|\s)max-h-\[min\(48rem/);
    expect(screen.getByRole('combobox', { name: 'settings.general.startupSection' })).toHaveAttribute('data-variant', 'ghost');
  });

  it('uses the same 32px scale and text-only action buttons and navigation throughout settings', async () => {
    render(<SettingsPanel />);
    await waitFor(() => {});

    const settingsDialog = screen.getByRole('dialog', { name: 'workbench.settings.title' });
    const sectionTitles = [
      'settings.general.title',
      'settings.appearance.title',
      'settings.terminal.title',
      'settings.sftp.title',
      'settings.ai.title',
      'settings.shortcuts.title',
      'settings.experimental.title',
      'settings.feedback.title',
    ];

    for (const tab of within(settingsDialog).getAllByRole('tab')) {
      expect(tab.querySelector('svg')).toBeNull();
    }

    for (const title of sectionTitles) {
      openSection(title);
      within(settingsDialog).getAllByRole('button')
        .filter((button) => button.getAttribute('data-slot') === 'button')
        .forEach((button) => {
          expect(button.className).toMatch(/(?:^|\s)(?:h-8|size-8)(?:\s|$)/);
          if ((button.textContent ?? '').trim().length > 0 && button.getAttribute('data-slot') === 'button') {
            expect(button.querySelector('svg')).toBeNull();
          }
        });
    }

    openSection('settings.appearance.title');
    const languageSelect = screen.getByRole('combobox', { name: 'settings.appearance.language' });
    expect(languageSelect.querySelector('.lucide-globe-2')).toBeNull();
  });

  it('shows the up-to-date status beside the current version', async () => {
    useUpdateStore.setState({ phase: 'no_update' });

    render(<SettingsPanel />);
    await waitFor(() => {});

    const statusBadge = screen.getByText('update.latest').closest('[data-slot="badge"]');

    expect(statusBadge).toBeInTheDocument();
    expect(statusBadge?.closest('[data-slot="update-summary"]')).toBeInTheDocument();
    expect(statusBadge?.closest('[data-slot="update-actions"]')).toBeNull();
  });

  it('shows update checking state only in the action button', async () => {
    useUpdateStore.setState({ phase: 'checking' });

    render(<SettingsPanel />);
    await waitFor(() => {});

    expect(screen.getByRole('button', { name: 'settings.general.checkingUpdate' })).toBeDisabled();
    expect(screen.queryByText('update.checking')).not.toBeInTheDocument();
  });

  it('shows a single retry action and a persistent notice for a failed update', async () => {
    useUpdateStore.setState({ phase: 'error', error: undefined });

    render(<SettingsPanel />);
    await waitFor(() => {});

    const retry = screen.getByRole('button', { name: 'settings.general.retry' });
    const row = retry.closest('[data-slot="field"]');
    const notice = screen.getByRole('alert');

    expect(row).toContainElement(notice);
    expect(row?.querySelector('[data-slot="update-actions"]')).toContainElement(retry);
    expect(row?.querySelectorAll('button')).toHaveLength(1);
    expect(notice).toHaveTextContent('update.failedFriendly');
  });

  it('groups related settings into compact outline cards with inset hairline dividers', async () => {
    render(<SettingsPanel />);
    await waitFor(() => {});

    const startupRow = screen
      .getByText('settings.general.startupSection')
      .closest('[data-slot="field"]');
    const updateRow = screen
      .getByText('settings.general.update')
      .closest('[data-slot="field"]');
    const behaviorCard = startupRow?.closest('[data-slot="card"]');
    const updateCard = updateRow?.closest('[data-slot="card"]');
    const behaviorGroup = startupRow?.closest('[data-slot="settings-group"]');
    const settingsGroups = behaviorGroup?.closest('[data-slot="settings-groups"]');

    expect(startupRow).toHaveClass('min-h-14', 'px-4', 'py-3', '@min-[32rem]:flex-row');
    expect(behaviorCard).toHaveAttribute('data-size', 'sm');
    expect(behaviorCard).toHaveAttribute('data-radius', 'compact');
    expect(behaviorCard).toHaveAttribute('data-variant', 'outline');
    expect(updateCard).not.toBe(behaviorCard);
    expect(screen.getByText('settings.general.startupUpdateCheck').closest('[data-slot="card"]')).toBe(updateCard);
    expect(screen.getByRole('heading', { name: 'settings.general.softwareUpdate' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'settings.general.appBehavior' })).toHaveAttribute('class', screen.getByRole('heading', { name: 'settings.general.softwareUpdate' }).className);
    expect(screen.getByRole('button', { name: 'settings.general.checkUpdate' })).toHaveAttribute('data-variant', 'soft');
    expect(behaviorCard?.querySelectorAll('[data-slot="separator"]')).toHaveLength(3);
    expect(updateCard?.querySelectorAll('[data-slot="separator"]')).toHaveLength(1);
    expect(settingsGroups).toHaveClass('flex-col', 'gap-3');
    expect(settingsGroups?.firstElementChild).toHaveClass('gap-2');

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

  it('places the section heading inside the content scroller and keeps shortcut rows compact', async () => {
    render(<SettingsPanel />);
    await waitFor(() => {});

    const sectionHeader = screen
      .getByRole('heading', { name: 'settings.general.title', level: 2 })
      .parentElement?.parentElement;
    expect(sectionHeader).toHaveClass('mb-6');
    expect(sectionHeader?.closest('[data-slot="scroll-area"]')).toBeTruthy();
    expect(sectionHeader?.closest('section')).toHaveClass('min-h-0', 'flex-1');

    const contentScroller = screen.getByRole('tabpanel').closest('[data-slot="scroll-area"]');
    const viewport = contentScroller?.querySelector('[data-slot="scroll-area-viewport"]');
    expect(viewport?.firstElementChild).toHaveClass('px-2', 'max-w-4xl', 'py-6');

    openSection('settings.shortcuts.title');
    const shortcutRow = screen.getByText('settings.shortcuts.newTerminalTab').parentElement;
    expect(shortcutRow).toHaveClass('min-h-11', 'px-4', 'py-1.5');
  });

  it('reports close requests without changing the active app section', async () => {
    const onOpenChange = vi.fn();
    useAppStore.setState({ activeSection: 'terminal' });
    render(<SettingsPanel open onOpenChange={onOpenChange} />);

    fireEvent.click(screen.getByRole('button', { name: 'common.close' }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(useAppStore.getState().activeSection).toBe('terminal');
  });

  it('groups model providers and terminal context in one settings card', async () => {
    render(<SettingsPanel />);
    await waitFor(() => {});
    openSection('settings.ai.title');

    const providerSection = screen.getByText('settings.ai.providers').closest('[data-slot="settings-group"]');
    const providerCard = providerSection?.querySelector('[data-slot="card"]');
    const providerRows = providerCard?.querySelectorAll('[data-slot="ai-provider-row"]');
    const contextField = screen.getByText('settings.ai.contextLines').closest('[data-slot="field"]');

    expect(providerCard).not.toBeNull();
    expect(providerRows).toHaveLength(useAiSettingsStore.getState().providers.length);
    expect(contextField?.closest('[data-slot="card"]')).toBe(providerCard);
    expect(screen.getAllByRole('button', { name: 'settings.ai.editProvider' })).not.toHaveLength(0);
  });

  it('explains how to add the first provider when none is configured', async () => {
    const previousProviders = useAiSettingsStore.getState().providers;
    const previousDefault = useAiSettingsStore.getState().defaultProviderId;
    useAiSettingsStore.setState({ providers: [], defaultProviderId: '' });
    try {
      render(<SettingsPanel />);
      await waitFor(() => {});
      openSection('settings.ai.title');

      const emptyState = screen.getByText('settings.ai.providersEmpty').closest('[data-slot="empty-state"]');
      const providerGroup = emptyState?.closest('[data-slot="settings-group"]');

      expect(emptyState).toHaveTextContent('settings.ai.providersEmptyDescription');
      expect(providerGroup).toBeInTheDocument();
      expect(providerGroup?.querySelectorAll('[data-slot="ai-provider-row"]')).toHaveLength(0);
      expect(
        screen.getByRole('button', { name: 'settings.ai.addProvider' }),
      ).toBeInTheDocument();
    } finally {
      useAiSettingsStore.setState({
        providers: previousProviders,
        defaultProviderId: previousDefault,
      });
    }
  });

  it('places global shortcut reset in the shortcuts title bar', async () => {
    render(<SettingsPanel />);
    await waitFor(() => {});
    openSection('settings.shortcuts.title');

    const resetAll = screen.getByRole('button', { name: 'settings.shortcuts.resetAll' });
    const title = screen.getByRole('heading', { name: 'settings.shortcuts.title', level: 2 });
    const titleBar = title.parentElement?.parentElement;
    const shortcutPanel = screen.getByRole('tabpanel', { name: 'settings.shortcuts.title' });

    expect(titleBar).toContainElement(resetAll);
    expect(shortcutPanel).not.toContainElement(resetAll);
    expect(resetAll).toBeDisabled();

    act(() => useAppStore.getState().setShortcut('openWorkbench', 'mod+9'));

    expect(resetAll).toBeEnabled();
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

  it('checks conflicts before resetting a single SFTP shortcut', async () => {
    useAppStore.setState({ shortcuts: { ...DEFAULT_SHORTCUTS, findSftp: 'mod+shift+f', newSftpConnection: 'mod+f' } });
    render(<SettingsPanel />);
    openSection('settings.shortcuts.title');
    const row = screen.getByText('settings.shortcuts.findSftp').parentElement!;
    fireEvent.click(within(row).getByRole('button', { name: 'settings.shortcuts.resetOne' }));
    expect(await screen.findByText('settings.shortcuts.conflict')).toBeInTheDocument();
    expect(useAppStore.getState().shortcuts.findSftp).toBe('mod+shift+f');
  });

  it('shows migrated unassigned SFTP shortcuts with a readable label', () => {
    useAppStore.setState({ shortcuts: { ...DEFAULT_SHORTCUTS, findSftp: '' } });
    render(<SettingsPanel />);
    openSection('settings.shortcuts.title');
    const row = screen.getByText('settings.shortcuts.findSftp').parentElement!;
    expect(within(row).getByText('settings.shortcuts.unassigned')).toBeInTheDocument();
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

  it('closes the shortcut recorder from its cancel button', async () => {
    render(<SettingsPanel />);
    await waitFor(() => {});

    await openRecorder('settings.shortcuts.closeTerminalTab');

    fireEvent.click(screen.getByRole('button', { name: 'common.cancel' }));

    expect(screen.queryByText('settings.shortcuts.recordPrompt')).not.toBeInTheDocument();
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

  it('scrolls to the pending terminal title template target when opened', async () => {
    const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
    const scrollIntoView = vi.fn();
    HTMLElement.prototype.scrollIntoView = scrollIntoView;
    try {
      useAppStore.getState().openSettings('terminal', 'terminal-title-template');
      render(<SettingsPanel open onOpenChange={vi.fn()} />);

      await waitFor(() => {
        expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center' });
      });
      const target = document.querySelector('[data-settings-target="terminal-title-template"]');
      expect(target).not.toBeNull();
      expect(scrollIntoView.mock.instances[0]).toBe(target);
      expect(useAppStore.getState().pendingSettingsTarget).toBeNull();
    } finally {
      HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
    }
  });

  it('displays readable labels for terminal minimum contrast ratio and updates the store', async () => {
    const user = userEvent.setup();
    useAppStore.setState({ activeSettingsSection: 'terminal', terminalMinimumContrastRatio: 4.5 });
    render(<SettingsPanel />);
    await waitFor(() => {});

    const trigger = screen.getByRole('combobox', { name: 'settings.terminal.minimumContrastRatio' });
    expect(trigger).toHaveTextContent('settings.terminal.minimumContrastRatio.standard');
    expect(trigger).not.toHaveTextContent('4.5');

    await user.click(trigger);
    await user.click(await screen.findByRole('option', { name: 'settings.terminal.minimumContrastRatio.off' }));

    expect(useAppStore.getState().terminalMinimumContrastRatio).toBe(1);
    expect(trigger).toHaveTextContent('settings.terminal.minimumContrastRatio.off');

    await user.click(trigger);
    await user.click(await screen.findByRole('option', { name: 'settings.terminal.minimumContrastRatio.high' }));

    expect(useAppStore.getState().terminalMinimumContrastRatio).toBe(7);
    expect(trigger).toHaveTextContent('settings.terminal.minimumContrastRatio.high');
  });
});
