import {
  invokeGetAgentRuntimeSession,
  invokeGetCommittedAgentRuntimeEvents,
  listenToAgentRuntimeSession,
} from '@/lib/tauri';
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
  private unlisten?: () => void;
  private work = Promise.resolve();
  private buffering = false;
  private buffered: AgentSessionEvent[] = [];

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
      hasTerminalEvent: this.events.some((event) => event.type === 'session/ended'),
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
      this.emit();
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
  }

  async settled(): Promise<AgentSessionStreamState> {
    await this.work;
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
    this.emit();
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

  private emit(): void {
    const state = this.state();
    for (const listener of this.listeners) listener(state);
  }
}
