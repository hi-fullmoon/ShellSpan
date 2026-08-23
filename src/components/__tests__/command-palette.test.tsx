import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CommandPalette, buildCommandPaletteItems } from '@/components/command-palette';
import { initI18n } from '@/locales';
import { useAppStore } from '@/stores/appStore';
import { useProfileStore } from '@/stores/profileStore';
import { useTerminalStore } from '@/stores/terminalStore';

const profile = {
  id: 'profile-1',
  name: 'Production API',
  host: 'api.example.test',
  port: 22,
  username: 'deploy',
  authMethod: 'password' as const,
  createdAt: 1,
  updatedAt: 1,
};

describe('CommandPalette', () => {
  beforeEach(async () => {
    await initI18n('en-US');
    useAppStore.setState({ locale: 'en-US' });
    useProfileStore.setState({ profiles: [profile], initialized: true });
    useTerminalStore.setState({
      sessions: [{
        sessionId: 'session-1',
        title: 'API shell',
        host: 'api.example.test',
        port: 22,
        username: 'deploy',
        status: 'connected',
        profileId: profile.id,
      }],
      activeSessionId: null,
    });
    useAppStore.setState({ activeSection: 'workbench', activeWorkbenchTab: 'connections' });
  });

  it('builds connection actions without losing their target identity', () => {
    const connect = vi.fn();
    const items = buildCommandPaletteItems({
      profiles: [profile],
      sessions: [],
      label: (key) => key,
      navigate: vi.fn(),
      connect,
      switchTerminal: vi.fn(),
    });

    items.find((item) => item.id === 'profile-sftp-profile-1')?.run();

    expect(connect).toHaveBeenCalledWith('profile-1', 'sftp');
    expect(items.find((item) => item.id === 'profile-terminal-profile-1')?.detail)
      .toBe('deploy@api.example.test:22');
  });

  it('opens from the global event, filters by host, and dispatches the selected action', () => {
    const connectListener = vi.fn();
    document.addEventListener('termbridge:connect-profile', connectListener);
    render(<CommandPalette />);

    act(() => document.dispatchEvent(new Event('termbridge:open-command-palette')));
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'api.example sftp' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(connectListener).toHaveBeenCalledOnce();
    const event = connectListener.mock.calls[0][0] as CustomEvent;
    expect(event.detail).toEqual({ profileId: 'profile-1', target: 'sftp' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    document.removeEventListener('termbridge:connect-profile', connectListener);
  });

  it('switches to an existing terminal session', () => {
    render(<CommandPalette />);
    act(() => document.dispatchEvent(new Event('termbridge:open-command-palette')));
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'API shell' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(useTerminalStore.getState().activeSessionId).toBe('session-1');
    expect(useAppStore.getState().activeSection).toBe('terminal');
  });
});
