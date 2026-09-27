import capture from './agent-inbox-timeline.json';
import { agentSessionView } from '@/lib/ai/agent-session-adapter';
import type { AgentSessionEvent, AgentSessionSnapshot } from '@/types/agent-session';

// Recorded by inbox_conversation_timeline_preserves_consumption_order_after_restart
// using the real Rust session store and local filesystem reads, without a model stub.
export const inboxTimelineEvidence = capture as unknown as {
  readonly events: readonly AgentSessionEvent[];
  readonly snapshot: AgentSessionSnapshot;
};

export function inboxTimelineView(length = inboxTimelineEvidence.events.length) {
  const events = inboxTimelineEvidence.events.slice(0, length);
  return agentSessionView({
    snapshot: inboxTimelineEvidence.snapshot, events,
    lastCommittedSeq: events[events.length - 1]?.seq, hasTerminalEvent: false,
  });
}
