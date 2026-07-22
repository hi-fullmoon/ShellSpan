import { render, screen, waitFor } from '@testing-library/react';
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

  it('renders appearance, terminal, general, and shortcut sections', async () => {
    render(<SettingsPanel />);
    await waitFor(() => {});

    expect(screen.getByText('workbench.settings.title')).toBeInTheDocument();
    expect(screen.getByText('settings.appearance.title')).toBeInTheDocument();
    expect(screen.getByText('settings.appearance.theme')).toBeInTheDocument();
    expect(screen.getByText('settings.appearance.language')).toBeInTheDocument();
    expect(screen.getByText('settings.general.title')).toBeInTheDocument();
    expect(screen.getByText('settings.terminal.title')).toBeInTheDocument();
    expect(screen.getByText('settings.terminal.fontSize')).toBeInTheDocument();
    expect(screen.getByText('settings.terminal.fontFamily')).toBeInTheDocument();
    expect(screen.getByText('settings.terminal.cursorStyle')).toBeInTheDocument();
    expect(screen.getByText('settings.terminal.cursorBlink')).toBeInTheDocument();
    expect(screen.getByText('settings.terminal.copyOnSelect')).toBeInTheDocument();
    expect(screen.getByText('settings.terminal.scrollback')).toBeInTheDocument();
    expect(screen.getByText('settings.shortcuts.title')).toBeInTheDocument();
    expect(screen.getByText('settings.general.startupSection')).toBeInTheDocument();
    expect(screen.getByText('settings.sftp.title')).toBeInTheDocument();
    expect(screen.getByText('settings.sftp.showHiddenFiles')).toBeInTheDocument();
    expect(
      screen.getByRole('combobox', { name: 'settings.appearance.theme' }),
    ).toHaveTextContent('theme.system');
    expect(
      screen.getByRole('combobox', { name: 'settings.appearance.language' }),
    ).toHaveTextContent('locale.zh-CN');
    expect(
      screen.getByText('settings.general.startupUpdateCheck'),
    ).toBeInTheDocument();
    expect(screen.getAllByRole('switch')).toHaveLength(14);
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
    expect(screen.getByText('settings.shortcuts.newTerminalTab')).toBeInTheDocument();
  });
});
