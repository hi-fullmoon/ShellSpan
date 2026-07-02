import { useEffect, useMemo, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { SessionState, UpdateState } from '../../types';
import { useOperationStore } from '../../stores/operationStore';
import { TaskBlocks } from './TaskBlocks';
import { TaskDialog } from './TaskDialog';

const AUTO_HIDE_DELAY_MS = 3000;

export interface StatusBarProps {
  sessions?: SessionState[];
  activeSession?: SessionState;
  updateState?: UpdateState;
  updateDownloadProgress?: number;
}

export function StatusBar(_props: StatusBarProps) {
  const { operations, setCancelling, removeOperation, clearCompleted } = useOperationStore(
    useShallow((state) => ({
      operations: state.operations,
      setCancelling: state.setCancelling,
      removeOperation: state.removeOperation,
      clearCompleted: state.clearCompleted,
    })),
  );
  const [dialogOpen, setDialogOpen] = useState(false);

  const allCompleted = useMemo(
    () =>
      operations.length > 0 &&
      operations.every((op) => op.status !== 'running' && op.status !== 'cancelling'),
    [operations],
  );

  useEffect(() => {
    if (!allCompleted) {
      return;
    }

    const timer = setTimeout(() => {
      clearCompleted();
    }, AUTO_HIDE_DELAY_MS);

    return () => clearTimeout(timer);
  }, [allCompleted, clearCompleted]);

  if (operations.length === 0) {
    return null;
  }

  const handleCancel = async (id: string) => {
    const operation = operations.find((op) => op.id === id);
    if (operation?.cancel) {
      await operation.cancel();
    } else {
      setCancelling(id);
    }
  };

  const handleCancelAll = () => {
    operations.forEach((op) => {
      if (op.status === 'running' && op.canCancel) {
        void handleCancel(op.id);
      }
    });
  };

  return (
    <div
      className="surface border-t border-t-[var(--app-border)] flex h-auto min-h-[30px] max-h-40 items-stretch gap-2 px-2 py-1"
      data-testid="status-bar"
    >
      <TaskBlocks
        operations={operations}
        onCancel={handleCancel}
        onRemove={(id) => removeOperation(id)}
        onOpenDialog={() => setDialogOpen(true)}
      />

      <TaskDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        operations={operations}
        onCancel={handleCancel}
        onRemove={(id) => removeOperation(id)}
        onCancelAll={handleCancelAll}
      />
    </div>
  );
}
