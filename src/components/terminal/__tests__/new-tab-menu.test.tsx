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
  overrides: Partial<ConnectionProfile> = {},
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
    ...overrides,
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
    expect(searchInput.parentElement).toHaveAttribute('data-slot', 'input-group');
  });

  it('navigates with arrow keys and connects on enter', () => {
    const p1 = makeProfile('p1', 'Alpha', 'host1.io', 'user1');
    const p2 = makeProfile('p2', 'Beta', 'host2.io', 'user2');
    useProfileStore.setState({ profiles: [p1, p2] });

    const onClose = vi.fn();
    render(<NewSessionDialog open onClose={onClose} onConnect={mockConnect} />);

    const search = screen.getByRole('searchbox');
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    fireEvent.keyDown(search, { key: 'Enter' });

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
    const search = screen.getByRole('searchbox');
    fireEvent.keyDown(search, { key: 'n', ctrlKey: true });
    fireEvent.keyDown(search, { key: 'p', ctrlKey: true });
    fireEvent.keyDown(search, { key: 'Enter' });

    expect(onOpenLocal).toHaveBeenCalledTimes(1);
    expect(mockConnect).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('renders the local terminal icon with the same tinted background as profile icons', () => {
    useProfileStore.setState({ profiles: [makeProfile('p1', 'Alpha', 'host1.io', 'user1')] });

    render(
      <NewSessionDialog
        open
        onClose={vi.fn()}
        onConnect={mockConnect}
        onOpenLocal={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    const localIcon = screen
      .getByRole('button', { name: 'terminal.newSession.localTerminal' })
      .querySelector('span');
    const profileIcon = screen.getByRole('button', { name: 'Alpha' }).querySelector('span');

    expect(localIcon).toHaveClass('bg-primary/10', 'text-primary');
    expect(localIcon).not.toHaveClass('bg-primary', 'text-primary-foreground');
    expect(localIcon?.className).toBe(profileIcon?.className);
  });

  it('cycles selection with arrow keys', () => {
    const p1 = makeProfile('p1', 'Alpha', 'host1.io', 'user1');
    const p2 = makeProfile('p2', 'Beta', 'host2.io', 'user2');
    useProfileStore.setState({ profiles: [p1, p2] });

    render(<NewSessionDialog open onClose={vi.fn()} onConnect={mockConnect} />);

    const search = screen.getByRole('searchbox');
    fireEvent.keyDown(search, { key: 'ArrowUp' });
    fireEvent.keyDown(search, { key: 'Enter' });

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

  it('keeps a definite dialog height and shrink chain so the command list can scroll', () => {
    useProfileStore.setState({
      profiles: [makeProfile('p1', 'Alpha', 'host1.io', 'user1')],
    });

    render(<NewSessionDialog open onClose={vi.fn()} onConnect={mockConnect} />);

    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveClass('h-[76vh]', 'max-h-[76vh]', 'flex-col', 'overflow-hidden');

    expect(dialog.querySelector('[data-slot="dialog-header"]')).toHaveClass('shrink-0');
    expect(dialog.querySelector('[data-slot="dialog-footer"]')).toHaveClass('shrink-0');

    const scrollArea = dialog.querySelector('[data-slot="scroll-area"]');
    expect(scrollArea).toHaveClass('min-h-0', 'flex-1');
    expect(scrollArea).not.toHaveClass('min-h-32');
  });

  it('renders group and tag badges on profile rows and connects when clicking a badge', () => {
    const withMetadata = makeProfile('p1', 'Alpha', 'host1.io', 'user1', {
      group: '  Production  ',
      tags: ['web', ' cn-shanghai ', 'web', ''],
    });
    const withoutMetadata = makeProfile('p2', 'Beta', 'host2.io', 'user2', {
      group: '   ',
      tags: [' '],
    });
    useProfileStore.setState({ profiles: [withMetadata, withoutMetadata] });

    const onClose = vi.fn();
    render(<NewSessionDialog open onClose={onClose} onConnect={mockConnect} />);

    const alphaRow = screen.getByRole('button', { name: 'Alpha' });
    const betaRow = screen.getByRole('button', { name: 'Beta' });

    expect(alphaRow.querySelector('[data-slot="profile-metadata"]')).not.toBeNull();
    expect(betaRow.querySelector('[data-slot="profile-metadata"]')).toBeNull();

    const groupBadge = screen.getByText('Production').closest('[data-slot="badge"]');
    expect(groupBadge).toHaveAttribute('data-variant', 'secondary');
    expect(groupBadge).toHaveClass('bg-background');

    const firstTagBadge = screen.getByText('web').closest('[data-slot="badge"]');
    const secondTagBadge = screen.getByText('cn-shanghai').closest('[data-slot="badge"]');
    expect(firstTagBadge).toHaveAttribute('data-variant', 'outline');
    expect(secondTagBadge).toHaveAttribute('data-variant', 'outline');
    expect(secondTagBadge).toHaveClass('hidden', 'sm:inline-flex');
    expect(screen.getByText('+1').closest('[data-slot="badge"]')).toHaveClass('sm:hidden');

    fireEvent.click(screen.getByText('Production'));
    expect(mockConnect).toHaveBeenCalledTimes(1);
    expect(mockConnect).toHaveBeenCalledWith(withMetadata);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('caps visible tags with overflow counts and surfaces matching overflow tags during search', () => {
    const profile = makeProfile('p1', 'Alpha', 'host1.io', 'user1', {
      group: 'Infra',
      tags: ['web', 'api', 'docker', 'gpu'],
    });
    useProfileStore.setState({ profiles: [profile] });

    render(<NewSessionDialog open onClose={vi.fn()} onConnect={mockConnect} />);

    expect(screen.getByText('Infra')).toBeInTheDocument();
    expect(screen.getByText('web')).toBeInTheDocument();
    expect(screen.getByText('api')).toBeInTheDocument();
    expect(screen.queryByText('docker')).not.toBeInTheDocument();
    expect(screen.getByText('+2')).toHaveClass('hidden', 'sm:inline');
    expect(screen.getByText('+3')).toHaveClass('sm:hidden');

    const searchInput = screen.getByRole('searchbox');
    fireEvent.change(searchInput, { target: { value: 'docker' } });

    expect(screen.getByText('docker')).toBeInTheDocument();
    expect(screen.getByText('web')).toBeInTheDocument();
    expect(screen.queryByText('api')).not.toBeInTheDocument();
  });
});
