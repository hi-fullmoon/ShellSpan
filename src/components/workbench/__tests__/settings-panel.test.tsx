import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SettingsPanel } from '../settings-panel';

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
  it('renders appearance and general sections', () => {
    render(<SettingsPanel />);

    expect(screen.getByText('workbench.settings.title')).toBeInTheDocument();
    expect(screen.getByText('settings.appearance.title')).toBeInTheDocument();
    expect(screen.getByText('settings.appearance.theme')).toBeInTheDocument();
    expect(screen.getByText('settings.appearance.language')).toBeInTheDocument();
    expect(screen.getByText('settings.general.title')).toBeInTheDocument();
    expect(
      screen.getByText('settings.general.startupUpdateCheck'),
    ).toBeInTheDocument();
    expect(screen.getByRole('switch')).toBeInTheDocument();
  });
});
