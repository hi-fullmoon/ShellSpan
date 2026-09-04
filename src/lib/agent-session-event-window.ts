import {
  isSupportedAgentSessionEventVersion,
  type AgentSessionEvent,
} from '@/types/agent-session';

/**
 * Validate the one committed event window shared by Conversation and Activity.
 * A page may start after seq 0, but every event inside it must be contiguous.
 */
export function validateCommittedAgentEventWindow(
  events: readonly AgentSessionEvent[],
): void {
  if (events.length === 0) return;
  const first = events[0];
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (!isSupportedAgentSessionEventVersion(event.version)) {
      throw new Error(`Unsupported Agent Session event version at seq ${event.seq}`);
    }
    if (event.sessionId !== first.sessionId) {
      throw new Error('Agent Session projection cannot mix session ids');
    }
    if (!Number.isSafeInteger(event.seq) || event.seq !== first.seq + index) {
      throw new Error('Agent Session events must be ordered and contiguous');
    }
    if (!Number.isSafeInteger(event.timeUnixMs) || event.timeUnixMs <= 0) {
      throw new Error(`Agent Session event ${event.seq} has an invalid timestamp`);
    }
  }
}

export function agentEventTimestamp(timeUnixMs: number): string {
  return new Date(timeUnixMs).toISOString();
}

/** Provider call IDs may repeat; identify tools within a single-session event window. */
export function agentToolEventKey(
  event: Readonly<{ turnId?: string; stepId?: string }>,
  callId: string,
): string {
  return [event.turnId ?? '', event.stepId ?? '', callId].map(encodeURIComponent).join(':');
}
