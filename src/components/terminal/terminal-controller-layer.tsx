import React, { useEffect, useRef } from 'react';
import { flushSync } from 'react-dom';
import { isTauri } from '@tauri-apps/api/core';
import { useTerminalStore, type TerminalWorkspace } from '@/stores/terminalStore';
import { useReconnectSession } from '@/hooks/useReconnectSession';
import { terminalRegistry } from './registry/terminal-registry';
import { terminalInputReadiness } from './terminal-input-readiness';
import { useAppStore } from '@/stores/appStore';
import { useFocusStore } from '@/stores/focusStore';
import {
  invokeGetAgentRuntimeSession,
  invokeAgentTerminalLeaseReady,
  invokeGetTerminalBrokerSnapshot,
  invokeGetTerminalManualHandoffs,
  invokeInterruptAgentRuntime,
  invokeTakeoverAgentTerminal,
  listenToAgentRuntimeSession,
  listenToAgentTerminalLease,
  listenToTerminalClosures,
  listenToTerminalIntegrationState,
} from '@/lib/ipc/tauri';
import { createLogger } from '@/lib/logger';
import { agentTerminalLeaseState, type AgentTerminalLeaseView } from './agent-terminal-lease-state';
import type { TerminalController } from './registry/terminal-registry';
import type { AgentSessionEvent, AgentTerminalLeaseEvent, LiveTerminalManualHandoff, TerminalManualHandoff } from '@/types/agent-session';
import type { ClosedEvent } from '@/types';

const logger = createLogger('agent-terminal-lease');
export const TAKEOVER_CONFIRMATION_TIMEOUT_MS = 5_000;

function rootWorkspace(sessionId: string): TerminalWorkspace | undefined {
  if (sessionId.startsWith('focus-agent-')) return 'focus';
  if (sessionId.startsWith('agent-')) return 'terminal';
  return undefined;
}

async function refreshTerminalIntegrationState(sessionId: string): Promise<void> {
  try {
    const snapshot = await invokeGetTerminalBrokerSnapshot(sessionId);
    const integrated = snapshot.session;
    if (!integrated) return;
    const remoteRolloutMissing = integrated.transportKind === 'sshPty'
      && !snapshot.remoteBoundTerminalRollout.enabled;
    const executionRolloutMissing = !snapshot.terminalExecuteRollout.enabled
      || remoteRolloutMissing;
    useTerminalStore.getState().setIntegrationState({
      sessionId,
      inputObservation: integrated.inputObservation,
      terminalSessionId: integrated.terminalSessionId,
      terminalGeneration: integrated.terminalGeneration,
      integrationStateRevision: integrated.integrationStateRevision,
      state: integrated.integrationState === 'ready' && executionRolloutMissing
        ? 'unavailable'
        : integrated.integrationState === 'degraded'
          ? 'unavailable'
          : integrated.integrationState,
      promptReady: integrated.promptReady,
      promptReadyRevision: integrated.promptReadyRevision,
      currentDirectory: integrated.currentDirectory,
      shell: integrated.integrationShell,
      reason: integrated.integrationState === 'ready' && executionRolloutMissing
        ? remoteRolloutMissing ? 'remoteBoundTerminalDisabled' : 'terminalExecuteDisabled'
        : integrated.integrationReason,
    });
    const current = useTerminalStore.getState().sessions.find((session) => session.sessionId === sessionId);
    if (integrated.inputObservation && current?.terminalSessionId === integrated.terminalSessionId
      && current.terminalGeneration === integrated.terminalGeneration) {
      agentTerminalLeaseState.observe(sessionId, integrated.terminalSessionId, integrated.terminalGeneration, integrated.inputObservation);
    }
  } catch (error) {
    logger.warn(`Failed to read terminal integration state ${sessionId}`, error);
  }
}

interface ActiveLeaseResources {
  readonly lease: AgentTerminalLeaseEvent & { state: 'acquired' };
  readonly controller?: TerminalController;
  releaseInput?: () => void;
  removeLifecycle?: () => void;
}

interface PendingTurnStop {
  readonly timer: ReturnType<typeof setTimeout>;
  readonly focusTerminal: () => void;
}

export interface AgentTerminalLeaseCoordinator {
  handle(lease: AgentTerminalLeaseEvent): Promise<void>;
  handleSession(event: AgentSessionEvent): void;
  handleTerminalClosed(event: ClosedEvent): void;
  restoreLiveManualHandoffs(handoffs: readonly LiveTerminalManualHandoff[]): void;
  dispose(): void;
}

export function createAgentTerminalLeaseCoordinator(): AgentTerminalLeaseCoordinator {
  let disposed = false;
  const activeLeases = new Map<string, ActiveLeaseResources>();
  const retainedInputs = new Map<string, {
    sessionId: string;
    controller: TerminalController;
    release: () => void;
    removeLifecycle: () => void;
  }>();
  const turnSurfaces = new Map<string, { sessionId: string; operationId: string; turnId?: string }>();
  const suspendedTurnViews = new Map<string, AgentTerminalLeaseView>();
  const currentTurns = new Map<string, string>();
  const closedTransports = new Set<string>();
  const lastTurnEventSeq = new Map<string, number>();
  const waitingForUserAction = new Set<string>();
  const pendingTurnBindings = new Map<string, Promise<void>>();
  const workspaceOwners = new Map<string, TerminalWorkspace>();
  const fencedTurns = new Map<string, string | undefined>();
  const pendingTurnStops = new Map<string, PendingTurnStop>();

  const runsBehindFocus = (agentSessionId: string): boolean =>
    useFocusStore.getState().enabled
    && (workspaceOwners.get(agentSessionId) ?? rootWorkspace(agentSessionId)) === 'terminal';

  const releaseResources = (active: ActiveLeaseResources, focus: boolean): boolean => {
    const { lease, controller } = active;
    const current = activeLeases.get(lease.sessionId);
    if (current?.lease.operationId !== lease.operationId) return false;
    activeLeases.delete(lease.sessionId);
    active.removeLifecycle?.();
    active.releaseInput?.();
    if (
      focus
      && !runsBehindFocus(lease.agentSessionId)
      && controller
      && terminalRegistry.get(lease.sessionId) === controller
      && controller.sessionId === lease.sessionId
    ) {
      controller.focus();
    }
    return true;
  };

  const releaseRetainedInput = (agentSessionId: string): void => {
    const retained = retainedInputs.get(agentSessionId);
    retained?.release();
    retained?.removeLifecycle();
    retainedInputs.delete(agentSessionId);
  };

  const retainTurnInput = (agentSessionId: string, sessionId: string, controller: TerminalController, suppress = true): void => {
    releaseRetainedInput(agentSessionId);
    retainedInputs.set(agentSessionId, {
      sessionId,
      controller,
      release: suppress ? controller.suppressUserInput(() => {
        const current = agentTerminalLeaseState.get(sessionId);
        if (current?.agentSessionId === agentSessionId) {
          agentTerminalLeaseState.update(sessionId, current.operationId, (view) => ({
            ...view,
            inputBlocked: true,
          }));
        }
      }, () => !useTerminalStore.getState().sessions.find((session) => session.sessionId === sessionId)?.foregroundHandoffActive) : () => {},
      removeLifecycle: controller.subscribeLifecycle((lifecycle) => {
        if (lifecycle.type === 'rebound' || lifecycle.type === 'disposed') clearTurn(agentSessionId);
      }),
    });
  };

  const clearTurn = (agentSessionId: string): void => {
    waitingForUserAction.delete(agentSessionId);
    workspaceOwners.delete(agentSessionId);
    const pendingStop = pendingTurnStops.get(agentSessionId);
    if (pendingStop) clearTimeout(pendingStop.timer);
    pendingTurnStops.delete(agentSessionId);
    const surface = turnSurfaces.get(agentSessionId);
    if (surface) {
      const active = activeLeases.get(surface.sessionId);
      if (active?.lease.agentSessionId === agentSessionId) releaseResources(active, false);
      agentTerminalLeaseState.clear(surface.sessionId, surface.operationId);
      turnSurfaces.delete(agentSessionId);
    }
    releaseRetainedInput(agentSessionId);
    suspendedTurnViews.delete(agentSessionId);
    if (disposed || !surface || agentTerminalLeaseState.get(surface.sessionId)) return;
    for (const view of [...suspendedTurnViews.values()].reverse()) {
      const owner = turnSurfaces.get(view.agentSessionId);
      const retained = retainedInputs.get(view.agentSessionId);
      if (view.sessionId !== surface.sessionId
        || owner?.sessionId !== view.sessionId || owner.operationId !== view.operationId
        || !currentTurns.has(view.agentSessionId) || fencedTurns.has(view.agentSessionId)
        || !retained || terminalRegistry.get(view.sessionId) !== retained.controller) continue;
      suspendedTurnViews.delete(view.agentSessionId);
      agentTerminalLeaseState.set(view);
      break;
    }
  };

  const cleanup = (active: ActiveLeaseResources, focus: boolean, keepForTurn = false): void => {
    if (activeLeases.get(active.lease.sessionId)?.lease.operationId !== active.lease.operationId) return;
    if (keepForTurn && active.releaseInput && active.controller) {
      releaseRetainedInput(active.lease.agentSessionId);
      retainedInputs.set(active.lease.agentSessionId, {
        sessionId: active.lease.sessionId,
        controller: active.controller,
        release: active.releaseInput,
        removeLifecycle: active.controller.subscribeLifecycle((lifecycle) => {
          if (lifecycle.type === 'rebound' || lifecycle.type === 'disposed') {
            clearTurn(active.lease.agentSessionId);
          }
        }),
      });
      active.releaseInput = undefined;
    }
    if (!releaseResources(active, focus)) return;
    const { lease } = active;
    if (keepForTurn) {
      agentTerminalLeaseState.update(lease.sessionId, lease.operationId, (current) => ({
        ...current,
        terminalOwned: false,
        inputBlocked: false,
        takeoverRequested: false,
        takeoverFailed: false,
      }));
      return;
    }
    releaseRetainedInput(lease.agentSessionId);
    agentTerminalLeaseState.clear(lease.sessionId, lease.operationId);
    const pendingStop = pendingTurnStops.get(lease.agentSessionId);
    if (pendingStop) clearTimeout(pendingStop.timer);
    pendingTurnStops.delete(lease.agentSessionId);
    if (turnSurfaces.get(lease.agentSessionId)?.operationId === lease.operationId) {
      turnSurfaces.delete(lease.agentSessionId);
    }
  };

  const updateManualInput = (agentSessionId: string, waiting: boolean, focus = true): void => {
    if (waiting) waitingForUserAction.add(agentSessionId);
    else waitingForUserAction.delete(agentSessionId);
    const surface = turnSurfaces.get(agentSessionId);
    if (!surface) return;
    const { sessionId } = surface;
    const controller = terminalRegistry.get(sessionId);
    if (waiting) {
      // A released native operation can still have a queued frontend release event.
      const active = activeLeases.get(sessionId);
      if (active) cleanup(active, false, true);
      for (const [owner, retained] of retainedInputs) {
        if (retained.sessionId === sessionId) releaseRetainedInput(owner);
      }
      if (controller) retainTurnInput(agentSessionId, sessionId, controller, false);
      const displayed = agentTerminalLeaseState.get(sessionId);
      const view = displayed?.agentSessionId === agentSessionId
        ? displayed
        : suspendedTurnViews.get(agentSessionId);
      if (view) {
        suspendedTurnViews.delete(agentSessionId);
        agentTerminalLeaseState.set({ ...view, terminalOwned: false, inputBlocked: false, waitingForUserAction: true });
      }
      if (focus && !runsBehindFocus(agentSessionId) && useAppStore.getState().activeSection === 'terminal'
        && useTerminalStore.getState().activeSessionId === sessionId) controller?.focus();
    } else {
      if (controller) retainTurnInput(agentSessionId, sessionId, controller);
      agentTerminalLeaseState.update(sessionId, surface.operationId, (view) => ({
        ...view,
        waitingForUserAction: false,
      }));
    }
  };

  const bindTurnSurface = (
    binding: Omit<TerminalManualHandoff, 'throughSeq'>,
    workspace: TerminalWorkspace | undefined,
    focus = true,
  ): void => {
    const { sessionId, agentSessionId, taskId, turnId, acquiredAtUnixMs } = binding;
    if (turnSurfaces.has(agentSessionId)) return;
    if (workspace) workspaceOwners.set(agentSessionId, workspace);
    const operationId = `turn:${turnId}`;
    // Preserve the frozen target even when another Agent is visible.
    turnSurfaces.set(agentSessionId, { sessionId, operationId, turnId });
    const existingOwner = agentTerminalLeaseState.get(sessionId);
    const view: AgentTerminalLeaseView = {
      sessionId, agentSessionId, workspace, taskId, operationId, acquiredAtUnixMs,
      state: 'acquired',
      terminalOwned: false,
      waitingForUserAction: waitingForUserAction.has(agentSessionId),
      inputBlocked: false,
      takeoverRequested: false,
      takeoverFailed: false,
      requestTakeover: () => requestTakeover(sessionId, operationId),
    };
    if (existingOwner && existingOwner.agentSessionId !== agentSessionId) {
      suspendedTurnViews.set(agentSessionId, view);
    } else {
      const controller = terminalRegistry.get(sessionId);
      if (controller && !view.waitingForUserAction) retainTurnInput(agentSessionId, sessionId, controller);
      agentTerminalLeaseState.set(view);
    }
    if (view.waitingForUserAction) updateManualInput(agentSessionId, true, focus);
  };

  const requestTakeover = (sessionId: string, operationId: string): void => {
    const view = agentTerminalLeaseState.get(sessionId);
    if (
      view?.operationId !== operationId
      || view.waitingForUserAction
      || view.takeoverRequested
      || pendingTurnStops.has(view.agentSessionId)
    ) return;
    const agentSessionId = view.agentSessionId;
    const controller = terminalRegistry.get(sessionId);
    const workspace = useTerminalStore.getState().workspace;
    const focusTerminal = (): void => {
      const store = useTerminalStore.getState();
      const { enabled, terminalOpen } = useFocusStore.getState();
      if (!controller?.terminal.textarea?.isConnected || controller.sessionId !== sessionId
        || terminalRegistry.get(sessionId) !== controller || store.workspace !== workspace
        || useAppStore.getState().activeSection !== 'terminal' || (enabled && !terminalOpen)
        || agentTerminalLeaseState.blocksUserInput(sessionId)) return;
      store.setActiveSession(sessionId);
      controller.focus();
    };
    agentTerminalLeaseState.update(sessionId, operationId, (current) => ({
      ...current,
      takeoverRequested: true,
      takeoverFailed: false,
    }));
    let pendingStop: PendingTurnStop;
    const timer = setTimeout(() => {
      if (pendingTurnStops.get(agentSessionId) !== pendingStop) return;
      pendingTurnStops.delete(agentSessionId);
      agentTerminalLeaseState.update(sessionId, operationId, (current) => ({
        ...current,
        takeoverRequested: false,
        takeoverFailed: true,
      }));
      logger.warn(`Timed out waiting for Agent turn cancellation ${agentSessionId}`);
    }, TAKEOVER_CONFIRMATION_TIMEOUT_MS);
    pendingStop = { timer, focusTerminal };
    pendingTurnStops.set(agentSessionId, pendingStop);
    const completeTakeover = (): void => {
      fencedTurns.set(agentSessionId, currentTurns.get(agentSessionId));
      clearTurn(agentSessionId);
      focusTerminal();
    };
    void (async () => {
      let backendFenced = false;
      try {
        backendFenced = await invokeTakeoverAgentTerminal({
          sessionId,
          agentSessionId,
          operationId,
        });
      } catch (error) {
        logger.warn(`Terminal takeover failed ${operationId}`, error);
      }
      if (pendingTurnStops.get(agentSessionId) !== pendingStop) return;

      if (backendFenced) {
        completeTakeover();
        void invokeInterruptAgentRuntime({ sessionId: agentSessionId }).catch((error) => {
          logger.warn(`Failed to stop taken-over Agent turn ${agentSessionId}`, error);
        });
        return;
      }

      try {
        await invokeInterruptAgentRuntime({ sessionId: agentSessionId });
        if (pendingTurnStops.get(agentSessionId) !== pendingStop) return;
        completeTakeover();
      } catch (error) {
        if (pendingTurnStops.get(agentSessionId) !== pendingStop) return;
        clearTimeout(pendingStop.timer);
        pendingTurnStops.delete(agentSessionId);
        agentTerminalLeaseState.update(sessionId, operationId, (current) => ({
          ...current,
          takeoverRequested: false,
          takeoverFailed: true,
        }));
        logger.warn(`Failed to cancel Agent turn ${agentSessionId}`, error);
      }
    })();
  };

  const restoreManualHandoff = (handoff: TerminalManualHandoff): boolean => {
    const { agentSessionId, sessionId, turnId, throughSeq } = handoff;
    const previousTurn = currentTurns.get(agentSessionId);
    const previousSurface = turnSurfaces.get(agentSessionId);
    if (disposed || fencedTurns.has(agentSessionId) || activeLeases.has(sessionId)
      || (lastTurnEventSeq.get(agentSessionId) ?? -1) > throughSeq
      || (previousTurn && previousTurn !== turnId)
      || (previousSurface && previousSurface.sessionId !== sessionId)) return false;
    currentTurns.set(agentSessionId, turnId);
    if (previousSurface) {
      if (!waitingForUserAction.has(agentSessionId)) updateManualInput(agentSessionId, true, false);
    } else {
      waitingForUserAction.add(agentSessionId);
      bindTurnSurface(handoff, rootWorkspace(agentSessionId), false);
    }
    return true;
  };

  return {
    restoreLiveManualHandoffs(handoffs) {
      const store = useTerminalStore.getState();
      const activeSessionId = store.activeSessionId;
      for (const { handoff, terminal, profileId } of handoffs) {
        const { sessionId } = terminal;
        const previous = useTerminalStore.getState().sessions.find((session) => session.sessionId === sessionId);
        if (closedTransports.has(sessionId) || previous?.closed || sessionId !== handoff.sessionId
          || !terminal.terminalSessionId || terminal.terminalGeneration === undefined
          || (previous?.terminalSessionId && (previous.terminalSessionId !== terminal.terminalSessionId
            || previous.terminalGeneration !== terminal.terminalGeneration))
          || !restoreManualHandoff(handoff)) continue;
        if (!previous) store.addSession(terminal, profileId ?? undefined);
        if (previous?.status !== 'connected' && !previous?.restoreDisplay) {
          useTerminalStore.setState(({ sessions }) => ({
            sessions: sessions.map(session => session.sessionId !== sessionId ? session : {
              ...session,
              status: 'connecting',
              statusMessage: undefined,
              restoreDisplay: true,
              terminalSessionId: terminal.terminalSessionId,
              terminalGeneration: terminal.terminalGeneration,
              ptyInfo: terminal.ptyInfo,
            }),
          }));
        }
      }
      if (activeSessionId && useTerminalStore.getState().activeSessionId !== activeSessionId) {
        store.setActiveSession(activeSessionId);
      }
    },

    handleTerminalClosed(event) {
      if (disposed) return;
      // Transport session IDs are single-use, including on reconnect.
      closedTransports.add(event.sessionId);
      useTerminalStore.getState().setClosed(event.sessionId, event);
      for (const [owner, surface] of turnSurfaces) {
        if (surface.sessionId === event.sessionId) clearTurn(owner);
      }
    },

    async handle(lease) {
      if (disposed) return;
      if (lease.state === 'activity') {
        agentTerminalLeaseState.update(lease.sessionId, lease.operationId, (current) => (
          current.terminalOwned && current.agentSessionId === lease.agentSessionId && !current.backendObservation
            ? { ...current, commandPhase: lease.commandPhase }
            : current
        ));
        await refreshTerminalIntegrationState(lease.sessionId);
        return;
      }
      if (lease.state === 'acquired') {
        await pendingTurnBindings.get(lease.agentSessionId);
        if (disposed) return;
      }
      if (lease.state === 'released' && lease.reason === 'handedOff') {
        const active = activeLeases.get(lease.sessionId);
        if (active?.lease.operationId === lease.operationId) {
          cleanup(active, true);
          clearTurn(lease.agentSessionId);
        }
        await refreshTerminalIntegrationState(lease.sessionId);
        return;
      }
      if (fencedTurns.has(lease.agentSessionId)) {
        if (lease.state === 'acquired') {
          try {
            await invokeAgentTerminalLeaseReady({
              sessionId: lease.sessionId,
              agentSessionId: lease.agentSessionId,
              operationId: lease.operationId,
              terminalConnected: false,
              outputListenerReady: false,
              hasPendingUserInput: false,
              hasUnverifiedUserSubmission: false,
              hasCredentialPrompt: false,
            });
          } catch (error) {
            logger.warn(`Failed to reject fenced Agent terminal lease ${lease.operationId}`, error);
          }
        }
        return;
      }
      if (lease.state === 'released') {
        const active = activeLeases.get(lease.sessionId);
        if (active?.lease.operationId === lease.operationId) {
          // A command ending does not end the Agent turn. Keep the same input
          // suppression until TurnEnd (or an explicit confirmed takeover).
          cleanup(active, false, true);
        }
        return;
      }

      const frozenSurface = turnSurfaces.get(lease.agentSessionId);
      if (
        currentTurns.has(lease.agentSessionId)
        && (!frozenSurface || frozenSurface.sessionId !== lease.sessionId)
      ) {
        try {
          await invokeAgentTerminalLeaseReady({
            sessionId: lease.sessionId,
            agentSessionId: lease.agentSessionId,
            operationId: lease.operationId,
            terminalConnected: false,
            outputListenerReady: false,
            hasPendingUserInput: false,
            hasUnverifiedUserSubmission: false,
            hasCredentialPrompt: false,
          });
        } catch (error) {
          logger.warn(`Failed to reject lease outside the frozen terminal ${lease.operationId}`, error);
        }
        return;
      }

      const previous = activeLeases.get(lease.sessionId);
      if (previous?.lease.operationId === lease.operationId) return;
      const controller = terminalRegistry.get(lease.sessionId);
      let inheritedInput: (() => void) | undefined;
      if (previous?.lease.agentSessionId === lease.agentSessionId && previous.controller === controller) {
        inheritedInput = previous.releaseInput;
        previous.releaseInput = undefined;
      }
      if (previous) releaseResources(previous, false);

      const acquiredLease = { ...lease, state: 'acquired' as const };
      const retained = retainedInputs.get(lease.agentSessionId);
      if (retained) {
        retainedInputs.delete(lease.agentSessionId);
        retained.removeLifecycle();
        if (retained.sessionId === lease.sessionId && retained.controller === controller) {
          inheritedInput = retained.release;
        } else {
          retained.release();
        }
      }
      const previousView = agentTerminalLeaseState.get(lease.sessionId);
      const delegatedInput = previousView && retainedInputs.get(previousView.agentSessionId);
      const preserveDelegatedView = previousView?.agentSessionId !== lease.agentSessionId
        && !!previousView && currentTurns.has(previousView.agentSessionId)
        && turnSurfaces.get(previousView.agentSessionId)?.operationId === previousView.operationId
        && delegatedInput?.sessionId === lease.sessionId && delegatedInput.controller === controller;
      suspendedTurnViews.delete(lease.agentSessionId);
      if (previousView && previousView.agentSessionId !== lease.agentSessionId
        && currentTurns.has(previousView.agentSessionId)
        && turnSurfaces.get(previousView.agentSessionId)?.operationId === previousView.operationId) {
        suspendedTurnViews.set(previousView.agentSessionId, previousView);
      }
      const pendingTurnStop = pendingTurnStops.has(lease.agentSessionId);
      const turnStartedAtUnixMs = previousView?.agentSessionId === lease.agentSessionId
        ? previousView.acquiredAtUnixMs
        : lease.acquiredAtUnixMs;
      const previousSurface = frozenSurface ?? turnSurfaces.get(lease.agentSessionId);
      if (
        previousSurface
        && (
          previousSurface.sessionId !== lease.sessionId
          || previousSurface.operationId !== lease.operationId
        )
      ) {
        agentTerminalLeaseState.clear(
          previousSurface.sessionId,
          previousSurface.operationId,
        );
      }
      const active: ActiveLeaseResources = {
        lease: acquiredLease,
        controller,
        releaseInput: inheritedInput,
      };
      activeLeases.set(lease.sessionId, active);
      turnSurfaces.set(lease.agentSessionId, {
        sessionId: frozenSurface?.sessionId ?? lease.sessionId,
        operationId: lease.operationId,
        ...(currentTurns.get(lease.agentSessionId)
          ? { turnId: currentTurns.get(lease.agentSessionId) }
          : {}),
      });
      if (controller) {
        active.releaseInput ??= controller.suppressUserInput(() => {
          const current = agentTerminalLeaseState.get(lease.sessionId);
          if (current?.agentSessionId === lease.agentSessionId) {
            agentTerminalLeaseState.update(lease.sessionId, current.operationId, (view) => ({
              ...view,
              inputBlocked: true,
            }));
          }
        });
        active.removeLifecycle = controller.subscribeLifecycle((lifecycle) => {
          if (lifecycle.type === 'rebound' || lifecycle.type === 'disposed') {
            cleanup(active, false);
          }
        });
      }
      agentTerminalLeaseState.set({
        ...acquiredLease,
        workspace: workspaceOwners.get(lease.agentSessionId) ?? rootWorkspace(lease.agentSessionId),
        acquiredAtUnixMs: turnStartedAtUnixMs,
        terminalOwned: true,
        inputBlocked: false,
        takeoverRequested: pendingTurnStop,
        takeoverFailed: false,
        requestTakeover: () => requestTakeover(lease.sessionId, lease.operationId),
      });
      const integrationRefresh = refreshTerminalIntegrationState(lease.sessionId);

      let outputListenerReady = false;
      if (controller) {
        try {
          await controller.whenOutputReady();
          // A prompt can reach the broker before its state event reaches this view.
          if (controller.hasPendingUserInput()) await integrationRefresh;
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

      const focused = document.activeElement;
      const changesView = useAppStore.getState().activeSection !== 'terminal'
        || useTerminalStore.getState().activeSessionId !== lease.sessionId;
      // Changing tabs or sections may detach the currently focused input.
      const preserveView = inheritedInput !== undefined || preserveDelegatedView || runsBehindFocus(lease.agentSessionId)
        || (changesView && focused !== null && focused !== document.body);
      if (controller && controller.sessionId === lease.sessionId
        && terminalRegistry.get(lease.sessionId) === controller && !preserveView) {
        // Commit the pane's attachment before acknowledging the output listener.
        flushSync(() => {
          // Focus commands use whichever terminal workspace the user is viewing.
          // A lease must not re-enter Focus after the user has left it.
          const workspace = workspaceOwners.get(lease.agentSessionId) ?? rootWorkspace(lease.agentSessionId);
          if (workspace === 'terminal') useFocusStore.getState().leave();
          useTerminalStore.getState().setActiveSession(lease.sessionId);
          useAppStore.getState().setActiveSection('terminal');
          if (useFocusStore.getState().enabled) useFocusStore.getState().setTerminalOpen(true);
        });
        // Switching sections can synchronously dispose or rebind a controller.
        // Don't acknowledge a controller whose lease or identity changed.
        if (disposed || activeLeases.get(lease.sessionId) !== active
          || controller.sessionId !== lease.sessionId
          || terminalRegistry.get(lease.sessionId) !== controller) return;
        controller.fit();
        if (disposed || activeLeases.get(lease.sessionId) !== active
          || controller.sessionId !== lease.sessionId
          || terminalRegistry.get(lease.sessionId) !== controller) return;
      }
      const terminalConnected = useTerminalStore.getState().sessions.some(
        (session) => session.sessionId === lease.sessionId && session.status === 'connected',
      );
      try {
        await invokeAgentTerminalLeaseReady({
          sessionId: lease.sessionId,
          agentSessionId: lease.agentSessionId,
          operationId: lease.operationId,
          terminalConnected,
          outputListenerReady,
          hasPendingUserInput: controller?.hasPendingUserInput() ?? false,
          hasUnverifiedUserSubmission: controller?.hasUnverifiedUserSubmission() ?? false,
          hasCredentialPrompt: controller?.hasKnownCredentialPrompt() ?? false,
          reducedMotion: typeof window.matchMedia !== 'function'
            || window.matchMedia('(prefers-reduced-motion: reduce)').matches,
        });
      } catch (error) {
        logger.warn(`Failed to acknowledge Agent terminal lease ${lease.operationId}`, error);
      }
    },

    handleSession(event) {
      if (disposed) return;
      const manualResponse = (event.type === 'question/answered' || event.type === 'question/action_answered')
        && event.data.submission.action !== undefined;
      const manualStatus = event.type === 'agent/status'
        && (event.data.reason === 'waitingForUserAction' || event.data.reason === 'userActionSubmitted');
      if (manualResponse || manualStatus || event.type === 'turn/start' || event.type === 'turn/end'
        || event.type === 'session/ended' || event.type === 'session/resumed') {
        lastTurnEventSeq.set(event.sessionId, Math.max(event.seq, lastTurnEventSeq.get(event.sessionId) ?? -1));
      }
      const restoredManualResponse = manualResponse
        && !turnSurfaces.has(event.sessionId) && !pendingTurnBindings.has(event.sessionId);
      if ((event.type === 'turn/start' || restoredManualResponse) && event.turnId) {
        if (fencedTurns.has(event.sessionId)) {
          if (fencedTurns.get(event.sessionId) === event.turnId) return;
          fencedTurns.delete(event.sessionId);
        }
        const currentTurn = currentTurns.get(event.sessionId);
        const surface = turnSurfaces.get(event.sessionId);
        if (currentTurn && currentTurn !== event.turnId) clearTurn(event.sessionId);
        else if (surface && !surface.turnId) {
          turnSurfaces.set(event.sessionId, { ...surface, turnId: event.turnId });
        }
        currentTurns.set(event.sessionId, event.turnId);
        const turnId = event.turnId;
        const binding = invokeGetAgentRuntimeSession({ sessionId: event.sessionId }).then(async (snapshot) => {
          if (disposed || currentTurns.get(event.sessionId) !== turnId) return;
          if (snapshot.header.executionSurface !== 'boundTerminal') return;
          let workspace = rootWorkspace(event.sessionId);
          let parentId = snapshot.header.parentSessionId;
          const visited = new Set([event.sessionId]);
          while (!workspace && parentId && !visited.has(parentId)) {
            visited.add(parentId);
            workspace = workspaceOwners.get(parentId) ?? rootWorkspace(parentId);
            if (workspace) break;
            const parent = await invokeGetAgentRuntimeSession({ sessionId: parentId });
            if (disposed || currentTurns.get(event.sessionId) !== turnId) return;
            parentId = parent.header.parentSessionId;
          }
          const sessionId = snapshot.header.target?.sessionId;
          if (sessionId) bindTurnSurface({
            sessionId, agentSessionId: event.sessionId, taskId: snapshot.header.taskId,
            turnId, acquiredAtUnixMs: event.timeUnixMs,
          }, workspace);
        }).catch((error) => {
          logger.warn(`Failed to bind Agent turn terminal ${event.sessionId}`, error);
        });
        pendingTurnBindings.set(event.sessionId, binding);
        void binding.then(() => {
          if (pendingTurnBindings.get(event.sessionId) === binding) {
            pendingTurnBindings.delete(event.sessionId);
          }
        });
        return;
      }
      if (event.type === 'agent/status' && currentTurns.has(event.sessionId) && !fencedTurns.has(event.sessionId)) {
        if (event.data.reason === 'waitingForUserAction') updateManualInput(event.sessionId, true);
        else if (event.data.reason === 'userActionSubmitted' && waitingForUserAction.has(event.sessionId)) {
          updateManualInput(event.sessionId, false);
        }
      }
      if (event.type === 'turn/end') {
        const surface = turnSurfaces.get(event.sessionId);
        if (!surface || !surface.turnId || surface.turnId === event.turnId) {
          const pendingStop = pendingTurnStops.get(event.sessionId);
          clearTurn(event.sessionId);
          pendingStop?.focusTerminal();
        }
        if (!event.turnId || currentTurns.get(event.sessionId) === event.turnId) {
          currentTurns.delete(event.sessionId);
          fencedTurns.delete(event.sessionId);
        }
        return;
      }
      if (event.type === 'session/ended' || event.type === 'session/resumed') {
        clearTurn(event.sessionId);
        currentTurns.delete(event.sessionId);
        fencedTurns.delete(event.sessionId);
      }
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      for (const active of [...activeLeases.values()]) cleanup(active, false);
      activeLeases.clear();
      for (const agentSessionId of [...turnSurfaces.keys()]) clearTurn(agentSessionId);
      for (const retained of retainedInputs.values()) {
        retained.release();
        retained.removeLifecycle();
      }
      retainedInputs.clear();
      turnSurfaces.clear();
      suspendedTurnViews.clear();
      currentTurns.clear();
      lastTurnEventSeq.clear();
      waitingForUserAction.clear();
      pendingTurnBindings.clear();
      workspaceOwners.clear();
      fencedTurns.clear();
      for (const pending of pendingTurnStops.values()) clearTimeout(pending.timer);
      pendingTurnStops.clear();
    },
  };
}

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
  const terminalCursorBlink = useAppStore((s) => s.terminalCursorBlink);
  const terminalCursorStyle = useAppStore((s) => s.terminalCursorStyle);
  const terminalScrollback = useAppStore((s) => s.terminalScrollback);
  const terminalColorScheme = useAppStore((s) => s.terminalColorScheme);
  const terminalColorOverrides = useAppStore((s) => s.terminalColorOverrides);
  const terminalAutoReconnect = useAppStore((s) => s.terminalAutoReconnect);
  const terminalLineHeight = useAppStore((s) => s.terminalLineHeight);
  const terminalLetterSpacing = useAppStore((s) => s.terminalLetterSpacing);
  const terminalUrlDetection = useAppStore((s) => s.terminalUrlDetection);
  const terminalBellStyle = useAppStore((s) => s.terminalBellStyle);
  const knownRef = useRef<Set<string>>(new Set());
  const restoringControllers = useRef(new WeakSet<TerminalController>());

  useEffect(() => {
    terminalRegistry.updateOptions({
      fontSize: terminalFontSize,
      fontFamily: terminalFontFamily,
      customFontFamily: terminalCustomFontFamily,
      macOptionIsMeta: terminalMacOptionIsMeta,
      altClickMovesCursor: terminalAltClickMovesCursor,
      cursorBlink: terminalCursorBlink,
      cursorStyle: terminalCursorStyle,
      scrollback: terminalScrollback,
      colorScheme: terminalColorScheme,
      colorOverrides: terminalColorOverrides,
      autoReconnect: terminalAutoReconnect,
      lineHeight: terminalLineHeight,
      letterSpacing: terminalLetterSpacing,
      urlDetection: terminalUrlDetection,
      bellStyle: terminalBellStyle,
    });
  }, [terminalAltClickMovesCursor, terminalAutoReconnect, terminalBellStyle, terminalColorScheme, terminalColorOverrides, terminalCursorBlink, terminalCursorStyle, terminalCustomFontFamily, terminalFontFamily, terminalFontSize, terminalLetterSpacing, terminalLineHeight, terminalMacOptionIsMeta, terminalScrollback, terminalUrlDetection]);

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
      if (controller && session.restoreDisplay && session.terminalSessionId && session.terminalGeneration !== undefined
        && !restoringControllers.current.has(controller)) {
        restoringControllers.current.add(controller);
        controller.restoreDisplay({
          terminalSessionId: session.terminalSessionId,
          terminalGeneration: session.terminalGeneration,
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
