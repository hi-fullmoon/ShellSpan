// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { act, cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { OperationStatusBar } from '../OperationStatusBar';
import { useOperationStore } from '../../stores/operationStore';
import { render } from '../../test-utils';

describe('OperationStatusBar', () => {
  beforeEach(() => {
    cleanup();
    document.body.innerHTML = '';
    useOperationStore.setState({ operations: [], expanded: false });
  });

  afterEach(() => {
    cleanup();
    document.body.innerHTML = '';
    useOperationStore.setState({ operations: [], expanded: false });
  });

  it('renders nothing when there are no operations', () => {
    const { container } = render(<OperationStatusBar />);
    expect(within(container).queryByText(/个操作进行中/i)).not.toBeInTheDocument();
  });

  it('shows a running operation summary', () => {
    act(() => {
      useOperationStore.getState().startOperation({
        id: 'op-1',
        type: 'upload',
        title: 'Upload file.txt',
        progress: 45,
        totalText: '4.5 MB / 10 MB',
      });
    });

    const { container } = render(<OperationStatusBar />);
    expect(within(container).getByText('1 个操作进行中 · 总进度 45%')).toBeInTheDocument();
    expect(within(container).getByText('Upload file.txt')).toBeInTheDocument();
  });

  it('expands to show operation details', async () => {
    act(() => {
      useOperationStore.getState().startOperation({
        id: 'op-1',
        type: 'download',
        title: 'Download archive.zip',
        progress: 20,
        totalText: '2 MB / 10 MB',
      });
    });

    const { container } = render(<OperationStatusBar />);
    await userEvent.click(within(container).getByTitle('展开'));

    expect(within(container).getByTestId('operation-row-title')).toHaveTextContent('Download archive.zip');
    expect(within(container).getByTestId('operation-row-total')).toHaveTextContent('2 MB / 10 MB');
  });

  it('cancels a running operation when cancel button is clicked', async () => {
    act(() => {
      useOperationStore.getState().startOperation({
        id: 'op-1',
        type: 'upload',
        title: 'Upload file.txt',
        progress: 10,
      });
    });

    const { container } = render(<OperationStatusBar />);
    await userEvent.click(within(container).getByTitle('展开'));

    await userEvent.click(within(container).getByTitle('取消'));

    expect(useOperationStore.getState().operations[0]?.status).toBe('cancelling');
  });

  it('removes a completed operation', async () => {
    act(() => {
      useOperationStore.getState().startOperation({
        id: 'op-1',
        type: 'delete',
        title: 'Delete file.txt',
        progress: 100,
      });
      useOperationStore.getState().setOperationStatus('op-1', 'completed');
    });

    const { container } = render(<OperationStatusBar />);
    await userEvent.click(within(container).getByTitle('展开'));

    await userEvent.click(within(container).getByTitle('移除'));

    expect(useOperationStore.getState().operations).toHaveLength(0);
  });

  it('clears all completed operations', async () => {
    act(() => {
      useOperationStore.getState().startOperation({ id: 'op-1', type: 'upload', title: 'A', progress: 100 });
      useOperationStore.getState().setOperationStatus('op-1', 'completed');
      useOperationStore.getState().startOperation({ id: 'op-2', type: 'upload', title: 'B', progress: 50 });
    });

    const { container } = render(<OperationStatusBar />);
    await userEvent.click(within(container).getByRole('button', { name: /清除已完成/i }));

    expect(useOperationStore.getState().operations).toHaveLength(1);
    expect(useOperationStore.getState().operations[0]?.id).toBe('op-2');
  });
});
