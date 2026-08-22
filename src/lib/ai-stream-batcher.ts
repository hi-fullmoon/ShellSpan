export interface AiStreamDeltaBatcher {
  push: (requestId: string, text: string) => void;
  flush: (requestId: string) => void;
  flushAll: () => void;
  dispose: () => void;
}

type RequestFrame = (callback: FrameRequestCallback) => number;
type CancelFrame = (handle: number) => void;

export const AI_STREAM_COMMIT_INTERVAL_MS = 50;

let registeredBatcher: AiStreamDeltaBatcher | null = null;

export function registerAiStreamDeltaBatcher(
  batcher: AiStreamDeltaBatcher,
): () => void {
  registeredBatcher = batcher;
  return () => {
    if (registeredBatcher === batcher) registeredBatcher = null;
  };
}

export function flushAiStreamDelta(requestId: string): void {
  registeredBatcher?.flush(requestId);
}

/**
 * Coalesces token-sized AI stream events and caps store commits to a smooth
 * 20fps cadence. Terminal events can call flush first so their final state
 * transition never overtakes buffered text.
 */
export function createAiStreamDeltaBatcher(
  applyDelta: (requestId: string, text: string) => void,
  requestFrame: RequestFrame = window.requestAnimationFrame.bind(window),
  cancelFrame: CancelFrame = window.cancelAnimationFrame.bind(window),
  commitIntervalMs = AI_STREAM_COMMIT_INTERVAL_MS,
): AiStreamDeltaBatcher {
  const pending = new Map<string, string>();
  let frame: number | null = null;
  let lastCommitAt = Number.NEGATIVE_INFINITY;

  const applyPending = (): void => {
    const deltas = [...pending];
    pending.clear();
    for (const [requestId, text] of deltas) applyDelta(requestId, text);
  };

  const flushAll: FrameRequestCallback = (timestamp) => {
    frame = null;
    if (pending.size === 0) return;
    if (timestamp - lastCommitAt < commitIntervalMs) {
      schedule();
      return;
    }
    lastCommitAt = timestamp;
    applyPending();
  };

  const schedule = (): void => {
    if (frame !== null) return;
    frame = requestFrame(flushAll);
  };

  return {
    push: (requestId, text) => {
      if (!text) return;
      pending.set(requestId, (pending.get(requestId) ?? '') + text);
      schedule();
    },
    flush: (requestId) => {
      const text = pending.get(requestId);
      if (text === undefined) return;
      pending.delete(requestId);
      if (pending.size === 0 && frame !== null) {
        cancelFrame(frame);
        frame = null;
      }
      applyDelta(requestId, text);
    },
    flushAll: () => {
      if (frame !== null) cancelFrame(frame);
      frame = null;
      applyPending();
    },
    dispose: () => {
      if (frame !== null) cancelFrame(frame);
      frame = null;
      pending.clear();
    },
  };
}
