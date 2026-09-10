import React, { useEffect, useRef } from 'react';
import { useTerminalStore } from '@/stores/terminalStore';
import { useReconnectSession } from '@/hooks/useReconnectSession';
import { terminalRegistry } from './registry/terminal-registry';
import { useAppStore } from '@/stores/appStore';
import {
  invokeAgentTerminalLeaseReady,
  invokeTakeoverAgentTerminal,
  listenToAgentTerminalLease,
} from '@/lib/ipc/tauri';
import { createLogger } from '@/lib/logger';
import { agentTerminalLeaseState } from './agent-terminal-lease-state';
import type {
  TerminalController,
  TerminalOutputFilter,
} from './registry/terminal-registry';
import type { AgentTerminalLeaseEvent } from '@/types/agent-session';

const logger = createLogger('agent-terminal-lease');

export interface AgentTerminalLeaseDisplayFilter extends TerminalOutputFilter {
  readonly operationId: string;
}

export function createAgentTerminalLeaseDisplayFilter(
  operationId: string,
): AgentTerminalLeaseDisplayFilter {
  // Phase 3 already turns raw PTY protocol bytes into a safe display stream.
  // This operation-bound pass-through keeps that stream attached to the same
  // lifecycle as input suppression without risking loss of real ANSI output.
  let active = true;
  return {
    operationId,
    push: (chunk) => active ? chunk : '',
    finish: () => {
      active = false;
      return '';
    },
  };
}

interface ActiveLeaseResources {
  readonly lease: AgentTerminalLeaseEvent & { state: 'acquired' };
  readonly controller?: TerminalController;
  releaseInput?: () => void;
  removeDisplayFilter?: () => void;
  removeLifecycle?: () => void;
  takeoverRequested: boolean;
}

export interface AgentTerminalLeaseCoordinator {
  handle(lease: AgentTerminalLeaseEvent): Promise<void>;
  dispose(): void;
}

export function createAgentTerminalLeaseCoordinator(): AgentTerminalLeaseCoordinator {
  let disposed = false;
  const activeLeases = new Map<string, ActiveLeaseResources>();

  const cleanup = (active: ActiveLeaseResources, focus: boolean): void => {
    const { lease, controller } = active;
    const current = activeLeases.get(lease.sessionId);
    if (current?.lease.operationId !== lease.operationId) return;
    activeLeases.delete(lease.sessionId);
    active.removeLifecycle?.();
    active.removeDisplayFilter?.();
    active.releaseInput?.();
    agentTerminalLeaseState.clear(lease.sessionId, lease.operationId);
    if (
      focus
      && controller
      && terminalRegistry.get(lease.sessionId) === controller
      && controller.sessionId === lease.sessionId
    ) {
      controller.focus();
    }
  };

  const requestTakeover = (sessionId: string, operationId: string): void => {
    const active = activeLeases.get(sessionId);
    if (
      !active
      || active.lease.operationId !== operationId
      || active.takeoverRequested
    ) return;
    active.takeoverRequested = true;
    agentTerminalLeaseState.update(sessionId, operationId, (lease) => ({
      ...lease,
      takeoverRequested: true,
    }));
    void invokeTakeoverAgentTerminal({
      sessionId,
      agentSessionId: active.lease.agentSessionId,
      operationId,
    }).then((accepted) => {
      if (accepted) return;
      agentTerminalLeaseState.update(sessionId, operationId, (lease) => ({
        ...lease,
        takeoverFailed: true,
      }));
    }).catch((error) => {
      agentTerminalLeaseState.update(sessionId, operationId, (lease) => ({
        ...lease,
        takeoverFailed: true,
      }));
      logger.warn(`Failed to take over Agent terminal lease ${operationId}`, error);
    });
  };

  return {
    async handle(lease) {
      if (disposed) return;
      if (lease.state === 'released') {
        const active = activeLeases.get(lease.sessionId);
        if (active?.lease.operationId === lease.operationId) cleanup(active, true);
        return;
      }

      const previous = activeLeases.get(lease.sessionId);
      if (previous?.lease.operationId === lease.operationId) return;
      if (previous) cleanup(previous, false);

      const acquiredLease = { ...lease, state: 'acquired' as const };
      const controller = terminalRegistry.get(lease.sessionId);
      const active: ActiveLeaseResources = {
        lease: acquiredLease,
        controller,
        takeoverRequested: false,
      };
      activeLeases.set(lease.sessionId, active);
      if (controller) {
        active.removeDisplayFilter = controller.subscribeOutputFilter(
          createAgentTerminalLeaseDisplayFilter(lease.operationId),
        );
        active.releaseInput = controller.suppressUserInput(() => {
          agentTerminalLeaseState.update(lease.sessionId, lease.operationId, (current) => ({
            ...current,
            inputBlocked: true,
          }));
        });
        active.removeLifecycle = controller.subscribeLifecycle((lifecycle) => {
          if (lifecycle.type === 'rebound' || lifecycle.type === 'disposed') {
            cleanup(active, false);
          }
        });
      }
      agentTerminalLeaseState.set({
        ...acquiredLease,
        inputBlocked: false,
        takeoverRequested: false,
        takeoverFailed: false,
        requestTakeover: () => requestTakeover(lease.sessionId, lease.operationId),
      });

      let outputListenerReady = false;
      if (controller) {
        try {
          await controller.whenOutputReady();
          const current = activeLeases.get(lease.sessionId);
          outputListenerReady = !disposed
            && current?.lease.operationId === lease.operationId
            && current.controller === controller
            && terminalRegistry.get(lease.sessionId) === controller;
        } catch (error) {
          logger.warn(`Terminal output readiness failed for ${lease.sessionId}`, error);
        }
      }
      if (
        disposed
        || activeLeases.get(lease.sessionId)?.lease.operationId !== lease.operationId
      ) return;

      try {
        await invokeAgentTerminalLeaseReady({
          sessionId: lease.sessionId,
          agentSessionId: lease.agentSessionId,
          operationId: lease.operationId,
          terminalConnected: useTerminalStore.getState().sessions.some(
            (session) => session.sessionId === lease.sessionId && session.status === 'connected',
          ),
          outputListenerReady,
          hasPendingUserInput: controller?.hasPendingUserInput() ?? false,
          hasUnverifiedUserSubmission: controller?.hasUnverifiedUserSubmission() ?? false,
          hasCredentialPrompt: controller?.hasKnownCredentialPrompt() ?? false,
        });
      } catch (error) {
        logger.warn(`Failed to acknowledge Agent terminal lease ${lease.operationId}`, error);
      }
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      for (const active of [...activeLeases.values()]) cleanup(active, false);
      activeLeases.clear();
    },
  };
}

export const TerminalControllerLayer: React.FC = () => {
  const sessions = useTerminalStore((s) => s.sessions);
  const setStatus = useTerminalStore((s) => s.setStatus);
  const setClosed = useTerminalStore((s) => s.setClosed);
  const reconnectSession = useReconnectSession();
  const terminalFontSize = useAppStore((s) => s.terminalFontSize);
  const terminalFontFamily = useAppStore((s) => s.terminalFontFamily);
  const terminalCursorBlink = useAppStore((s) => s.terminalCursorBlink);
  const terminalCursorStyle = useAppStore((s) => s.terminalCursorStyle);
  const terminalScrollback = useAppStore((s) => s.terminalScrollback);
  const terminalColorScheme = useAppStore((s) => s.terminalColorScheme);
  const terminalAutoReconnect = useAppStore((s) => s.terminalAutoReconnect);
  const terminalLineHeight = useAppStore((s) => s.terminalLineHeight);
  const terminalLetterSpacing = useAppStore((s) => s.terminalLetterSpacing);
  const terminalUrlDetection = useAppStore((s) => s.terminalUrlDetection);
  const terminalBellStyle = useAppStore((s) => s.terminalBellStyle);
  const knownRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    terminalRegistry.updateOptions({
      fontSize: terminalFontSize,
      fontFamily: terminalFontFamily,
      cursorBlink: terminalCursorBlink,
      cursorStyle: terminalCursorStyle,
      scrollback: terminalScrollback,
      colorScheme: terminalColorScheme,
      autoReconnect: terminalAutoReconnect,
      lineHeight: terminalLineHeight,
      letterSpacing: terminalLetterSpacing,
      urlDetection: terminalUrlDetection,
      bellStyle: terminalBellStyle,
    });
  }, [terminalAutoReconnect, terminalBellStyle, terminalColorScheme, terminalCursorBlink, terminalCursorStyle, terminalFontFamily, terminalFontSize, terminalLetterSpacing, terminalLineHeight, terminalScrollback, terminalUrlDetection]);

  useEffect(() => {
    const root = document.documentElement;
    let previousTheme = root.getAttribute('data-theme');
    const observer = new MutationObserver(() => {
      const nextTheme = root.getAttribute('data-theme');
      if (nextTheme === previousTheme) return;
      previousTheme = nextTheme;
      terminalRegistry.refreshTheme();
    });
    observer.observe(root, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const currentIds = new Set(
      sessions
        .filter((session) => !session.pendingConnection)
        .map((session) => session.sessionId),
    );
    for (const session of sessions) {
      if (session.pendingConnection) continue;
      if (!knownRef.current.has(session.sessionId) && !terminalRegistry.get(session.sessionId)) {
        const controller = terminalRegistry.create(
          session.sessionId,
          setStatus,
          setClosed,
          (currentSessionId) =>
            useTerminalStore.getState().sessions.find((s) => s.sessionId === currentSessionId,
            )?.status ?? 'connecting',
          (currentSessionId) => reconnectSession(currentSessionId),
        );
        // Restored workspace sessions start disconnected and have no backend
        // process, so the closed-event hint never fires for them; show it up
        // front so the pane isn't blank.
        if (session.status === 'disconnected') {
          controller.writeDisconnectedHint();
        }
      }
    }
    for (const sessionId of knownRef.current) {
      if (!currentIds.has(sessionId)) {
        terminalRegistry.dispose(sessionId);
      }
    }
    knownRef.current = currentIds;
  }, [sessions, setStatus, setClosed, reconnectSession]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    const coordinator = createAgentTerminalLeaseCoordinator();

    void listenToAgentTerminalLease((event) => {
      void coordinator.handle(event.payload);
    }).then((disposeListener) => {
      if (disposed) disposeListener();
      else unlisten = disposeListener;
    }).catch((error) => {
      logger.warn('Failed to subscribe to Agent terminal leases', error);
    });

    return () => {
      disposed = true;
      unlisten?.();
      coordinator.dispose();
    };
  }, []);

  return null;
};
