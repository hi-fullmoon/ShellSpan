export interface AiStreamDeltaBatcher {
  push: (requestId: string, text: string) => void;
  flush: (requestId: string) => void;
  dispose: () => void;
}

type RequestFrame = (callback: FrameRequestCallback) => number;
type CancelFrame = (handle: number) => void;

/**
 * Coalesces token-sized AI stream events into at most one store update per
 * animation frame. Terminal events can call flush first so their final state
 * transition never overtakes buffered text.
 */
export function createAiStreamDeltaBatcher(
  applyDelta: (requestId: string, text: string) => void,
  requestFrame: RequestFrame = window.requestAnimationFrame.bind(window),
  cancelFrame: CancelFrame = window.cancelAnimationFrame.bind(window),
): AiStreamDeltaBatcher {
  const pending = new Map<string, string>();
  let frame: number | null = null;

  const flushAll = (): void => {
    frame = null;
    const deltas = [...pending];
    pending.clear();
    for (const [requestId, text] of deltas) applyDelta(requestId, text);
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
    dispose: () => {
      if (frame !== null) cancelFrame(frame);
      frame = null;
      pending.clear();
    },
  };
}
