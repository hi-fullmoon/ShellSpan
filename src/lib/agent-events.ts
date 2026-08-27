import { isAgentRunTerminalStateV1 } from '@/lib/agent-state';
import type { AgentEventV1, AgentRunSnapshotV1 } from '@/types/agent';

export type AgentEventCursorStatusV1 =
  | 'applied'
  | 'buffered'
  | 'duplicate'
  | 'gap'
  | 'ignoredRun'
  | 'ignoredTerminal'
  | 'staleSnapshot';

export interface AgentEventCursorUpdateV1 {
  status: AgentEventCursorStatusV1;
  applied: AgentEventV1[];
  lastSequence: number;
  resyncRequired: boolean;
}

/**
 * Sequence-only projection guard for the P1-A control plane. Payload-to-view
 * projection remains a later UI work package; this cursor guarantees that a
 * panel never applies an event across a gap or after an authoritative terminal.
 */
export class AgentEventCursorV1 {
  readonly runId: string;
  private sequence = 0;
  private terminal = false;
  private resyncing = false;
  private readonly buffered = new Map<number, AgentEventV1>();

  constructor(runId: string) {
    this.runId = runId;
  }

  get lastSequence(): number {
    return this.sequence;
  }

  get resyncRequired(): boolean {
    return this.resyncing;
  }

  accept(event: AgentEventV1): AgentEventCursorUpdateV1 {
    if (event.runId !== this.runId) return this.update('ignoredRun');
    if (event.sequence <= this.sequence) return this.update('duplicate');
    if (this.terminal) return this.update('ignoredTerminal');

    if (this.buffered.has(event.sequence)) return this.update('duplicate');
    this.buffered.set(event.sequence, event);
    if (this.resyncing) return this.update('buffered');
    if (event.sequence !== this.sequence + 1) {
      this.resyncing = true;
      return this.update('gap');
    }

    return this.applyContiguous('applied');
  }

  installSnapshot(snapshot: AgentRunSnapshotV1): AgentEventCursorUpdateV1 {
    if (snapshot.runId !== this.runId) return this.update('ignoredRun');
    if (snapshot.lastSequence < this.sequence) return this.update('staleSnapshot');

    this.sequence = snapshot.lastSequence;
    this.terminal = isAgentRunTerminalStateV1(snapshot.state);
    for (const sequence of this.buffered.keys()) {
      if (sequence <= this.sequence) this.buffered.delete(sequence);
    }
    if (this.terminal) {
      this.buffered.clear();
      this.resyncing = false;
      return this.update('applied');
    }

    this.resyncing = false;
    return this.applyContiguous('applied');
  }

  private applyContiguous(status: AgentEventCursorStatusV1): AgentEventCursorUpdateV1 {
    const applied: AgentEventV1[] = [];
    while (!this.terminal) {
      const next = this.buffered.get(this.sequence + 1);
      if (!next) break;
      this.buffered.delete(next.sequence);
      this.sequence = next.sequence;
      applied.push(next);
      if (next.type === 'run.terminal') {
        this.terminal = true;
        this.buffered.clear();
      }
    }

    if (!this.terminal && this.buffered.size > 0) {
      let firstBuffered = Number.MAX_SAFE_INTEGER;
      for (const sequence of this.buffered.keys()) {
        firstBuffered = Math.min(firstBuffered, sequence);
      }
      this.resyncing = firstBuffered > this.sequence + 1;
    } else {
      this.resyncing = false;
    }
    return this.update(status, applied);
  }

  private update(
    status: AgentEventCursorStatusV1,
    applied: AgentEventV1[] = [],
  ): AgentEventCursorUpdateV1 {
    return {
      status,
      applied,
      lastSequence: this.sequence,
      resyncRequired: this.resyncing,
    };
  }
}
