import { describe, expect, it, vi } from 'vitest';
import { createAiStreamDeltaBatcher } from '@/lib/ai-stream-batcher';

describe('createAiStreamDeltaBatcher', () => {
  it('coalesces token deltas into one update per animation frame', () => {
    const frames: FrameRequestCallback[] = [];
    const applyDelta = vi.fn();
    const batcher = createAiStreamDeltaBatcher(
      applyDelta,
      (callback) => {
        frames.push(callback);
        return frames.length;
      },
      vi.fn(),
    );

    batcher.push('request-1', 'Hel');
    batcher.push('request-1', 'lo');
    batcher.push('request-2', 'Other');

    expect(frames).toHaveLength(1);
    expect(applyDelta).not.toHaveBeenCalled();

    frames[0](0);

    expect(applyDelta.mock.calls).toEqual([
      ['request-1', 'Hello'],
      ['request-2', 'Other'],
    ]);
  });

  it('flushes buffered text before a terminal stream event', () => {
    const frames: FrameRequestCallback[] = [];
    const cancelFrame = vi.fn();
    const applyDelta = vi.fn();
    const batcher = createAiStreamDeltaBatcher(
      applyDelta,
      (callback) => {
        frames.push(callback);
        return 7;
      },
      cancelFrame,
    );

    batcher.push('request-1', 'Final chunk');
    batcher.flush('request-1');

    expect(applyDelta).toHaveBeenCalledOnce();
    expect(applyDelta).toHaveBeenCalledWith('request-1', 'Final chunk');
    expect(cancelFrame).toHaveBeenCalledWith(7);
  });
});
