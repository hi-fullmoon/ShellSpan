import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { useI18n } from '@/hooks/useI18n';
import {
  invokeGetDesktopNotificationStatus,
  invokeOpenSystemNotificationSettings,
  invokeRequestDesktopNotificationPermission,
  invokeSendDesktopNotification,
  isTauriRuntime,
} from '@/lib/ipc/tauri';
import type { LocaleKey } from '@/locales';
import { useAppStore } from '@/stores/appStore';
import type {
  DesktopNotificationPermission,
  DesktopNotificationStatus,
  NotificationTriggerPolicy,
} from '@/types';
import { getPlatform } from '@/lib/platform';
import { cn } from '@/lib/utils';
import { SettingRow, SettingsGroup } from './settings-layout';

function resolveFallbackPlatform(): DesktopNotificationStatus['platform'] {
  const platform = getPlatform();
  return platform === 'other' ? 'linux' : platform;
}

const PERMISSION_LABEL_KEYS: Record<DesktopNotificationPermission, LocaleKey> = {
  granted: 'settings.notifications.permission.granted',
  denied: 'settings.notifications.permission.denied',
  prompt: 'settings.notifications.permission.prompt',
  unknown: 'settings.notifications.permission.unknown',
};

const TRIGGER_POLICIES: readonly NotificationTriggerPolicy[] = [
  'whenUnfocusedOrHidden',
  'whenWindowUnfocused',
  'always',
];

const COMMAND_THRESHOLDS = [0, 5, 10, 30, 60] as const;

export const NotificationSettingsSection: React.FC = () => {
  const { t } = useI18n();
  const notificationsEnabled = useAppStore((state) => state.notificationsEnabled);
  const setNotificationsEnabled = useAppStore((state) => state.setNotificationsEnabled);
  const notificationTriggerPolicy = useAppStore((state) => state.notificationTriggerPolicy);
  const setNotificationTriggerPolicy = useAppStore((state) => state.setNotificationTriggerPolicy);
  const aiNotifyApproval = useAppStore((state) => state.aiNotifyApproval);
  const setAiNotifyApproval = useAppStore((state) => state.setAiNotifyApproval);
  const aiNotifyQuestion = useAppStore((state) => state.aiNotifyQuestion);
  const setAiNotifyQuestion = useAppStore((state) => state.setAiNotifyQuestion);
  const aiNotifySudo = useAppStore((state) => state.aiNotifySudo);
  const setAiNotifySudo = useAppStore((state) => state.setAiNotifySudo);
  const aiNotifyCompleted = useAppStore((state) => state.aiNotifyCompleted);
  const setAiNotifyCompleted = useAppStore((state) => state.setAiNotifyCompleted);
  const aiNotifyFailed = useAppStore((state) => state.aiNotifyFailed);
  const setAiNotifyFailed = useAppStore((state) => state.setAiNotifyFailed);
  const commandNotificationThreshold = useAppStore((state) => state.terminalCommandNotificationThresholdSec);
  const setCommandNotificationThreshold = useAppStore((state) => state.setTerminalCommandNotificationThresholdSec);
  const sftpCompletionNotification = useAppStore((state) => state.sftpCompletionNotification);
  const setSftpCompletionNotification = useAppStore((state) => state.setSftpCompletionNotification);

  const [status, setStatus] = useState<DesktopNotificationStatus | null>(null);
  const [checkingPermission, setCheckingPermission] = useState(false);
  const [sendingTest, setSendingTest] = useState(false);
  const [openingSystemSettings, setOpeningSystemSettings] = useState(false);
  const mountedRef = useRef(true);
  const inFlightRef = useRef(false);
  const requestSeqRef = useRef(0);
  const tRef = useRef(t);
  tRef.current = t;

  const refreshPermissionStatus = useCallback(async (requestPermission = false): Promise<void> => {
    if (!isTauriRuntime()) {
      setStatus({
        supported: false,
        permission: 'unknown',
        canRequestPermission: false,
        canOpenSystemSettings: false,
        platform: resolveFallbackPlatform(),
      });
      return;
    }
    if (!requestPermission && inFlightRef.current) return;
    const seq = ++requestSeqRef.current;
    inFlightRef.current = true;
    setCheckingPermission(true);
    try {
      const next = requestPermission
        ? await invokeRequestDesktopNotificationPermission()
        : await invokeGetDesktopNotificationStatus();
      if (mountedRef.current && requestSeqRef.current === seq) {
        setStatus(next);
      }
    } catch {
      if (mountedRef.current && requestSeqRef.current === seq) {
        setStatus((current) => current ?? {
          supported: true,
          permission: 'unknown',
          canRequestPermission: false,
          canOpenSystemSettings: false,
          platform: resolveFallbackPlatform(),
        });
        if (requestPermission) {
          toast.error(tRef.current('settings.notifications.permissionCheckFailed'));
        }
      }
    } finally {
      if (requestSeqRef.current === seq) {
        inFlightRef.current = false;
        if (mountedRef.current) {
          setCheckingPermission(false);
        }
      }
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void refreshPermissionStatus(false);
    const handleWindowFocus = (): void => {
      if (isTauriRuntime()) {
        void refreshPermissionStatus(false);
      }
    };
    window.addEventListener('focus', handleWindowFocus);
    return () => {
      mountedRef.current = false;
      window.removeEventListener('focus', handleWindowFocus);
    };
  }, [refreshPermissionStatus]);

  const triggerPolicyItems = useMemo(
    () => TRIGGER_POLICIES.map((value) => ({
      value,
      label: t(`settings.notifications.triggerPolicy.${value}`),
    })),
    [t],
  );

  const commandNotificationItems = useMemo(
    () => COMMAND_THRESHOLDS.map((seconds) => ({
      value: String(seconds),
      label: seconds
        ? t('terminal.commandBlock.thresholdSeconds', { seconds })
        : t('terminal.commandBlock.notificationsOff'),
    })),
    [t],
  );

  const permissionState: DesktopNotificationPermission = status?.permission ?? 'unknown';
  const permissionBadgeLabel = !notificationsEnabled
    ? t('settings.notifications.permission.disabled')
    : checkingPermission
      ? t('settings.notifications.permission.checking')
      : t(PERMISSION_LABEL_KEYS[permissionState]);
  const permissionBadgeVariant = !notificationsEnabled
    ? 'outline'
    : permissionState === 'granted'
      ? 'default'
      : permissionState === 'denied'
        ? 'destructive'
        : 'outline';

  const handleSendTest = async (): Promise<void> => {
    if (sendingTest) return;
    if (!isTauriRuntime()) {
      toast.info(t('settings.notifications.testDesktopOnly'));
      return;
    }
    setSendingTest(true);
    try {
      await invokeSendDesktopNotification({
        title: t('settings.notifications.testTitle'),
        body: t('settings.notifications.testBody'),
        target: { type: 'settings', settingsSection: 'notifications' },
        urgency: 'normal',
      });
    } catch {
      toast.error(t('settings.notifications.testFailed'));
    } finally {
      if (mountedRef.current) {
        setSendingTest(false);
      }
    }
  };

  const handleOpenSystemSettings = async (): Promise<void> => {
    if (openingSystemSettings || !isTauriRuntime()) return;
    setOpeningSystemSettings(true);
    try {
      await invokeOpenSystemNotificationSettings();
    } catch {
      toast.error(t('settings.notifications.openSystemSettingsFailed'));
    } finally {
      if (mountedRef.current) {
        setOpeningSystemSettings(false);
      }
    }
  };

  const permissionHint = !notificationsEnabled
    ? t('settings.notifications.disabledHint')
    : permissionState === 'denied'
      ? t('settings.notifications.permissionHintDenied')
      : t('settings.notifications.permissionHint');

  return (
    <div data-slot="notification-settings" className="flex min-w-0 flex-col gap-3">
      <SettingsGroup
        title={t('settings.notifications.groupDesktop')}
        titleId="desktop-notifications-group-title"
        action={(
          <div
            role="status"
            aria-label={t('settings.notifications.permissionAnnouncement', { status: permissionBadgeLabel })}
            aria-live="polite"
            aria-atomic="true"
            aria-busy={checkingPermission}
          >
            <Badge variant={permissionBadgeVariant}>
              {permissionBadgeLabel}
            </Badge>
          </div>
        )}
      >
        <SettingRow
          controlId="notifications-enabled"
          label={t('settings.notifications.enabled')}
          description={t('settings.notifications.enabledDescription')}
        >
          <div className="flex justify-end">
            <Switch
              id="notifications-enabled"
              aria-label={t('settings.notifications.enabled')}
              checked={notificationsEnabled}
              onCheckedChange={setNotificationsEnabled}
            />
          </div>
        </SettingRow>
        <SettingRow
          label={t('settings.notifications.triggerPolicy')}
          description={t('settings.notifications.triggerPolicyDescription')}
        >
          <Select
            items={triggerPolicyItems}
            value={notificationTriggerPolicy}
            onValueChange={(value) => {
              if (value) setNotificationTriggerPolicy(value as NotificationTriggerPolicy);
            }}
          >
            <SelectTrigger variant="ghost" size="sm" aria-label={t('settings.notifications.triggerPolicy')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="end" alignItemWithTrigger={false}>
              <SelectGroup>
                {triggerPolicyItems.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </SettingRow>
        <div className="flex flex-col gap-2.5 bg-muted/25 px-4 py-2.5 @min-[32rem]:flex-row @min-[32rem]:items-center @min-[32rem]:justify-between @min-[32rem]:gap-x-4">
          <p id="notifications-permission-hint" className="min-w-0 flex-1 text-xs leading-relaxed text-muted-foreground">
            {permissionHint}
          </p>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant="soft"
              disabled={checkingPermission}
              onClick={() => void refreshPermissionStatus(Boolean(status?.canRequestPermission))}
            >
              {checkingPermission
                ? t('settings.notifications.permission.checking')
                : status?.canRequestPermission
                  ? t('settings.notifications.requestPermission')
                  : t('settings.notifications.recheckPermission')}
            </Button>
            {status?.canOpenSystemSettings && (
              <Button
                type="button"
                size="sm"
                variant="soft"
                disabled={openingSystemSettings}
                onClick={() => void handleOpenSystemSettings()}
              >
                {t('settings.notifications.openSystemSettings')}
              </Button>
            )}
            <Button
              type="button"
              size="sm"
              variant="soft"
              aria-describedby="notifications-permission-hint"
              disabled={!notificationsEnabled || sendingTest}
              onClick={() => void handleSendTest()}
            >
              {sendingTest
                ? t('settings.notifications.sendingTest')
                : t('settings.notifications.sendTest')}
            </Button>
          </div>
        </div>
      </SettingsGroup>

      <div
        data-slot="notification-rule-groups"
        data-inactive={!notificationsEnabled ? 'true' : undefined}
        className={cn(
          'flex min-w-0 flex-col gap-3 transition-opacity duration-200',
          !notificationsEnabled && 'opacity-65 hover:opacity-100 focus-within:opacity-100',
        )}
      >
        <SettingsGroup title={t('settings.notifications.groupAiAgent')}>
          <SettingRow
            controlId="ai-notify-approval"
            label={t('settings.notifications.ai.approval')}
            description={t('settings.notifications.ai.approvalDescription')}
          >
            <div className="flex justify-end">
              <Switch
                id="ai-notify-approval"
                aria-label={t('settings.notifications.ai.approval')}
                checked={aiNotifyApproval}
                onCheckedChange={setAiNotifyApproval}
              />
            </div>
          </SettingRow>
          <SettingRow
            controlId="ai-notify-question"
            label={t('settings.notifications.ai.question')}
            description={t('settings.notifications.ai.questionDescription')}
          >
            <div className="flex justify-end">
              <Switch
                id="ai-notify-question"
                aria-label={t('settings.notifications.ai.question')}
                checked={aiNotifyQuestion}
                onCheckedChange={setAiNotifyQuestion}
              />
            </div>
          </SettingRow>
          <SettingRow
            controlId="ai-notify-sudo"
            label={t('settings.notifications.ai.sudo')}
            description={t('settings.notifications.ai.sudoDescription')}
          >
            <div className="flex justify-end">
              <Switch
                id="ai-notify-sudo"
                aria-label={t('settings.notifications.ai.sudo')}
                checked={aiNotifySudo}
                onCheckedChange={setAiNotifySudo}
              />
            </div>
          </SettingRow>
          <SettingRow
            controlId="ai-notify-completed"
            label={t('settings.notifications.ai.completed')}
            description={t('settings.notifications.ai.completedDescription')}
          >
            <div className="flex justify-end">
              <Switch
                id="ai-notify-completed"
                aria-label={t('settings.notifications.ai.completed')}
                checked={aiNotifyCompleted}
                onCheckedChange={setAiNotifyCompleted}
              />
            </div>
          </SettingRow>
          <SettingRow
            controlId="ai-notify-failed"
            label={t('settings.notifications.ai.failed')}
            description={t('settings.notifications.ai.failedDescription')}
          >
            <div className="flex justify-end">
              <Switch
                id="ai-notify-failed"
                aria-label={t('settings.notifications.ai.failed')}
                checked={aiNotifyFailed}
                onCheckedChange={setAiNotifyFailed}
              />
            </div>
          </SettingRow>
        </SettingsGroup>

        <SettingsGroup title={t('settings.notifications.groupWorkspace')}>
          <SettingRow
            label={t('terminal.commandBlock.notifications')}
            description={t('terminal.commandBlock.notificationsDescription')}
          >
            <Select
              items={commandNotificationItems}
              value={String(commandNotificationThreshold)}
              onValueChange={(value) => {
                if (value) setCommandNotificationThreshold(Number(value));
              }}
            >
              <SelectTrigger variant="ghost" size="sm" aria-label={t('terminal.commandBlock.notifications')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="end" alignItemWithTrigger={false}>
                <SelectGroup>
                  {commandNotificationItems.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </SettingRow>
          <SettingRow
            controlId="sftp-completion-notification"
            label={t('settings.sftp.completionNotification')}
            description={t('settings.sftp.completionNotificationDescription')}
          >
            <div className="flex justify-end">
              <Switch
                id="sftp-completion-notification"
                aria-label={t('settings.sftp.completionNotification')}
                checked={sftpCompletionNotification}
                onCheckedChange={setSftpCompletionNotification}
              />
            </div>
          </SettingRow>
        </SettingsGroup>
      </div>
    </div>
  );
};
