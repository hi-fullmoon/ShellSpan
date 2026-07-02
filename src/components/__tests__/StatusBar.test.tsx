// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, waitFor, fireEvent, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StatusBlock } from '../StatusBar/StatusBlock';
import { StatusBlockTooltip } from '../StatusBar/StatusBlockTooltip';
import { SystemBlocks } from '../StatusBar/SystemBlocks';
import { TaskBlocks } from '../StatusBar/TaskBlocks';
import type { SessionState } from '../../types';
import { TaskDialog } from '../StatusBar/TaskDialog';
import { StatusBar } from '../StatusBar';
import { useOperationStore, type OperationItem } from '../../stores/operationStore';
import { operationTone, operationTypeLabel, operationStatusText } from '../StatusBar/statusHelpers';

describe('StatusBlock', () => {
  it('renders small block with icon and progress bar', () => {
    const { container } = render(
      <StatusBlock icon={<span data-testid="icon">I</span>} progress={45} tone="active" />,
    );
    expect(container.querySelector('[data-testid="icon"]')).toBeInTheDocument();
    expect(container.querySelector('[data-testid="status-block-progress"]')).toHaveStyle({ width: '45%' });
  });

  it('renders large block when size is lg', () => {
    const { container } = render(
      <StatusBlock icon={<span data-testid="icon">I</span>} progress={80} tone="success" size="lg" />,
    );
    expect(container.querySelector('[data-testid="status-block"]')).toHaveClass('h-10', 'w-10');
  });
});

describe('statusHelpers', () => {
  it('maps running to active tone', () => {
    expect(operationTone('running')).toBe('active');
  });

  it('maps completed to success tone', () => {
    expect(operationTone('completed')).toBe('success');
  });

  it('returns localized operation type label', () => {
    expect(operationTypeLabel('upload')).toBe('上传');
  });

  it('returns localized status text', () => {
    expect(operationStatusText('running')).toBe('进行中');
  });
});

describe('StatusBlockTooltip', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders nothing when closed', () => {
    const { container } = render(
      <StatusBlockTooltip open={false} anchorRef={{ current: null }} data={{ title: 'Upload' }} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders detail content when open', () => {
    const { getByText } = render(
      <StatusBlockTooltip open={true} anchorRef={{ current: null }} data={{ title: 'Upload file.txt', subtitle: '进行中', detail: '45%' }} />,
    );
    expect(getByText('Upload file.txt')).toBeInTheDocument();
    expect(getByText('进行中')).toBeInTheDocument();
    expect(getByText('45%')).toBeInTheDocument();
  });

  it('clamps tooltip position to stay within left viewport edge', () => {
    Object.defineProperty(window, 'innerWidth', { value: 1024, configurable: true, writable: true });
    const anchorRef = {
      current: {
        getBoundingClientRect: () =>
          ({ left: 5, top: 100, width: 20, height: 20, right: 25, bottom: 120, x: 5, y: 100, toJSON: () => {} }) as DOMRect,
      } as HTMLElement,
    };

    render(<StatusBlockTooltip open anchorRef={anchorRef} data={{ title: 'Title' }} />);
    const tooltip = document.querySelector('[role="tooltip"]') as HTMLElement;
    Object.defineProperty(tooltip, 'offsetWidth', { value: 200, configurable: true });

    act(() => {
      window.dispatchEvent(new Event('resize'));
    });

    // margin 8 + half tooltip width 100 = 108
    expect(tooltip).toHaveStyle({ left: '108px' });
  });

  it('clamps tooltip position to stay within right viewport edge', () => {
    Object.defineProperty(window, 'innerWidth', { value: 1024, configurable: true, writable: true });
    const anchorRef = {
      current: {
        getBoundingClientRect: () =>
          ({ left: 1010, top: 100, width: 20, height: 20, right: 1030, bottom: 120, x: 1010, y: 100, toJSON: () => {} }) as DOMRect,
      } as HTMLElement,
    };

    render(<StatusBlockTooltip open anchorRef={anchorRef} data={{ title: 'Title' }} />);
    const tooltip = document.querySelector('[role="tooltip"]') as HTMLElement;
    Object.defineProperty(tooltip, 'offsetWidth', { value: 200, configurable: true });

    act(() => {
      window.dispatchEvent(new Event('resize'));
    });

    // 1024 - margin 8 - half tooltip width 100 = 916
    expect(tooltip).toHaveStyle({ left: '916px' });
  });

  it('clamps tooltip position to stay below top viewport edge', () => {
    Object.defineProperty(window, 'innerHeight', { value: 768, configurable: true, writable: true });
    const anchorRef = {
      current: {
        getBoundingClientRect: () =>
          ({ left: 100, top: 5, width: 20, height: 20, right: 120, bottom: 25, x: 100, y: 5, toJSON: () => {} }) as DOMRect,
      } as HTMLElement,
    };

    render(<StatusBlockTooltip open anchorRef={anchorRef} data={{ title: 'Title' }} />);
    const tooltip = document.querySelector('[role="tooltip"]') as HTMLElement;
    Object.defineProperty(tooltip, 'offsetWidth', { value: 200, configurable: true });
    Object.defineProperty(tooltip, 'offsetHeight', { value: 100, configurable: true });

    act(() => {
      window.dispatchEvent(new Event('resize'));
    });

    // margin 8 + tooltip height 100 = 108
    expect(tooltip).toHaveStyle({ top: '108px' });
  });
});

describe('TaskBlocks', () => {
  beforeEach(() => {
    cleanup();
    useOperationStore.setState({ operations: [], expanded: false });
  });

  afterEach(() => {
    cleanup();
    useOperationStore.setState({ operations: [], expanded: false });
    vi.useRealTimers();
  });

  it('renders visible task blocks', () => {
    const operations = [
      { id: 'op-1', type: 'upload', title: 'A', status: 'running', progress: 10, canCancel: true, createdAt: 1 },
      { id: 'op-2', type: 'download', title: 'B', status: 'completed', progress: 100, canCancel: true, createdAt: 2 },
    ] as OperationItem[];

    const { container } = render(
      <TaskBlocks operations={operations} onCancel={() => {}} onRemove={() => {}} onOpenDialog={() => {}} />,
    );
    expect(container.querySelectorAll('[data-testid="status-block"]')).toHaveLength(2);
  });

  it('renders overflow button with dots icon when blocks exceed container width', async () => {
    const originalResizeObserver = globalThis.ResizeObserver;
    const callbacks: Array<() => void> = [];

    globalThis.ResizeObserver = class MockResizeObserver {
      constructor(callback: () => void) {
        callbacks.push(callback);
      }

      observe() {}

      unobserve() {}

      disconnect() {}
    } as unknown as typeof ResizeObserver;

    try {
      const operations = Array.from({ length: 5 }, (_, i) => ({
        id: `op-${i}`,
        type: 'upload',
        title: `File ${i}`,
        status: 'running',
        progress: 10,
        canCancel: true,
        createdAt: i,
      })) as OperationItem[];

      const { container } = render(
        <TaskBlocks operations={operations} onCancel={() => {}} onRemove={() => {}} onOpenDialog={() => {}} />,
      );

      const wrapper = container.firstChild as HTMLElement;
      Object.defineProperty(wrapper, 'clientWidth', { value: 40, configurable: true });

      callbacks[0]?.();

      await waitFor(() => {
        const button = container.querySelector('[data-testid="task-overflow-button"]');
        expect(button).toBeInTheDocument();
        expect(button).toContainHTML('svg');
        expect(button).toHaveAttribute('title', expect.stringContaining('5'));
      });
    } finally {
      globalThis.ResizeObserver = originalResizeObserver;
    }
  });

  it('shows tooltip with cancel action after hover delay', () => {
    vi.useFakeTimers();
    const onCancel = vi.fn();
    const operations = [
      { id: 'op-1', type: 'upload', title: 'A', status: 'running', progress: 10, canCancel: true, createdAt: 1 },
    ] as OperationItem[];

    const { container } = render(
      <TaskBlocks operations={operations} onCancel={onCancel} onRemove={() => {}} onOpenDialog={() => {}} />,
    );

    const block = container.querySelector('[data-testid="status-block"]') as HTMLElement;
    fireEvent.mouseEnter(block);

    expect(document.querySelector('[role="tooltip"]')).not.toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(200);
    });

    const tooltip = document.querySelector('[role="tooltip"]') as HTMLElement;
    expect(tooltip).toBeInTheDocument();
    expect(tooltip).toHaveTextContent('取消');

    const cancelButton = tooltip.querySelector('button') as HTMLElement;
    fireEvent.click(cancelButton);
    expect(onCancel).toHaveBeenCalledWith('op-1');
  });

  it('shows tooltip with remove action for completed operations after hover delay', () => {
    vi.useFakeTimers();
    const onRemove = vi.fn();
    const operations = [
      { id: 'op-1', type: 'download', title: 'B', status: 'completed', progress: 100, canCancel: true, createdAt: 2 },
    ] as OperationItem[];

    const { container } = render(
      <TaskBlocks operations={operations} onCancel={() => {}} onRemove={onRemove} onOpenDialog={() => {}} />,
    );

    const block = container.querySelector('[data-testid="status-block"]') as HTMLElement;
    fireEvent.mouseEnter(block);

    act(() => {
      vi.advanceTimersByTime(200);
    });

    const tooltip = document.querySelector('[role="tooltip"]') as HTMLElement;
    expect(tooltip).toBeInTheDocument();
    expect(tooltip).toHaveTextContent('移除');

    const removeButton = tooltip.querySelector('button') as HTMLElement;
    fireEvent.click(removeButton);
    expect(onRemove).toHaveBeenCalledWith('op-1');
  });

  it('keeps tooltip open when cursor moves from block to tooltip across the gap', () => {
    vi.useFakeTimers();
    const onCancel = vi.fn();
    const operations = [
      { id: 'op-1', type: 'upload', title: 'A', status: 'running', progress: 10, canCancel: true, createdAt: 1 },
    ] as OperationItem[];

    const { container } = render(
      <TaskBlocks operations={operations} onCancel={onCancel} onRemove={() => {}} onOpenDialog={() => {}} />,
    );

    const block = container.querySelector('[data-testid="status-block"]') as HTMLElement;
    fireEvent.mouseEnter(block);

    act(() => {
      vi.advanceTimersByTime(200);
    });

    const tooltip = document.querySelector('[role="tooltip"]') as HTMLElement;
    expect(tooltip).toBeInTheDocument();

    fireEvent.mouseLeave(block);
    act(() => {
      vi.advanceTimersByTime(50);
    });
    expect(document.querySelector('[role="tooltip"]')).toBeInTheDocument();

    fireEvent.mouseEnter(tooltip);
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(document.querySelector('[role="tooltip"]')).toBeInTheDocument();

    fireEvent.click(tooltip.querySelector('button') as HTMLElement);
    expect(onCancel).toHaveBeenCalledWith('op-1');
  });
});

describe('TaskDialog', () => {
  beforeEach(() => {
    cleanup();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders all tasks when open', () => {
    const operations = [
      { id: 'op-1', type: 'upload', title: 'A', status: 'running', progress: 10, canCancel: true, createdAt: 1 },
      { id: 'op-2', type: 'download', title: 'B', status: 'completed', progress: 100, canCancel: true, createdAt: 2 },
    ] as OperationItem[];

    const { getAllByTestId } = render(
      <TaskDialog open={true} onClose={() => {}} operations={operations} onCancel={() => {}} onRemove={() => {}} onCancelAll={() => {}} />,
    );
    expect(getAllByTestId('status-block')).toHaveLength(2);
  });

  it('does not render when closed', () => {
    const operations = [
      { id: 'op-1', type: 'upload', title: 'A', status: 'running', progress: 10, canCancel: true, createdAt: 1 },
    ] as OperationItem[];

    const { container } = render(
      <TaskDialog open={false} onClose={() => {}} operations={operations} onCancel={() => {}} onRemove={() => {}} onCancelAll={() => {}} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('shows cancel button for running cancellable operations', () => {
    const operations = [
      { id: 'op-1', type: 'upload', title: 'A', status: 'running', progress: 10, canCancel: true, createdAt: 1 },
    ] as OperationItem[];

    const { getByTestId } = render(
      <TaskDialog open={true} onClose={() => {}} operations={operations} onCancel={() => {}} onRemove={() => {}} onCancelAll={() => {}} />,
    );
    expect(getByTestId('task-cancel-button')).toBeInTheDocument();
  });

  it('shows remove button for completed operations', () => {
    const operations = [
      { id: 'op-1', type: 'download', title: 'B', status: 'completed', progress: 100, canCancel: true, createdAt: 2 },
    ] as OperationItem[];

    const { getByTestId } = render(
      <TaskDialog open={true} onClose={() => {}} operations={operations} onCancel={() => {}} onRemove={() => {}} onCancelAll={() => {}} />,
    );
    expect(getByTestId('task-remove-button')).toBeInTheDocument();
  });

  it('shows cancel all button when there are cancellable operations', () => {
    const operations = [
      { id: 'op-1', type: 'upload', title: 'A', status: 'running', progress: 10, canCancel: true, createdAt: 1 },
      { id: 'op-2', type: 'download', title: 'B', status: 'running', progress: 20, canCancel: true, createdAt: 2 },
    ] as OperationItem[];

    const { getByTestId } = render(
      <TaskDialog open={true} onClose={() => {}} operations={operations} onCancel={() => {}} onRemove={() => {}} onCancelAll={() => {}} />,
    );
    expect(getByTestId('task-cancel-all-button')).toBeInTheDocument();
  });

  it('calls onCancel when cancel button is clicked', async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    const operations = [
      { id: 'op-1', type: 'upload', title: 'A', status: 'running', progress: 10, canCancel: true, createdAt: 1 },
    ] as OperationItem[];

    const { getByTestId } = render(
      <TaskDialog open={true} onClose={() => {}} operations={operations} onCancel={onCancel} onRemove={() => {}} onCancelAll={() => {}} />,
    );
    await user.click(getByTestId('task-cancel-button'));
    expect(onCancel).toHaveBeenCalledWith('op-1');
  });

  it('calls onRemove when remove button is clicked', async () => {
    const user = userEvent.setup();
    const onRemove = vi.fn();
    const operations = [
      { id: 'op-1', type: 'download', title: 'B', status: 'completed', progress: 100, canCancel: true, createdAt: 2 },
    ] as OperationItem[];

    const { getByTestId } = render(
      <TaskDialog open={true} onClose={() => {}} operations={operations} onCancel={() => {}} onRemove={onRemove} onCancelAll={() => {}} />,
    );
    await user.click(getByTestId('task-remove-button'));
    expect(onRemove).toHaveBeenCalledWith('op-1');
  });

  it('calls onCancelAll when cancel all button is clicked', async () => {
    const user = userEvent.setup();
    const onCancelAll = vi.fn();
    const operations = [
      { id: 'op-1', type: 'upload', title: 'A', status: 'running', progress: 10, canCancel: true, createdAt: 1 },
    ] as OperationItem[];

    const { getByTestId } = render(
      <TaskDialog open={true} onClose={() => {}} operations={operations} onCancel={() => {}} onRemove={() => {}} onCancelAll={onCancelAll} />,
    );
    await user.click(getByTestId('task-cancel-all-button'));
    expect(onCancelAll).toHaveBeenCalled();
  });
});

describe('SystemBlocks', () => {
  beforeEach(() => {
    cleanup();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('renders session count block', () => {
    const sessions = [
      { sessionId: 's1', status: 'connected', host: 'host1' },
      { sessionId: 's2', status: 'connecting', host: 'host2' },
    ] as SessionState[];

    const { container } = render(
      <SystemBlocks sessions={sessions} activeSession={sessions[0]} updateState={{ phase: 'idle' }} updateDownloadProgress={undefined} />,
    );
    expect(container.querySelectorAll('[data-testid="status-block"]')).toHaveLength(2);
  });

  it('shows localized subtitle for active session status', () => {
    vi.useFakeTimers();
    const sessions = [{ sessionId: 's1', status: 'connected', host: 'host1' }] as SessionState[];

    const { container } = render(
      <SystemBlocks sessions={sessions} activeSession={sessions[0]} updateState={{ phase: 'idle' }} updateDownloadProgress={undefined} />,
    );

    const block = container.querySelector('[data-testid="status-block"]') as HTMLElement;
    fireEvent.mouseEnter(block);

    act(() => {
      vi.advanceTimersByTime(200);
    });

    const tooltip = document.querySelector('[role="tooltip"]') as HTMLElement;
    expect(tooltip).toBeInTheDocument();
    expect(tooltip).toHaveTextContent('已连接');
    expect(tooltip).not.toHaveTextContent('connected');
  });

  it('shows localized subtitle for update phase', () => {
    vi.useFakeTimers();

    const { container } = render(
      <SystemBlocks sessions={[]} activeSession={undefined} updateState={{ phase: 'downloading' }} updateDownloadProgress={50} />,
    );

    const block = container.querySelector('[data-testid="status-block"]') as HTMLElement;
    fireEvent.mouseEnter(block);

    act(() => {
      vi.advanceTimersByTime(200);
    });

    const tooltip = document.querySelector('[role="tooltip"]') as HTMLElement;
    expect(tooltip).toBeInTheDocument();
    expect(tooltip).toHaveTextContent('正在下载更新');
    expect(tooltip).not.toHaveTextContent('downloading');
  });
});

describe('StatusBar', () => {
  beforeEach(() => {
    cleanup();
    useOperationStore.setState({ operations: [], expanded: false });
  });

  afterEach(() => {
    cleanup();
    useOperationStore.setState({ operations: [], expanded: false });
  });

  it('renders null when empty', () => {
    const { container } = render(<StatusBar sessions={[]} activeSession={undefined} updateState={{ phase: 'idle' }} updateDownloadProgress={undefined} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders task blocks when operations exist', () => {
    useOperationStore.getState().startOperation({ id: 'op-1', type: 'upload', title: 'A', progress: 10 });
    const { container } = render(
      <StatusBar sessions={[]} activeSession={undefined} updateState={{ phase: 'idle' }} updateDownloadProgress={undefined} />,
    );
    expect(container.querySelector('[data-testid="status-block"]')).toBeInTheDocument();
  });

  it('renders system blocks when update is available', () => {
    const { container } = render(
      <StatusBar sessions={[]} activeSession={undefined} updateState={{ phase: 'update_available' }} updateDownloadProgress={undefined} />,
    );
    expect(container.querySelector('[data-testid="status-bar"]')).toBeInTheDocument();
    expect(container.querySelectorAll('[data-testid="status-block"]')).toHaveLength(1);
  });
});

describe('StatusBar overflow', () => {
  beforeEach(() => {
    cleanup();
    useOperationStore.setState({ operations: [], expanded: false });
  });

  afterEach(() => {
    cleanup();
    useOperationStore.setState({ operations: [], expanded: false });
  });

  it('opens task dialog when overflow button is clicked', async () => {
    const user = userEvent.setup();
    const originalResizeObserver = globalThis.ResizeObserver;
    const callbacks: Array<() => void> = [];

    globalThis.ResizeObserver = class MockResizeObserver {
      constructor(callback: () => void) {
        callbacks.push(callback);
      }

      observe() {}

      unobserve() {}

      disconnect() {}
    } as unknown as typeof ResizeObserver;

    try {
      const operations = Array.from({ length: 20 }, (_, i) => ({
        id: `op-${i}`,
        type: 'upload',
        title: `File ${i}`,
        status: 'running',
        progress: 10,
        canCancel: true,
        createdAt: i,
      })) as OperationItem[];

      useOperationStore.setState({ operations });

      const { container } = render(
        <StatusBar sessions={[]} activeSession={undefined} updateState={{ phase: 'idle' }} updateDownloadProgress={undefined} />,
      );

      const taskBlocksContainer = container.querySelector('[data-testid="status-bar"] > div');
      if (!taskBlocksContainer) throw new Error('TaskBlocks container not found');
      Object.defineProperty(taskBlocksContainer, 'clientWidth', { value: 40, configurable: true });

      callbacks[0]?.();

      const overflow = await waitFor(() => {
        const button = container.querySelector('[data-testid="task-overflow-button"]');
        expect(button).toBeInTheDocument();
        return button as HTMLElement;
      });

      await user.click(overflow);
      expect(document.querySelector('[role="dialog"]')).toBeInTheDocument();
    } finally {
      globalThis.ResizeObserver = originalResizeObserver;
    }
  });
});

