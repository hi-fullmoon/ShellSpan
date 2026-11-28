import { useEffect } from 'react';
import type { Terminal } from '@xterm/xterm';
import { invokeSendDesktopNotification, isTauriRuntime, listenToTerminalCommandLifecycle } from '@/lib/ipc/tauri';
import { createLogger } from '@/lib/logger';
import {
  isAppWindowFocused,
  isTerminalSessionCurrentlyVisible,
  sanitizeNotificationText,
  shouldDeliverDesktopNotification,
} from '@/lib/notifications/policy';
import { createTerminalCommandBlocks, jumpToTerminalCommand, shouldNotifyTerminalCommand,
  type TerminalCommandBlocks } from '@/lib/terminal/terminal-command-blocks';
import { cleanTerminalTitle } from '@/lib/terminal/tab-title';
import { t } from '@/locales';
import { useAppStore } from '@/stores/appStore';
import { useFocusStore } from '@/stores/focusStore';
import { useTerminalStore } from '@/stores/terminalStore';
import { terminalRegistry } from './registry/terminal-registry';

const logger = createLogger('terminalCommandActivity');
const trackedTerminals = new WeakMap<Terminal, TerminalCommandBlocks>();
const trackerListeners = new Set<() => void>();

export function terminalCommandTracker(terminal: Terminal): TerminalCommandBlocks | undefined {
  return trackedTerminals.get(terminal);
}

export function subscribeTerminalCommandTrackers(listener: () => void): () => void {
  trackerListeners.add(listener);
  return () => trackerListeners.delete(listener);
}

export function TerminalCommandActivity() {
  useEffect(() => {
    let disposed = false;
    const sessions = new Map<string, { terminal: Terminal; tracker: TerminalCommandBlocks; lastCompleted: number }>();
    const clear = (id: string): void => {
      const entry = sessions.get(id);
      if (!entry) return;
      sessions.delete(id);
      trackedTerminals.delete(entry.terminal);
      entry.tracker.dispose();
    };
    const reconcile = (): void => {
      const available = useTerminalStore.getState().sessions;
      let changed = false;
      for (const [id, entry] of sessions) {
        if (!available.some((candidate) => candidate.sessionId === id)
          || terminalRegistry.get(id)?.terminal !== entry.terminal) {
          clear(id);
          changed = true;
        }
      }
      for (const { sessionId, pendingConnection } of available) {
        if (pendingConnection || sessions.has(sessionId)) continue;
        const terminal = terminalRegistry.get(sessionId)?.terminal;
        if (!terminal) continue;
        const tracker = createTerminalCommandBlocks(terminal);
        sessions.set(sessionId, { terminal, tracker, lastCompleted: 0 });
        trackedTerminals.set(terminal, tracker);
        changed = true;
      }
      if (changed) trackerListeners.forEach((listener) => listener());
    };
    const markActiveRead = (): void => {
      const state = useTerminalStore.getState();
      if (state.activeSessionId && isTerminalSessionCurrentlyVisible(state.activeSessionId)) {
        state.setUnreadCommand(state.activeSessionId);
      }
    };
    const onJump = (event: Event): void => {
      const sessionId = useTerminalStore.getState().activeSessionId;
      const tracking = sessionId && sessions.get(sessionId);
      if (tracking) jumpToTerminalCommand(tracking.terminal, tracking.tracker.list(), (event as CustomEvent<boolean>).detail);
    };
    const unsubscribe = terminalRegistry.subscribe(reconcile);
    const unsubscribeSessions = useTerminalStore.subscribe((state, previous) => {
      if (state.sessions !== previous.sessions) reconcile();
      if (state.activeSessionId !== previous.activeSessionId) markActiveRead();
    });
    const unsubscribeSection = useAppStore.subscribe((state, previous) => {
      if (state.activeSection !== previous.activeSection
        || state.settingsDialogOpen !== previous.settingsDialogOpen) markActiveRead();
    });
    const unsubscribeFocus = useFocusStore.subscribe((state, previous) => {
      if (state.terminalOpen !== previous.terminalOpen) markActiveRead();
    });
    document.addEventListener('visibilitychange', markActiveRead);
    document.addEventListener('shellspan:jump-terminal-command', onJump);
    window.addEventListener('focus', markActiveRead);
    reconcile();
    const unlisten = isTauriRuntime() ? listenToTerminalCommandLifecycle(({ payload }) => {
      if (disposed) return;
      const state = useTerminalStore.getState();
      const session = state.sessions.find((item) => item.sessionId === payload.sessionId);
      if (!session || session.terminalSessionId !== payload.terminalSessionId
        || session.terminalGeneration !== payload.terminalGeneration) return;
      const entry = sessions.get(payload.sessionId);
      entry?.tracker.update(payload);
      if (payload.phase !== 'completed' || !entry || entry.lastCompleted >= payload.commandId) return;
      entry.lastCompleted = payload.commandId;
      const app = useAppStore.getState();
      const targetVisible = isTerminalSessionCurrentlyVisible(payload.sessionId);
      const meetsCommandCriteria = shouldNotifyTerminalCommand(
        payload,
        app.terminalCommandNotificationThresholdSec,
        false,
      );
      if (!meetsCommandCriteria) return;
      const failed = (payload.exitCode ?? 0) !== 0;
      if (!targetVisible) {
        state.setUnreadCommand(payload.sessionId, failed ? 'failed' : 'completed');
      }
      if (!shouldDeliverDesktopNotification({
        enabled: app.notificationsEnabled,
        categoryEnabled: app.terminalCommandNotificationThresholdSec > 0,
        policy: app.notificationTriggerPolicy,
        windowFocused: isAppWindowFocused(),
        targetVisible,
      })) return;
      const target = cleanTerminalTitle(session.manualTitle ?? session.baseTitle ?? session.host, 128);
      const title = sanitizeNotificationText(
        t(failed ? 'terminal.commandBlock.failed' : 'terminal.commandBlock.completed'),
        160,
      );
      if (!title) return;
      const body = sanitizeNotificationText(
        t('terminal.commandBlock.notification', { target, seconds: ((payload.durationMs ?? 0) / 1000).toFixed(1) }),
        360,
      );
      void invokeSendDesktopNotification({
        title,
        body,
        target: { type: 'terminalSession', terminalSessionId: payload.sessionId },
        urgency: failed ? 'critical' : 'normal',
      }).catch((error) => logger.debug('Desktop notification unavailable', error));
    }).catch((error) => logger.warn('Failed to subscribe to command lifecycle', error)) : undefined;
    return () => {
      disposed = true;
      void unlisten?.then((remove) => remove?.());
      unsubscribe();
      unsubscribeSessions();
      unsubscribeSection();
      unsubscribeFocus();
      window.removeEventListener('focus', markActiveRead);
      document.removeEventListener('visibilitychange', markActiveRead);
      document.removeEventListener('shellspan:jump-terminal-command', onJump);
      [...sessions.keys()].forEach(clear);
      trackerListeners.forEach((listener) => listener());
    };
  }, []);
  return null;
}
