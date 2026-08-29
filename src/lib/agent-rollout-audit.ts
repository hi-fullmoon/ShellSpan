import { recordOperationHistoryEvent } from '@/lib/operation-history';
import { createOperationId } from '@/lib/operation-id';
import type { AiProviderKind } from '@/types/ai';
import type {
  AgentProviderCapabilityEvidence,
  AgentRolloutPolicy,
  AgentRunRecord,
  AgentTargetSnapshot,
} from '@/types/agent';
import type {
  OperationHistoryErrorCategory,
  OperationHistoryStatus,
  OperationHistoryTarget,
  RecordOperationEventRequest,
} from '@/types/operation-history';

type AuditWriter = (request: RecordOperationEventRequest) => Promise<void>;

function historyTarget(target: AgentTargetSnapshot): OperationHistoryTarget {
  return {
    kind: target.kind,
    profileId: target.profileId,
    host: target.host,
    port: target.port,
    username: target.username,
    sessionId: target.sessionId,
  };
}

function fallbackFailure(run: AgentRunRecord): OperationHistoryErrorCategory | undefined {
  if (run.stepLimitReached) return 'stepLimit';
  if (run.fallback?.reason === 'toolCallingUnsupported') return 'toolCallingUnsupported';
  if (run.fallback?.reason === 'toolCallingUnverified') return 'toolCallingUnverified';
  return undefined;
}

function historyStatus(run: AgentRunRecord): OperationHistoryStatus {
  switch (run.status) {
    case 'running':
      return 'running';
    case 'completed':
      return 'succeeded';
    case 'partial':
      return 'partialSuccess';
    case 'cancelled':
      return 'cancelled';
    case 'incomplete':
    case 'failed':
      return 'failed';
  }
}

/**
 * Preview-only, local diagnostics. Records controlled enum values and the
 * already-audited frozen target only; prompts, model text, tool output, model
 * names, base URLs, and credentials never enter these records.
 */
export class AgentRolloutAuditor {
  private readonly writer: AuditWriter;
  private readonly compatibility = new Set<string>();
  private readonly terminalRuns = new Set<string>();
  private readonly inFlight = new Set<Promise<void>>();

  constructor(writer: AuditWriter = recordOperationHistoryEvent) {
    this.writer = writer;
  }

  recordCompatibility(
    policy: Pick<AgentRolloutPolicy, 'stage' | 'collectLocalDiagnostics'>,
    providerKind: AiProviderKind,
    capability: AgentProviderCapabilityEvidence,
    target?: AgentTargetSnapshot,
  ): void {
    if (!policy.collectLocalDiagnostics || policy.stage !== 'preview') return;
    const key = [
      providerKind,
      capability.source,
      capability.support,
    ].join('\u0000');
    if (this.compatibility.has(key)) return;
    this.compatibility.add(key);
    const operationId = createOperationId('agent-compatibility');
    const failed = capability.support !== 'supported';
    this.track(this.writer({
      eventId: createOperationId('agent-preview-event'),
      taskId: operationId,
      operationId,
      occurredAt: Date.now(),
      category: 'agent',
      action: 'detectAgentProviderCapability',
      eventKind: failed ? 'failed' : 'completed',
      status: failed ? 'failed' : 'succeeded',
      subjectId: `${providerKind}:${capability.source}:${capability.support}`,
      targets: target ? [historyTarget(target)] : [],
      evidence: [],
      errorCategory: capability.support === 'unsupported'
        ? 'toolCallingUnsupported'
        : capability.support === 'unknown'
          ? 'toolCallingUnverified'
          : undefined,
    }));
  }

  recordRunOutcome(
    run: AgentRunRecord | undefined,
    errorCategory?: OperationHistoryErrorCategory,
  ): void {
    if (!run || run.rolloutStage !== 'preview' || run.status === 'running') return;
    if (this.terminalRuns.has(run.requestId)) return;
    this.terminalRuns.add(run.requestId);
    const status = historyStatus(run);
    const failed = status !== 'succeeded';
    this.track(this.writer({
      eventId: createOperationId('agent-preview-event'),
      taskId: run.requestId,
      operationId: run.requestId,
      occurredAt: Date.now(),
      category: 'agent',
      action: 'runAgentTask',
      eventKind: failed ? 'failed' : 'completed',
      status,
      subjectId: `${run.rolloutStage}:${run.phase}`,
      targets: [historyTarget(run.target)],
      evidence: [],
      errorCategory: errorCategory ?? fallbackFailure(run) ?? (failed ? 'unknown' : undefined),
    }));
  }

  async flush(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.allSettled([...this.inFlight]);
    }
  }

  resetForTests(): void {
    this.compatibility.clear();
    this.terminalRuns.clear();
  }

  private track(operation: Promise<void>): void {
    this.inFlight.add(operation);
    const cleanup = (): void => {
      this.inFlight.delete(operation);
    };
    void operation.then(cleanup, cleanup);
  }
}

export const agentRolloutAuditor = new AgentRolloutAuditor();
