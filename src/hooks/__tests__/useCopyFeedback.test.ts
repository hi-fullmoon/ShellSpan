import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toast } from 'sonner';
import { useCopyFeedback } from '../useCopyFeedback';

const { write } = vi.hoisted(() => ({ write: vi.fn() }));
vi.mock('@/lib/clipboard', () => ({ writeClipboardText: write }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/hooks/useI18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  write.mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('shared copy feedback', () => {
  it('does not show success or a second error when an action reports failure', async () => {
    const { result } = renderHook(() => useCopyFeedback());
    await act(async () => { expect(await result.current.run(() => false)).toBe(false); });
    expect(result.current.copied).toBe(false);
    expect(toast.error).not.toHaveBeenCalled();
    await act(async () => { expect(await result.current.run(() => true)).toBe(true); });
    expect(result.current.copied).toBe(true);
    expect(toast.success).not.toHaveBeenCalled();
  });
  it('ignores repeated clicks while reading and while showing success, then permits another copy', async () => {
    const { result } = renderHook(() => useCopyFeedback());
    let resolve!: (text: string) => void;
    const source = vi.fn(() => new Promise<string>(done => { resolve = done; }));
    let pending!: Promise<boolean>;
    act(() => { pending = result.current.copy(source); });
    await act(() => result.current.copy(source));
    expect(source).toHaveBeenCalledTimes(1);
    expect(result.current.copied).toBe(false);
    await act(async () => { resolve('complete\ncontent'); await pending; });
    expect(write).toHaveBeenCalledExactlyOnceWith('complete\ncontent');
    expect(result.current.copied).toBe(true);
    await act(() => result.current.copy('ignored'));
    expect(write).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(1_000));
    expect(result.current.copied).toBe(false);
    await act(() => result.current.copy('next'));
    expect(write).toHaveBeenLastCalledWith('next');
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('reports one failure and allows retry without showing success', async () => {
    write.mockRejectedValueOnce(new Error('locked'));
    const { result } = renderHook(() => useCopyFeedback('Copy failed'));
    await act(() => result.current.copy('content'));
    expect(result.current.copied).toBe(false);
    expect(toast.error).toHaveBeenCalledExactlyOnceWith('Copy failed');
    await act(() => result.current.copy('content'));
    expect(result.current.copied).toBe(true);
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('does not write or show feedback when an asynchronous read finishes after unmount', async () => {
    const { result, unmount } = renderHook(() => useCopyFeedback());
    let resolve!: (text: string) => void;
    const pending = result.current.copy(() => new Promise<string>(done => { resolve = done; }));
    unmount();
    resolve('stale');
    await pending;
    expect(write).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('cleans up the feedback timer when its surface unmounts', async () => {
    const { result, unmount } = renderHook(() => useCopyFeedback());
    await act(() => result.current.copy('content'));
    expect(result.current.copied).toBe(true);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
