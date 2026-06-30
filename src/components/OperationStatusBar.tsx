import { useMemo } from 'react';
import { useOperationStore, type OperationItem, type OperationType } from '../stores/operationStore';
import { t } from '../lib/i18n';
import { cn } from '../lib/ui';
import { ChevronDownIcon, CloseIcon, DownloadIcon, FileIcon, TrashIcon, UploadIcon } from './Icons';

function OperationIcon({ type }: { type: OperationType }) {
  switch (type) {
    case 'upload':
      return <UploadIcon className="rotate-180" />;
    case 'download':
      return <DownloadIcon />;
    case 'delete':
      return <TrashIcon />;
    case 'open-with-default':
      return <FileIcon />;
  }
}

function operationTypeLabel(type: OperationType): string {
  switch (type) {
    case 'upload':
      return t('operationStatus.type.upload');
    case 'download':
      return t('operationStatus.type.download');
    case 'delete':
      return t('operationStatus.type.delete');
    case 'open-with-default':
      return t('operationStatus.type.openWithDefault');
  }
}

function statusTone(status: OperationItem['status']): string {
  switch (status) {
    case 'running':
      return 'text-sky-300';
    case 'cancelling':
      return 'text-amber-300';
    case 'completed':
      return 'text-emerald-300';
    case 'failed':
      return 'text-rose-300';
    case 'cancelled':
      return 'text-slate-400';
  }
}

function statusText(status: OperationItem['status']): string {
  switch (status) {
    case 'running':
      return t('operationStatus.status.running');
    case 'cancelling':
      return t('operationStatus.status.cancelling');
    case 'completed':
      return t('operationStatus.status.completed');
    case 'failed':
      return t('operationStatus.status.failed');
    case 'cancelled':
      return t('operationStatus.status.cancelled');
  }
}

function ProgressBar({ progress, tone }: { progress: number; tone: 'active' | 'success' | 'error' | 'neutral' }) {
  const trackClass =
    tone === 'active'
      ? 'bg-slate-700/50'
      : tone === 'success'
        ? 'bg-emerald-900/30'
        : tone === 'error'
          ? 'bg-rose-900/30'
          : 'bg-slate-700/30';
  const barClass =
    tone === 'active'
      ? 'bg-sky-400'
      : tone === 'success'
        ? 'bg-emerald-400'
        : tone === 'error'
          ? 'bg-rose-400'
          : 'bg-slate-400';

  return (
    <div className={cn('h-1.5 w-full overflow-hidden rounded-full', trackClass)}>
      <div
        className={cn('h-full transition-[width] duration-150', barClass)}
        style={{ width: `${Math.min(100, Math.max(0, progress))}%` }}
      />
    </div>
  );
}

function OperationRow({ operation, onCancel, onRemove }: { operation: OperationItem; onCancel: () => void; onRemove: () => void }) {
  const isRunning = operation.status === 'running';
  const isCancelling = operation.status === 'cancelling';
  const isCompleted = operation.status === 'completed';
  const isFailed = operation.status === 'failed';

  return (
    <div className="flex items-start gap-2 px-2 py-1.5">
      <span className={cn('mt-0.5 shrink-0', statusTone(operation.status))}>
        <OperationIcon type={operation.type} />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-[12px]" data-testid="operation-row-title">{operation.title}</span>
          <span className={cn('shrink-0 text-[11px]', statusTone(operation.status))}>{statusText(operation.status)}</span>
        </div>
        <ProgressBar
          progress={operation.progress}
          tone={isCompleted ? 'success' : isFailed ? 'error' : isRunning || isCancelling ? 'active' : 'neutral'}
        />
        {operation.totalText ? (
          <span className="text-subtle text-[10px]" data-testid="operation-row-total">{operation.totalText}</span>
        ) : null}
        {operation.errorMessage ? (
          <span className="text-[10px] leading-4 text-rose-300">{operation.errorMessage}</span>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        {(isRunning || isCancelling) && operation.canCancel ? (
          <button
            className="icon-btn h-6 w-6 px-0"
            disabled={isCancelling}
            onClick={onCancel}
            title={t('operationStatus.actions.cancel')}
            type="button"
          >
            <CloseIcon />
          </button>
        ) : null}
        {!isRunning && !isCancelling ? (
          <button
            className="icon-btn h-6 w-6 px-0"
            onClick={onRemove}
            title={t('operationStatus.actions.remove')}
            type="button"
          >
            <CloseIcon />
          </button>
        ) : null}
      </div>
    </div>
  );
}

export function OperationStatusBar() {
  const { operations, expanded, setExpanded, setCancelling, removeOperation, clearCompleted } = useOperationStore();

  const activeCount = useMemo(
    () => operations.filter((op) => op.status === 'running' || op.status === 'cancelling').length,
    [operations],
  );
  const completedCount = operations.length - activeCount;
  const overallProgress = useMemo(() => {
    const active = operations.filter((op) => op.status === 'running' || op.status === 'cancelling');
    if (active.length === 0) {
      return 0;
    }

    return Math.round(active.reduce((sum, op) => sum + op.progress, 0) / active.length);
  }, [operations]);

  const firstActive = operations.find((op) => op.status === 'running' || op.status === 'cancelling');

  if (operations.length === 0) {
    return null;
  }

  return (
    <div className="operation-status-bar surface border-t flex flex-col" data-testid="operation-status-bar">
      <div className="flex h-8 items-center gap-2 px-2">
        <span className="text-subtle shrink-0">
          {activeCount > 0 ? (
            <span className="flex items-center gap-1.5 text-[11px]">
              <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-sky-400" />
              {t('operationStatus.summary.running', { count: activeCount, progress: overallProgress })}
            </span>
          ) : (
            <span className="text-[11px]">{t('operationStatus.summary.completed', { count: completedCount })}</span>
          )}
        </span>

        {firstActive ? (
          <span className="min-w-0 flex-1 truncate text-[11px]">{firstActive.title}</span>
        ) : (
          <span className="min-w-0 flex-1" />
        )}

        {activeCount > 0 ? (
          <button
            className="icon-btn h-6 px-1.5 text-[11px]"
            onClick={() => {
              operations.forEach((op) => {
                if (op.status === 'running' && op.canCancel) {
                  setCancelling(op.id);
                }
              });
            }}
            type="button"
          >
            {t('operationStatus.actions.cancelAll')}
          </button>
        ) : null}

        {completedCount > 0 ? (
          <button
            className="icon-btn h-6 px-1.5 text-[11px]"
            onClick={() => clearCompleted()}
            type="button"
          >
            {t('operationStatus.actions.clearCompleted')}
          </button>
        ) : null}

        <button
          className="icon-btn h-6 w-6 px-0"
          onClick={() => setExpanded(!expanded)}
          title={expanded ? t('operationStatus.actions.collapse') : t('operationStatus.actions.expand')}
          type="button"
        >
          <ChevronDownIcon className={cn('transition-transform', expanded && 'rotate-180')} />
        </button>
      </div>

      {expanded ? (
        <div className="max-h-48 overflow-auto border-t py-1">
          {operations.map((operation) => (
            <OperationRow
              key={operation.id}
              operation={operation}
              onCancel={() => setCancelling(operation.id)}
              onRemove={() => removeOperation(operation.id)}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
