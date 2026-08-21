import { describe, expect, it, vi } from 'vitest';
import { render, fireEvent, screen, waitFor } from '@testing-library/react';
import { ConnectionFormDrawer } from '../connection-form-drawer';
import type { ConnectionProfile } from '@/types';

vi.mock('@/hooks/useI18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
    ready: true,
    locale: 'en-US',
    setLocale: () => {},
  }),
}));

vi.mock('@/lib/tauri', () => ({
  invokePickPrivateKeyFile: vi.fn(),
  invokeReadTextFile: vi.fn(() => Promise.resolve('')),
  invokeListKeyCredentials: vi.fn(() => Promise.resolve([])),
}));

const profile: ConnectionProfile = {
  id: 'p1',
  name: 'My Server',
  host: '192.168.1.1',
  port: 22,
  username: 'root',
  authMethod: 'password',
  password: 'secret',
  createdAt: Date.now(),
  updatedAt: Date.now(),
};

describe('ConnectionFormDrawer', () => {
  it('fills an empty name from the host when the host loses focus', () => {
    render(<ConnectionFormDrawer open={true} onClose={() => {}} onSubmit={() => {}} />);

    const nameInput = screen.getByPlaceholderText('My Server');
    const hostInput = screen.getByPlaceholderText('192.168.1.1');
    fireEvent.change(hostInput, { target: { value: '  server.example.com  ' } });
    fireEvent.blur(hostInput);

    expect(nameInput).toHaveValue('server.example.com');
  });

  it('does not overwrite an existing name when the host loses focus', () => {
    render(<ConnectionFormDrawer open={true} onClose={() => {}} onSubmit={() => {}} />);

    const nameInput = screen.getByPlaceholderText('My Server');
    const hostInput = screen.getByPlaceholderText('192.168.1.1');
    fireEvent.change(nameInput, { target: { value: 'Production' } });
    fireEvent.change(hostInput, { target: { value: 'prod.example.com' } });
    fireEvent.blur(hostInput);

    expect(nameInput).toHaveValue('Production');
  });

  it('does not fill the name while editing an existing connection', () => {
    render(
      <ConnectionFormDrawer
        open={true}
        onClose={() => {}}
        onSubmit={() => {}}
        initial={{ ...profile, name: '' }}
      />,
    );

    const nameInput = screen.getByPlaceholderText('My Server');
    const hostInput = screen.getByPlaceholderText('192.168.1.1');
    fireEvent.blur(hostInput);

    expect(nameInput).toHaveValue('');
  });

  it('renders the form body as a constrained scrollable region', () => {
    render(<ConnectionFormDrawer open={true} onClose={() => {}} onSubmit={() => {}} />);

    const scrollArea = document.body.querySelector(
      '[data-slot="drawer-content"] > [data-slot="scroll-area"]',
    );
    expect(scrollArea).toBeInTheDocument();
    expect(scrollArea).toHaveClass('flex-1');
    expect(scrollArea).toHaveClass('min-h-0');

    const formBody = scrollArea?.querySelector('[data-slot="scroll-area-viewport"] > div');
    expect(formBody).toBeInTheDocument();
    expect(formBody).toHaveClass('flex-col');
    expect(formBody).toHaveClass('gap-5');
  });

  it('renders the auth method as a segmented toggle with the translated label', () => {
    render(<ConnectionFormDrawer open={true} onClose={() => {}} onSubmit={() => {}} />);

    const pressedItem = document.body.querySelector(
      '[data-slot="toggle-group-item"][aria-pressed="true"]',
    );
    expect(pressedItem).toHaveTextContent(/^connection\.form\.auth\.password$/);
  });

  it('renders the translated jump-host auth method label when enabled', () => {
    render(<ConnectionFormDrawer open={true} onClose={() => {}} onSubmit={() => {}} />);

    const jumpHostSwitch = document.body.querySelector('[data-slot="switch"]');
    expect(jumpHostSwitch).toBeInTheDocument();
    fireEvent.click(jumpHostSwitch!);

    const authGroups = document.body.querySelectorAll('[data-slot="toggle-group"]');
    expect(authGroups).toHaveLength(2);
    const pressedItem = authGroups[1].querySelector(
      '[data-slot="toggle-group-item"][aria-pressed="true"]',
    );
    expect(pressedItem).toHaveTextContent(/^connection\.form\.auth\.password$/);
  });

  it('resets form values when opening with a new profile', () => {
    const { rerender } = render(
      <ConnectionFormDrawer open={true} onClose={() => {}} onSubmit={() => {}} initial={profile} />,
    );

    const nameInput = document.body.querySelector('[data-slot="input"]') as HTMLInputElement;
    expect(nameInput.value).toBe('My Server');

    fireEvent.change(nameInput, { target: { value: 'Changed' } });
    expect(nameInput.value).toBe('Changed');

    const nextProfile: ConnectionProfile = { ...profile, id: 'p2', name: 'Other Server' };
    rerender(
      <ConnectionFormDrawer open={true} onClose={() => {}} onSubmit={() => {}} initial={nextProfile} />,
    );

    expect(nameInput.value).toBe('Other Server');
  });

  it('requires a password when password auth is selected', () => {
    const onSubmit = vi.fn();
    const storedProfile: ConnectionProfile = {
      ...profile,
      password: undefined,
    };
    render(
      <ConnectionFormDrawer
        open={true}
        onClose={() => {}}
        onSubmit={onSubmit}
        initial={storedProfile}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'connection.form.saveAndConnect' }));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(
      screen.getByText('connection.form.validation.passwordRequired'),
    ).toBeInTheDocument();
  });

  it('focuses the first invalid field after validation fails', async () => {
    render(<ConnectionFormDrawer open={true} onClose={() => {}} onSubmit={() => {}} />);

    const usernameInput = screen.getByLabelText('common.username');
    usernameInput.focus();
    expect(usernameInput).toHaveFocus();

    fireEvent.click(screen.getByRole('button', { name: 'connection.form.saveAndConnect' }));

    const nameInput = screen.getByLabelText('common.name');
    await waitFor(() => expect(nameInput).toHaveFocus());
    expect(nameInput).toHaveAttribute('aria-invalid', 'true');
    expect(nameInput).toHaveAttribute('aria-describedby', 'connection-name-error');
    expect(screen.getByText('connection.form.validation.nameRequired')).toHaveAttribute(
      'role',
      'alert',
    );
  });

  it('focuses the password field when it is the only validation error', async () => {
    render(
      <ConnectionFormDrawer
        open={true}
        onClose={() => {}}
        onSubmit={() => {}}
        initial={{ ...profile, password: undefined }}
      />,
    );

    const nameInput = screen.getByLabelText('common.name');
    await waitFor(() => expect(nameInput).toHaveFocus());
    const usernameInput = screen.getByLabelText('common.username');
    usernameInput.focus();
    expect(usernameInput).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: 'connection.form.saveAndConnect' }));

    const passwordInput = screen.getByLabelText('common.password');
    await waitFor(() => expect(passwordInput).toHaveFocus());
    expect(passwordInput).toHaveAttribute('aria-invalid', 'true');
  });

  it('toggles password visibility without changing its value', () => {
    render(
      <ConnectionFormDrawer
        open={true}
        onClose={() => {}}
        onSubmit={() => {}}
        initial={profile}
      />,
    );

    const passwordInput = screen.getByLabelText('common.password');
    const showButton = screen.getByRole('button', { name: 'common.showPassword' });

    expect(passwordInput).toHaveAttribute('type', 'password');
    expect(passwordInput).toHaveAttribute('autocomplete', 'new-password');
    expect(passwordInput).toHaveValue('secret');
    expect(showButton).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(showButton);

    expect(passwordInput).toHaveAttribute('type', 'text');
    expect(passwordInput).toHaveValue('secret');
    const hideButton = screen.getByRole('button', { name: 'common.hidePassword' });
    expect(hideButton).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(hideButton);

    expect(passwordInput).toHaveAttribute('type', 'password');
    expect(passwordInput).toHaveValue('secret');
  });

  it('preserves password when toggling auth method away and back', () => {
    render(
      <ConnectionFormDrawer
        open={true}
        onClose={() => {}}
        onSubmit={() => {}}
        initial={profile}
      />,
    );

    const authItems = document.body.querySelectorAll(
      '[data-slot="toggle-group-item"]',
    );
    const keyItem = Array.from(authItems).find(
      (item) => item.textContent === 'connection.form.auth.key',
    );
    const passwordItem = Array.from(authItems).find(
      (item) => item.textContent === 'connection.form.auth.password',
    );

    fireEvent.click(keyItem!);
    fireEvent.click(passwordItem!);

    const passwordInput = document.body.querySelector(
      'input[type="password"]',
    ) as HTMLInputElement;
    expect(passwordInput.value).toBe('secret');
  });

  it('calls onConnect instead of onSubmit when the primary action is clicked', async () => {
    const onSubmit = vi.fn();
    const onConnect = vi.fn();
    render(
      <ConnectionFormDrawer
        open={true}
        onClose={() => {}}
        onSubmit={onSubmit}
        onConnect={onConnect}
        initial={profile}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'connection.form.saveAndConnect' }));

    await waitFor(() => {
      expect(onConnect).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'My Server' }),
      );
    });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('exposes save as a visible secondary action', async () => {
    const onSubmit = vi.fn();
    const onConnect = vi.fn();
    render(
      <ConnectionFormDrawer
        open={true}
        onClose={() => {}}
        onSubmit={onSubmit}
        onConnect={onConnect}
        initial={profile}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'common.save' }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'My Server' }),
      );
    });
    expect(onConnect).not.toHaveBeenCalled();
  });

  it('submits only once when the primary action is clicked repeatedly', async () => {
    const onConnect = vi.fn(() => new Promise<void>(() => {}));
    render(
      <ConnectionFormDrawer
        open={true}
        onClose={() => {}}
        onSubmit={() => {}}
        onConnect={onConnect}
        initial={profile}
      />,
    );

    const connectButton = screen.getByRole('button', { name: 'connection.form.saveAndConnect' });
    fireEvent.click(connectButton);
    fireEvent.click(connectButton);

    await waitFor(() => {
      expect(onConnect).toHaveBeenCalledTimes(1);
    });
    expect(connectButton).toBeDisabled();
    expect(
      screen.getByRole('button', { name: 'common.save' }),
    ).toBeDisabled();
  });
});
