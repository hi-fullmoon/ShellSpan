export const AGENT_PERMISSION_MODES = [
  'requestApproval',
  'autoApproveReadOnly',
  'fullAccess',
] as const;

export type AgentPermissionMode = (typeof AGENT_PERMISSION_MODES)[number];

export interface AgentApprovalTarget {
  readonly kind: 'remote' | 'local';
  readonly sessionId: string;
  readonly profileId?: string;
  readonly host: string;
  readonly port: number;
  readonly username: string;
}
