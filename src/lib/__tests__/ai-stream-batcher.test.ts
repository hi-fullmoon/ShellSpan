import { describe, expect, it, vi } from 'vitest';
import {
  createAiStreamDeltaBatcher,
  flushAiStreamDelta,
  registerAiStreamDeltaBatcher,
} from '@/lib/ai-stream-batcher';

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

  it('caps store commits while keeping incoming text buffered', () => {
    const frames: FrameRequestCallback[] = [];
    const applyDelta = vi.fn();
    const batcher = createAiStreamDeltaBatcher(
      applyDelta,
      (callback) => {
        frames.push(callback);
        return frames.length;
      },
      vi.fn(),
      50,
    );

    batcher.push('request-1', 'A');
    frames[0](0);
    batcher.push('request-1', 'B');
    frames[1](16);
    batcher.push('request-1', 'C');
    frames[2](50);

    expect(applyDelta.mock.calls).toEqual([
      ['request-1', 'A'],
      ['request-1', 'BC'],
    ]);
  });

  it('lets application lifecycle handlers flush the registered batcher', () => {
    const applyDelta = vi.fn();
    const cancelFrame = vi.fn();
    const batcher = createAiStreamDeltaBatcher(
      applyDelta,
      vi.fn(() => 9),
      cancelFrame,
    );
    const unregister = registerAiStreamDeltaBatcher(batcher);

    try {
      batcher.push('request-1', 'Persist me');
      flushAiStreamDelta('request-1');

      expect(applyDelta).toHaveBeenCalledWith('request-1', 'Persist me');
      expect(cancelFrame).toHaveBeenCalledWith(9);
    } finally {
      unregister();
      batcher.dispose();
    }
  });
});
