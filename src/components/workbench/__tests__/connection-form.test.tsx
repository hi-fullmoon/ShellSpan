import { describe, expect, it, vi } from 'vitest';
import { render, fireEvent, screen } from '@testing-library/react';
import { ConnectionForm } from '../connection-form';
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

describe('ConnectionForm', () => {
  it('renders the form body as a constrained scrollable region', () => {
    render(<ConnectionForm open={true} onClose={() => {}} onSubmit={() => {}} />);

    const formBody = document.body.querySelector(
      '[data-slot="drawer-content"] > div.overflow-y-auto',
    );
    expect(formBody).toBeInTheDocument();
    expect(formBody).toHaveClass('flex-1');
    expect(formBody).toHaveClass('min-h-0');
    expect(formBody).toHaveClass('gap-5');
  });

  it('renders the auth method as a segmented toggle with the translated label', () => {
    render(<ConnectionForm open={true} onClose={() => {}} onSubmit={() => {}} />);

    const pressedItem = document.body.querySelector(
      '[data-slot="toggle-group-item"][aria-pressed="true"]',
    );
    expect(pressedItem).toHaveTextContent(/^connection\.form\.auth\.password$/);
  });

  it('renders the translated jump-host auth method label when enabled', () => {
    render(<ConnectionForm open={true} onClose={() => {}} onSubmit={() => {}} />);

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
      <ConnectionForm open={true} onClose={() => {}} onSubmit={() => {}} initial={profile} />,
    );

    const nameInput = document.body.querySelector('[data-slot="input"]') as HTMLInputElement;
    expect(nameInput.value).toBe('My Server');

    fireEvent.change(nameInput, { target: { value: 'Changed' } });
    expect(nameInput.value).toBe('Changed');

    const nextProfile: ConnectionProfile = { ...profile, id: 'p2', name: 'Other Server' };
    rerender(
      <ConnectionForm open={true} onClose={() => {}} onSubmit={() => {}} initial={nextProfile} />,
    );

    expect(nameInput.value).toBe('Other Server');
  });

  it('keeps an existing keychain password when the field is left blank', () => {
    const onSubmit = vi.fn();
    const storedProfile: ConnectionProfile = {
      ...profile,
      password: undefined,
      passwordStored: true,
    };
    render(
      <ConnectionForm
        open={true}
        onClose={() => {}}
        onSubmit={onSubmit}
        initial={storedProfile}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'common.save' }));

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ password: undefined }),
    );
    expect(
      screen.queryByText('connection.form.validation.passwordRequired'),
    ).not.toBeInTheDocument();
  });
});
