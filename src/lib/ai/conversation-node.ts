import type {
  AgentSessionAssistantContentBlock,
  AgentSessionEffect,
  AgentSessionMessageSource,
  AgentSessionRequestToolSchema,
  AgentSessionRuntimeStatus,
  AgentSessionStopReason,
  AgentSessionTokenUsage,
} from '@/types/agent-session';

export type AiSessionKind = 'agent';

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

export interface AiSystemPromptNode extends AiConversationNodeBase {
  readonly kind: 'systemPrompt';
  readonly requestId: string;
  readonly requestIds: readonly string[];
  readonly providerId: string;
  readonly model: string;
  readonly reasoningEffort: string | null;
  readonly seriesId: string;
  readonly content: string;
  readonly toolSchemas: readonly AgentSessionRequestToolSchema[];
}

export interface AiContextInjectionNode extends AiConversationNodeBase {
  readonly kind: 'contextInjection';
  readonly messageId: string;
  readonly content: string;
  readonly provenance: AgentSessionMessageSource;
}

export interface AiAssistantMessageNode extends AiConversationNodeBase {
  readonly kind: 'assistantMessage';
  readonly messageId: string;
  readonly requestId: string | null;
  /** Provider-ordered durable blocks. */
  readonly blocks: readonly AgentSessionAssistantContentBlock[];
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

export interface AiRetryNode extends AiConversationNodeBase {
  readonly kind: 'retry';
  readonly requestId: string;
  readonly previousRequestId: string | null;
  readonly attempt: number;
  readonly reason: string;
}

export interface AiErrorNode extends AiConversationNodeBase {
  readonly kind: 'error';
  readonly scope: 'request' | 'turn' | 'step' | 'session' | 'unknown';
  readonly message: string;
  readonly code: string | null;
  readonly state: 'failed' | 'cancelled' | 'unknown';
}

export interface AiDurableTurnStats {
  readonly turnCount: 1;
  readonly stepCount: number;
  readonly requestCount: number;
  readonly toolCount: number;
  readonly modelDurationMs: number | null;
  readonly toolDurationMs: number | null;
  /** Sum of recorded request-to-first-response intervals. */
  readonly timeToFirstTokenMs: number | null;
  /** Requests contributing to `timeToFirstTokenMs`. */
  readonly timeToFirstTokenCount: number;
  readonly averageTimeToFirstTokenMs: number | null;
  /** Sum of recorded first-response-to-completion intervals carrying output usage. */
  readonly decodeDurationMs: number | null;
  /** Output tokens paired with `decodeDurationMs`. */
  readonly decodeTokens: number | null;
  readonly uncachedInputTokens: number | null;
  readonly cacheReadTokens: number | null;
  readonly cacheWriteTokens: number | null;
  readonly outputTokens: number | null;
  readonly reasoningTokens: number | null;
  readonly totalTokens: number | null;
  readonly tokensPerSecond: number | null;
  readonly usageComplete: boolean;
}

export interface AiDurableSessionStats {
  /** False when the committed event window starts after seq 0. */
  readonly historyComplete: boolean;
  readonly turnCount: number;
  readonly stepCount: number;
  readonly requestCount: number;
  readonly toolCount: number;
  readonly modelDurationMs: number | null;
  readonly toolDurationMs: number | null;
  readonly timeToFirstTokenMs: number | null;
  readonly timeToFirstTokenCount: number;
  readonly averageTimeToFirstTokenMs: number | null;
  readonly decodeDurationMs: number | null;
  readonly decodeTokens: number | null;
  readonly uncachedInputTokens: number | null;
  readonly cacheReadTokens: number | null;
  readonly cacheWriteTokens: number | null;
  readonly outputTokens: number | null;
  readonly reasoningTokens: number | null;
  readonly totalTokens: number | null;
  readonly tokensPerSecond: number | null;
  readonly usageComplete: boolean;
}

export type AiTurnProcessStatus =
  | 'running'
  | 'waiting'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'partial';

export type AiTurnProcessChildNode =
  | AiAssistantMessageNode
  | AiContextInjectionNode
  | AiReasoningNode
  | AiToolNode
  | AiApprovalMarkerNode
  | AiRetryNode
  | AiErrorNode;

export interface AiTurnProcessNode extends AiConversationNodeBase {
  readonly kind: 'turnProcess';
  readonly status: AiTurnProcessStatus;
  /** Stable request generation used to scope disclosure state across stream revisions. */
  readonly answerGeneration: string;
  readonly hasStartBoundary: boolean;
  readonly hasEndBoundary: boolean;
  readonly childKeys: readonly string[];
  readonly children: readonly AiTurnProcessChildNode[];
}

export interface AiTurnTailNode extends AiConversationNodeBase {
  readonly kind: 'turnTail';
  readonly status: Exclude<AiTurnProcessStatus, 'running' | 'partial'>;
  readonly endReason: string;
  readonly stopReason: AgentSessionStopReason | null;
  readonly usage: AgentSessionTokenUsage | null;
  readonly stats: AiDurableTurnStats;
  readonly sessionStats: AiDurableSessionStats;
}

export type AiConversationNode =
  | AiSystemPromptNode
  | AiContextInjectionNode
  | AiUserMessageNode
  | AiAssistantMessageNode
  | AiReasoningNode
  | AiToolNode
  | AiArtifactNode
  | AiApprovalMarkerNode
  | AiRetryNode
  | AiErrorNode
  | AiTurnProcessNode
  | AiTurnTailNode;

export type AiConversationNodeOf<Kind extends AiConversationNode['kind']> = Extract<
  AiConversationNode,
  { readonly kind: Kind }
>;
