import { useMemo } from 'react';
import { cn } from '../../lib/ui';
import { t } from '../../lib/i18n';
import { ProgressBar } from './ProgressBar';
import { operationActionLabel, operationIcon, operationStatusText, operationTone } from './statusHelpers';
import { useOperationSpeedEta } from './useOperationSpeedEta';
import type { TaskRowProps } from './types';

export function TaskRow({ operation, onCancel, onRemove, className }: TaskRowProps) {
  const isRunning = operation.status === 'running';
  const isCancelling = operation.status === 'cancelling';
  const { speedText, etaText } = useOperationSpeedEta(operation);

  const progressText = useMemo(() => {
    const parts: string[] = [];
    if (operation.totalText) {
      parts.push(operation.totalText);
    }

    if ((isRunning || isCancelling) && speedText) {
      parts.push(speedText);
    }

    if (isRunning && etaText) {
      parts.push(t('operationStatus.eta.about', { eta: etaText }));
    }

    if (parts.length === 0 || !isRunning) {
      parts.push(operationStatusText(operation.status));
    }

    return parts.join(', ');
  }, [operation.totalText, operation.status, isRunning, isCancelling, speedText, etaText]);

  const actionLabel = operationActionLabel(operation.status);
  const handleAction = isRunning || isCancelling ? onCancel : onRemove;

  return (
    <div
      className={cn('flex h-9 items-center gap-2 px-2', className)}
      data-testid="task-row"
      title={operation.errorMessage}
    >
      <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center text-[var(--app-text-soft)]">
        {operationIcon(operation.type)}
      </span>
      <span
        className="min-w-0 shrink truncate text-[12px] font-medium text-[var(--app-text)]"
        title={operation.title}
      >
        {operation.title}
      </span>
      <span className="shrink-0 text-[11px] text-[var(--app-text-soft)]" data-testid="task-row-progress-text">
        {progressText}
      </span>
      <ProgressBar
        progress={operation.progress}
        tone={operationTone(operation.status)}
        className="h-2 min-w-24 flex-1"
      />
      <button
        className={cn(
          'shrink-0 text-[11px] font-medium transition',
          isRunning || isCancelling
            ? 'text-rose-400 hover:text-rose-300'
            : 'text-slate-400 hover:text-slate-300',
        )}
        disabled={isCancelling}
        onClick={handleAction}
        type="button"
        data-testid="task-row-action"
      >
        {actionLabel}
      </button>
    </div>
  );
}
