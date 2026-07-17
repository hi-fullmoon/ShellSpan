import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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

  it('keeps successful deletes until they are closed manually', () => {
    useTransferStore.setState({
      operations: [
        {
          ...failedUpload,
          kind: 'delete',
          status: 'running',
          processedBytes: 100,
          completedSteps: 1,
        },
      ],
    });
    render(<TransferProgress />);

    expect(useTransferStore.getState().operations).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'common.close' }));
    expect(useTransferStore.getState().operations).toHaveLength(0);
  });

  it('restores a completed delete from the task row', async () => {
    const undo = vi.fn().mockResolvedValue(undefined);
    useTransferStore.setState({
      operations: [
        {
          operationId: 'delete-1',
          kind: 'delete',
          currentPath: '/tmp/large-folder',
          totalBytes: 0,
          processedBytes: 0,
          totalSteps: 10,
          completedSteps: 10,
          status: 'running',
          undo,
        },
      ],
    });
    render(<TransferProgress />);

    fireEvent.click(
      screen.getByRole('button', { name: 'sftp.transfer.undoDelete' }),
    );
    await waitFor(() => expect(undo).toHaveBeenCalledOnce());
    expect(screen.getByText('sftp.transfer.restored')).toBeInTheDocument();
  });

  it('shows the trash status while undo remains available', () => {
    const undo = vi.fn().mockResolvedValue(undefined);
    useTransferStore.setState({
      operations: [
        {
          operationId: 'trashed-delete-1',
          kind: 'delete',
          currentPath: '/tmp/draft.txt',
          totalBytes: 0,
          processedBytes: 0,
          totalSteps: 1,
          completedSteps: 1,
          status: 'running',
          undo,
        },
      ],
    });
    render(<TransferProgress />);

    expect(screen.getByText('sftp.transfer.trashed')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'sftp.transfer.undoDelete' }),
    ).toBeInTheDocument();
  });
});
