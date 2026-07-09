import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TerminalPane } from './TerminalPane';
import type { TerminalSession as TerminalSessionState } from '@/stores/terminalStore';

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
    render(<TerminalPane activeSession={makeSession()} />);
    expect(screen.getByTitle('Search')).toBeInTheDocument();
  });

  it('opens and closes the search bar via the toggle button', async () => {
    render(<TerminalPane activeSession={makeSession()} />);
    expect(screen.queryByPlaceholderText('Search...')).toBeNull();
    await userEvent.click(screen.getByTitle('Search'));
    expect(screen.getByPlaceholderText('Search...')).toBeInTheDocument();
    await userEvent.click(screen.getByTitle('Search'));
    expect(screen.queryByPlaceholderText('Search...')).toBeNull();
  });

  it('shows the connecting overlay when status is connecting', () => {
    render(<TerminalPane activeSession={makeSession({ status: 'connecting' })} />);
    const overlay = document.querySelector('div.absolute.inset-0.z-10');
    expect(overlay).not.toBeNull();
    expect(overlay?.querySelector('span')?.textContent ?? '').toMatch(/\.\.\.$/);
  });

  it('hides the connecting overlay when status is not connecting', () => {
    render(<TerminalPane activeSession={makeSession({ status: 'connected' })} />);
    expect(document.querySelector('div.absolute.inset-0.z-10')).toBeNull();
  });

  it('renders without an active session', () => {
    render(<TerminalPane activeSession={null} />);
    expect(screen.getByTitle('Search')).toBeInTheDocument();
  });
});