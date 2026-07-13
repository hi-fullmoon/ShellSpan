import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { NewTabMenu } from '../NewTabMenu';
import { useProfileStore } from '@/stores/profileStore';
import { useAppStore } from '@/stores/appStore';
import type { ConnectionProfile } from '@/types';

const mockConnect = vi.fn();

vi.mock('@/hooks/useI18n', () => ({
  useI18n: () => ({
    t: (key: string, variables?: Record<string, string | number>) => {
      if (variables && key === 'terminal.newTabMenu.connectionCount') {
        return `${variables.count} connections`;
      }
      return key;
    },
    ready: true,
    locale: 'en-US',
    setLocale: () => {},
  }),
}));

vi.mock('@/hooks/useConnectSession', () => ({
  useConnectSession: () => ({
    connect: mockConnect,
    hostKeyDialog: {
      open: false,
      host: '',
      port: 22,
      mismatch: false,
      onTrust: () => {},
    },
    closeHostKeyDialog: vi.fn(),
  }),
}));

vi.mock('@/lib/tauri', () => ({
  invokeRetrievePassword: vi.fn().mockResolvedValue(null),
  invokeStorePassword: vi.fn().mockResolvedValue(undefined),
  invokeRemovePassword: vi.fn().mockResolvedValue(undefined),
}));

const initialProfile = useProfileStore.getState();
const initialApp = useAppStore.getState();

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
    mockConnect.mockReset();
  });

  afterEach(() => {
    cleanup();
    useProfileStore.setState(initialProfile, true);
    useAppStore.setState(initialApp, true);
  });

  it('renders saved profiles and connects on row click then closes', () => {
    const p1 = makeProfile('p1', 'Alpha', 'host1.io', 'user1');
    const p2 = makeProfile('p2', 'Beta', 'host2.io', 'user2');
    useProfileStore.setState({ profiles: [p1, p2] });

    const onClose = vi.fn();
    render(<NewTabMenu open onClose={onClose} />);

    expect(screen.getByText('Alpha')).toBeInTheDocument();
    expect(screen.getByText('Beta')).toBeInTheDocument();
    expect(screen.getByText('user1@host1.io:22')).toBeInTheDocument();
    expect(screen.getByText('user2@host2.io:22')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Alpha'));

    expect(mockConnect).toHaveBeenCalledTimes(1);
    expect(mockConnect).toHaveBeenCalledWith(p1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('filters profiles by search query', () => {
    const p1 = makeProfile('p1', 'Alpha', 'host1.io', 'user1');
    const p2 = makeProfile('p2', 'Beta', 'host2.io', 'user2');
    useProfileStore.setState({ profiles: [p1, p2] });

    render(<NewTabMenu open onClose={vi.fn()} />);

    const searchInput = screen.getByPlaceholderText(
      'terminal.newTabMenu.searchPlaceholder',
    );
    fireEvent.change(searchInput, { target: { value: 'beta' } });

    expect(screen.queryByText('Alpha')).not.toBeInTheDocument();
    expect(screen.getByText('Beta')).toBeInTheDocument();
  });

  it('shows the empty hint and a go-to-workbench button when no profiles', () => {
    useProfileStore.setState({ profiles: [] });

    const onClose = vi.fn();
    render(<NewTabMenu open onClose={onClose} />);

    expect(screen.getByText('terminal.tab.noProfiles')).toBeInTheDocument();
    const workbenchButton = screen.getByRole('button', {
      name: 'section.workbench',
    });
    expect(workbenchButton).toBeInTheDocument();

    fireEvent.click(workbenchButton);

    expect(useAppStore.getState().activeSection).toBe('workbench');
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it('renders nothing when open is false', () => {
    const { container } = render(<NewTabMenu open={false} onClose={vi.fn()} />);
    expect(container.firstChild).toBeNull();
  });

  it('closes when the backdrop is clicked', () => {
    useProfileStore.setState({
      profiles: [makeProfile('p1', 'Alpha', 'host1.io', 'user1')],
    });

    const onClose = vi.fn();
    const { container } = render(<NewTabMenu open onClose={onClose} />);

    const backdrop = container.querySelector('[role="presentation"]') as HTMLElement;
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
    render(<NewTabMenu open onClose={onClose} />);

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
