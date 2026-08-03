import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ConnectionFormDrawer } from '../connection-form-drawer';

let mockInitialized = false;
const mockHydrate = vi.fn();

vi.mock('@/stores/keychainStore', () => ({
  useKeychainStore: () => ({
    keys: [],
    initialized: mockInitialized,
    hydrate: mockHydrate,
    addKey: vi.fn(),
  }),
}));

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

vi.mock('@/lib/tauri', () => ({
  invokePickPrivateKeyFile: vi.fn(),
  invokeReadTextFile: vi.fn(() => Promise.resolve('')),
}));

describe('ConnectionFormDrawer form reset', () => {
  beforeEach(() => {
    mockInitialized = false;
    mockHydrate.mockClear();
  });

  it('does not wipe user input when keychain hydration finishes after opening', () => {
    const { rerender } = render(
      <ConnectionFormDrawer open={true} onClose={() => {}} onSubmit={() => {}} />,
    );
    expect(mockHydrate).toHaveBeenCalledTimes(1);

    const nameInput = screen.getByPlaceholderText('My Server');
    fireEvent.change(nameInput, { target: { value: 'Typed while loading' } });

    // Hydration completes while the drawer is open.
    mockInitialized = true;
    rerender(
      <ConnectionFormDrawer open={true} onClose={() => {}} onSubmit={() => {}} />,
    );

    expect(nameInput).toHaveValue('Typed while loading');
  });
});
