import { type RefObject } from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useSystemFileDrop } from '../useSystemFileDrop';

const handlers: Array<(event: { payload: { type: string; position: { x: number; y: number }; paths: string[] } }) => void> = [];
const mockUnlisten = vi.fn();
const mockOnDrop = vi.fn();

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: vi.fn().mockReturnValue({
    onDragDropEvent: vi.fn().mockImplementation((handler) => {
      handlers.push(handler);
      return Promise.resolve(mockUnlisten);
    }),
  }),
}));

function createElement(rect: Partial<DOMRect>): HTMLElement {
  const element = document.createElement('div');
  vi.spyOn(element, 'getBoundingClientRect').mockReturnValue(rect as DOMRect);
  return element;
}

describe('useSystemFileDrop', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    handlers.length = 0;
  });

  it('returns no hover when no drag event has fired', () => {
    const leftRef = { current: createElement({ left: 0, right: 400, top: 0, bottom: 600 }) };
    const rightRef = { current: createElement({ left: 400, right: 800, top: 0, bottom: 600 }) };
    const { result } = renderHook(() =>
      useSystemFileDrop({
        leftPaneRef: leftRef as RefObject<HTMLElement>,
        rightPaneRef: rightRef as RefObject<HTMLElement>,
        onDrop: mockOnDrop,
      }),
    );
    expect(result.current.dragActive).toBe(false);
    expect(result.current.hoveredSide).toBeNull();
  });

  it('detects hover over left pane', async () => {
    const leftRef = { current: createElement({ left: 0, right: 400, top: 0, bottom: 600 }) };
    const rightRef = { current: createElement({ left: 400, right: 800, top: 0, bottom: 600 }) };
    const { result } = renderHook(() =>
      useSystemFileDrop({
        leftPaneRef: leftRef as RefObject<HTMLElement>,
        rightPaneRef: rightRef as RefObject<HTMLElement>,
        onDrop: mockOnDrop,
      }),
    );
    handlers[0]!({ payload: { type: 'over', position: { x: 100, y: 100 }, paths: [] } });
    await waitFor(() => expect(result.current.hoveredSide).toBe('local'));
    expect(result.current.dragActive).toBe(true);
  });

  it('detects hover over right pane', async () => {
    const leftRef = { current: createElement({ left: 0, right: 400, top: 0, bottom: 600 }) };
    const rightRef = { current: createElement({ left: 400, right: 800, top: 0, bottom: 600 }) };
    const { result } = renderHook(() =>
      useSystemFileDrop({
        leftPaneRef: leftRef as RefObject<HTMLElement>,
        rightPaneRef: rightRef as RefObject<HTMLElement>,
        onDrop: mockOnDrop,
      }),
    );
    handlers[0]!({ payload: { type: 'over', position: { x: 500, y: 100 }, paths: [] } });
    await waitFor(() => expect(result.current.hoveredSide).toBe('remote'));
  });

  it('calls onDrop when dropped on a pane', async () => {
    const leftRef = { current: createElement({ left: 0, right: 400, top: 0, bottom: 600 }) };
    const rightRef = { current: createElement({ left: 400, right: 800, top: 0, bottom: 600 }) };
    renderHook(() =>
      useSystemFileDrop({
        leftPaneRef: leftRef as RefObject<HTMLElement>,
        rightPaneRef: rightRef as RefObject<HTMLElement>,
        onDrop: mockOnDrop,
      }),
    );
    handlers[0]!({ payload: { type: 'drop', position: { x: 500, y: 100 }, paths: ['/a/file.txt'] } });
    await waitFor(() => expect(mockOnDrop).toHaveBeenCalledWith(['/a/file.txt'], 'remote'));
  });

  it('does not call onDrop when canDrop returns false', async () => {
    const leftRef = { current: createElement({ left: 0, right: 400, top: 0, bottom: 600 }) };
    const rightRef = { current: createElement({ left: 400, right: 800, top: 0, bottom: 600 }) };
    renderHook(() =>
      useSystemFileDrop({
        leftPaneRef: leftRef as RefObject<HTMLElement>,
        rightPaneRef: rightRef as RefObject<HTMLElement>,
        onDrop: mockOnDrop,
        canDrop: () => false,
      }),
    );
    handlers[0]!({ payload: { type: 'drop', position: { x: 500, y: 100 }, paths: ['/a/file.txt'] } });
    await waitFor(() => expect(mockOnDrop).not.toHaveBeenCalled());
  });

  it('unlistens on unmount once the listener is registered', async () => {
    const leftRef = { current: createElement({ left: 0, right: 400, top: 0, bottom: 600 }) };
    const rightRef = { current: createElement({ left: 400, right: 800, top: 0, bottom: 600 }) };
    const { unmount } = renderHook(() =>
      useSystemFileDrop({
        leftPaneRef: leftRef as RefObject<HTMLElement>,
        rightPaneRef: rightRef as RefObject<HTMLElement>,
        onDrop: mockOnDrop,
      }),
    );
    unmount();
    await waitFor(() => expect(mockUnlisten).toHaveBeenCalledTimes(1));
  });

  it('unlistens when unmounted before the listener registration completes', async () => {
    const leftRef = { current: createElement({ left: 0, right: 400, top: 0, bottom: 600 }) };
    const rightRef = { current: createElement({ left: 400, right: 800, top: 0, bottom: 600 }) };
    let resolveRegistration!: (unlisten: () => void) => void;
    const pendingRegistration = new Promise<() => void>((resolve) => {
      resolveRegistration = resolve;
    });
    vi.mocked(getCurrentWindow().onDragDropEvent).mockImplementationOnce((handler) => {
      handlers.push(handler as (typeof handlers)[number]);
      return pendingRegistration;
    });

    const { unmount } = renderHook(() =>
      useSystemFileDrop({
        leftPaneRef: leftRef as RefObject<HTMLElement>,
        rightPaneRef: rightRef as RefObject<HTMLElement>,
        onDrop: mockOnDrop,
      }),
    );
    unmount();

    const lateUnlisten = vi.fn();
    resolveRegistration(lateUnlisten);
    await waitFor(() => expect(lateUnlisten).toHaveBeenCalledTimes(1));
  });
});
