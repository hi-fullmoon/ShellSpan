export const AGENT_PERMISSION_MODES = [
  'requestApproval',
  'autoApproveReadOnly',
  'fullAccess',
] as const;

export type AgentPermissionMode = (typeof AGENT_PERMISSION_MODES)[number];
export type AgentRisk = 'readOnly' | 'stateChange' | 'destructive';

export interface AgentApprovalTarget {
  readonly kind: 'remote' | 'local';
  readonly sessionId: string;
  readonly profileId?: string;
  readonly host: string;
  readonly port: number;
  readonly username: string;
}

export interface AgentApprovalReference {
  readonly sessionId: string;
  readonly turnId: string;
  readonly stepId: string;
  readonly requestId: string;
  readonly callId: string;
  readonly approvalId: string;
}

export type AgentToolApprovalStatus =
  | 'pending'
  | 'awaitingApproval'
  | 'running'
  | 'completed'
  | 'rejected'
  | 'failed'
  | 'timedOut'
  | 'cancelled';

export interface AgentToolApprovalSnapshot {
  readonly toolCall: {
    readonly requestId: string;
    readonly callId: string;
    readonly name: string;
    readonly command: string;
    readonly explanation: string;
    readonly target: AgentApprovalTarget;
  };
  readonly riskAssessment: { readonly risk: AgentRisk };
  readonly status: AgentToolApprovalStatus;
  readonly approval?: AgentApprovalReference;
  readonly result?: {
    readonly requestId?: string;
    readonly callId?: string;
    readonly status?: Exclude<AgentToolApprovalStatus, 'pending' | 'awaitingApproval' | 'running'>;
    readonly exitCode?: number;
    readonly output: string;
  };
}
