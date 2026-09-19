import type { AgentSessionEvent } from '@/types/agent-session';
import { validateCommittedAgentEventWindow } from './agent-session-event-window';

interface EventProjection<Result> {
  apply(event: AgentSessionEvent): void;
  snapshot(events: readonly AgentSessionEvent[]): Result;
}

/**
 * The committed client shares immutable event objects between publications.
 * Consume only its appended suffix; a replaced/truncated window resets all state.
 * Each owner must keep one projector per session, rather than a global cache.
 */
export function createCommittedEventProjection<Result>(
  create: () => EventProjection<Result>,
): (events: readonly AgentSessionEvent[]) => Result {
  let projection: EventProjection<Result> | undefined;
  let first: AgentSessionEvent | undefined;
  let last: AgentSessionEvent | undefined;
  let count = 0;
  let result: Result;

  return (events) => {
    const appending = projection !== undefined && events.length >= count
      && events[0] === first && events[count - 1] === last;
    const start = appending ? count : 0;
    // Include the previous boundary in validation to reject gaps across batches.
    validateCommittedAgentEventWindow(events.slice(Math.max(0, start - 1)));
    if (!appending) projection = create();
    if (!appending || events.length !== count) {
      try {
        for (let index = start; index < events.length; index += 1) {
          projection!.apply(events[index]);
        }
        result = projection!.snapshot(events);
      } catch (error) {
        // A partially applied batch must never be reused after an error.
        projection = undefined;
        throw error;
      }
    }
    first = events[0];
    last = events[events.length - 1];
    count = events.length;
    return result;
  };
}
