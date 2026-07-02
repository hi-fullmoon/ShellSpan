import { useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { SessionState, UpdateState } from '../../types';
import { useOperationStore } from '../../stores/operationStore';
import { TaskBlocks } from './TaskBlocks';
import { TaskDialog } from './TaskDialog';
import { SystemBlocks } from './SystemBlocks';

interface StatusBarProps {
  sessions: SessionState[];
  activeSession: SessionState | undefined;
  updateState: UpdateState;
  updateDownloadProgress: number | undefined;
}

export function StatusBar({ sessions, activeSession, updateState, updateDownloadProgress }: StatusBarProps) {
  const { operations, setCancelling, removeOperation } = useOperationStore(
    useShallow((state) => ({
      operations: state.operations,
      setCancelling: state.setCancelling,
      removeOperation: state.removeOperation,
    })),
  );
  const [dialogOpen, setDialogOpen] = useState(false);

  const hasSystemInfo =
    sessions.length > 0 ||
    updateState.phase === 'checking' ||
    updateState.phase === 'update_available' ||
    updateState.phase === 'downloading' ||
    updateState.phase === 'downloaded' ||
    updateState.phase === 'error';

  if (operations.length === 0 && !hasSystemInfo) {
    return null;
  }

  const handleCancelAll = () => {
    operations.forEach((op) => {
      if (op.status === 'running' && op.canCancel) {
        setCancelling(op.id);
      }
    });
  };

  return (
    <div
      className="surface border-t flex h-[30px] items-center gap-2 px-2"
      data-testid="status-bar"
    >
      {operations.length > 0 ? (
        <TaskBlocks
          operations={operations}
          onCancel={(id) => setCancelling(id)}
          onRemove={(id) => removeOperation(id)}
          onOpenDialog={() => setDialogOpen(true)}
        />
      ) : null}

      {operations.length > 0 && hasSystemInfo ? (
        <div className="h-4 w-px shrink-0 bg-[var(--app-border)]" />
      ) : null}

      {hasSystemInfo ? (
        <SystemBlocks
          sessions={sessions}
          activeSession={activeSession}
          updateState={updateState}
          updateDownloadProgress={updateDownloadProgress}
        />
      ) : null}

      <TaskDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        operations={operations}
        onCancel={(id) => setCancelling(id)}
        onRemove={(id) => removeOperation(id)}
        onCancelAll={handleCancelAll}
      />
    </div>
  );
}
