import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { Platform } from '@/lib/platform';
import { useAppStore } from '@/stores/appStore';
import { useAiPanelStore } from '@/stores/aiPanelStore';
import { TitleBar } from '../title-bar';

const mocks = vi.hoisted(() => ({
  platform: 'windows' as Platform,
}));

vi.mock('@/hooks/usePlatform', () => ({
  usePlatform: () => mocks.platform,
}));

vi.mock('@/hooks/useWindowControls', () => ({
  useWindowControls: () => ({
    minimize: vi.fn(),
    toggleMaximize: vi.fn(),
    close: vi.fn(),
    isMaximized: false,
  }),
}));

vi.mock('@/hooks/useI18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}));

describe('TitleBar', () => {
  beforeEach(() => {
    mocks.platform = 'windows';
    useAppStore.setState({ activeSection: 'workbench' });
    useAiPanelStore.setState({
      panelOpenBySection: { workbench: false, terminal: false },
    });
  });

  it('keeps the Windows controls flush with the right edge', () => {
    const { container } = render(<TitleBar />);
    const actions = container.querySelector('[data-slot="titlebar-actions"]');
    const controls = screen.getByRole('button', { name: 'close' }).parentElement;

    expect(actions).not.toHaveClass('pr-2');
    expect(actions?.lastElementChild).toBe(controls);
  });

  it('retains right padding when macOS window controls are absent', () => {
    mocks.platform = 'macos';

    const { container } = render(<TitleBar />);

    expect(container.querySelector('[data-slot="titlebar-actions"]')).toHaveClass('pr-2');
    expect(screen.queryByRole('button', { name: 'close' })).not.toBeInTheDocument();
  });
});
