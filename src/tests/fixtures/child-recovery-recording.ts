import failedEventsJson from './child-failure-recovery/failed-events.json';
import failedSnapshotJson from './child-failure-recovery/failed-snapshot.json';
import admittedEventsJson from './child-failure-recovery/admitted-events.json';
import admittedSnapshotJson from './child-failure-recovery/admitted-snapshot.json';
import type { AgentSessionEvent, AgentSessionSnapshot } from '@/types/agent-session';
import { agentSessionView } from '@/lib/ai/agent-session-adapter';

// Recorded by the Rust recovery regression using a real local file write and
// a refused HTTP connection. No provider or native runtime responses are mocked.
export const childFailureEvents = failedEventsJson as unknown as readonly AgentSessionEvent[];
export const childAdmittedEvents = admittedEventsJson as unknown as readonly AgentSessionEvent[];
export const childFailureSnapshot = failedSnapshotJson as unknown as AgentSessionSnapshot;
export const childAdmittedSnapshot = admittedSnapshotJson as unknown as AgentSessionSnapshot;
export const childFailureRecordedAt = childFailureEvents[childFailureEvents.length - 1].timeUnixMs;

export function recordedChildFailureView() {
  return agentSessionView({ snapshot: childFailureSnapshot, events: childFailureEvents,
    lastCommittedSeq: childFailureEvents[childFailureEvents.length - 1].seq, hasTerminalEvent: true });
}

export function recordedChildAdmittedView() {
  return agentSessionView({ snapshot: childAdmittedSnapshot, events: childAdmittedEvents,
    lastCommittedSeq: childAdmittedEvents[childAdmittedEvents.length - 1].seq, hasTerminalEvent: false });
}
