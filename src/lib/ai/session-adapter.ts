import type {
  AiProviderConfig,
} from '@/types/ai';
import type {
  AgentArtifactResponse,
  AgentActivityNode,
  AgentSessionSnapshot,
  CreateAgentSessionRequest,
} from '@/types/agent-session';
import type {
  AiConversationNode,
  AiSessionKind,
  AiSessionStatus,
} from './conversation-node';

export interface AiSessionSummary {
  readonly id: string;
  readonly kind: AiSessionKind;
  readonly title: string;
  readonly updatedAt: string;
  readonly status: AiSessionStatus;
  readonly scopeKey: string;
  readonly archived: boolean;
  readonly revision?: number | null;
}

export type AiSessionSourceSnapshot = Readonly<{
  kind: 'agent';
  value: AgentSessionSnapshot;
}>;

export interface AiInboxItem {
  readonly id: string;
  readonly clientSubmissionId?: string;
  readonly lane: 'nextTurn' | 'nextStep';
  readonly content: string;
  readonly state: 'queued' | 'pending' | 'claimed';
  readonly source: import('@/types/agent-session').AgentSessionProvenanceKind;
  readonly provenance?: import('@/types/agent-session').AgentSessionMessageSource;
}

export interface AiPendingApproval {
  readonly sessionId: string;
  readonly turnId: string;
  readonly stepId: string;
  readonly requestId: string;
  readonly callId: string;
  readonly approvalId: string;
  readonly risk: import('@/types/agent-session').AgentSessionEffect;
  readonly prompt: string | null;
  readonly reason: string | null;
  readonly expiresAtUnixMs: number | null;
  readonly toolName: string;
  readonly target: import('@/types/agent-session').AgentSessionTarget | null;
  readonly arguments: unknown;
  readonly effect: import('@/types/agent-session').AgentSessionEffect;
  readonly evidenceRefs: readonly string[];
}

export interface AiSessionError {
  readonly kind: 'auth' | 'rateLimit' | 'offline' | 'conflict' | 'cancelled' | 'terminal' | 'unknown';
  readonly message: string;
  readonly retryable: boolean;
  readonly currentRevision?: number;
}

export interface AiSessionView {
  readonly pendingQuestion?: import('@/types/agent-question').AgentQuestionView | null;
  readonly summary: AiSessionSummary;
  readonly snapshot: AiSessionSourceSnapshot;
  readonly nodes: readonly AiConversationNode[];
  readonly activityNodes: readonly AgentActivityNode[];
  readonly inbox: readonly AiInboxItem[];
  readonly pendingApproval: AiPendingApproval | null;
  readonly status: AiSessionStatus;
  readonly error: AiSessionError | null;
  readonly throughSeq: number | null;
  readonly revision?: number | null;
  readonly committedOperationIds?: readonly string[];
  readonly canLoadOlder: boolean;
  readonly contextUsage?: AiContextUsage;
}

export type AiInboxMutationInput =
  | Readonly<{
      type: 'update';
      sessionId: string;
      itemId: string;
      content: string;
      expectedRevision: number;
      clientOperationId: string;
    }>
  | Readonly<{
      type: 'remove';
      sessionId: string;
      itemId: string;
      expectedRevision: number;
      clientOperationId: string;
    }>
  | Readonly<{
      type: 'reorder';
      sessionId: string;
      lane: 'nextTurn' | 'nextStep';
      orderedItemIds: readonly string[];
      expectedRevision: number;
      clientOperationId: string;
    }>;

export interface AiSessionRenameInput {
  readonly sessionId: string;
  readonly title: string;
  readonly expectedRevision: number;
  readonly clientOperationId: string;
}

export interface ListSessionsInput {
  readonly scopeKey?: string;
  readonly archived?: boolean;
  readonly cursor?: string;
  readonly limit: number;
}

export interface AiSessionSummaryPage {
  readonly sessions: readonly AiSessionSummary[];
  readonly nextCursor?: string;
}

export interface AiContextUsage {
  readonly usedTokens: number;
  readonly contextWindow: number;
  readonly source: 'reported' | 'estimated';
  readonly breakdown?: Readonly<{
    readonly systemTokens: number;
    readonly toolsTokens: number;
    readonly messageTokens: number;
  }>;
}

export type AiCreateSessionInput = Readonly<{
  kind: 'agent';
  request: CreateAgentSessionRequest;
}>;

export type AiSubmissionMode = 'start' | 'nextTurn' | 'nextStep';

export interface AiSubmitInput<Kind extends AiSessionKind = AiSessionKind> {
  readonly images?: readonly import('@/types/agent-image').AgentImageUpload[];
  readonly content: string;
  readonly mode: AiSubmissionMode;
  readonly clientOperationId: string;
  readonly provider: AiProviderConfig;
  readonly create?: Extract<AiCreateSessionInput, { readonly kind: Kind }>;
}

export interface AiSubmitReceipt {
  readonly sessionId: string;
  readonly clientOperationId: string;
  readonly mode: AiSubmissionMode;
}

export interface AiApprovalDecisionInput {
  readonly sessionId: string;
  readonly turnId: string;
  readonly stepId: string;
  readonly requestId: string;
  readonly callId: string;
  readonly approvalId: string;
}

export type AiSessionListener = (view: AiSessionView) => void;

/** UI-facing operations backed exclusively by the Agent Runtime. */
export interface AiSessionAdapter<Kind extends AiSessionKind = AiSessionKind> {
  listFileReferences?(sessionId: string, query: string, signal: AbortSignal): Promise<import('@/types/agent-file-reference').FileReferenceList>;
  listSkills?(sessionId: string): Promise<import('@/types/agent-skill').SkillUserList>;
  answerQuestion(input: import('@/types/agent-question').AnswerQuestionInput): Promise<void>;
  readonly kind: Kind;
  list(input: ListSessionsInput): Promise<AiSessionSummaryPage>;
  create(
    input: Extract<AiCreateSessionInput, { readonly kind: Kind }>,
  ): Promise<AiSessionView>;
  open(sessionId: string): Promise<AiSessionView>;
  subscribe(sessionId: string, listener: AiSessionListener): () => void;
  submit(sessionId: string | null, input: AiSubmitInput<Kind>): Promise<AiSubmitReceipt>;
  stop(sessionId: string): Promise<void>;
  approve(input: AiApprovalDecisionInput): Promise<void>;
  reject(input: AiApprovalDecisionInput): Promise<void>;
  archive(sessionId: string): Promise<void>;
  mutateInbox(input: AiInboxMutationInput): Promise<void>;
  rename(input: AiSessionRenameInput): Promise<void>;
  refresh(sessionId: string): Promise<AiSessionView>;
  loadOlder(sessionId: string, cursor: string): Promise<readonly AiConversationNode[]>;
  loadArtifact(sessionId: string, artifactId: string, maxBytes: number): Promise<AgentArtifactResponse>;
  dispose(): void;
}
