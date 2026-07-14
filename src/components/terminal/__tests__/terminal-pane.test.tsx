import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TerminalPane } from '../terminal-pane';
import type { TerminalSession as TerminalSessionState } from '@/stores/terminalStore';

vi.mock('@/hooks/useI18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
    ready: true,
    locale: 'en-US',
    setLocale: () => {},
  }),
}));

function makeSession(
  overrides: Partial<TerminalSessionState> = {},
): TerminalSessionState {
  return {
    sessionId: 's1',
    title: 'session',
    host: 'h',
    port: 22,
    username: 'u',
    status: 'connected',
    ...overrides,
  };
}

describe('TerminalPane', () => {
  it('renders the pane host and search toggle button', () => {
    const { container } = render(<TerminalPane activeSession={makeSession()} />);
    expect(screen.getByTitle('terminal.tab.search')).toBeInTheDocument();
    expect(container.querySelector('div.h-full.w-full.p-0')).toBeInTheDocument();
  });

  it('opens and closes the search bar via the toggle button', async () => {
    render(<TerminalPane activeSession={makeSession()} />);
    expect(screen.queryByPlaceholderText('terminal.search.placeholder')).toBeNull();
    await userEvent.click(screen.getByTitle('terminal.tab.search'));
    expect(screen.getByPlaceholderText('terminal.search.placeholder')).toBeInTheDocument();
    await userEvent.click(screen.getByTitle('terminal.tab.search'));
    expect(screen.queryByPlaceholderText('terminal.search.placeholder')).toBeNull();
  });

  it('shows the connecting overlay when status is connecting', () => {
    render(<TerminalPane activeSession={makeSession({ status: 'connecting' })} />);
    const overlay = document.querySelector('div.absolute.inset-0.z-10');
    expect(overlay).not.toBeNull();
    expect(overlay?.querySelector('span')?.textContent ?? '').toMatch(/\.\.\.$/);
    expect(overlay?.querySelector('svg.animate-spin')).not.toBeNull();
  });

  it('hides the connecting overlay when status is not connecting', () => {
    render(<TerminalPane activeSession={makeSession({ status: 'connected' })} />);
    expect(document.querySelector('div.absolute.inset-0.z-10')).toBeNull();
  });

  it('renders without an active session', () => {
    render(<TerminalPane activeSession={null} />);
    expect(screen.getByTitle('terminal.tab.search')).toBeInTheDocument();
  });
});
