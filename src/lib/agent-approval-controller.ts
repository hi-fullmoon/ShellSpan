import { terminalRegistry } from '@/components/terminal/registry/terminal-registry';
import { classifyAgentCommandRisk } from '@/lib/agent-command-risk';
import { classifyAgentRisk, evaluateAgentPermission } from '@/lib/agent-contract';
import {
  agentTerminalExecutor,
  validateFrozenAgentTarget,
  type AgentTerminalExecutionAuthorization,
  type AuthorizedAgentTerminalExecution,
} from '@/lib/agent-terminal-executor';
import { invokeSubmitAgentToolResult } from '@/lib/tauri';
import { generateId } from '@/lib/utils';
import { useAgentPermissionStore } from '@/stores/agentPermissionStore';
import { useTerminalStore } from '@/stores/terminalStore';
import type {
  AgentApprovalReference,
  AgentPermissionMode,
  AgentTargetSnapshot,
  AgentToolApprovalSnapshot,
  AgentToolApprovalStatus,
  AgentToolCall,
  AgentToolResult,
} from '@/types/agent';

type AgentApprovalListener = (snapshot: AgentToolApprovalSnapshot) => void;

interface ApprovalRecord {
  readonly toolCall: AgentToolCall;
  readonly permissionMode: AgentPermissionMode;
  readonly riskAssessment: AgentToolApprovalSnapshot['riskAssessment'];
  readonly decision: AgentToolApprovalSnapshot['decision'];
  readonly approval?: AgentApprovalReference;
  released: boolean;
  status: AgentToolApprovalStatus;
  result?: AgentToolResult;
  resolveResult: (result: AgentToolResult) => void;
  readonly resultPromise: Promise<AgentToolResult>;
}

export interface AgentApprovalControllerDependencies {
  readonly getPermissionMode?: (sessionId: string) => AgentPermissionMode;
  readonly validateTarget?: (target: AgentTargetSnapshot) => string | null;
  readonly execute?: (input: AuthorizedAgentTerminalExecution) => Promise<AgentToolResult>;
  readonly cancelExecution?: (requestId: string, callId: string) => boolean;
  readonly submitResult?: (result: AgentToolResult) => Promise<void> | void;
  readonly createApprovalId?: () => string;
  readonly subscribeToTerminalStore?: boolean;
}

function approvalKey(requestId: string, callId: string): string {
  return `${requestId}\u0000${callId}`;
}

function frozenToolCall(call: AgentToolCall): AgentToolCall {
  return Object.freeze({
    requestId: call.requestId,
    callId: call.callId,
    name: call.name,
    command: call.command,
    explanation: call.explanation,
    target: Object.freeze({ ...call.target }),
  });
}

function defaultValidateTarget(target: AgentTargetSnapshot): string | null {
  const session = useTerminalStore.getState().sessions.find(
    (candidate) => candidate.sessionId === target.sessionId,
  );
  return validateFrozenAgentTarget(target, session, terminalRegistry.get(target.sessionId));
}

function frozenResult(result: AgentToolResult): AgentToolResult {
  return Object.freeze({ ...result });
}

/**
 * The sole M3 policy transition from a structured toolCall event to M2 PTY
 * authorization. UI actions carry an opaque approval id and can only advance
 * the exact frozen call currently in awaitingApproval. All automatic paths
 * and user approvals revalidate the frozen connection identity before the
 * state becomes running; M2 validates it again immediately before writing.
 */
export class AgentApprovalController {
  private readonly records = new Map<string, ApprovalRecord>();
  private readonly listeners = new Set<AgentApprovalListener>();
  private readonly getPermissionMode: (sessionId: string) => AgentPermissionMode;
  private readonly validateTarget: (target: AgentTargetSnapshot) => string | null;
  private readonly executeTerminal: (input: AuthorizedAgentTerminalExecution) => Promise<AgentToolResult>;
  private readonly cancelTerminalExecution: (requestId: string, callId: string) => boolean;
  private readonly submitTerminalResult: (result: AgentToolResult) => Promise<void> | void;
  private readonly createApprovalId: () => string;
  private readonly unsubscribeTerminalStore?: () => void;

  constructor(dependencies: AgentApprovalControllerDependencies = {}) {
    this.getPermissionMode = dependencies.getPermissionMode
      ?? ((sessionId) => useAgentPermissionStore.getState().getMode(sessionId));
    this.validateTarget = dependencies.validateTarget ?? defaultValidateTarget;
    this.executeTerminal = dependencies.execute
      ?? ((input) => agentTerminalExecutor.execute(input));
    this.cancelTerminalExecution = dependencies.cancelExecution
      ?? ((requestId, callId) => agentTerminalExecutor.cancel(requestId, callId));
    this.submitTerminalResult = dependencies.submitResult ?? invokeSubmitAgentToolResult;
    this.createApprovalId = dependencies.createApprovalId ?? generateId;
    if (dependencies.subscribeToTerminalStore !== false) {
      this.unsubscribeTerminalStore = useTerminalStore.subscribe(() => {
        this.revalidateActiveTargets();
      });
    }
  }

  registerToolCall(call: AgentToolCall): AgentToolApprovalSnapshot {
    const key = approvalKey(call.requestId, call.callId);
    const existing = this.records.get(key);
    if (existing) return this.snapshot(existing);

    const toolCall = frozenToolCall(call);
    const permissionMode = this.getPermissionMode(toolCall.target.sessionId);
    const riskAssessment = Object.freeze(classifyAgentCommandRisk(toolCall.command));
    const decision = Object.freeze(evaluateAgentPermission(
      permissionMode,
      classifyAgentRisk(riskAssessment.risk),
    ));
    let resolveResult!: (result: AgentToolResult) => void;
    const resultPromise = new Promise<AgentToolResult>((resolve) => {
      resolveResult = resolve;
    });
    const approval = decision.requiresApproval
      ? Object.freeze({
          requestId: toolCall.requestId,
          callId: toolCall.callId,
          approvalId: this.createApprovalId(),
        })
      : undefined;
    const record: ApprovalRecord = {
      toolCall,
      permissionMode,
      riskAssessment,
      decision,
      ...(approval ? { approval } : {}),
      released: false,
      status: decision.requiresApproval ? 'awaitingApproval' : 'pending',
      resolveResult,
      resultPromise,
    };
    this.records.set(key, record);

    if (decision.requiresApproval) {
      this.emit(record);
    } else {
      this.startExecution(record, 'explicitUpstreamAuthorization');
    }
    return this.snapshot(record);
  }

  approve(reference: AgentApprovalReference): boolean {
    const record = this.records.get(approvalKey(reference.requestId, reference.callId));
    if (
      !record
      || record.status !== 'awaitingApproval'
      || !record.approval
      || record.approval.approvalId !== reference.approvalId
    ) return false;
    this.startExecution(record, 'explicitUserAction');
    return true;
  }

  reject(reference: AgentApprovalReference): boolean {
    const record = this.records.get(approvalKey(reference.requestId, reference.callId));
    if (
      !record
      || record.status !== 'awaitingApproval'
      || !record.approval
      || record.approval.approvalId !== reference.approvalId
    ) return false;
    this.commitResult(record, {
      requestId: record.toolCall.requestId,
      callId: record.toolCall.callId,
      status: 'rejected',
      output: '',
    });
    return true;
  }

  cancel(requestId: string, callId: string): boolean {
    const record = this.records.get(approvalKey(requestId, callId));
    if (!record || record.result) return false;
    if (record.status === 'awaitingApproval' || record.status === 'pending') {
      this.commitResult(record, {
        requestId,
        callId,
        status: 'cancelled',
        output: '',
      });
      return true;
    }
    return record.status === 'running'
      ? this.cancelTerminalExecution(requestId, callId)
      : false;
  }

  getSnapshot(requestId: string, callId: string): AgentToolApprovalSnapshot | undefined {
    const record = this.records.get(approvalKey(requestId, callId));
    return record ? this.snapshot(record) : undefined;
  }

  waitForResult(requestId: string, callId: string): Promise<AgentToolResult> | undefined {
    return this.records.get(approvalKey(requestId, callId))?.resultPromise;
  }

  releaseRequest(requestId: string): void {
    for (const [key, record] of this.records) {
      if (record.toolCall.requestId !== requestId) continue;
      record.released = true;
      this.records.delete(key);
    }
  }

  subscribe(listener: AgentApprovalListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    this.unsubscribeTerminalStore?.();
    this.listeners.clear();
    for (const record of this.records.values()) record.released = true;
    this.records.clear();
  }

  private startExecution(
    record: ApprovalRecord,
    source: AgentTerminalExecutionAuthorization['source'],
  ): void {
    if (record.status !== 'pending' && record.status !== 'awaitingApproval') return;
    const targetError = this.validateTarget(record.toolCall.target);
    if (targetError) {
      this.commitResult(record, {
        requestId: record.toolCall.requestId,
        callId: record.toolCall.callId,
        status: 'failed',
        output: targetError,
      });
      return;
    }

    record.status = 'running';
    this.emit(record);
    const authorization: AgentTerminalExecutionAuthorization = Object.freeze({
      decision: 'authorized',
      source,
      requestId: record.toolCall.requestId,
      callId: record.toolCall.callId,
      sessionId: record.toolCall.target.sessionId,
    });
    void this.executeTerminal({
      toolCall: record.toolCall,
      authorization,
    }).then((result) => {
      this.commitResult(record, result);
    }, () => {
      this.commitResult(record, {
        requestId: record.toolCall.requestId,
        callId: record.toolCall.callId,
        status: 'failed',
        output: 'Terminal execution failed.',
      });
    });
  }

  private commitResult(record: ApprovalRecord, result: AgentToolResult): void {
    if (record.result) return;
    if (
      result.requestId !== record.toolCall.requestId
      || result.callId !== record.toolCall.callId
    ) {
      result = {
        requestId: record.toolCall.requestId,
        callId: record.toolCall.callId,
        status: 'failed',
        output: 'Terminal result identity does not match the frozen tool call.',
      };
    }
    const ownedResult = frozenResult(result);
    record.result = ownedResult;
    record.status = ownedResult.status;
    if (!record.released) this.emit(record);
    record.resolveResult(ownedResult);
    if (record.released) return;
    // Marking the terminal state above makes this callback exactly-once even
    // when UI events, lifecycle events, and executor completion race.
    void Promise.resolve(this.submitTerminalResult(ownedResult)).catch(() => undefined);
  }

  private revalidateActiveTargets(): void {
    for (const record of this.records.values()) {
      if (record.result) continue;
      const targetError = this.validateTarget(record.toolCall.target);
      if (!targetError) continue;
      if (record.status === 'running') {
        this.cancelTerminalExecution(record.toolCall.requestId, record.toolCall.callId);
      } else if (record.status === 'pending' || record.status === 'awaitingApproval') {
        this.commitResult(record, {
          requestId: record.toolCall.requestId,
          callId: record.toolCall.callId,
          status: 'failed',
          output: targetError,
        });
      }
    }
  }

  private snapshot(record: ApprovalRecord): AgentToolApprovalSnapshot {
    return Object.freeze({
      toolCall: record.toolCall,
      permissionMode: record.permissionMode,
      riskAssessment: record.riskAssessment,
      decision: record.decision,
      status: record.status,
      ...(record.approval ? { approval: record.approval } : {}),
      ...(record.result ? { result: record.result } : {}),
    });
  }

  private emit(record: ApprovalRecord): void {
    const snapshot = this.snapshot(record);
    for (const listener of this.listeners) listener(snapshot);
  }
}
