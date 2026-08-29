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
import { redactSensitiveValue } from '@/lib/terminal-output-buffer';
import { agentOperationAuditor } from '@/lib/agent-operation-audit';
import { agentRolloutAuditor } from '@/lib/agent-rollout-audit';
import { registerAgentLifecycleHandlers } from '@/lib/agent-lifecycle';
import { useAgentPermissionStore } from '@/stores/agentPermissionStore';
import { useAiSettingsStore } from '@/stores/aiSettingsStore';
import { agentToolKey, useAgentStore } from '@/stores/agentStore';
import { useTerminalStore, type TerminalSession } from '@/stores/terminalStore';
import type { AiMessageInput, AiProviderConfig } from '@/types/ai';
import type {
  AgentApprovalReference,
  AgentStartRequest,
  AgentRolloutStage,
  AgentStreamEvent,
  AgentTargetSnapshot,
  AgentToolApprovalSnapshot,
  AgentToolResult,
} from '@/types/agent';

const logger = createLogger('agentUi');

export interface StartAgentUiRunInput {
  readonly goal: string;
  readonly conversationId?: string;
  readonly conversationStartedAt?: string;
  readonly provider: AiProviderConfig;
  readonly target: AgentTargetSnapshot;
  readonly targetTitle: string;
  readonly messages: readonly AiMessageInput[];
  readonly rolloutStage?: AgentRolloutStage;
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
 * App-lifetime product coordinator. It consumes the structured Agent stream,
 * routes tool calls through the approval/execution boundary, and keeps UI,
 * backend cancellation, persistence subscribers, and operation audit aligned.
 */
export class AgentUiController {
  private readonly approvalController: AgentApprovalController;
  private readonly startBackend: NonNullable<AgentUiControllerDependencies['startRequest']>;
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
  private readonly cancellationIntents = new Set<string>();
  private readonly startingRequests = new Set<string>();
  private readonly lifecyclePromises = new Set<Promise<unknown>>();
  private readonly releaseTimers = new Map<string, ReturnType<typeof setTimeout>>();
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
      agentOperationAuditor.recordSnapshot(snapshot);
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
    if (
      !goal
      || !useAiSettingsStore.getState().agentEnabled
      || useAgentStore.getState().activeRequestId
    ) return undefined;
    const target = freezeAgentTarget(input.target);
    const targetError = this.validateTarget(target);
    if (targetError) throw new Error(targetError);
    await this.connect();
    const requestId = this.createRequestId();
    const permissionMode = useAgentPermissionStore.getState().getMode(target.sessionId);
    useAgentStore.getState().beginRun({
      requestId,
      conversationId: input.conversationId,
      conversationStartedAt: input.conversationStartedAt,
      goal,
      providerId: input.provider.id,
      target,
      targetTitle: input.targetTitle,
      permissionMode,
      rolloutStage: input.rolloutStage,
    });
    this.startingRequests.add(requestId);
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
      if (this.cancellationIntents.has(requestId)) {
        await this.cancelBackend(requestId).catch(() => undefined);
      }
      return requestId;
    } catch (reason) {
      useAgentStore.getState().failRun(requestId, errorMessage(reason));
      agentRolloutAuditor.recordRunOutcome(
        useAgentStore.getState().runs[requestId],
        'provider',
      );
      this.releaseTerminalRequest(requestId);
      return undefined;
    } finally {
      this.startingRequests.delete(requestId);
      if (useAgentStore.getState().runs[requestId]?.status !== 'running') {
        this.cancellationIntents.delete(requestId);
      }
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
      conversationId: run.conversationId,
      conversationStartedAt: run.conversationStartedAt,
      provider,
      target: run.target,
      targetTitle: run.targetTitle,
      messages: [{ role: 'user', content: run.goal }],
      rolloutStage: run.rolloutStage,
    });
  }

  canRetry(requestId: string): boolean {
    const run = useAgentStore.getState().runs[requestId];
    return Boolean(
      run
      && useAiSettingsStore.getState().agentEnabled
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
    this.cancellationIntents.add(reference.requestId);
    useAgentStore.getState().endIncomplete(reference.requestId);
    agentRolloutAuditor.recordRunOutcome(
      useAgentStore.getState().runs[reference.requestId],
      'approvalRejected',
    );
    this.releaseTerminalRequest(reference.requestId);
    this.trackLifecycle(this.cancelBackend(reference.requestId).catch((reason) => {
      logger.warn(`Failed to cancel rejected Agent request ${reference.requestId}`, reason);
    }));
    return true;
  }

  stop(requestId: string): boolean {
    const run = useAgentStore.getState().runs[requestId];
    if (!run || run.status !== 'running') return false;
    useAgentStore.getState().requestStop(requestId);
    this.cancellationIntents.add(requestId);
    const activeTool = activeToolSnapshot(requestId);
    if (activeTool) {
      agentOperationAuditor.recordCancelRequested(activeTool);
      this.approvalController.cancel(requestId, activeTool.toolCall.callId);
    }
    useAgentStore.getState().cancelRun(requestId);
    agentRolloutAuditor.recordRunOutcome(useAgentStore.getState().runs[requestId], 'cancelled');
    this.releaseTerminalRequest(requestId);
    this.trackLifecycle(this.cancelBackend(requestId).catch((reason) => {
      logger.warn(`Failed to cancel Agent request ${requestId}`, reason);
    }));
    return true;
  }

  async cancelForSession(sessionId: string): Promise<void> {
    const requestIds = Object.values(useAgentStore.getState().runs)
      .filter((run) => run.target.sessionId === sessionId && run.status === 'running')
      .map((run) => run.requestId);
    await Promise.allSettled(requestIds.map((requestId) => this.cancelAndWait(requestId)));
    await agentOperationAuditor.flush();
    await agentRolloutAuditor.flush();
  }

  async shutdown(): Promise<void> {
    const requestIds = Object.values(useAgentStore.getState().runs)
      .filter((run) => run.status === 'running')
      .map((run) => run.requestId);
    await Promise.allSettled(requestIds.map((requestId) => this.cancelAndWait(requestId)));
    while (this.lifecyclePromises.size > 0) {
      await Promise.allSettled([...this.lifecyclePromises]);
    }
    await agentOperationAuditor.flush();
    await agentRolloutAuditor.flush();
  }

  handleStreamEvent(event: AgentStreamEvent): void {
    const state = useAgentStore.getState();
    const run = state.runs[event.requestId];
    // Once the user stops a task, or any terminal run state has won, every
    // later provider/UI event is stale. In particular, a delayed toolCall
    // must never enter the approval controller because fullAccess would turn
    // registration into immediate PTY authorization before the store has a
    // chance to reject the stale snapshot.
    if (
      !run
      || run.status !== 'running'
      || this.blockedRequests.has(event.requestId)
      || this.cancellationIntents.has(event.requestId)
    ) return;

    switch (event.type) {
      case 'started':
        if (!sameTarget(run.target, event.target)) {
          this.blockForTargetMismatch(event.requestId, 'Agent stream target does not match the frozen task target.');
          return;
        }
        state.markStarted(event.requestId, event.maxToolSteps, event.toolResultTimeoutMs);
        return;
      case 'capabilityDetected':
        agentRolloutAuditor.recordCompatibility(
          {
            stage: run.rolloutStage,
            collectLocalDiagnostics: run.rolloutStage === 'preview',
          },
          event.capability.source === 'openAiResponses'
            ? 'openAi'
            : event.capability.source === 'ollamaModelMetadata'
              ? 'ollama'
              : 'openAiCompatible',
          event.capability,
          run.target,
        );
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
        const activeTool = activeToolSnapshot(event.requestId);
        if (
          activeTool
          && activeTool.toolCall.callId !== event.toolCall.callId
        ) {
          this.blockRequest(
            event.requestId,
            'Agent provider emitted an overlapping terminal tool call.',
          );
          return;
        }
        const snapshot = this.approvalController.registerToolCall(event.toolCall);
        state.registerTool(snapshot);
        agentOperationAuditor.recordSnapshot(snapshot);
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
          const timedOut: AgentToolApprovalSnapshot = {
            ...snapshot,
            status: 'timedOut',
            result: {
              requestId: event.requestId,
              callId: event.callId,
              status: 'timedOut',
              output: '',
            },
          };
          state.updateTool(timedOut);
          agentOperationAuditor.recordSnapshot(timedOut);
        }
        return;
      }
      case 'stepLimitReached':
        state.markStepLimit(event.requestId);
        return;
      case 'completed':
        state.completeRun(event.requestId, event.fallback);
        agentRolloutAuditor.recordRunOutcome(useAgentStore.getState().runs[event.requestId]);
        this.releaseTerminalRequest(event.requestId);
        return;
      case 'cancelled': {
        const activeTool = activeToolSnapshot(event.requestId);
        if (activeTool) this.approvalController.cancel(event.requestId, activeTool.toolCall.callId);
        state.cancelRun(event.requestId);
        agentRolloutAuditor.recordRunOutcome(
          useAgentStore.getState().runs[event.requestId],
          'cancelled',
        );
        this.releaseTerminalRequest(event.requestId);
        return;
      }
      case 'error': {
        const activeTool = activeToolSnapshot(event.requestId);
        if (activeTool) this.approvalController.cancel(event.requestId, activeTool.toolCall.callId);
        state.failRun(event.requestId, event.message);
        agentRolloutAuditor.recordRunOutcome(
          useAgentStore.getState().runs[event.requestId],
          'provider',
        );
        this.releaseTerminalRequest(event.requestId);
        return;
      }
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
    this.expiredToolCalls.clear();
    this.blockedRequests.clear();
    this.cancellationIntents.clear();
    this.startingRequests.clear();
    for (const timer of this.releaseTimers.values()) clearTimeout(timer);
    this.releaseTimers.clear();
  }

  private async submitToolResult(result: AgentToolResult): Promise<void> {
    const safeResult = redactSensitiveValue(result);
    const key = agentToolKey(safeResult.requestId, safeResult.callId);
    try {
      await this.submitBackendResult(safeResult);
    } catch (reason) {
      if (this.expiredToolCalls.delete(key)) return;
      const message = `Failed to submit terminal result: ${errorMessage(reason)}`;
      this.blockedRequests.add(result.requestId);
      useAgentStore.getState().failRun(safeResult.requestId, message);
      agentRolloutAuditor.recordRunOutcome(
        useAgentStore.getState().runs[safeResult.requestId],
        'provider',
      );
      this.releaseTerminalRequest(safeResult.requestId);
      void this.cancelBackend(safeResult.requestId).catch(() => undefined);
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
    this.blockRequest(requestId, message);
  }

  private blockRequest(requestId: string, message: string): void {
    if (this.blockedRequests.has(requestId)) return;
    this.blockedRequests.add(requestId);
    this.cancellationIntents.add(requestId);
    const activeTool = activeToolSnapshot(requestId);
    if (activeTool) {
      agentOperationAuditor.recordCancelRequested(activeTool);
      this.approvalController.cancel(requestId, activeTool.toolCall.callId);
    }
    useAgentStore.getState().failRun(requestId, message);
    agentRolloutAuditor.recordRunOutcome(
      useAgentStore.getState().runs[requestId],
      'targetChanged',
    );
    this.releaseTerminalRequest(requestId);
    this.trackLifecycle(this.cancelBackend(requestId).catch((reason) => {
      logger.warn(`Failed to cancel invalid Agent target ${requestId}`, reason);
    }));
  }

  private trackLifecycle<T>(promise: Promise<T>): Promise<T> {
    this.lifecyclePromises.add(promise);
    const cleanup = (): void => {
      this.lifecyclePromises.delete(promise);
    };
    void promise.then(cleanup, cleanup);
    return promise;
  }

  private releaseTerminalRequest(requestId: string): void {
    const activeTool = activeToolSnapshot(requestId);
    const pendingResult = activeTool
      ? this.approvalController.waitForResult(requestId, activeTool.toolCall.callId)
      : undefined;
    const release = (): void => {
      const timer = this.releaseTimers.get(requestId);
      if (timer) clearTimeout(timer);
      this.releaseTimers.delete(requestId);
      this.approvalController.releaseRequest(requestId);
      agentOperationAuditor.releaseRequest(requestId);
      this.blockedRequests.delete(requestId);
      if (!this.startingRequests.has(requestId)) this.cancellationIntents.delete(requestId);
      const prefix = `${requestId}\u0000`;
      for (const key of this.expiredToolCalls) {
        if (key.startsWith(prefix)) this.expiredToolCalls.delete(key);
      }
    };
    if (!pendingResult) {
      release();
      return;
    }
    const existingTimer = this.releaseTimers.get(requestId);
    if (existingTimer) clearTimeout(existingTimer);
    this.releaseTimers.set(requestId, setTimeout(release, 5_000));
    void pendingResult.then(release, release);
  }

  private async cancelAndWait(requestId: string): Promise<void> {
    const run = useAgentStore.getState().runs[requestId];
    if (!run || run.status !== 'running') return;
    const activeTool = activeToolSnapshot(requestId);
    const resultPromise = activeTool
      ? this.approvalController.waitForResult(requestId, activeTool.toolCall.callId)
      : undefined;
    this.stop(requestId);
    if (resultPromise) {
      await Promise.race([
        resultPromise.then(() => undefined),
        new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
      ]);
    }
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

registerAgentLifecycleHandlers({
  cancelForSession: (sessionId) => agentUiController.cancelForSession(sessionId),
  shutdown: () => agentUiController.shutdown(),
});
