import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useRef } from 'react';
import { terminalRegistry } from '@/components/terminal/registry/terminal-registry';
import { useActiveController } from '../hooks/use-active-controller';

class RO {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = (globalThis.ResizeObserver ?? RO) as typeof ResizeObserver;

vi.mock('@/lib/tauri', () => ({
  invokeGetSessionStatus: vi.fn().mockResolvedValue({
    sessionId: 's1',
    status: 'connected',
    message: 'ready',
  }),
  invokeMarkSessionReady: vi.fn().mockResolvedValue(undefined),
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
  shouldFocus = true,
) {
  return renderHook(
    ({ sid, focus }: { sid: string | null; focus: boolean }) => {
      const paneRef = useRef<HTMLDivElement | null>(host);
      return useActiveController(paneRef, sid, focus);
    },
    { initialProps: { sid: activeSessionId, focus: shouldFocus } },
  );
}

function createController(sessionId: string) {
  let controller: ReturnType<typeof terminalRegistry.create>;
  act(() => {
    controller = terminalRegistry.create(
      sessionId,
      vi.fn(),
      vi.fn(),
      () => 'connected',
      vi.fn(),
    );
  });
  return controller!;
}

describe('useActiveController', () => {
  beforeEach(() => {
    terminalRegistry.disposeAll();
  });

  afterEach(() => {
    act(() => {
      terminalRegistry.disposeAll();
    });
    document.body.innerHTML = '';
  });

  it('attaches the active controller container to the pane', () => {
    const host = setupPane();
    const controller = createController('s1');
    renderControllerHook(host, 's1');
    expect(host.firstChild).toBe(controller.container);
  });

  it('detaches previous controller on active-id change', () => {
    const host = setupPane();
    const c1 = createController('s1');
    const c2 = createController('s2');
    const { rerender } = renderControllerHook(host, 's1');
    expect(host.firstChild).toBe(c1.container);
    rerender({ sid: 's2', focus: true });
    expect(c1.host).toBeNull();
    expect(host.firstChild).toBe(c2.container);
  });

  it('detaches on unmount', () => {
    const host = setupPane();
    const controller = createController('s1');
    const { unmount } = renderControllerHook(host, 's1');
    expect(host.firstChild).toBe(controller.container);
    unmount();
    expect(controller.host).toBeNull();
    expect(host.firstChild).toBeNull();
  });

  it('routes searchNext to the active controller searchAddon', () => {
    const host = setupPane();
    const controller = createController('s1');
    const spy = vi.spyOn(controller.searchAddon, 'findNext');
    const { result } = renderControllerHook(host, 's1');
    result.current.searchNext('foo');
    expect(spy).toHaveBeenCalledWith('foo', undefined);
  });

  it('routes searchPrevious to the active controller searchAddon', () => {
    const host = setupPane();
    const controller = createController('s1');
    const spy = vi.spyOn(controller.searchAddon, 'findPrevious');
    const { result } = renderControllerHook(host, 's1');
    result.current.searchPrevious('bar');
    expect(spy).toHaveBeenCalledWith('bar', undefined);
  });

  it('routes clearSearch to clearDecorations', () => {
    const host = setupPane();
    const controller = createController('s1');
    const spy = vi.spyOn(controller.searchAddon, 'clearDecorations');
    const { result } = renderControllerHook(host, 's1');
    result.current.clearSearch();
    expect(spy).toHaveBeenCalled();
  });

  it('focus calls the active controller focus method', () => {
    const host = setupPane();
    const controller = createController('s1');
    const spy = vi.spyOn(controller, 'focus');
    const { result } = renderControllerHook(host, 's1');
    result.current.focus();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('focus is no-op when activeSessionId is null', () => {
    const host = setupPane();
    const { result } = renderControllerHook(host, null);
    expect(() => result.current.focus()).not.toThrow();
  });

  it('search controls are stable across rerenders with same active id', () => {
    const host = setupPane();
    createController('s1');
    const { result, rerender } = renderControllerHook(host, 's1');
    const first = result.current;
    rerender({ sid: 's1', focus: true });
    expect(result.current.searchNext).toBe(first.searchNext);
    expect(result.current.searchPrevious).toBe(first.searchPrevious);
    expect(result.current.clearSearch).toBe(first.clearSearch);
  });

  it('no-op when controller does not exist for active id', () => {
    const host = setupPane();
    expect(() => renderControllerHook(host, 'missing')).not.toThrow();
    expect(host.firstChild).toBeNull();
  });

  it('attaches when the controller is created after the hook renders', () => {
    const host = setupPane();
    renderControllerHook(host, 's1');
    expect(host.firstChild).toBeNull();

    const controller = createController('s1');

    expect(host.firstChild).toBe(controller.container);
  });

  it('does not auto-focus a controller in an inactive terminal group', async () => {
    const host = setupPane();
    const controller = createController('s1');
    const spy = vi.spyOn(controller, 'focus');

    renderControllerHook(host, 's1', false);
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

    expect(spy).not.toHaveBeenCalled();
  });
});
