import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { DEFAULT_SHORTCUTS, useAppStore } from '@/stores/appStore';
import type { TerminalSession } from '@/stores/terminalStore';
import { TerminalTabSwitcher } from '../terminal-tab-switcher';

vi.mock('@/hooks/useI18n', () => ({
  useI18n: () => ({
    t: (key: string, values?: Record<string, string | number>) => (
      values?.count === undefined ? key : `${key}:${values.count}`
    ),
  }),
}));

vi.mock('@/hooks/usePlatform', () => ({
  usePlatform: () => 'macos',
}));

const sessions: TerminalSession[] = [
  {
    sessionId: 's1',
    title: 'API server',
    host: 'api.example.com',
    port: 22,
    username: 'deploy',
    status: 'connected',
    pinned: true,
  },
  {
    sessionId: 's2',
    title: 'Worker logs',
    host: 'worker.example.com',
    port: 2202,
    username: 'ops',
    status: 'connecting',
  },
];

describe('TerminalTabSwitcher', () => {
  beforeEach(() => {
    useAppStore.setState({ shortcuts: { ...DEFAULT_SHORTCUTS } });
  });

  it('shows a compact tab list and the configured shortcut', () => {
    render(
      <TerminalTabSwitcher
        sessions={sessions}
        activeSessionId="s1"
        open
        onOpenChange={vi.fn()}
        onSelect={vi.fn()}
      />,
    );

    expect(screen.getByText('API server')).toBeInTheDocument();
    expect(screen.getByText('Worker logs')).toBeInTheDocument();
    expect(screen.getByText('terminal.tabSwitcher.current')).toHaveClass(
      'border-border',
      'text-[10px]',
    );
    expect(screen.getByText('⌘ ⇧ O')).toBeInTheDocument();
    expect(screen.queryByLabelText('terminal.tabSwitcher.preview')).not.toBeInTheDocument();
    expect(screen.getByTestId('terminal-tab-switcher')).toHaveClass(
      'top-[12vh]',
      'translate-y-0',
      'max-w-xl',
    );
  });

  it('filters by host and switches the selected tab with Enter', () => {
    const onOpenChange = vi.fn();
    const onSelect = vi.fn();
    render(
      <TerminalTabSwitcher
        sessions={sessions}
        activeSessionId="s1"
        open
        onOpenChange={onOpenChange}
        onSelect={onSelect}
      />,
    );

    const search = screen.getByRole('searchbox', {
      name: 'terminal.tabSwitcher.searchPlaceholder',
    });
    fireEvent.change(search, { target: { value: 'worker.example.com' } });

    const listbox = screen.getByRole('listbox');
    expect(within(listbox).queryByText('API server')).not.toBeInTheDocument();
    expect(within(listbox).getByText('Worker logs')).toBeInTheDocument();

    fireEvent.keyDown(search, { key: 'Enter' });

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onSelect).toHaveBeenCalledWith('s2');
  });

  it('cycles through tabs with arrow keys before switching', () => {
    const onSelect = vi.fn();
    render(
      <TerminalTabSwitcher
        sessions={sessions}
        activeSessionId="s1"
        open
        onOpenChange={vi.fn()}
        onSelect={onSelect}
      />,
    );

    const search = screen.getByRole('searchbox', {
      name: 'terminal.tabSwitcher.searchPlaceholder',
    });
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    fireEvent.keyDown(search, { key: 'Enter' });

    expect(onSelect).toHaveBeenCalledWith('s2');
  });

  it('cycles through tabs with Ctrl+N and Ctrl+P', () => {
    const onSelect = vi.fn();
    render(
      <TerminalTabSwitcher
        sessions={sessions}
        activeSessionId="s1"
        open
        onOpenChange={vi.fn()}
        onSelect={onSelect}
      />,
    );

    const search = screen.getByRole('searchbox', {
      name: 'terminal.tabSwitcher.searchPlaceholder',
    });
    const options = screen.getAllByRole('option');

    fireEvent.keyDown(search, { key: 'n', ctrlKey: true });
    expect(options[1]).toHaveAttribute('aria-selected', 'true');

    fireEvent.keyDown(search, { key: 'p', ctrlKey: true });
    expect(options[0]).toHaveAttribute('aria-selected', 'true');

    fireEvent.keyDown(search, { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledWith('s1');
  });
});
