import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useToast } from '../useToast';
import { useToastStore } from '@/stores/toastStore';

describe('useToast', () => {
  beforeEach(() => {
    useToastStore.setState({ toasts: [] });
  });

  it('keeps action references stable across renders', () => {
    const { result, rerender } = renderHook(() => useToast());
    const first = result.current;

    rerender();

    expect(result.current).toBe(first);
    expect(result.current.info).toBe(first.info);
    expect(result.current.success).toBe(first.success);
    expect(result.current.error).toBe(first.error);
  });

  it('adds the requested toast variant', () => {
    const { result } = renderHook(() => useToast());

    act(() => result.current.success('Saved', 1500));

    expect(useToastStore.getState().toasts).toEqual([
      expect.objectContaining({
        message: 'Saved',
        variant: 'success',
        duration: 1500,
      }),
    ]);
  });
});
