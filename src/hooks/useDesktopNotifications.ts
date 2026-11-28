import { useEffect } from 'react';
import {
  invokeSendDesktopNotification,
  isTauriRuntime,
  listenToAgentRuntimeSession,
  listenToAgentSudoPrompt,
  listenToDesktopNotificationClicked,
} from '@/lib/ipc/tauri';
import { createLogger } from '@/lib/logger';
import {
  AgentNotificationMonitor,
  type AgentNotificationCandidate,
  type AiNotificationKind,
} from '@/lib/notifications/agent-notification-monitor';
import { navigateToNotificationTarget } from '@/lib/notifications/navigation';
import {
  isAgentSessionCurrentlyVisible,
  isAppWindowFocused,
  sanitizeNotificationText,
  shouldDeliverDesktopNotification,
} from '@/lib/notifications/policy';
import { t } from '@/locales';
import { useAppStore } from '@/stores/appStore';

const logger = createLogger('desktop-notifications');

function isAiNotificationKindEnabled(kind: AiNotificationKind): boolean {
  const state = useAppStore.getState();
  switch (kind) {
    case 'approval':
      return state.aiNotifyApproval;
    case 'question':
      return state.aiNotifyQuestion;
    case 'sudo':
      return state.aiNotifySudo;
    case 'completed':
      return state.aiNotifyCompleted;
    case 'failed':
      return state.aiNotifyFailed;
  }
}

export function formatAgentNotificationContent(
  candidate: AgentNotificationCandidate,
): { title: string; body: string } {
  const sessionLabel = candidate.sessionTitle || t('notifications.agent.defaultSession');

  switch (candidate.kind) {
    case 'approval':
      return {
        title: t('notifications.agent.approvalTitle'),
        body: candidate.detail
          ? t('notifications.agent.sessionWithDetail', {
              session: sessionLabel,
              detail: candidate.detail,
            })
          : t('notifications.agent.approvalBody', { session: sessionLabel }),
      };
    case 'question':
      return {
        title: t('notifications.agent.questionTitle'),
        body: candidate.detail
          ? t('notifications.agent.sessionWithDetail', {
              session: sessionLabel,
              detail: candidate.detail,
            })
          : t('notifications.agent.questionBody', { session: sessionLabel }),
      };
    case 'sudo':
      return {
        title: t('notifications.agent.sudoTitle'),
        body: t('notifications.agent.sudoBody', {
          account: candidate.account || t('notifications.agent.defaultSession'),
        }),
      };
    case 'completed':
      return {
        title: t('notifications.agent.completedTitle'),
        body: t('notifications.agent.completedBody', { session: sessionLabel }),
      };
    case 'failed':
      return {
        title: t('notifications.agent.failedTitle'),
        body: candidate.detail
          ? t('notifications.agent.sessionWithDetail', {
              session: sessionLabel,
              detail: candidate.detail,
            })
          : t('notifications.agent.failedBody', { session: sessionLabel }),
      };
  }
}

function maybeNotifyAgentCandidate(candidate: AgentNotificationCandidate | null): void {
  if (!candidate) return;
  const app = useAppStore.getState();
  const windowFocused = isAppWindowFocused();
  const targetVisible = candidate.kind === 'sudo'
    ? windowFocused
    : Boolean(candidate.sessionId && isAgentSessionCurrentlyVisible(candidate.sessionId));

  if (
    !shouldDeliverDesktopNotification({
      enabled: app.notificationsEnabled,
      categoryEnabled: isAiNotificationKindEnabled(candidate.kind),
      policy: app.notificationTriggerPolicy,
      windowFocused,
      targetVisible,
    })
  ) {
    return;
  }

  const content = formatAgentNotificationContent(candidate);
  const title = sanitizeNotificationText(content.title, 160);
  const body = sanitizeNotificationText(content.body, 360);
  if (!title) return;

  void invokeSendDesktopNotification({
    title,
    body,
    target: candidate.target,
    urgency: candidate.urgency,
  }).catch((error) => {
    logger.debug('Desktop notification unavailable', error);
  });
}

export function useDesktopNotifications(): void {
  useEffect(() => {
    if (!isTauriRuntime()) return;

    let disposed = false;
    const monitor = new AgentNotificationMonitor();
    const unlisteners: Array<() => void> = [];

    const register = (promise: Promise<() => void>, label: string): void => {
      void promise
        .then((dispose) => {
          if (disposed) {
            dispose();
          } else {
            unlisteners.push(dispose);
          }
        })
        .catch((error) => {
          logger.warn(`Failed to attach ${label} listener`, error);
        });
    };

    register(
      listenToAgentRuntimeSession((event) => {
        if (disposed) return;
        maybeNotifyAgentCandidate(monitor.observeSessionEvent(event.payload));
      }),
      'agent notification session',
    );

    register(
      listenToAgentSudoPrompt((event) => {
        if (disposed) return;
        maybeNotifyAgentCandidate(monitor.observeSudoPrompt(event.payload));
      }),
      'agent notification sudo',
    );

    register(
      listenToDesktopNotificationClicked((event) => {
        if (disposed) return;
        navigateToNotificationTarget(event.payload.target);
      }),
      'desktop notification click',
    );

    return () => {
      disposed = true;
      for (const unlisten of unlisteners) {
        unlisten();
      }
      unlisteners.length = 0;
    };
  }, []);
}
