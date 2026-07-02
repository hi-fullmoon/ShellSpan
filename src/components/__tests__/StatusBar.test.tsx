// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StatusBlock } from '../StatusBar/StatusBlock';
import { StatusBlockTooltip } from '../StatusBar/StatusBlockTooltip';
import { TaskBlocks } from '../StatusBar/TaskBlocks';
import { TaskDialog } from '../StatusBar/TaskDialog';
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
});

describe('TaskBlocks', () => {
  beforeEach(() => {
    cleanup();
    useOperationStore.setState({ operations: [], expanded: false });
  });

  afterEach(() => {
    cleanup();
    useOperationStore.setState({ operations: [], expanded: false });
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

  it('renders overflow button when blocks exceed container width', async () => {
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
        expect(container.querySelector('[data-testid="task-overflow-button"]')).toBeInTheDocument();
      });
    } finally {
      globalThis.ResizeObserver = originalResizeObserver;
    }
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
