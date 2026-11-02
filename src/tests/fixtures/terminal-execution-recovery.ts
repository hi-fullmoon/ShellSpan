import { taskTokenBudgetView } from './task-token-budget';
import type { AiSessionView } from '@/lib/ai/session-adapter';
import { projectAgentChatNodes } from '@/lib/ai/conversation-projection';
import type { AgentSessionEvent } from '@/types/agent-session';
import capture from './terminal-execution-recovery.json';

/** Recovery diagnostics captured from the stalled native terminal session on 2026-10-27. */
export function terminalRecoveryView(status: 'waiting' | 'idle' = 'waiting'): AiSessionView {
  const base = taskTokenBudgetView();
  return {
    ...base,
    status,
    statusReason: status === 'waiting' ? capture.statusReason : 'stoppedByUser',
    recovery: { status: 'required', summary: capture.recovery.summary },
    summary: { ...base.summary, status },
    snapshot: { kind: 'agent', value: { ...base.snapshot.value, status, ended: false,
      header: { ...base.snapshot.value.header, executionSurface: 'boundTerminal' } } },
    // Keep the recorded result and omit the unrelated command payload/job details.
    nodes: projectAgentChatNodes([capture.toolResult as AgentSessionEvent]),
  };
}
