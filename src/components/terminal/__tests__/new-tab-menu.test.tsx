import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { NewTabMenu } from '../new-tab-menu';
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

vi.mock('@/lib/tauri', () => ({
  invokeRetrievePassword: vi.fn().mockResolvedValue(null),
  invokeStorePassword: vi.fn().mockResolvedValue(undefined),
  invokeRemovePassword: vi.fn().mockResolvedValue(undefined),
}));

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

describe('NewTabMenu', () => {
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
    render(<NewTabMenu open onClose={onClose} onConnect={mockConnect} />);

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
    render(<NewTabMenu open onClose={onClose} onConnect={mockConnect} />);

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

    render(<NewTabMenu open onClose={vi.fn()} onConnect={mockConnect} />);

    const section = screen.getByText('terminal.newTabMenu.recentConnections');
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

    render(<NewTabMenu open onClose={vi.fn()} onConnect={mockConnect} />);

    const searchInput = screen.getByPlaceholderText(
      'terminal.newTabMenu.searchPlaceholder',
    );
    fireEvent.change(searchInput, { target: { value: 'beta' } });

    expect(screen.queryByText('Alpha')).not.toBeInTheDocument();
    expect(screen.getByText('Beta')).toBeInTheDocument();
  });

  it('navigates with arrow keys and connects on enter', () => {
    const p1 = makeProfile('p1', 'Alpha', 'host1.io', 'user1');
    const p2 = makeProfile('p2', 'Beta', 'host2.io', 'user2');
    useProfileStore.setState({ profiles: [p1, p2] });

    const onClose = vi.fn();
    render(<NewTabMenu open onClose={onClose} onConnect={mockConnect} />);

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
      <NewTabMenu
        open
        onClose={onClose}
        onConnect={mockConnect}
        onOpenLocal={onOpenLocal}
      />,
    );

    expect(screen.getByText('terminal.newTabMenu.localTerminal')).toBeInTheDocument();
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

    render(<NewTabMenu open onClose={vi.fn()} onConnect={mockConnect} />);

    fireEvent.keyDown(document, { key: 'ArrowUp' });
    fireEvent.keyDown(document, { key: 'Enter' });

    expect(mockConnect).toHaveBeenCalledWith(p2);
  });

  it('shows the empty hint and opens workbench from footer when no profiles', () => {
    useProfileStore.setState({ profiles: [] });

    const onClose = vi.fn();
    render(<NewTabMenu open onClose={onClose} onConnect={mockConnect} />);

    expect(screen.getByText('terminal.tab.noProfiles')).toBeInTheDocument();
    expect(
      screen.getByText('terminal.newTabMenu.openWorkbenchHint'),
    ).toBeInTheDocument();

    const workbenchButton = screen.getByRole('button', {
      name: 'terminal.newTabMenu.openWorkbench',
    });
    expect(workbenchButton).toBeInTheDocument();

    fireEvent.click(workbenchButton);

    expect(useAppStore.getState().activeSection).toBe('workbench');
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it('renders nothing when open is false', () => {
    const { container } = render(
      <NewTabMenu open={false} onClose={vi.fn()} onConnect={mockConnect} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('closes when the backdrop is clicked', () => {
    useProfileStore.setState({
      profiles: [makeProfile('p1', 'Alpha', 'host1.io', 'user1')],
    });

    const onClose = vi.fn();
    render(<NewTabMenu open onClose={onClose} onConnect={mockConnect} />);

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
    render(<NewTabMenu open onClose={onClose} onConnect={mockConnect} />);

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
