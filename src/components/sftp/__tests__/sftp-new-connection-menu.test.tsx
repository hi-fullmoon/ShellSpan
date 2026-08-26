import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SftpNewConnectionMenu } from '../sftp-new-connection-menu';
import { useAppStore } from '@/stores/appStore';
import { useProfileStore } from '@/stores/profileStore';
import { useRecentProfilesStore } from '@/stores/recentProfilesStore';
import type { ConnectionProfile } from '@/types';

vi.mock('@/hooks/useI18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
    ready: true,
    locale: 'en-US',
    setLocale: () => {},
  }),
}));

const initialProfile = useProfileStore.getState();
const initialApp = useAppStore.getState();
const initialRecent = useRecentProfilesStore.getState();

const profile: ConnectionProfile = {
  id: 'p1',
  name: 'Alpha',
  host: 'host1.io',
  port: 22,
  username: 'user1',
  authMethod: 'password',
  createdAt: 0,
  updatedAt: 0,
};

describe('SftpNewConnectionMenu', () => {
  beforeEach(() => {
    useProfileStore.setState(initialProfile, true);
    useAppStore.setState(initialApp, true);
    useRecentProfilesStore.setState(initialRecent, true);
  });

  afterEach(() => {
    cleanup();
    useProfileStore.setState(initialProfile, true);
    useAppStore.setState(initialApp, true);
    useRecentProfilesStore.setState(initialRecent, true);
  });

  it('connects only once when a profile row is double-clicked', () => {
    useProfileStore.setState({ profiles: [profile] });
    const onConnect = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();

    render(
      <SftpNewConnectionMenu
        open
        onClose={onClose}
        onConnect={onConnect}
      />,
    );

    const row = screen.getByRole('button', { name: 'Alpha' });
    fireEvent.click(row, { detail: 1 });
    fireEvent.click(row, { detail: 2 });

    expect(onConnect).toHaveBeenCalledTimes(1);
    expect(onConnect).toHaveBeenCalledWith(profile);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('renders an accessible dialog and focuses search when opened', async () => {
    useProfileStore.setState({ profiles: [profile] });

    render(
      <SftpNewConnectionMenu
        open
        onClose={vi.fn()}
        onConnect={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'sftp.newConnectionMenu.title' }),
    ).toBeInTheDocument();
    expect(screen.getByText('sftp.newConnectionMenu.description')).toBeInTheDocument();
    const searchInput = screen.getByPlaceholderText(
      'sftp.newConnectionMenu.searchPlaceholder',
    );
    await waitFor(() => {
      expect(searchInput).toHaveFocus();
    });
    expect(searchInput.parentElement).toHaveClass(
      'h-10',
      'has-[[data-slot=input-group-control]:focus-visible]:ring-1',
    );
    expect(screen.getByRole('button', { name: 'common.close' })).toBeInTheDocument();
  });

  it('moves selection with arrow keys and connects with Enter', () => {
    const secondProfile: ConnectionProfile = {
      ...profile,
      id: 'p2',
      name: 'Beta',
      host: 'host2.io',
    };
    useProfileStore.setState({ profiles: [profile, secondProfile] });
    const onConnect = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();

    render(
      <SftpNewConnectionMenu
        open
        onClose={onClose}
        onConnect={onConnect}
      />,
    );

    fireEvent.keyDown(document, { key: 'ArrowDown' });
    fireEvent.keyDown(document, { key: 'Enter' });

    expect(onConnect).toHaveBeenCalledTimes(1);
    expect(onConnect).toHaveBeenCalledWith(secondProfile);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on Escape without activating a connection', () => {
    useProfileStore.setState({ profiles: [profile] });
    const onConnect = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();

    render(
      <SftpNewConnectionMenu
        open
        onClose={onClose}
        onConnect={onConnect}
      />,
    );

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onConnect).not.toHaveBeenCalled();
  });
});
