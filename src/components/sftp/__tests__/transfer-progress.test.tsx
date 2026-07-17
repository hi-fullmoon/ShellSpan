import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { TransferProgress } from '@/components/sftp/transfer-progress';
import { useTransferStore, type TransferOperation } from '@/stores/transferStore';

vi.mock('@/hooks/useI18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

const failedUpload: TransferOperation = {
  operationId: 'upload-1',
  kind: 'upload',
  currentPath: '/tmp/apple-touch-icon.png',
  totalBytes: 100,
  processedBytes: 20,
  totalSteps: 1,
  completedSteps: 0,
  status: 'failed',
  error: 'connection lost',
  retry: vi.fn().mockResolvedValue(undefined),
};

describe('TransferProgress', () => {
  beforeEach(() => {
    useTransferStore.setState({ operations: [] });
  });

  it('renders nothing without transfers', () => {
    const { container } = render(<TransferProgress />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows failed uploads as file rows and retries them', async () => {
    useTransferStore.setState({ operations: [failedUpload] });
    render(<TransferProgress />);

    expect(screen.getByText('apple-touch-icon.png')).toBeInTheDocument();
    expect(screen.getByText('sftp.transfer.uploadFailed')).toHaveAttribute(
      'title',
      'connection lost',
    );
    expect(screen.getByRole('button', { name: 'common.retry' })).toHaveClass(
      'h-6',
    );
    expect(
      screen.getByRole('button', { name: 'sftp.transfer.discard' }),
    ).toHaveClass('h-6');

    fireEvent.click(screen.getByRole('button', { name: 'common.retry' }));
    await waitFor(() => expect(failedUpload.retry).toHaveBeenCalledOnce());
  });

  it('discards failed uploads', () => {
    useTransferStore.setState({ operations: [failedUpload] });
    render(<TransferProgress />);

    fireEvent.click(screen.getByRole('button', { name: 'sftp.transfer.discard' }));
    expect(useTransferStore.getState().operations).toHaveLength(0);
  });

  it('uses a compact height for each transfer row', () => {
    useTransferStore.setState({ operations: [failedUpload] });
    render(<TransferProgress />);

    expect(screen.getByText('apple-touch-icon.png').parentElement).toHaveClass(
      'h-10',
      'bg-app-surface-muted/60',
    );
  });

  it('uses a thin progress track for active transfers', () => {
    useTransferStore.setState({
      operations: [{ ...failedUpload, status: 'running' }],
    });
    render(<TransferProgress />);

    expect(
      document.body.querySelector('[data-slot="transfer-progress-track"]'),
    ).toHaveClass('h-0.5');
  });

  it('removes successful transfers after two seconds', () => {
    vi.useFakeTimers();
    try {
      useTransferStore.setState({
        operations: [
          {
            ...failedUpload,
            status: 'running',
            processedBytes: 100,
            completedSteps: 1,
          },
        ],
      });
      render(<TransferProgress />);

      act(() => vi.advanceTimersByTime(1999));
      expect(useTransferStore.getState().operations).toHaveLength(1);

      act(() => vi.advanceTimersByTime(1));
      expect(useTransferStore.getState().operations).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
