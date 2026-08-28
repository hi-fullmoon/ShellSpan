import { terminalRegistry } from '@/components/terminal/registry/terminal-registry';
import {
  AgentApprovalController,
  type AgentApprovalControllerDependencies,
} from '@/lib/agent-approval-controller';
import {
  validateFrozenAgentTarget,
} from '@/lib/agent-terminal-executor';
import {
  invokeCancelAgentRequest,
  invokeStartAgentRequest,
  invokeSubmitAgentToolResult,
  isTauriRuntime,
  listenToAgentStream,
} from '@/lib/tauri';
import { createLogger } from '@/lib/logger';
import { freezeAgentTarget } from '@/lib/agent-contract';
import { generateId } from '@/lib/utils';
import { useAgentPermissionStore } from '@/stores/agentPermissionStore';
import { agentToolKey, useAgentStore } from '@/stores/agentStore';
import { useTerminalStore, type TerminalSession } from '@/stores/terminalStore';
import type { AiMessageInput, AiProviderConfig } from '@/types/ai';
import type {
  AgentApprovalReference,
  AgentStartRequest,
  AgentStreamEvent,
  AgentTargetSnapshot,
  AgentToolApprovalSnapshot,
  AgentToolResult,
} from '@/types/agent';

const logger = createLogger('agentUi');

export interface StartAgentUiRunInput {
  readonly goal: string;
  readonly provider: AiProviderConfig;
  readonly target: AgentTargetSnapshot;
  readonly targetTitle: string;
  readonly messages: readonly AiMessageInput[];
}

export interface AgentUiControllerDependencies {
  readonly approvalController?: AgentApprovalController;
  readonly approvalDependencies?: Omit<AgentApprovalControllerDependencies, 'submitResult'>;
  readonly startRequest?: (request: AgentStartRequest) => Promise<void>;
  readonly cancelRequest?: (requestId: string) => Promise<void>;
  readonly submitResult?: (result: AgentToolResult) => Promise<void>;
  readonly listen?: (
    callback: (event: { payload: AgentStreamEvent }) => void,
  ) => Promise<() => void>;
  readonly validateTarget?: (target: AgentTargetSnapshot) => string | null;
  readonly createRequestId?: () => string;
  readonly subscribeToTerminalStore?: boolean;
  readonly subscribeToRegistry?: boolean;
  readonly runtimeAvailable?: () => boolean;
}

function sameTarget(left: AgentTargetSnapshot, right: AgentTargetSnapshot): boolean {
  return left.kind === right.kind
    && left.sessionId === right.sessionId
    && left.profileId === right.profileId
    && left.host === right.host
    && left.port === right.port
    && left.username === right.username;
}

function defaultValidateTarget(target: AgentTargetSnapshot): string | null {
  const session = useTerminalStore.getState().sessions.find(
    (candidate) => candidate.sessionId === target.sessionId,
  );
  return validateFrozenAgentTarget(target, session, terminalRegistry.get(target.sessionId));
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

function activeToolSnapshot(requestId: string): AgentToolApprovalSnapshot | undefined {
  const state = useAgentStore.getState();
  const run = state.runs[requestId];
  if (!run) return undefined;
  return [...run.toolCallIds].reverse()
    .map((callId) => state.tools[agentToolKey(requestId, callId)])
    .find((snapshot) => snapshot && [
      'pending',
      'awaitingApproval',
      'running',
    ].includes(snapshot.status));
}

/**
 * M4's app-lifetime product coordinator. It consumes M1's structured stream,
 * routes tool calls only through M3, and keeps M2 plus the backend request
 * cancellation in lockstep. It intentionally owns no persistence or audit
 * behavior; those remain M5 scope.
 */
export class AgentUiController {
  private readonly approvalController: AgentApprovalController;
  private readonly startBackend: (request: AgentStartRequest) => Promise<void>;
  private readonly cancelBackend: (requestId: string) => Promise<void>;
  private readonly submitBackendResult: (result: AgentToolResult) => Promise<void>;
  private readonly listenStream: NonNullable<AgentUiControllerDependencies['listen']>;
  private readonly validateTarget: (target: AgentTargetSnapshot) => string | null;
  private readonly createRequestId: () => string;
  private readonly runtimeAvailable: () => boolean;
  private readonly subscribeToTerminalStore: boolean;
  private readonly subscribeToRegistry: boolean;
  private readonly expiredToolCalls = new Set<string>();
  private readonly blockedRequests = new Set<string>();
  private readonly unsubscribeApproval: () => void;
  private unsubscribeTerminal?: () => void;
  private unsubscribeRegistry?: () => void;
  private unlistenStream?: () => void;
  private connecting?: Promise<void>;

  constructor(dependencies: AgentUiControllerDependencies = {}) {
    this.startBackend = dependencies.startRequest ?? invokeStartAgentRequest;
    this.cancelBackend = dependencies.cancelRequest ?? invokeCancelAgentRequest;
    this.submitBackendResult = dependencies.submitResult ?? invokeSubmitAgentToolResult;
    this.listenStream = dependencies.listen ?? listenToAgentStream;
    this.validateTarget = dependencies.validateTarget ?? defaultValidateTarget;
    this.createRequestId = dependencies.createRequestId ?? generateId;
    this.runtimeAvailable = dependencies.runtimeAvailable ?? isTauriRuntime;
    this.subscribeToTerminalStore = dependencies.subscribeToTerminalStore !== false;
    this.subscribeToRegistry = dependencies.subscribeToRegistry !== false;
    this.approvalController = dependencies.approvalController ?? new AgentApprovalController({
      ...dependencies.approvalDependencies,
      submitResult: (result) => this.submitToolResult(result),
      subscribeToTerminalStore: false,
    });
    this.unsubscribeApproval = this.approvalController.subscribe((snapshot) => {
      const key = agentToolKey(snapshot.toolCall.requestId, snapshot.toolCall.callId);
      if (this.expiredToolCalls.has(key) && [
        'completed',
        'rejected',
        'failed',
        'timedOut',
        'cancelled',
      ].includes(snapshot.status)) return;
      useAgentStore.getState().updateTool(snapshot);
    });
  }

  connect(): Promise<void> {
    if (!this.runtimeAvailable()) return Promise.resolve();
    this.ensureLifecycleSubscriptions();
    if (this.unlistenStream) return Promise.resolve();
    if (this.connecting) return this.connecting;
    this.connecting = this.listenStream((event) => this.handleStreamEvent(event.payload))
      .then((unlisten) => {
        this.unlistenStream = unlisten;
      })
      .finally(() => {
        this.connecting = undefined;
      });
    return this.connecting;
  }

  async start(input: StartAgentUiRunInput): Promise<string | undefined> {
    const goal = input.goal.trim();
    if (!goal || useAgentStore.getState().activeRequestId) return undefined;
    const target = freezeAgentTarget(input.target);
    const targetError = this.validateTarget(target);
    if (targetError) throw new Error(targetError);
    await this.connect();
    const requestId = this.createRequestId();
    const permissionMode = useAgentPermissionStore.getState().getMode(target.sessionId);
    useAgentStore.getState().beginRun({
      requestId,
      goal,
      providerId: input.provider.id,
      target,
      targetTitle: input.targetTitle,
      permissionMode,
    });
    try {
      await this.startBackend({
        request: {
          requestId,
          task: 'agent',
          target,
          permissionMode,
        },
        provider: input.provider,
        messages: [...input.messages],
      });
      return requestId;
    } catch (reason) {
      useAgentStore.getState().failRun(requestId, errorMessage(reason));
      return undefined;
    }
  }

  async retry(requestId: string, provider: AiProviderConfig): Promise<string | undefined> {
    const run = useAgentStore.getState().runs[requestId];
    if (
      !run
      || run.status === 'running'
      || run.status === 'completed'
      || provider.id !== run.providerId
      || this.validateTarget(run.target)
    ) return undefined;
    return this.start({
      goal: run.goal,
      provider,
      target: run.target,
      targetTitle: run.targetTitle,
      messages: [{ role: 'user', content: run.goal }],
    });
  }

  canRetry(requestId: string): boolean {
    const run = useAgentStore.getState().runs[requestId];
    return Boolean(
      run
      && run.status !== 'running'
      && run.status !== 'completed'
      && !this.validateTarget(run.target),
    );
  }

  approve(reference: AgentApprovalReference): boolean {
    return this.approvalController.approve(reference);
  }

  reject(reference: AgentApprovalReference): boolean {
    const rejected = this.approvalController.reject(reference);
    if (!rejected) return false;
    this.blockedRequests.add(reference.requestId);
    useAgentStore.getState().endIncomplete(reference.requestId);
    void this.cancelBackend(reference.requestId).catch((reason) => {
      logger.warn(`Failed to cancel rejected Agent request ${reference.requestId}`, reason);
    });
    return true;
  }

  stop(requestId: string): boolean {
    const run = useAgentStore.getState().runs[requestId];
    if (!run || run.status !== 'running') return false;
    useAgentStore.getState().requestStop(requestId);
    const activeTool = activeToolSnapshot(requestId);
    if (activeTool) {
      this.approvalController.cancel(requestId, activeTool.toolCall.callId);
    }
    useAgentStore.getState().cancelRun(requestId);
    void this.cancelBackend(requestId).catch((reason) => {
      logger.warn(`Failed to cancel Agent request ${requestId}`, reason);
    });
    return true;
  }

  handleStreamEvent(event: AgentStreamEvent): void {
    const state = useAgentStore.getState();
    const run = state.runs[event.requestId];
    if (!run || this.blockedRequests.has(event.requestId)) return;

    switch (event.type) {
      case 'started':
        if (!sameTarget(run.target, event.target)) {
          this.blockForTargetMismatch(event.requestId, 'Agent stream target does not match the frozen task target.');
          return;
        }
        state.markStarted(event.requestId, event.maxToolSteps, event.toolResultTimeoutMs);
        return;
      case 'capabilityDetected':
        if (event.capability.support === 'supported') state.setPhase(event.requestId, 'preparingCommand');
        return;
      case 'safeFallback':
        state.markFallback(event.requestId, event.fallback);
        return;
      case 'textDelta':
        state.appendText(event.requestId, event.text);
        if (useAgentStore.getState().runs[event.requestId]?.toolCallIds.length) {
          state.setPhase(event.requestId, 'verifying');
        }
        return;
      case 'toolCall': {
        if (
          event.toolCall.requestId !== event.requestId
          || !sameTarget(run.target, event.toolCall.target)
        ) {
          this.blockForTargetMismatch(event.requestId, 'Agent tool call target does not match the frozen task target.');
          return;
        }
        const targetError = this.validateTarget(run.target);
        if (targetError) {
          this.blockForTargetMismatch(event.requestId, targetError);
          return;
        }
        const snapshot = this.approvalController.registerToolCall(event.toolCall);
        state.registerTool(snapshot);
        return;
      }
      case 'toolResultAccepted':
        state.setPhase(event.requestId, 'verifying');
        return;
      case 'toolResultTimedOut': {
        const key = agentToolKey(event.requestId, event.callId);
        this.expiredToolCalls.add(key);
        this.approvalController.cancel(event.requestId, event.callId);
        const snapshot = useAgentStore.getState().tools[key];
        if (snapshot) {
          state.updateTool({
            ...snapshot,
            status: 'timedOut',
            result: {
              requestId: event.requestId,
              callId: event.callId,
              status: 'timedOut',
              output: '',
            },
          });
        }
        return;
      }
      case 'stepLimitReached':
        state.markStepLimit(event.requestId);
        return;
      case 'completed':
        state.completeRun(event.requestId, event.fallback);
        return;
      case 'cancelled':
        state.cancelRun(event.requestId);
        return;
      case 'error':
        state.failRun(event.requestId, event.message);
    }
  }

  dispose(): void {
    this.unlistenStream?.();
    this.unlistenStream = undefined;
    this.unsubscribeApproval();
    this.unsubscribeTerminal?.();
    this.unsubscribeTerminal = undefined;
    this.unsubscribeRegistry?.();
    this.unsubscribeRegistry = undefined;
    this.approvalController.dispose();
  }

  private async submitToolResult(result: AgentToolResult): Promise<void> {
    const key = agentToolKey(result.requestId, result.callId);
    try {
      await this.submitBackendResult(result);
    } catch (reason) {
      if (this.expiredToolCalls.delete(key)) return;
      const message = `Failed to submit terminal result: ${errorMessage(reason)}`;
      this.blockedRequests.add(result.requestId);
      useAgentStore.getState().failRun(result.requestId, message);
      void this.cancelBackend(result.requestId).catch(() => undefined);
      throw reason;
    }
    this.expiredToolCalls.delete(key);
  }

  private ensureLifecycleSubscriptions(): void {
    if (this.subscribeToTerminalStore && !this.unsubscribeTerminal) {
      this.unsubscribeTerminal = useTerminalStore.subscribe(() => {
        this.revalidateActiveTarget();
      });
    }
    if (this.subscribeToRegistry && !this.unsubscribeRegistry) {
      this.unsubscribeRegistry = terminalRegistry.subscribe(() => {
        this.revalidateActiveTarget();
      });
    }
  }

  private revalidateActiveTarget(): void {
    const requestId = useAgentStore.getState().activeRequestId;
    if (!requestId || this.blockedRequests.has(requestId)) return;
    const run = useAgentStore.getState().runs[requestId];
    if (!run) return;
    const targetError = this.validateTarget(run.target);
    if (targetError) this.blockForTargetMismatch(requestId, targetError);
  }

  private blockForTargetMismatch(requestId: string, message: string): void {
    if (this.blockedRequests.has(requestId)) return;
    this.blockedRequests.add(requestId);
    const activeTool = activeToolSnapshot(requestId);
    if (activeTool) {
      this.approvalController.cancel(requestId, activeTool.toolCall.callId);
    }
    useAgentStore.getState().failRun(requestId, message);
    void this.cancelBackend(requestId).catch((reason) => {
      logger.warn(`Failed to cancel invalid Agent target ${requestId}`, reason);
    });
  }
}

export function agentTargetFromSession(session: TerminalSession): AgentTargetSnapshot {
  return {
    kind: session.host === 'local' && session.port === 0 ? 'local' : 'remote',
    sessionId: session.sessionId,
    ...(session.profileId ? { profileId: session.profileId } : {}),
    host: session.host,
    port: session.port,
    username: session.username,
  };
}

export const agentUiController = new AgentUiController();
