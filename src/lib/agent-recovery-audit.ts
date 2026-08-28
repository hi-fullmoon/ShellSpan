import type { AgentToolApprovalSnapshot } from '@/types/agent';

type RecoveryAuditHandler = (snapshot: AgentToolApprovalSnapshot) => void;

let handler: RecoveryAuditHandler = () => {};

export function registerAgentRecoveryAuditHandler(next: RecoveryAuditHandler): () => void {
  handler = next;
  return () => {
    if (handler === next) handler = () => {};
  };
}

export function auditRecoveredAgentTool(snapshot: AgentToolApprovalSnapshot): void {
  handler(snapshot);
}
