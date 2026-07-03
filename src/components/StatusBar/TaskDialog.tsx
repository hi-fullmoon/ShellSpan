import { Dialog, DialogPanel, DialogHeader, DialogFooter } from '../ui';
import type { OperationItem } from '../../stores/operationStore';
import { t } from '../../lib/i18n';
import { TaskRow } from './TaskRow';

interface TaskDialogProps {
  open: boolean;
  onClose: () => void;
  operations: OperationItem[];
  onCancel: (id: string) => void;
  onRemove: (id: string) => void;
  onCancelAll: () => void;
}

export function TaskDialog({ open, onClose, operations, onCancel, onRemove, onCancelAll }: TaskDialogProps) {
  const cancellable = operations.filter((op) => op.status === 'running' && op.canCancel);

  return (
    <Dialog open={open} onClose={onClose}>
      <DialogPanel className="w-full max-w-md p-4" ariaLabel={t('statusBar.taskDialog.title')}>
        <DialogHeader title={t('statusBar.taskDialog.title')} onClose={onClose} />
        <div className="mt-3 flex flex-col gap-1">
          {operations.map((operation) => (
            <TaskRow
              key={operation.id}
              operation={operation}
              onCancel={() => onCancel(operation.id)}
              onRemove={() => onRemove(operation.id)}
            />
          ))}
        </div>
        {cancellable.length > 0 ? (
          <DialogFooter>
            <button className="btn-danger" data-testid="task-cancel-all-button" onClick={onCancelAll} type="button">
              {t('operationStatus.actions.cancelAll')}
            </button>
          </DialogFooter>
        ) : null}
      </DialogPanel>
    </Dialog>
  );
}
