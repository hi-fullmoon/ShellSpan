import type { AgentSessionEvent } from '@/types/agent-session';

/** Session-owned append-only storage with stable, immutable publication windows. */
export class CommittedEventBuffer {
  private readonly events: AgentSessionEvent[] = [];
  private published: readonly AgentSessionEvent[] = [];

  get length(): number { return this.events.length; }

  get last(): AgentSessionEvent | undefined { return this.events[this.events.length - 1]; }

  get(index: number): AgentSessionEvent | undefined { return this.events[index]; }

  append(event: AgentSessionEvent): void { this.events.push(event); }

  clear(): void {
    this.events.length = 0;
    this.published = [];
  }

  snapshot(): readonly AgentSessionEvent[] {
    if (this.published.length !== this.events.length) this.published = [...this.events];
    return this.published;
  }
}
