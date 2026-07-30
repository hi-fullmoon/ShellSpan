import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsPanel } from '../settings-panel';
import { DEFAULT_SHORTCUTS, useAppStore } from '@/stores/appStore';
import type { ShortcutBindings } from '@/types';

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
    useAppStore.setState({ shortcuts: { ...DEFAULT_SHORTCUTS } });
  });

  const openSection = (titleKey: string): void => {
    fireEvent.click(screen.getByRole('button', { name: titleKey }));
  };

  it('renders one section at a time with sidebar navigation', async () => {
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
      expect(screen.getByRole('button', { name: titleKey })).toBeInTheDocument();
    }

    // Appearance is the default section.
    expect(screen.getByText('settings.appearance.theme')).toBeInTheDocument();
    expect(screen.getByText('settings.appearance.language')).toBeInTheDocument();
    expect(screen.queryByText('settings.terminal.fontSize')).not.toBeInTheDocument();
    expect(
      screen.getByRole('combobox', { name: 'settings.appearance.theme' }),
    ).toHaveTextContent('theme.system');
    expect(
      screen.getByRole('combobox', { name: 'settings.appearance.language' }),
    ).toHaveTextContent('locale.zh-CN');

    openSection('settings.general.title');
    expect(screen.getByText('settings.general.startupSection')).toBeInTheDocument();
    expect(screen.getByText('settings.general.startupUpdateCheck')).toBeInTheDocument();
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
