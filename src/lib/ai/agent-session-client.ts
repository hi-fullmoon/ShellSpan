import {
  invokeGetAgentRuntimeSession,
  invokeGetCommittedAgentRuntimeEvents,
  listenToAgentRuntimeSession,
} from '@/lib/ipc/tauri';
import {
  isSupportedAgentSessionEventVersion,
  type AgentCommittedEventsRequest,
  type AgentSessionEvent,
  type AgentSessionEventPage,
  type AgentSessionSnapshot,
} from '@/types/agent-session';

const PAGE_SIZE = 1_024;

export interface AgentSessionStreamTransport {
  readonly snapshot: (sessionId: string) => Promise<AgentSessionSnapshot>;
  readonly committedEvents: (
    request: AgentCommittedEventsRequest,
  ) => Promise<AgentSessionEventPage>;
  readonly subscribe: (
    listener: (event: AgentSessionEvent) => void,
  ) => Promise<() => void>;
}

export interface AgentSessionStreamState {
  readonly snapshot?: AgentSessionSnapshot;
  readonly events: readonly AgentSessionEvent[];
  readonly lastCommittedSeq?: number;
  readonly hasTerminalEvent: boolean;
}

const defaultTransport: AgentSessionStreamTransport = {
  snapshot: (sessionId) => invokeGetAgentRuntimeSession({ sessionId }),
  committedEvents: invokeGetCommittedAgentRuntimeEvents,
  subscribe: (listener) => listenToAgentRuntimeSession((event) => listener(event.payload)),
};

/**
 * Subscribe-first client for the committed Agent Runtime stream. It treats sequence
 * numbers as the only ordering authority, backfills every gap with afterSeq,
 * and never derives a terminal event from a snapshot alone.
 */
export class AgentSessionCommittedClient {
  private readonly events: AgentSessionEvent[] = [];
  private readonly listeners = new Set<(state: AgentSessionStreamState) => void>();
  private snapshotValue?: AgentSessionSnapshot;
  private hasTerminalEventValue = false;
  private unlisten?: () => void;
  private work = Promise.resolve();
  private buffering = false;
  private buffered: AgentSessionEvent[] = [];
  private emitPending = false;
  private cancelScheduledEmit?: () => void;

  constructor(
    private readonly sessionId: string,
    private readonly transport: AgentSessionStreamTransport = defaultTransport,
  ) {}

  state(): AgentSessionStreamState {
    const last = this.events[this.events.length - 1];
    return {
      snapshot: this.snapshotValue,
      events: [...this.events],
      lastCommittedSeq: last?.seq,
      hasTerminalEvent: this.hasTerminalEventValue,
    };
  }

  onChange(listener: (state: AgentSessionStreamState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async connect(): Promise<AgentSessionStreamState> {
    if (this.unlisten) return this.state();
    this.buffering = true;
    this.unlisten = await this.transport.subscribe((event) => {
      if (event.sessionId !== this.sessionId) return;
      if (this.buffering) {
        this.buffered.push(event);
        return;
      }
      this.enqueue(() => this.ingestLive(event));
    });
    try {
      this.snapshotValue = await this.transport.snapshot(this.sessionId);
      await this.fetchAfter(this.events[this.events.length - 1]?.seq);
      this.buffering = false;
      const buffered = this.buffered.sort((left, right) => left.seq - right.seq);
      this.buffered = [];
      for (const event of buffered) await this.ingestLive(event);
      this.publishNow(true);
      return this.state();
    } catch (error) {
      // A rootless image draft may probe its durable ID before creating the Session.
      // A failed probe must not leave connect() believing it is already connected.
      this.disconnect();
      throw error;
    }
  }

  async reconnect(): Promise<AgentSessionStreamState> {
    this.unlisten?.();
    this.unlisten = undefined;
    return this.connect();
  }

  disconnect(): void {
    this.unlisten?.();
    this.unlisten = undefined;
    this.buffering = false;
    this.buffered = [];
    this.cancelScheduledEmit?.();
    this.cancelScheduledEmit = undefined;
    this.emitPending = false;
  }

  async settled(): Promise<AgentSessionStreamState> {
    await this.work;
    this.publishNow();
    return this.state();
  }

  private enqueue(operation: () => Promise<void>): void {
    this.work = this.work.then(operation, operation);
  }

  private async ingestLive(event: AgentSessionEvent): Promise<void> {
    this.validateEnvelope(event);
    const last = this.events[this.events.length - 1];
    if (last && event.seq <= last.seq) {
      const existing = this.events[event.seq];
      if (JSON.stringify(existing) !== JSON.stringify(event)) {
        throw new Error(`Committed Agent event ${event.seq} changed after publication`);
      }
      return;
    }
    const expected = last ? last.seq + 1 : 0;
    if (event.seq !== expected) {
      try {
        await this.fetchAfter(last?.seq);
      } catch {
        await this.fullResync();
      }
    }
    if ((this.events[this.events.length - 1]?.seq ?? -1) + 1 < event.seq) {
      await this.fullResync();
    }
    this.merge(event);
    this.scheduleEmit();
  }

  private async fetchAfter(afterSeq: number | undefined): Promise<void> {
    let cursor = afterSeq;
    for (;;) {
      const page = await this.transport.committedEvents({
        sessionId: this.sessionId,
        afterSeq: cursor,
        limit: PAGE_SIZE,
      });
      for (const event of page.events) this.merge(event);
      const last = page.events[page.events.length - 1];
      if (!last || page.nextCursor === undefined) break;
      cursor = last.seq;
    }
  }

  private async fullResync(): Promise<void> {
    this.snapshotValue = await this.transport.snapshot(this.sessionId);
    this.events.length = 0;
    this.hasTerminalEventValue = false;
    await this.fetchAfter(undefined);
  }

  private merge(event: AgentSessionEvent): void {
    this.validateEnvelope(event);
    const expected = this.events.length;
    if (event.seq < expected) {
      if (JSON.stringify(this.events[event.seq]) !== JSON.stringify(event)) {
        throw new Error(`Committed Agent event ${event.seq} changed during backfill`);
      }
      return;
    }
    if (event.seq !== expected) {
      throw new Error(`Committed Agent stream has a gap before seq ${event.seq}`);
    }
    this.events.push(event);
    if (event.type === 'session/ended') this.hasTerminalEventValue = true;
    if (event.type === 'session/resumed') this.hasTerminalEventValue = false;
  }

  private validateEnvelope(event: AgentSessionEvent): void {
    if (!isSupportedAgentSessionEventVersion(event.version) || event.sessionId !== this.sessionId) {
      throw new Error('Committed Agent event has an incompatible identity or version');
    }
    if (event.type === 'agent/inbox/item_steered') {
      const data = event.data;
      if (!data || typeof data.itemId !== 'string' || !data.itemId.trim()
        || typeof data.clientOperationId !== 'string' || !data.clientOperationId.trim()
        || !Number.isSafeInteger(data.previousRevision) || data.previousRevision < 0
        || data.previousRevision !== event.seq || event.turnId || event.stepId) {
        throw new Error('Committed Agent inbox steer event has an invalid mutation identity');
      }
    }
  }

  private scheduleEmit(): void {
    if (this.emitPending) return;
    this.emitPending = true;
    if (typeof globalThis.requestAnimationFrame === 'function') {
      const frame = globalThis.requestAnimationFrame(() => this.publishNow());
      // Background WebViews can pause animation frames. Keep a bounded fallback
      // so committed approvals, questions, and terminal state still propagate.
      const fallback = globalThis.setTimeout(() => this.publishNow(), 50);
      this.cancelScheduledEmit = () => {
        globalThis.cancelAnimationFrame(frame);
        globalThis.clearTimeout(fallback);
      };
      return;
    }
    const timer = globalThis.setTimeout(() => this.publishNow(), 16);
    this.cancelScheduledEmit = () => globalThis.clearTimeout(timer);
  }

  private publishNow(force = false): void {
    if (!this.emitPending && !force) return;
    if (this.emitPending) {
      this.cancelScheduledEmit?.();
      this.cancelScheduledEmit = undefined;
      this.emitPending = false;
    }
    const state = this.state();
    for (const listener of this.listeners) listener(state);
  }
}
