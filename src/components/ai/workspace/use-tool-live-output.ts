import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { isTauriRuntime, listenToAgentToolProgress } from '@/lib/ipc/tauri';
import type { AgentToolProgressEvent } from '@/types/agent-session';

const MAX_TRACKED_ENTRIES = 64;

function progressKey(sessionId: string, callId: string): string {
  return `${sessionId}\0${callId}`;
}

class ToolLiveOutputStore {
  private readonly entries = new Map<string, AgentToolProgressEvent>();
  private readonly listeners = new Map<string, Set<() => void>>();
  private activeSubscribers = 0;
  private unlisten: (() => void) | null = null;
  private listening = false;
  private subscriptionGeneration = 0;

  get(sessionId: string, callId: string): AgentToolProgressEvent | null {
    return this.entries.get(progressKey(sessionId, callId)) ?? null;
  }

  ingest(event: AgentToolProgressEvent): void {
    const key = progressKey(event.sessionId, event.callId);
    const existing = this.entries.get(key);
    if (existing && event.revision <= existing.revision) return;
    this.entries.delete(key);
    this.entries.set(key, event);
    if (this.entries.size > MAX_TRACKED_ENTRIES) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.notify(key);
  }

  clearCall(sessionId: string, callId: string): void {
    const key = progressKey(sessionId, callId);
    if (!this.entries.delete(key)) return;
    this.notify(key);
  }

  clearCallIfIdle(sessionId: string, callId: string): void {
    const key = progressKey(sessionId, callId);
    if (this.listeners.has(key)) return;
    this.entries.delete(key);
  }

  clearSession(sessionId: string): void {
    const prefix = `${sessionId}\0`;
    for (const key of [...this.entries.keys()]) {
      if (!key.startsWith(prefix)) continue;
      this.entries.delete(key);
      this.notify(key);
    }
  }

  reset(): void {
    const keys = [...this.entries.keys()];
    this.entries.clear();
    for (const key of keys) this.notify(key);
  }

  subscribe(sessionId: string, callId: string, listener: () => void): () => void {
    const key = progressKey(sessionId, callId);
    let group = this.listeners.get(key);
    if (!group) {
      group = new Set();
      this.listeners.set(key, group);
    }
    group.add(listener);
    this.activeSubscribers += 1;
    this.ensureListening();

    return () => {
      const current = this.listeners.get(key);
      if (current) {
        current.delete(listener);
        if (current.size === 0) {
          this.listeners.delete(key);
          this.entries.delete(key);
        }
      }
      this.activeSubscribers = Math.max(0, this.activeSubscribers - 1);
      if (this.activeSubscribers === 0) this.stopListening();
    };
  }

  private notify(key: string): void {
    const group = this.listeners.get(key);
    if (!group) return;
    for (const listener of group) listener();
  }

  private ensureListening(): void {
    if (this.listening || !isTauriRuntime()) return;
    this.listening = true;
    const generation = ++this.subscriptionGeneration;
    void listenToAgentToolProgress((event) => {
      if (this.subscriptionGeneration !== generation) return;
      this.ingest(event.payload);
    }).then((unlisten) => {
      if (this.subscriptionGeneration !== generation || this.activeSubscribers === 0) {
        unlisten();
        return;
      }
      this.unlisten = unlisten;
    }).catch(() => {
      if (this.subscriptionGeneration === generation) this.listening = false;
    });
  }

  private stopListening(): void {
    this.subscriptionGeneration += 1;
    this.listening = false;
    const unlisten = this.unlisten;
    this.unlisten = null;
    unlisten?.();
  }
}

export const toolLiveOutputStore = new ToolLiveOutputStore();

export function useToolLiveOutput(
  sessionId: string,
  callId: string,
  active: boolean,
): AgentToolProgressEvent | null {
  const subscribe = useCallback(
    (listener: () => void) => (active ? toolLiveOutputStore.subscribe(sessionId, callId, listener) : () => {}),
    [active, callId, sessionId],
  );
  const snapshot = useCallback(
    () => (active ? toolLiveOutputStore.get(sessionId, callId) : null),
    [active, callId, sessionId],
  );
  const value = useSyncExternalStore(subscribe, snapshot, snapshot);

  useEffect(() => {
    if (!active) toolLiveOutputStore.clearCallIfIdle(sessionId, callId);
  }, [active, callId, sessionId]);

  return value;
}
