import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { KeychainPanel } from '../keychain-panel';
import { useKeychainStore } from '@/stores/keychainStore';

vi.mock('@/hooks/useI18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
    ready: true,
    locale: 'en-US',
    setLocale: () => {},
  }),
}));

vi.mock('@/hooks/useToast', () => ({
  useToast: () => ({
    success: vi.fn(),
    error: vi.fn(),
  }),
}));

describe('KeychainPanel', () => {
  beforeEach(() => {
    useKeychainStore.setState({
      keys: [
        { id: 'profile-1', label: 'Server password', keyType: 'ecdsa', kind: 'password' },
        { id: 'key-1', label: 'Server key', keyType: 'rsa', kind: 'keyFile' },
      ],
      initialized: true,
    });
  });

  it('renders profile password keychains without an edit button', () => {
    render(<KeychainPanel />);

    expect(screen.getByText('Server password')).toBeInTheDocument();
    const editButtons = screen.queryAllByRole('button', {
      name: 'common.edit',
      hidden: true,
    });
    expect(editButtons).toHaveLength(1);
  });

  it('renders regular key keychains with an edit button', () => {
    render(<KeychainPanel />);

    expect(screen.getByText('Server key')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'common.edit', hidden: true }),
    ).toBeInTheDocument();
  });

  it('renders delete buttons for all keychains', () => {
    render(<KeychainPanel />);

    const deleteButtons = screen.getAllByRole('button', {
      name: 'common.delete',
      hidden: true,
    });
    expect(deleteButtons).toHaveLength(2);
  });

  it('creates key-file keys only and hides the kind selector', () => {
    render(<KeychainPanel />);

    fireEvent.click(screen.getByRole('button', { name: 'common.create' }));

    expect(
      screen.getByPlaceholderText('keychain.form.privateKeyPlaceholder'),
    ).toBeInTheDocument();
    expect(
      screen.getByPlaceholderText('keychain.form.publicKeyOptionalPlaceholder'),
    ).toBeInTheDocument();
    expect(
      screen.queryByPlaceholderText('keychain.form.passwordPlaceholder'),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText('workbench.keychain.newSubtitle'),
    ).toBeInTheDocument();
  });
});
