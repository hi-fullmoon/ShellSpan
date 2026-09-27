import {
  invokeGetAgentRuntimeSession,
  invokeGetCommittedAgentRuntimeEvents,
  listenToAgentRuntimeSession,
} from '@/lib/ipc/tauri';
import { CommittedEventBuffer } from './committed-event-buffer';
import type { AiSessionSyncRecovery } from './session-adapter';
import {
  isSupportedAgentSessionEventVersion,
  type AgentCommittedEventsRequest,
  type AgentSessionEvent,
  type AgentSessionEventPage,
  type AgentSessionSnapshot,
} from '@/types/agent-session';

const PAGE_SIZE = 1_024;
const RECOVERY_DELAY_MS = 1_000;
const MAX_RECOVERY_DELAY_MS = 30_000;

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
  readonly syncError?: Error;
  readonly syncRecovery?: AiSessionSyncRecovery;
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
  private events = new CommittedEventBuffer();
  private readonly listeners = new Set<(state: AgentSessionStreamState) => void>();
  private snapshotValue?: AgentSessionSnapshot;
  private hasTerminalEventValue = false;
  private unlisten?: () => void;
  private work = Promise.resolve();
  private buffering = false;
  private buffered: AgentSessionEvent[] = [];
  private emitPending = false;
  private cancelScheduledEmit?: () => void;
  private connection?: AbortController;
  private connecting?: Promise<AgentSessionStreamState>;
  private syncError?: Error;
  private recoveryTimer?: ReturnType<typeof setTimeout>;
  private recoveryDelay = RECOVERY_DELAY_MS;
  private requiredSeq = -1;
  private lastSyncedAt?: number;
  private syncRecovery?: AiSessionSyncRecovery;
  private recoveryWork?: Promise<void>;

  constructor(
    private readonly sessionId: string,
    private readonly transport: AgentSessionStreamTransport = defaultTransport,
  ) {}

  state(): AgentSessionStreamState {
    const last = this.events.last;
    return {
      snapshot: this.snapshotValue,
      events: this.events.snapshot(),
      lastCommittedSeq: last?.seq,
      hasTerminalEvent: this.hasTerminalEventValue,
      syncError: this.syncError,
      syncRecovery: this.syncRecovery,
    };
  }

  onChange(listener: (state: AgentSessionStreamState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  connect(): Promise<AgentSessionStreamState> {
    if (this.connecting) return this.connecting;
    if (this.unlisten) return Promise.resolve(this.state());
    const connection = new AbortController();
    this.connection = connection;
    const connecting = this.establish(connection.signal).finally(() => {
      if (this.connecting === connecting) this.connecting = undefined;
    });
    this.connecting = connecting;
    return connecting;
  }

  private async establish(signal: AbortSignal): Promise<AgentSessionStreamState> {
    this.buffering = true;
    try {
      const unlisten = await this.transport.subscribe((event) => {
        if (signal.aborted || event.sessionId !== this.sessionId) return;
        if (this.buffering) {
          this.buffered.push(event);
          return;
        }
        this.enqueue(signal, () => this.ingestLive(event, signal));
      });
      if (signal.aborted) unlisten();
      signal.throwIfAborted();
      this.unlisten = unlisten;
      const snapshot = await this.transport.snapshot(this.sessionId);
      signal.throwIfAborted();
      this.snapshotValue = snapshot;
      await this.fetchAfter(this.events.last?.seq, signal);
      // Keep buffering until replay is fully drained. Live work must not race
      // a buffered event's asynchronous gap repair.
      while (this.buffered.length > 0) {
        signal.throwIfAborted();
        const buffered = this.buffered.sort((left, right) => left.seq - right.seq);
        this.buffered = [];
        for (const event of buffered) await this.ingestLive(event, signal);
      }
      signal.throwIfAborted();
      this.buffering = false;
      this.assertCaughtUp();
      this.lastSyncedAt = Date.now();
      this.clearSyncError();
      this.publishNow(true);
      return this.state();
    } catch (error) {
      // A rootless image draft may probe its durable ID before creating the Session.
      // A failed probe must not leave connect() believing it is already connected.
      if (!signal.aborted) this.disconnect();
      throw error;
    }
  }

  async reconnect(): Promise<AgentSessionStreamState> {
    if (this.connecting) return this.connecting;
    this.disconnect();
    return this.connect();
  }

  disconnect(): void {
    this.connection?.abort();
    this.connection = undefined;
    this.connecting = undefined;
    // Old queued operations retain their aborted signal. A new connection
    // must not wait behind an IPC request belonging to the previous one.
    this.work = Promise.resolve();
    this.recoveryWork = undefined;
    if (this.syncRecovery) this.syncRecovery = { ...this.syncRecovery, retrying: false };
    this.unlisten?.();
    this.unlisten = undefined;
    this.buffering = false;
    this.buffered = [];
    this.cancelScheduledEmit?.();
    this.cancelScheduledEmit = undefined;
    this.emitPending = false;
    if (this.recoveryTimer !== undefined) clearTimeout(this.recoveryTimer);
    this.recoveryTimer = undefined;
  }

  async settled(): Promise<AgentSessionStreamState> {
    await this.work;
    this.publishNow();
    if (this.syncError) throw this.syncError;
    return this.state();
  }

  async retrySync(): Promise<AgentSessionStreamState> {
    if (!this.connection || !this.unlisten) return this.reconnect();
    await this.recover(this.connection.signal);
    return this.settled();
  }

  private enqueue(signal: AbortSignal, operation: () => Promise<void>): Promise<void> {
    this.work = this.work.then(async () => {
      if (signal.aborted) return;
      try {
        await operation();
        signal.throwIfAborted();
        this.assertCaughtUp();
        this.lastSyncedAt = Date.now();
        if (this.syncError || this.syncRecovery) {
          this.clearSyncError();
          this.scheduleEmit();
        }
      } catch (error) {
        if (signal.aborted) return;
        this.syncError = error instanceof Error ? error : new Error(String(error));
        this.syncRecovery = { attempts: this.syncRecovery?.attempts ?? 0, retrying: false,
          lastSyncedAt: this.lastSyncedAt };
        this.scheduleEmit();
        this.scheduleRecovery(signal);
      }
    });
    return this.work;
  }

  private async ingestLive(event: AgentSessionEvent, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    this.validateEnvelope(event);
    this.requiredSeq = Math.max(this.requiredSeq, event.seq);
    const last = this.events.last;
    if (last && event.seq <= last.seq) {
      const existing = this.events.get(event.seq);
      if (JSON.stringify(existing) !== JSON.stringify(event)) {
        throw new Error(`Committed Agent event ${event.seq} changed after publication`);
      }
      return;
    }
    const expected = last ? last.seq + 1 : 0;
    if (event.seq !== expected) {
      try {
        await this.fetchAfter(last?.seq, signal);
      } catch {
        signal.throwIfAborted();
        await this.fullResync(signal);
      }
    }
    if ((this.events.last?.seq ?? -1) + 1 < event.seq) {
      await this.fullResync(signal);
    }
    signal.throwIfAborted();
    this.merge(event);
    this.scheduleEmit();
  }

  private async fetchAfter(
    afterSeq: number | undefined,
    signal: AbortSignal,
    events = this.events,
  ): Promise<void> {
    let cursor = afterSeq;
    for (;;) {
      signal.throwIfAborted();
      const page = await this.transport.committedEvents({
        sessionId: this.sessionId,
        afterSeq: cursor,
        limit: PAGE_SIZE,
      });
      signal.throwIfAborted();
      for (const event of page.events) this.merge(event, events);
      const last = page.events[page.events.length - 1];
      if (!last || page.nextCursor === undefined) break;
      cursor = last.seq;
    }
  }

  private async fullResync(signal: AbortSignal): Promise<void> {
    const snapshot = await this.transport.snapshot(this.sessionId);
    signal.throwIfAborted();
    // Publish a complete replacement only after replay succeeds. Failed repair
    // must not erase the committed text already visible to the reader.
    const events = new CommittedEventBuffer();
    await this.fetchAfter(undefined, signal, events);
    signal.throwIfAborted();
    if (events.length < this.events.length) {
      throw new Error('Committed Agent replay is shorter than the published event window');
    }
    this.snapshotValue = snapshot;
    this.events = events;
    this.hasTerminalEventValue = false;
    for (const event of events.snapshot()) this.updateTerminalState(event);
  }

  private clearSyncError(): void {
    this.syncError = undefined;
    this.syncRecovery = undefined;
    this.recoveryDelay = RECOVERY_DELAY_MS;
    if (this.recoveryTimer !== undefined) clearTimeout(this.recoveryTimer);
    this.recoveryTimer = undefined;
  }

  private assertCaughtUp(): void {
    if ((this.events.last?.seq ?? -1) < this.requiredSeq) {
      throw new Error(`Committed Agent stream has not recovered through seq ${this.requiredSeq}`);
    }
  }

  private scheduleRecovery(signal: AbortSignal): void {
    if (signal.aborted || this.recoveryTimer !== undefined) return;
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = undefined;
      void this.recover(signal);
    }, this.recoveryDelay);
    this.recoveryDelay = Math.min(this.recoveryDelay * 2, MAX_RECOVERY_DELAY_MS);
  }

  private recover(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.resolve();
    if (this.recoveryWork) return this.recoveryWork;
    if (this.recoveryTimer !== undefined) clearTimeout(this.recoveryTimer);
    this.recoveryTimer = undefined;
    this.syncRecovery = { attempts: (this.syncRecovery?.attempts ?? 0) + 1,
      retrying: true, lastSyncedAt: this.lastSyncedAt };
    const work = this.enqueue(signal, async () => {
      try {
        await this.fetchAfter(this.events.last?.seq, signal);
      } catch {
        signal.throwIfAborted();
        await this.fullResync(signal);
      }
      signal.throwIfAborted();
      this.scheduleEmit();
    }).finally(() => {
      if (this.recoveryWork === work) this.recoveryWork = undefined;
    });
    this.recoveryWork = work;
    this.publishNow(true);
    return work;
  }

  private merge(event: AgentSessionEvent, events = this.events): void {
    this.validateEnvelope(event);
    const expected = events.length;
    if (event.seq < expected) {
      if (JSON.stringify(events.get(event.seq)) !== JSON.stringify(event)) {
        throw new Error(`Committed Agent event ${event.seq} changed during backfill`);
      }
      return;
    }
    if (event.seq !== expected) {
      throw new Error(`Committed Agent stream has a gap before seq ${event.seq}`);
    }
    events.append(event);
    if (events === this.events) this.updateTerminalState(event);
  }

  private updateTerminalState(event: AgentSessionEvent): void {
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
