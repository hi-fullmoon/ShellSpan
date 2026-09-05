import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { NewSessionDialog } from '../new-session-dialog';
import { useProfileStore } from '@/stores/profileStore';
import { useAppStore } from '@/stores/appStore';
import { useRecentProfilesStore } from '@/stores/recentProfilesStore';
import type { ConnectionProfile } from '@/types';

const mockConnect = vi.fn();

vi.mock('@/hooks/useI18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
    ready: true,
    locale: 'en-US',
    setLocale: () => {},
  }),
}));

vi.mock('@/lib/ipc/tauri', () => ({}));

const initialProfile = useProfileStore.getState();
const initialApp = useAppStore.getState();
const initialRecent = useRecentProfilesStore.getState();

function makeProfile(
  id: string,
  name: string,
  host: string,
  username: string,
): ConnectionProfile {
  return {
    id,
    name,
    host,
    port: 22,
    username,
    authMethod: 'password',
    createdAt: 0,
    updatedAt: 0,
  };
}

describe('NewSessionDialog', () => {
  beforeEach(() => {
    useProfileStore.setState(initialProfile, true);
    useAppStore.setState(initialApp, true);
    useRecentProfilesStore.setState(initialRecent, true);
    mockConnect.mockReset();
  });

  afterEach(() => {
    cleanup();
    useProfileStore.setState(initialProfile, true);
    useAppStore.setState(initialApp, true);
    useRecentProfilesStore.setState(initialRecent, true);
  });

  it('renders saved profiles and connects on row click then closes', () => {
    const p1 = makeProfile('p1', 'Alpha', 'host1.io', 'user1');
    const p2 = makeProfile('p2', 'Beta', 'host2.io', 'user2');
    useProfileStore.setState({ profiles: [p1, p2] });

    const onClose = vi.fn();
    render(<NewSessionDialog open onClose={onClose} onConnect={mockConnect} />);

    expect(screen.getByText('Alpha')).toBeInTheDocument();
    expect(screen.getByText('Beta')).toBeInTheDocument();
    expect(screen.getByText('user1@host1.io:22')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Alpha'));

    expect(mockConnect).toHaveBeenCalledTimes(1);
    expect(mockConnect).toHaveBeenCalledWith(p1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('connects only once when a profile row is double-clicked', () => {
    const profile = makeProfile('p1', 'Alpha', 'host1.io', 'user1');
    useProfileStore.setState({ profiles: [profile] });

    const onClose = vi.fn();
    render(<NewSessionDialog open onClose={onClose} onConnect={mockConnect} />);

    const row = screen.getByRole('button', { name: 'Alpha' });
    fireEvent.click(row, { detail: 1 });
    fireEvent.click(row, { detail: 2 });

    expect(mockConnect).toHaveBeenCalledTimes(1);
    expect(mockConnect).toHaveBeenCalledWith(profile);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('shows recent profiles first when recentIds exist', () => {
    const p1 = makeProfile('p1', 'Alpha', 'host1.io', 'user1');
    const p2 = makeProfile('p2', 'Beta', 'host2.io', 'user2');
    const p3 = makeProfile('p3', 'Gamma', 'host3.io', 'user3');
    useProfileStore.setState({ profiles: [p1, p2, p3] });
    useRecentProfilesStore.setState({ recentIds: ['p3', 'p2'] });

    render(<NewSessionDialog open onClose={vi.fn()} onConnect={mockConnect} />);

    const section = screen.getByText('terminal.newSession.recentConnections');
    expect(section).toBeInTheDocument();

    const buttons = screen.getAllByRole('button', { name: /^(Alpha|Beta|Gamma)$/ });
    expect(buttons[0]).toHaveTextContent('Gamma');
    expect(buttons[1]).toHaveTextContent('Beta');
    expect(buttons[2]).toHaveTextContent('Alpha');
  });

  it('filters profiles by search query', () => {
    const p1 = makeProfile('p1', 'Alpha', 'host1.io', 'user1');
    const p2 = makeProfile('p2', 'Beta', 'host2.io', 'user2');
    useProfileStore.setState({ profiles: [p1, p2] });

    render(<NewSessionDialog open onClose={vi.fn()} onConnect={mockConnect} />);

    const searchInput = screen.getByPlaceholderText(
      'terminal.newSession.searchPlaceholder',
    );
    fireEvent.change(searchInput, { target: { value: 'beta' } });

    expect(screen.queryByText('Alpha')).not.toBeInTheDocument();
    expect(screen.getByText('Beta')).toBeInTheDocument();
  });

  it('renders an accessible dialog and focuses search when opened', async () => {
    useProfileStore.setState({
      profiles: [makeProfile('p1', 'Alpha', 'host1.io', 'user1')],
    });

    render(<NewSessionDialog open onClose={vi.fn()} onConnect={mockConnect} />);

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'terminal.newSession.title' }),
    ).toBeInTheDocument();
    const searchInput = screen.getByPlaceholderText(
      'terminal.newSession.searchPlaceholder',
    );
    await waitFor(() => {
      expect(searchInput).toHaveFocus();
    });
    expect(searchInput.parentElement).toHaveClass(
      'has-[[data-slot=input-group-control]:focus-visible]:ring-1',
    );
    expect(searchInput.parentElement).not.toHaveClass(
      'has-[[data-slot=input-group-control]:focus-visible]:ring-3',
    );
  });

  it('navigates with arrow keys and connects on enter', () => {
    const p1 = makeProfile('p1', 'Alpha', 'host1.io', 'user1');
    const p2 = makeProfile('p2', 'Beta', 'host2.io', 'user2');
    useProfileStore.setState({ profiles: [p1, p2] });

    const onClose = vi.fn();
    render(<NewSessionDialog open onClose={onClose} onConnect={mockConnect} />);

    fireEvent.keyDown(document, { key: 'ArrowDown' });
    fireEvent.keyDown(document, { key: 'Enter' });

    expect(mockConnect).toHaveBeenCalledTimes(1);
    expect(mockConnect).toHaveBeenCalledWith(p2);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('opens a local terminal and supports Ctrl+N/Ctrl+P navigation', () => {
    const p1 = makeProfile('p1', 'Alpha', 'host1.io', 'user1');
    useProfileStore.setState({ profiles: [p1] });
    const onOpenLocal = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();

    render(
      <NewSessionDialog
        open
        onClose={onClose}
        onConnect={mockConnect}
        onOpenLocal={onOpenLocal}
      />,
    );

    expect(screen.getByText('terminal.newSession.localTerminal')).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'n', ctrlKey: true });
    fireEvent.keyDown(document, { key: 'p', ctrlKey: true });
    fireEvent.keyDown(document, { key: 'Enter' });

    expect(onOpenLocal).toHaveBeenCalledTimes(1);
    expect(mockConnect).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('cycles selection with arrow keys', () => {
    const p1 = makeProfile('p1', 'Alpha', 'host1.io', 'user1');
    const p2 = makeProfile('p2', 'Beta', 'host2.io', 'user2');
    useProfileStore.setState({ profiles: [p1, p2] });

    render(<NewSessionDialog open onClose={vi.fn()} onConnect={mockConnect} />);

    fireEvent.keyDown(document, { key: 'ArrowUp' });
    fireEvent.keyDown(document, { key: 'Enter' });

    expect(mockConnect).toHaveBeenCalledWith(p2);
  });

  it('does not connect the selected profile when Enter is pressed on the workbench button', () => {
    const profile = makeProfile('p1', 'Alpha', 'host1.io', 'user1');
    useProfileStore.setState({ profiles: [profile] });
    const onClose = vi.fn();
    render(<NewSessionDialog open onClose={onClose} onConnect={mockConnect} />);
    const workbenchButton = screen.getByRole('button', {
      name: 'terminal.newSession.manageConnections',
    });
    workbenchButton.focus();

    fireEvent.keyDown(workbenchButton, { key: 'Enter' });
    fireEvent.click(workbenchButton);

    expect(mockConnect).not.toHaveBeenCalled();
    expect(useAppStore.getState().activeSection).toBe('workbench');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('shows the empty hint and opens the connection manager from the footer', () => {
    useProfileStore.setState({ profiles: [] });

    const onClose = vi.fn();
    render(<NewSessionDialog open onClose={onClose} onConnect={mockConnect} />);

    expect(screen.getByText('terminal.newSession.noSearchResults')).toBeInTheDocument();
    expect(
      screen.getByText('terminal.newSession.noSearchResultsHint'),
    ).toBeInTheDocument();

    const workbenchButton = screen.getByRole('button', {
      name: 'terminal.newSession.manageConnections',
    });
    expect(workbenchButton).toBeInTheDocument();

    fireEvent.click(workbenchButton);

    expect(useAppStore.getState().activeSection).toBe('workbench');
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it('routes a new SSH connection request to the workbench form', () => {
    useAppStore.getState().setActiveSection('terminal');
    const onClose = vi.fn();
    render(<NewSessionDialog open onClose={onClose} onConnect={mockConnect} />);

    fireEvent.click(screen.getByRole('button', {
      name: 'terminal.newSession.createConnection',
    }));

    expect(useAppStore.getState()).toMatchObject({
      activeSection: 'workbench',
      activeWorkbenchTab: 'connections',
      pendingWorkbenchAction: 'newConnection',
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('renders nothing when open is false', () => {
    const { container } = render(
      <NewSessionDialog open={false} onClose={vi.fn()} onConnect={mockConnect} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('closes when the backdrop is clicked', () => {
    useProfileStore.setState({
      profiles: [makeProfile('p1', 'Alpha', 'host1.io', 'user1')],
    });

    const onClose = vi.fn();
    render(<NewSessionDialog open onClose={onClose} onConnect={mockConnect} />);

    const backdrop = document.body.querySelector('[role="presentation"]') as HTMLElement;
    expect(backdrop).not.toBeNull();
    fireEvent.click(backdrop);

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it('closes on Escape key when open', () => {
    useProfileStore.setState({
      profiles: [makeProfile('p1', 'Alpha', 'host1.io', 'user1')],
    });

    const onClose = vi.fn();
    render(<NewSessionDialog open onClose={onClose} onConnect={mockConnect} />);

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
