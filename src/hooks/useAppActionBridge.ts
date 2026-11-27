import { useEffect } from 'react';
import { dispatchAppAction } from '@/lib/app-actions/registry';
import {
  invokeDrainPendingDeepLinks,
  isTauriRuntime,
  listenToAgentRuntimeSession,
  listenToDeepLink,
} from '@/lib/ipc/tauri';
import { createLogger } from '@/lib/logger';
import type { DeepLinkDispatch } from '@/types/agent-app-action';
import type { AgentSessionEvent } from '@/types/agent-session';

const logger = createLogger('app-action-bridge');

export function handleLiveAgentAppActionEvent(event: AgentSessionEvent): void {
  if (event.type !== 'app_action/dispatched') return;
  const result = dispatchAppAction(event.data.action, {
    source: 'agent',
    actionId: event.data.actionId,
    requiresFocus: event.data.requiresFocus,
  });
  if (result.status === 'invalidPayload' || result.status === 'targetNotFound') {
    logger.warn(`App action ${event.data.actionId} was not applied (${result.status}): ${result.detail ?? ''}`);
  }
}

export function handleDeepLinkDispatch(dispatch: DeepLinkDispatch): void {
  const result = dispatchAppAction(dispatch.action, {
    source: 'deepLink',
    actionId: dispatch.actionId,
    requiresFocus: true,
  });
  if (result.status === 'invalidPayload' || result.status === 'targetNotFound') {
    logger.warn(`Deep-link action ${dispatch.actionId} was not applied (${result.status}): ${result.detail ?? ''}`);
  }
}

/**
 * Listens only to live committed Agent Session events and validated
 * `shellspan://` deep links so historical replay or app restarts never
 * re-execute UI navigation or draft dialogs automatically.
 */
export function useAppActionBridge(): void {
  useEffect(() => {
    if (!isTauriRuntime()) return;
    let disposed = false;
    let unlistenSession: (() => void) | undefined;
    let unlistenDeepLink: (() => void) | undefined;

    void listenToAgentRuntimeSession((event) => {
      if (disposed) return;
      handleLiveAgentAppActionEvent(event.payload);
    }).then((dispose) => {
      if (disposed) {
        dispose();
      } else {
        unlistenSession = dispose;
      }
    }).catch((error) => {
      logger.warn('Failed to attach live app action bridge', error);
    });

    void listenToDeepLink((event) => {
      if (disposed) return;
      handleDeepLinkDispatch(event.payload);
    }).then((dispose) => {
      if (disposed) {
        dispose();
      } else {
        unlistenDeepLink = dispose;
      }
    }).catch((error) => {
      logger.warn('Failed to attach deep-link bridge', error);
    });

    void invokeDrainPendingDeepLinks().then((pending) => {
      if (disposed) return;
      for (const item of pending) {
        handleDeepLinkDispatch(item);
      }
    }).catch((error) => {
      logger.warn('Failed to drain startup deep links', error);
    });

    return () => {
      disposed = true;
      unlistenSession?.();
      unlistenDeepLink?.();
    };
  }, []);
}
