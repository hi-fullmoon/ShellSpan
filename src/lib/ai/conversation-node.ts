import type {
  AgentSessionEffect,
  AgentSessionRuntimeStatus,
} from '@/types/agent-session';

export type AiSessionKind = 'ask' | 'agent';

export type AiSessionStatus = AgentSessionRuntimeStatus;

export interface AiConversationNodeBase {
  readonly key: string;
  readonly sourceKind: AiSessionKind;
  readonly sessionId: string;
  readonly turnId: string | null;
  readonly stepId: string | null;
  readonly firstSeq: number;
  readonly lastSeq: number;
  readonly timestamp: string;
}

export interface AiUserMessageNode extends AiConversationNodeBase {
  readonly kind: 'userMessage';
  readonly messageId: string;
  readonly clientSubmissionId?: string;
  readonly content: string;
  readonly delivery: 'committed' | 'pending' | 'failed';
}

export interface AiAssistantMessageNode extends AiConversationNodeBase {
  readonly kind: 'assistantMessage';
  readonly messageId: string;
  readonly requestId: string | null;
  readonly content: string;
  readonly state: 'streaming' | 'completed' | 'interrupted' | 'failed' | 'cancelled';
}

export interface AiReasoningNode extends AiConversationNodeBase {
  readonly kind: 'reasoning';
  readonly requestId: string | null;
  readonly summary: string;
  readonly content: string;
  readonly state: 'streaming' | 'completed' | 'interrupted';
}

export interface AiToolDetailRef {
  readonly kind: 'agentTool';
  readonly sessionId: string;
  readonly callId: string;
}

export interface AiToolNode extends AiConversationNodeBase {
  readonly kind: 'tool';
  readonly callId: string;
  readonly name: string;
  readonly summary: string;
  readonly state: 'preparing' | 'approval' | 'running' | 'succeeded' | 'failed' | 'rejected';
  readonly effect: AgentSessionEffect;
  readonly durationMs: number | null;
  readonly detailRef: AiToolDetailRef;
  readonly evidenceRefs: readonly string[];
  readonly input: unknown;
  readonly output: unknown | null;
  readonly error: string | null;
  readonly target: import('@/types/agent-session').AgentSessionTarget | null;
  readonly idempotency: 'yes' | 'no' | 'conditional' | null;
  readonly approval: Readonly<{
    approvalId: string;
    requestId: string;
    status: 'requested' | 'approved' | 'rejected' | 'expired' | 'cancelled';
    risk: AgentSessionEffect;
    prompt: string | null;
    reason: string | null;
    expiresAtUnixMs: number | null;
  }> | null;
}

export interface AiArtifactNode extends AiConversationNodeBase {
  readonly kind: 'artifact';
  readonly artifactId: string;
  readonly artifactKind: string;
  readonly title: string;
  readonly sizeBytes: number | null;
  readonly mediaType: string | null;
  readonly sha256: string | null;
  readonly sensitivity: 'internal' | 'sensitiveRedacted' | null;
}

export interface AiApprovalMarkerNode extends AiConversationNodeBase {
  readonly kind: 'approvalMarker';
  readonly approvalId: string;
  readonly requestId: string;
  readonly callId: string;
  readonly status: 'requested' | 'approved' | 'rejected' | 'expired' | 'cancelled';
  readonly risk: AgentSessionEffect;
  readonly prompt: string | null;
  readonly reason: string | null;
  readonly expiresAtUnixMs: number | null;
}

export type AiLifecycleMarkerCategory =
  | 'session'
  | 'agent'
  | 'inbox'
  | 'turn'
  | 'step'
  | 'request'
  | 'context'
  | 'artifact'
  | 'compaction'
  | 'recovery'
  | 'subagent'
  | 'task'
  | 'terminal'
  | 'unknown';

export interface AiLifecycleMarkerNode extends AiConversationNodeBase {
  readonly kind: 'lifecycleMarker';
  readonly category: AiLifecycleMarkerCategory;
  readonly state: AiSessionStatus | 'started' | 'info' | 'unknown';
  readonly label: string;
  readonly detail: string | null;
  readonly eventTypes: readonly string[];
  readonly eventSeqs: readonly number[];
}

export interface AiRetryNode extends AiConversationNodeBase {
  readonly kind: 'retry';
  readonly requestId: string;
  readonly previousRequestId: string | null;
  readonly attempt: number;
  readonly reason: string;
}

export interface AiErrorNode extends AiConversationNodeBase {
  readonly kind: 'error';
  readonly scope: 'ask' | 'request' | 'turn' | 'step' | 'session' | 'unknown';
  readonly message: string;
  readonly code: string | null;
  readonly state: 'failed' | 'cancelled' | 'unknown';
}

export type AiConversationNode =
  | AiUserMessageNode
  | AiAssistantMessageNode
  | AiReasoningNode
  | AiToolNode
  | AiArtifactNode
  | AiApprovalMarkerNode
  | AiLifecycleMarkerNode
  | AiRetryNode
  | AiErrorNode;

export type AiConversationNodeOf<Kind extends AiConversationNode['kind']> = Extract<
  AiConversationNode,
  { readonly kind: Kind }
>;
