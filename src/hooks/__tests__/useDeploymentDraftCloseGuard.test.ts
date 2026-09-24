import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useDeploymentWorkflowStore } from '@/stores/deploymentWorkflowStore';
import { useDeploymentDraftCloseGuard } from '../useDeploymentDraftCloseGuard';

const closeHandlers: Array<(event: { preventDefault: () => void }) => void> = [];
const unlistenMock = vi.fn();
const windowMock = {
  onCloseRequested: vi.fn((handler: (event: { preventDefault: () => void }) => void) => {
    closeHandlers.push(handler);
    return Promise.resolve(unlistenMock);
  }),
  show: vi.fn().mockResolvedValue(undefined),
  setFocus: vi.fn().mockResolvedValue(undefined),
  close: vi.fn().mockResolvedValue(undefined),
};

vi.mock('@tauri-apps/api/webviewWindow', () => ({
  getCurrentWebviewWindow: () => windowMock,
}));

describe('useDeploymentDraftCloseGuard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    closeHandlers.length = 0;
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    useDeploymentWorkflowStore.getState().reset();
  });

  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  });

  it('lets the close request through when the draft is clean', async () => {
    const { result } = renderHook(() => useDeploymentDraftCloseGuard());
    await act(() => Promise.resolve());
    expect(closeHandlers).toHaveLength(1);

    const event = { preventDefault: vi.fn() };
    act(() => closeHandlers[0](event));
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(result.current.confirmOpen).toBe(false);
  });

  it('blocks the close request and offers a discard confirmation for a dirty draft', async () => {
    act(() => {
      useDeploymentWorkflowStore.getState().startTemplate('blank', 'Draft', 'profile-1', '/srv/example');
    });
    const { result } = renderHook(() => useDeploymentDraftCloseGuard());
    await act(() => Promise.resolve());

    const event = { preventDefault: vi.fn() };
    act(() => closeHandlers[0](event));
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(result.current.confirmOpen).toBe(true);
    expect(windowMock.show).toHaveBeenCalled();
    expect(windowMock.setFocus).toHaveBeenCalled();
    expect(windowMock.close).not.toHaveBeenCalled();

    act(() => result.current.confirmClose());
    expect(windowMock.close).toHaveBeenCalledTimes(1);
  });

  it('keeps the window open when the discard confirmation is canceled', async () => {
    act(() => {
      useDeploymentWorkflowStore.getState().startTemplate('blank', 'Draft', 'profile-1', '/srv/example');
    });
    const { result } = renderHook(() => useDeploymentDraftCloseGuard());
    await act(() => Promise.resolve());

    act(() => closeHandlers[0]({ preventDefault: vi.fn() }));
    act(() => result.current.cancelClose());
    expect(result.current.confirmOpen).toBe(false);
    expect(windowMock.close).not.toHaveBeenCalled();
  });
});
