import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useRef } from 'react';
import { terminalRegistry } from '@/components/Terminal/registry/terminalRegistry';
import { useActiveController } from './useActiveController';

class RO {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = (globalThis.ResizeObserver ?? RO) as typeof ResizeObserver;

vi.mock('@/lib/tauri', () => ({
  invokeWriteSession: vi.fn().mockResolvedValue(undefined),
  invokeResizeSession: vi.fn().mockResolvedValue(undefined),
  listenToSshData: vi.fn().mockResolvedValue(() => {}),
  listenToSshStatus: vi.fn().mockResolvedValue(() => {}),
  listenToSshClosed: vi.fn().mockResolvedValue(() => {}),
}));

function setupPane() {
  const host = document.createElement('div');
  document.body.appendChild(host);
  return host;
}

function renderControllerHook(
  host: HTMLDivElement,
  activeSessionId: string | null,
) {
  return renderHook(
    ({ sid }: { sid: string | null }) => {
      const paneRef = useRef<HTMLDivElement | null>(host);
      return useActiveController(paneRef, sid);
    },
    { initialProps: { sid: activeSessionId } },
  );
}

describe('useActiveController', () => {
  beforeEach(() => {
    terminalRegistry.disposeAll();
  });

  afterEach(() => {
    terminalRegistry.disposeAll();
    document.body.innerHTML = '';
  });

  it('attaches the active controller container to the pane', () => {
    const host = setupPane();
    const controller = terminalRegistry.create('s1', vi.fn(), vi.fn());
    renderControllerHook(host, 's1');
    expect(host.firstChild).toBe(controller.container);
  });

  it('detaches previous controller on active-id change', () => {
    const host = setupPane();
    const c1 = terminalRegistry.create('s1', vi.fn(), vi.fn());
    const c2 = terminalRegistry.create('s2', vi.fn(), vi.fn());
    const { rerender } = renderControllerHook(host, 's1');
    expect(host.firstChild).toBe(c1.container);
    rerender({ sid: 's2' });
    expect(c1.host).toBeNull();
    expect(host.firstChild).toBe(c2.container);
  });

  it('detaches on unmount', () => {
    const host = setupPane();
    const controller = terminalRegistry.create('s1', vi.fn(), vi.fn());
    const { unmount } = renderControllerHook(host, 's1');
    expect(host.firstChild).toBe(controller.container);
    unmount();
    expect(controller.host).toBeNull();
    expect(host.firstChild).toBeNull();
  });

  it('routes searchNext to the active controller searchAddon', () => {
    const host = setupPane();
    const controller = terminalRegistry.create('s1', vi.fn(), vi.fn());
    const spy = vi.spyOn(controller.searchAddon, 'findNext');
    const { result } = renderControllerHook(host, 's1');
    result.current.searchNext('foo');
    expect(spy).toHaveBeenCalledWith('foo');
  });

  it('routes searchPrevious to the active controller searchAddon', () => {
    const host = setupPane();
    const controller = terminalRegistry.create('s1', vi.fn(), vi.fn());
    const spy = vi.spyOn(controller.searchAddon, 'findPrevious');
    const { result } = renderControllerHook(host, 's1');
    result.current.searchPrevious('bar');
    expect(spy).toHaveBeenCalledWith('bar');
  });

  it('routes clearSearch to clearDecorations', () => {
    const host = setupPane();
    const controller = terminalRegistry.create('s1', vi.fn(), vi.fn());
    const spy = vi.spyOn(controller.searchAddon, 'clearDecorations');
    const { result } = renderControllerHook(host, 's1');
    result.current.clearSearch();
    expect(spy).toHaveBeenCalled();
  });

  it('search controls are no-op when activeSessionId is null', () => {
    const host = setupPane();
    const { result } = renderControllerHook(host, null);
    expect(() => {
      result.current.searchNext('foo');
      result.current.searchPrevious('bar');
      result.current.clearSearch();
    }).not.toThrow();
  });

  it('search controls are stable across rerenders with same active id', () => {
    const host = setupPane();
    terminalRegistry.create('s1', vi.fn(), vi.fn());
    const { result, rerender } = renderControllerHook(host, 's1');
    const first = result.current;
    rerender({ sid: 's1' });
    expect(result.current.searchNext).toBe(first.searchNext);
    expect(result.current.searchPrevious).toBe(first.searchPrevious);
    expect(result.current.clearSearch).toBe(first.clearSearch);
  });

  it('no-op when controller does not exist for active id', () => {
    const host = setupPane();
    expect(() => renderControllerHook(host, 'missing')).not.toThrow();
    expect(host.firstChild).toBeNull();
  });
});
