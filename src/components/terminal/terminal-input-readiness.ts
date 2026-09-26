// Share the reconnect guard with the UI so blocked input always has a visible
// explanation. Shells without integration retain the bounded grace period.
const RECONNECT_INPUT_GRACE_MS = 800;
const pending = new Map<string, { deadline: number; timer: ReturnType<typeof setTimeout> }>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

export const terminalInputReadiness = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  isPreparing(sessionId: string | null): boolean {
    const entry = sessionId === null ? undefined : pending.get(sessionId);
    return entry !== undefined && Date.now() < entry.deadline;
  },
  begin(sessionId: string): void {
    const previous = pending.get(sessionId);
    if (previous) clearTimeout(previous.timer);
    pending.set(sessionId, {
      deadline: Date.now() + RECONNECT_INPUT_GRACE_MS,
      timer: setTimeout(() => terminalInputReadiness.finish(sessionId), RECONNECT_INPUT_GRACE_MS),
    });
    notify();
  },
  finish(sessionId: string): void {
    const entry = pending.get(sessionId);
    if (!entry) return;
    clearTimeout(entry.timer);
    pending.delete(sessionId);
    notify();
  },
};
