import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NotificationSettingsSection } from '../notification-settings-section';
import { useAppStore } from '@/stores/appStore';

const ipcMocks = vi.hoisted(() => ({
  isTauriRuntime: vi.fn(),
  getStatus: vi.fn(),
  requestPermission: vi.fn(),
  sendNotification: vi.fn(),
  openSystemSettings: vi.fn(),
}));

const toastMocks = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
}));

vi.mock('@/lib/ipc/tauri', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ipc/tauri')>()),
  isTauriRuntime: ipcMocks.isTauriRuntime,
  invokeGetDesktopNotificationStatus: ipcMocks.getStatus,
  invokeRequestDesktopNotificationPermission: ipcMocks.requestPermission,
  invokeSendDesktopNotification: ipcMocks.sendNotification,
  invokeOpenSystemNotificationSettings: ipcMocks.openSystemSettings,
}));

vi.mock('sonner', () => ({
  toast: toastMocks,
}));

vi.mock('@/hooks/useI18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
    locale: 'zh-CN',
    setLocale: vi.fn(),
  }),
}));

describe('NotificationSettingsSection', () => {
  beforeEach(() => {
    ipcMocks.isTauriRuntime.mockReturnValue(true);
    ipcMocks.getStatus.mockReset().mockResolvedValue({
      supported: true,
      permission: 'granted',
      canRequestPermission: false,
      canOpenSystemSettings: true,
      platform: 'windows',
    });
    ipcMocks.requestPermission.mockReset().mockResolvedValue({
      supported: true,
      permission: 'granted',
      canRequestPermission: false,
      canOpenSystemSettings: true,
      platform: 'windows',
    });
    ipcMocks.sendNotification.mockReset().mockResolvedValue(undefined);
    ipcMocks.openSystemSettings.mockReset().mockResolvedValue(undefined);
    toastMocks.success.mockReset();
    toastMocks.error.mockReset();
    toastMocks.info.mockReset();

    useAppStore.setState({
      notificationsEnabled: true,
      notificationTriggerPolicy: 'whenUnfocusedOrHidden',
      aiNotifyApproval: true,
      aiNotifyQuestion: true,
      aiNotifySudo: true,
      aiNotifyCompleted: true,
      aiNotifyFailed: true,
      terminalCommandNotificationThresholdSec: 10,
      sftpCompletionNotification: true,
    });
  });

  it('loads OS permission status, exposes readable select labels, and toggles preferences', async () => {
    render(<NotificationSettingsSection />);

    expect(await screen.findByText('settings.notifications.permission.granted')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveAttribute('aria-live', 'polite');

    const policySelect = screen.getByRole('combobox', { name: 'settings.notifications.triggerPolicy' });
    expect(policySelect).toHaveTextContent(/^settings\.notifications\.triggerPolicy\.whenUnfocusedOrHidden$/);

    const terminalSelect = screen.getByRole('combobox', { name: 'terminal.commandBlock.notifications' });
    expect(terminalSelect).toHaveTextContent(/^terminal\.commandBlock\.thresholdSeconds$/);

    const approvalToggle = screen.getByRole('switch', { name: 'settings.notifications.ai.approval' });
    expect(approvalToggle).toBeChecked();
    fireEvent.click(approvalToggle);
    expect(useAppStore.getState().aiNotifyApproval).toBe(false);

    const masterToggle = screen.getByRole('switch', { name: 'settings.notifications.enabled' });
    fireEvent.click(masterToggle);
    expect(useAppStore.getState().notificationsEnabled).toBe(false);
    expect(screen.getByRole('button', { name: 'settings.notifications.sendTest' })).toBeDisabled();
    expect(screen.getByText('settings.notifications.permission.disabled')).toBeInTheDocument();
  });

  it('sends a test desktop notification and opens system notification settings', async () => {
    render(<NotificationSettingsSection />);

    const openSettingsButton = await screen.findByRole('button', {
      name: 'settings.notifications.openSystemSettings',
    });
    fireEvent.click(openSettingsButton);
    await waitFor(() => {
      expect(ipcMocks.openSystemSettings).toHaveBeenCalledTimes(1);
    });

    const testButton = screen.getByRole('button', { name: 'settings.notifications.sendTest' });
    fireEvent.click(testButton);
    await waitFor(() => {
      expect(ipcMocks.sendNotification).toHaveBeenCalledWith({
        title: 'settings.notifications.testTitle',
        body: 'settings.notifications.testBody',
        target: { type: 'settings', settingsSection: 'notifications' },
        urgency: 'normal',
      });
    });
    expect(toastMocks.success).not.toHaveBeenCalled();
  });

  it('requests permission when status reports prompt', async () => {
    ipcMocks.getStatus.mockResolvedValueOnce({
      supported: true,
      permission: 'prompt',
      canRequestPermission: true,
      canOpenSystemSettings: true,
      platform: 'macos',
    });

    render(<NotificationSettingsSection />);

    const requestButton = await screen.findByRole('button', {
      name: 'settings.notifications.requestPermission',
    });
    fireEvent.click(requestButton);
    await waitFor(() => {
      expect(ipcMocks.requestPermission).toHaveBeenCalledTimes(1);
    });
    expect(await screen.findByText('settings.notifications.permission.granted')).toBeInTheDocument();
  });
});
