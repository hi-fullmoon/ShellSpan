import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useDisableContextMenu } from '../useDisableContextMenu';

describe('useDisableContextMenu', () => {
  it('prevents the native menu without blocking custom context-menu handlers', () => {
    const customHandler = vi.fn();
    const target = document.createElement('div');
    target.addEventListener('contextmenu', customHandler);
    document.body.appendChild(target);
    const { unmount } = renderHook(() => useDisableContextMenu());

    const event = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
    });
    target.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(customHandler).toHaveBeenCalledOnce();

    unmount();
    target.remove();
  });
});
