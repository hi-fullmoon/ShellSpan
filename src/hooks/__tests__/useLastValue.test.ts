import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useLastValue } from '../useLastValue';

interface LastValueProps {
  value: string | undefined;
}

function renderLastValue(value: string | undefined) {
  return renderHook(({ value: v }: LastValueProps) => useLastValue(v), {
    initialProps: { value },
  });
}

describe('useLastValue', () => {
  it('returns the initial value when provided', () => {
    const { result } = renderLastValue('a');
    expect(result.current).toBe('a');
  });

  it('keeps the last value when the value becomes undefined', () => {
    const { result, rerender } = renderLastValue('a');

    rerender({ value: undefined });

    expect(result.current).toBe('a');
  });

  it('eagerly updates the snapshot when a new value arrives', () => {
    const { result, rerender } = renderLastValue('a');

    rerender({ value: undefined });
    rerender({ value: 'b' });

    expect(result.current).toBe('b');
  });

  it('does not capture undefined as a value', () => {
    const { result, rerender } = renderLastValue(undefined);

    rerender({ value: 'a' });
    rerender({ value: undefined });
    rerender({ value: 'b' });

    expect(result.current).toBe('b');
  });

  it('keeps the snapshot across a closed-then-reopened dialog', () => {
    const { result, rerender } = renderLastValue('a');

    rerender({ value: undefined });
    rerender({ value: undefined });

    expect(result.current).toBe('a');
  });
});
