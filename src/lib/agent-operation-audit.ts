import {
  listOperationHistory,
  recordOperationHistoryEvent,
} from '@/lib/operation-history';
import { createOperationId } from '@/lib/operation-id';
import { registerAgentRecoveryAuditHandler } from '@/lib/agent-recovery-audit';
import { redactTerminalSecrets } from '@/lib/terminal-output-buffer';
import type {
  AgentToolApprovalSnapshot,
  AgentToolApprovalStatus,
} from '@/types/agent';
import type {
  OperationHistoryErrorCategory,
  OperationHistoryEventKind,
  OperationHistoryPage,
  OperationHistoryStatus,
  RecordOperationEventRequest,
} from '@/types/operation-history';

type AuditWriter = (request: RecordOperationEventRequest) => Promise<void>;

function keyFor(snapshot: AgentToolApprovalSnapshot): string {
  return snapshot.toolCall.requestId + '\u0000' + snapshot.toolCall.callId;
}

function targetFor(snapshot: AgentToolApprovalSnapshot) {
  return {
    kind: snapshot.toolCall.target.kind,
    profileId: snapshot.toolCall.target.profileId,
    host: snapshot.toolCall.target.host,
    port: snapshot.toolCall.target.port,
    username: snapshot.toolCall.target.username,
    sessionId: snapshot.toolCall.target.sessionId,
  } as const;
}

function failureFor(snapshot: AgentToolApprovalSnapshot): {
  status: OperationHistoryStatus;
  errorCategory?: OperationHistoryErrorCategory;
} {
  if (snapshot.status === 'timedOut') {
    return { status: 'timedOut', errorCategory: 'timeout' };
  }
  if (snapshot.status === 'cancelled') {
    return { status: 'cancelled', errorCategory: 'cancelled' };
  }
  // Terminal output is untrusted data and must not be able to forge audit
  // categories. Structural executor failures have no process exit code and
  // use exact locally generated messages; command output with a real exit
  // code therefore always remains an ordinary execution failure.
  const output = snapshot.result?.output ?? '';
  if (
    snapshot.result?.exitCode === undefined
    && output === 'Terminal result identity does not match the frozen tool call.'
  ) {
    return { status: 'identityMismatch', errorCategory: 'identityMismatch' };
  }
  if (
    snapshot.result?.exitCode === undefined
    && [
      'Frozen terminal target identity no longer matches the live session',
      'Frozen terminal controller changed before execution.',
      'Frozen connection instance is no longer valid.',
    ].includes(output)
  ) {
    return { status: 'failed', errorCategory: 'targetChanged' };
  }
  return { status: 'failed', errorCategory: 'unknown' };
}

export class AgentOperationAuditor {
  private readonly writer: AuditWriter;
  private readonly statuses = new Map<string, AgentToolApprovalStatus>();
  private readonly queues = new Map<string, Promise<void>>();
  private readonly humanApproved = new Set<string>();

  constructor(writer: AuditWriter = recordOperationHistoryEvent) {
    this.writer = writer;
  }

  recordSnapshot(snapshot: AgentToolApprovalSnapshot): void {
    const key = keyFor(snapshot);
    const previous = this.statuses.get(key);
    if (previous === snapshot.status) return;
    if (!previous) {
      this.enqueue(snapshot, 'started', 'pending', false);
    }
    this.statuses.set(key, snapshot.status);

    switch (snapshot.status) {
      case 'pending':
      case 'awaitingApproval':
        this.enqueue(snapshot, 'statusChanged', 'pending', false);
        break;
      case 'running': {
        const approved = snapshot.decision.requiresApproval;
        if (approved && !this.humanApproved.has(key)) {
          this.humanApproved.add(key);
          this.enqueue(snapshot, 'approved', 'running', true);
        }
        this.enqueue(snapshot, 'statusChanged', 'running', approved);
        break;
      }
      case 'rejected':
        this.enqueue(snapshot, 'rejected', 'rejected', false);
        break;
      case 'completed':
        if (snapshot.result?.exitCode !== undefined && snapshot.result.exitCode !== 0) {
          this.enqueue(snapshot, 'failed', 'failed', this.humanApproved.has(key), 'unknown');
        } else {
          this.enqueue(snapshot, 'completed', 'succeeded', this.humanApproved.has(key));
        }
        break;
      case 'failed':
      case 'timedOut': {
        const failure = failureFor(snapshot);
        this.enqueue(
          snapshot,
          'failed',
          failure.status,
          this.humanApproved.has(key),
          failure.errorCategory,
        );
        break;
      }
      case 'cancelled': {
        const failure = failureFor(snapshot);
        this.enqueue(
          snapshot,
          'statusChanged',
          failure.status,
          this.humanApproved.has(key),
          failure.errorCategory,
        );
        break;
      }
    }
  }

  recordCancelRequested(snapshot: AgentToolApprovalSnapshot): void {
    this.enqueue(
      snapshot,
      'cancelRequested',
      'cancelling',
      this.humanApproved.has(keyFor(snapshot)),
      'cancelled',
    );
  }

  recordRecoveredCancellation(snapshot: AgentToolApprovalSnapshot): void {
    if (!snapshot.recoveredFromStatus || snapshot.status !== 'cancelled') return;
    const key = keyFor(snapshot);
    if (this.statuses.has(key)) return;
    this.statuses.set(key, 'cancelled');
    const humanApproved = snapshot.recoveredFromStatus === 'running'
      && snapshot.decision.requiresApproval;
    this.enqueue(
      snapshot,
      'statusChanged',
      'cancelled',
      humanApproved,
      'cancelled',
      recoveryEventId(snapshot),
    );
  }

  async flush(): Promise<void> {
    while (this.queues.size > 0) {
      await Promise.allSettled([...this.queues.values()]);
    }
  }

  private enqueue(
    snapshot: AgentToolApprovalSnapshot,
    eventKind: OperationHistoryEventKind,
    status: OperationHistoryStatus,
    humanApproved: boolean,
    errorCategory?: OperationHistoryErrorCategory,
    eventId = createOperationId('agent-history-event'),
  ): void {
    const key = keyFor(snapshot);
    const previous = this.queues.get(key) ?? Promise.resolve();
    const operation = previous.catch(() => {}).then(() => this.writer({
      eventId,
      taskId: snapshot.toolCall.requestId,
      operationId: snapshot.toolCall.callId,
      parentOperationId: snapshot.toolCall.requestId,
      occurredAt: Date.now(),
      category: 'terminal',
      action: 'executeAgentCommand',
      eventKind,
      status,
      risk: snapshot.riskAssessment.risk,
      targets: [targetFor(snapshot)],
      commandPreview: redactTerminalSecrets(snapshot.toolCall.command),
      evidence: eventKind === 'approved'
        ? [{
            operationId: snapshot.toolCall.callId,
            kind: 'approval',
            observedAt: Date.now(),
          }]
        : [],
      errorCategory,
      exitCode: snapshot.result?.exitCode,
      permissionMode: snapshot.permissionMode,
      humanApproved,
    }));
    this.queues.set(key, operation);
    const cleanup = (): void => {
      if (this.queues.get(key) === operation) this.queues.delete(key);
    };
    void operation.then(cleanup, cleanup);
  }
}

export const agentOperationAuditor = new AgentOperationAuditor();

function recoveryEventId(snapshot: AgentToolApprovalSnapshot): string {
  const input = `${snapshot.toolCall.requestId}\u0000${snapshot.toolCall.callId}`;
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < input.length; index += 1) {
    const code = input.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
  }
  const hex = (value: number): string => (value >>> 0).toString(16).padStart(8, '0');
  return `agent-recovery-${hex(first)}${hex(second)}`;
}

registerAgentRecoveryAuditHandler((snapshot) => {
  agentOperationAuditor.recordRecoveredCancellation(snapshot);
});

export function listAgentOperationHistory(
  taskId?: string,
  limit = 100,
): Promise<OperationHistoryPage> {
  return listOperationHistory({
    action: 'executeAgentCommand',
    ...(taskId ? { taskId } : {}),
  }, limit);
}
