import { useAiPanelStore } from '@/stores/aiPanelStore';
import { useAppStore } from '@/stores/appStore';
import { useFocusStore } from '@/stores/focusStore';
import { useTerminalStore } from '@/stores/terminalStore';
import type { NotificationTriggerPolicy } from '@/types';

export interface NotificationDeliveryCheck {
  readonly enabled: boolean;
  readonly categoryEnabled: boolean;
  readonly policy: NotificationTriggerPolicy;
  readonly windowFocused: boolean;
  readonly targetVisible: boolean;
}

export function shouldDeliverDesktopNotification(check: NotificationDeliveryCheck): boolean {
  if (!check.enabled || !check.categoryEnabled) {
    return false;
  }
  switch (check.policy) {
    case 'always':
      return true;
    case 'whenWindowUnfocused':
      return !check.windowFocused;
    case 'whenUnfocusedOrHidden':
      return !check.windowFocused || !check.targetVisible;
  }
}

export function isAppWindowFocused(): boolean {
  if (typeof document === 'undefined') return false;
  return document.visibilityState !== 'hidden' && !document.hidden && document.hasFocus();
}

export function isTerminalSessionCurrentlyVisible(terminalSessionId: string): boolean {
  if (!isAppWindowFocused()) return false;
  const app = useAppStore.getState();
  if (app.settingsDialogOpen) return false;
  const focus = useFocusStore.getState();
  return app.activeSection === 'terminal'
    && (!focus.enabled || focus.terminalOpen)
    && useTerminalStore.getState().activeSessionId === terminalSessionId;
}

export function isAgentSessionCurrentlyVisible(agentSessionId: string): boolean {
  if (!isAppWindowFocused()) return false;
  const app = useAppStore.getState();
  if (app.settingsDialogOpen) return false;
  const focus = useFocusStore.getState();
  const aiPanel = useAiPanelStore.getState();

  if (focus.enabled) {
    return app.activeSection === 'terminal'
      && (aiPanel.activeSessionByScope.focus === agentSessionId
        || focus.conversationSessionId === agentSessionId);
  }

  if (app.activeSection === 'terminal') {
    return aiPanel.panelOpenBySection.terminal
      && aiPanel.activeSessionByScope.terminal === agentSessionId;
  }

  if (app.activeSection === 'workbench') {
    return aiPanel.panelOpenBySection.workbench
      && aiPanel.activeSessionByScope.workbench === agentSessionId;
  }

  return false;
}

export function sanitizeNotificationText(raw: string, maxLength = 240): string {
  const cleaned = raw
    .replace(/[\u0000-\u001F\u007F-\u009F]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned.length <= maxLength) {
    return cleaned;
  }
  const truncated = cleaned
    .slice(0, Math.max(1, maxLength - 1))
    .replace(/[\uD800-\uDBFF]$/, '')
    .trimEnd();
  return `${truncated}…`;
}
