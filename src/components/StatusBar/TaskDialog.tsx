import { Dialog, DialogPanel, DialogHeader, DialogFooter } from '../Dialog';
import type { OperationItem } from '../../stores/operationStore';
import { t } from '../../lib/i18n';
import { StatusBlock } from './StatusBlock';
import { operationIcon, operationTone } from './statusHelpers';

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
        <div className="mt-3 flex flex-wrap gap-2">
          {operations.map((operation) => (
            <div key={operation.id} className="flex w-16 flex-col items-center gap-1">
              <StatusBlock
                icon={operationIcon(operation.type)}
                progress={operation.progress}
                tone={operationTone(operation.status)}
                size="lg"
              />
              <span className="max-w-full truncate text-[10px]" title={operation.title}>
                {operation.title}
              </span>
              {operation.status === 'running' && operation.canCancel ? (
                <button
                  className="text-[10px] text-sky-400 hover:text-sky-300"
                  onClick={() => onCancel(operation.id)}
                  type="button"
                >
                  {t('operationStatus.actions.cancel')}
                </button>
              ) : operation.status !== 'running' && operation.status !== 'cancelling' ? (
                <button
                  className="text-[10px] text-slate-400 hover:text-slate-300"
                  onClick={() => onRemove(operation.id)}
                  type="button"
                >
                  {t('operationStatus.actions.remove')}
                </button>
              ) : null}
            </div>
          ))}
        </div>
        {cancellable.length > 0 ? (
          <DialogFooter>
            <button className="btn-danger" onClick={onCancelAll} type="button">
              {t('operationStatus.actions.cancelAll')}
            </button>
          </DialogFooter>
        ) : null}
      </DialogPanel>
    </Dialog>
  );
}
