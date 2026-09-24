import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { UserProfileDialog } from '../user-profile-dialog';
import { useAppStore } from '@/stores/appStore';
import { useToastStore } from '@/stores/toastStore';

const ipcMocks = vi.hoisted(() => ({
  pickProfileAvatar: vi.fn(),
}));

vi.mock('@/lib/ipc/tauri', () => ({
  invokeLoadPreferences: vi.fn(),
  invokeSavePreferences: vi.fn(),
  invokePickProfileAvatar: ipcMocks.pickProfileAvatar,
}));

vi.mock('@/hooks/useI18n', () => ({
  useI18n: () => ({
    t: (key: string) => ({
      'workbench.userMenu.name': 'Me',
      'workbench.userMenu.editProfile': 'Edit profile',
      'settings.profile.description': 'Update your avatar and display name.',
      'settings.profile.changeAvatar': 'Change image',
      'settings.profile.removeAvatar': 'Remove image',
      'settings.profile.name': 'Display name',
      'settings.profile.namePlaceholder': 'Enter a display name',
      'settings.profile.nameHint': 'Leave empty to use the default name.',
      'settings.profile.saved': 'Profile updated',
      'settings.profile.pickFailed': 'Could not read the selected image.',
      'common.cancel': 'Cancel',
      'common.save': 'Save',
    })[key] ?? key,
  }),
}));

const AVATAR = 'data:image/png;base64,aGVsbG8=';

function renderDialog(open = true) {
  const onOpenChange = vi.fn();
  render(<UserProfileDialog open={open} onOpenChange={onOpenChange} />);
  return { onOpenChange };
}

describe('UserProfileDialog', () => {
  beforeEach(() => {
    ipcMocks.pickProfileAvatar.mockReset();
    useToastStore.setState({ toasts: [] });
    useAppStore.setState({ profileName: '', profileAvatar: '' });
  });

  it('saves a trimmed display name and shows a success toast', async () => {
    const { onOpenChange } = renderDialog();
    const dialog = screen.getByRole('dialog', { name: 'Edit profile' });

    const input = screen.getByLabelText('Display name');
    await act(async () => {
      fireEvent.change(input, { target: { value: '  小明  ' } });
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    expect(useAppStore.getState().profileName).toBe('小明');
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(useToastStore.getState().toasts[useToastStore.getState().toasts.length - 1]).toMatchObject({
      message: 'Profile updated',
      variant: 'success',
    });
  });

  it('keeps an empty name so the default display name applies', () => {
    useAppStore.setState({ profileName: '小明' });
    renderDialog();

    const input = screen.getByLabelText('Display name');
    expect(input).toHaveValue('小明');
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(useAppStore.getState().profileName).toBe('');
  });

  it('previews a picked avatar and persists it on save', async () => {
    ipcMocks.pickProfileAvatar.mockResolvedValue(AVATAR);
    renderDialog();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Change image' }));
    });
    await waitFor(() => {
      expect(screen.getByRole('img', { name: 'Me' })).toHaveAttribute('src', AVATAR);
    });

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(useAppStore.getState().profileAvatar).toBe(AVATAR);
  });

  it('clears a custom avatar with the remove action', async () => {
    useAppStore.setState({ profileAvatar: AVATAR });
    renderDialog();

    expect(screen.getByRole('img', { name: 'Me' })).toHaveAttribute('src', AVATAR);
    fireEvent.click(screen.getByRole('button', { name: 'Remove image' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(useAppStore.getState().profileAvatar).toBe('');
    expect(screen.queryByRole('button', { name: 'Remove image' })).not.toBeInTheDocument();
  });

  it('reports a failed avatar pick without changing the profile', async () => {
    ipcMocks.pickProfileAvatar.mockRejectedValue(new Error('decode failed'));
    renderDialog();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Change image' }));
    });

    await waitFor(() => {
      expect(useToastStore.getState().toasts[useToastStore.getState().toasts.length - 1]).toMatchObject({
        message: 'Could not read the selected image.',
        variant: 'error',
      });
    });
    expect(useAppStore.getState().profileAvatar).toBe('');
  });

  it('ignores a cancelled avatar pick', async () => {
    ipcMocks.pickProfileAvatar.mockResolvedValue(null);
    renderDialog();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Change image' }));
    });

    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it('discards edits on cancel', () => {
    useAppStore.setState({ profileName: '小明', profileAvatar: AVATAR });
    const { onOpenChange } = renderDialog();

    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: '新名字' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(useAppStore.getState().profileName).toBe('小明');
    expect(useAppStore.getState().profileAvatar).toBe(AVATAR);
  });

  it('caps the display name at the configured maximum length', () => {
    renderDialog();

    const input = screen.getByLabelText('Display name');
    expect(input).toHaveAttribute('maxlength', '32');
  });
});
