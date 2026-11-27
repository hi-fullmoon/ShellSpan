import React, { useEffect, useRef } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { useTerminalStore } from '@/stores/terminalStore';
import { useReconnectSession } from '@/hooks/useReconnectSession';
import { terminalRegistry, type TerminalController } from './registry/terminal-registry';
import { terminalInputReadiness } from './terminal-input-readiness';
import { useAppStore } from '@/stores/appStore';
import {
  invokeGetTerminalManualHandoffs,
  listenToAgentRuntimeSession,
  listenToAgentTerminalLease,
  listenToTerminalClosures,
  listenToTerminalIntegrationState,
} from '@/lib/ipc/tauri';
import { createLogger } from '@/lib/logger';
import { agentTerminalLeaseState } from './agent-terminal-lease-state';
import {
  createAgentTerminalLeaseCoordinator,
  refreshTerminalIntegrationState,
  TAKEOVER_CONFIRMATION_TIMEOUT_MS,
  type AgentTerminalLeaseCoordinator,
} from './agent-terminal-lease-coordinator';

const logger = createLogger('agent-terminal-lease');

export {
  createAgentTerminalLeaseCoordinator,
  TAKEOVER_CONFIRMATION_TIMEOUT_MS,
  type AgentTerminalLeaseCoordinator,
};

export const TerminalControllerLayer: React.FC = () => {
  const sessions = useTerminalStore((s) => s.sessions);
  const setStatus = useTerminalStore((s) => s.setStatus);
  const setClosed = useTerminalStore((s) => s.setClosed);
  const setIntegrationState = useTerminalStore((s) => s.setIntegrationState);
  const reconnectSession = useReconnectSession();
  const terminalFontSize = useAppStore((s) => s.terminalFontSize);
  const terminalFontFamily = useAppStore((s) => s.terminalFontFamily);
  const terminalCustomFontFamily = useAppStore((s) => s.terminalCustomFontFamily);
  const terminalMacOptionIsMeta = useAppStore((s) => s.terminalMacOptionIsMeta);
  const terminalAltClickMovesCursor = useAppStore((s) => s.terminalAltClickMovesCursor);
  const terminalWebglRenderer = useAppStore((s) => s.terminalWebglRenderer);
  const terminalCursorBlink = useAppStore((s) => s.terminalCursorBlink);
  const terminalCursorStyle = useAppStore((s) => s.terminalCursorStyle);
  const terminalScrollback = useAppStore((s) => s.terminalScrollback);
  const terminalColorScheme = useAppStore((s) => s.terminalColorScheme);
  const terminalColorOverrides = useAppStore((s) => s.terminalColorOverrides);
  const terminalMinimumContrastRatio = useAppStore((s) => s.terminalMinimumContrastRatio);
  const terminalAutoReconnect = useAppStore((s) => s.terminalAutoReconnect);
  const terminalLineHeight = useAppStore((s) => s.terminalLineHeight);
  const terminalLetterSpacing = useAppStore((s) => s.terminalLetterSpacing);
  const terminalUrlDetection = useAppStore((s) => s.terminalUrlDetection);
  const terminalBellStyle = useAppStore((s) => s.terminalBellStyle);
  const knownRef = useRef<Set<string>>(new Set());
  const restoringControllers = useRef(new WeakMap<TerminalController, string>());

  useEffect(() => {
    terminalRegistry.updateOptions({
      fontSize: terminalFontSize,
      fontFamily: terminalFontFamily,
      customFontFamily: terminalCustomFontFamily,
      macOptionIsMeta: terminalMacOptionIsMeta,
      altClickMovesCursor: terminalAltClickMovesCursor,
      webglRenderer: terminalWebglRenderer,
      cursorBlink: terminalCursorBlink,
      cursorStyle: terminalCursorStyle,
      scrollback: terminalScrollback,
      colorScheme: terminalColorScheme,
      colorOverrides: terminalColorOverrides,
      minimumContrastRatio: terminalMinimumContrastRatio,
      autoReconnect: terminalAutoReconnect,
      lineHeight: terminalLineHeight,
      letterSpacing: terminalLetterSpacing,
      urlDetection: terminalUrlDetection,
      bellStyle: terminalBellStyle,
    });
  }, [terminalAltClickMovesCursor, terminalAutoReconnect, terminalBellStyle, terminalColorScheme, terminalColorOverrides, terminalCursorBlink, terminalCursorStyle, terminalCustomFontFamily, terminalFontFamily, terminalFontSize, terminalLetterSpacing, terminalLineHeight, terminalMacOptionIsMeta, terminalMinimumContrastRatio, terminalScrollback, terminalUrlDetection, terminalWebglRenderer]);

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
      if (session.promptReady || session.status === 'error' || session.status === 'disconnected') {
        terminalInputReadiness.finish(session.sessionId);
      }
      if (!knownRef.current.has(session.sessionId) && !terminalRegistry.get(session.sessionId)) {
        const controller = terminalRegistry.create(
          session.sessionId,
          setStatus,
          setClosed,
          (currentSessionId) =>
            useTerminalStore.getState().sessions.find((s) => s.sessionId === currentSessionId,
            )?.status ?? 'connecting',
          (currentSessionId, automatic) => reconnectSession(currentSessionId, automatic),
          session.ptyInfo,
        );
        // Restored workspace sessions start disconnected and have no backend
        // process, so the closed-event hint never fires for them; show it up
        // front so the pane isn't blank.
        if (session.status === 'disconnected') {
          controller.writeDisconnectedHint();
        }
      }
      const controller = terminalRegistry.get(session.sessionId);
      const restoreKey = session.terminalSessionId && session.terminalGeneration !== undefined
        ? `${session.terminalSessionId}:${session.terminalGeneration}`
        : null;
      if (controller && session.restoreDisplay && restoreKey
        && restoringControllers.current.get(controller) !== restoreKey) {
        restoringControllers.current.set(controller, restoreKey);
        controller.restoreDisplay({
          terminalSessionId: session.terminalSessionId!,
          terminalGeneration: session.terminalGeneration!,
        });
        void refreshTerminalIntegrationState(session.sessionId);
      } else if (!knownRef.current.has(session.sessionId) && session.terminalSessionId) {
        // Native startup can finish before addSession.
        void refreshTerminalIntegrationState(session.sessionId);
      }
    }
    for (const session of sessions) {
      if (session.status === 'error' && session.statusMessage) {
        terminalRegistry.get(session.sessionId)?.writeConnectionFailure(session.statusMessage);
      } else if (session.status === 'connecting') {
        terminalRegistry.get(session.sessionId)?.clearConnectionFailure();
      }
    }
    for (const sessionId of knownRef.current) {
      if (!currentIds.has(sessionId)) {
        terminalRegistry.dispose(sessionId);
      }
    }
    knownRef.current = currentIds;
  }, [sessions, setStatus, setClosed, setIntegrationState, reconnectSession]);

  useEffect(() => {
    let disposed = false;
    let unlistenLease: (() => void) | undefined;
    let unlistenSession: (() => void) | undefined;
    let unlistenIntegration: (() => void) | undefined;
    let unlistenClosures: (() => void) | undefined;
    const coordinator = createAgentTerminalLeaseCoordinator();
    const closuresReady = isTauri() ? listenToTerminalClosures(({ payload }) => {
      coordinator.handleTerminalClosed(payload);
    }).then((unlisten) => {
      if (disposed) unlisten();
      else unlistenClosures = unlisten;
      return true;
    }).catch((error) => {
      logger.warn('Failed to subscribe to terminal closures', error);
      return false;
    }) : Promise.resolve(false);
    const restoreHandoffs = (): void => {
      void closuresReady.then(async (ready) => {
        if (!ready || disposed) return;
        const handoffs = await invokeGetTerminalManualHandoffs();
        if (!disposed) coordinator.restoreLiveManualHandoffs(handoffs);
      }).catch((error) => {
        if (!disposed) logger.warn('Failed to restore terminal handoffs', error);
      });
    };

    void listenToAgentTerminalLease((event) => {
      void coordinator.handle(event.payload);
    }).then((disposeListener) => {
      if (disposed) disposeListener();
      else unlistenLease = disposeListener;
    }).catch((error) => {
      logger.warn('Failed to subscribe to Agent terminal leases', error);
    });
    void listenToAgentRuntimeSession((event) => {
      coordinator.handleSession(event.payload);
      // A handoff can commit just after the initial read, with its turn start
      // already in history. Recheck terminals without a live view in that case.
      if (event.payload.type === 'agent/status' && event.payload.data.reason === 'waitingForUserAction') {
        const visible = useTerminalStore.getState().sessions.some((session) =>
          agentTerminalLeaseState.get(session.sessionId)?.agentSessionId === event.payload.sessionId);
        if (!visible) restoreHandoffs();
      }
    }).then((disposeListener) => {
      if (disposed) disposeListener();
      else {
        unlistenSession = disposeListener;
        // Subscribe before reading native state so a completion or cancellation
        // committed during a refresh can supersede the snapshot.
        restoreHandoffs();
      }
    }).catch((error) => {
      logger.warn('Failed to subscribe to Agent turn lifecycle', error);
    });
    void listenToTerminalIntegrationState((event) => {
      setIntegrationState(event.payload);
      const payload = event.payload;
      const current = useTerminalStore.getState().sessions.find((session) => session.sessionId === payload.sessionId);
      if (payload.inputObservation && current?.terminalSessionId === payload.terminalSessionId
        && current.terminalGeneration === payload.terminalGeneration) {
        agentTerminalLeaseState.observe(payload.sessionId, payload.terminalSessionId, payload.terminalGeneration, payload.inputObservation);
      }
    }).then((disposeListener) => {
      if (disposed) disposeListener();
      else {
        unlistenIntegration = disposeListener;
        // A shell can reach its first prompt before the event listener is ready.
        // Reconcile after subscription so that prompt boundary is not lost.
        for (const session of useTerminalStore.getState().sessions) {
          if (session.terminalSessionId && !session.pendingConnection) {
            void refreshTerminalIntegrationState(session.sessionId);
          }
        }
      }
    }).catch((error) => {
      logger.warn('Failed to subscribe to terminal integration state', error);
    });

    return () => {
      disposed = true;
      unlistenLease?.();
      unlistenSession?.();
      unlistenIntegration?.();
      unlistenClosures?.();
      coordinator.dispose();
    };
  }, [setIntegrationState]);

  return null;
};
