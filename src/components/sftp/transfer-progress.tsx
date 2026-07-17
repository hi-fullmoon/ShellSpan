import React from 'react';
import { CircleAlertIcon, FileIcon, XIcon } from 'lucide-react';
import { cn, formatBytes } from '@/lib/utils';
import { useI18n } from '@/hooks/useI18n';
import { Button } from '@/components/ui/button';
import {
  useTransferStore,
  isTransferComplete,
  formatTransferProgress,
} from '@/stores/transferStore';

const COMPLETED_TRANSFER_DISMISS_DELAY_MS = 2000;

export const TransferProgress: React.FC = () => {
  const { t } = useI18n();
  const operations = useTransferStore((state) => state.operations);
  const removeOperation = useTransferStore((state) => state.removeOperation);
  const retryOperation = useTransferStore((state) => state.retryOperation);
  const completedTimers = React.useRef(
    new Map<string, ReturnType<typeof setTimeout>>(),
  );

  React.useEffect(() => {
    const completedIds = new Set(
      operations
        .filter((operation) => isTransferComplete(operation))
        .map((operation) => operation.operationId),
    );

    for (const operationId of completedIds) {
      if (completedTimers.current.has(operationId)) continue;
      const timer = setTimeout(() => {
        completedTimers.current.delete(operationId);
        removeOperation(operationId);
      }, COMPLETED_TRANSFER_DISMISS_DELAY_MS);
      completedTimers.current.set(operationId, timer);
    }

    for (const [operationId, timer] of completedTimers.current) {
      if (completedIds.has(operationId)) continue;
      clearTimeout(timer);
      completedTimers.current.delete(operationId);
    }
  }, [operations, removeOperation]);

  React.useEffect(
    () => () => {
      for (const timer of completedTimers.current.values()) {
        clearTimeout(timer);
      }
      completedTimers.current.clear();
    },
    [],
  );

  if (operations.length === 0) return null;

  return (
    <div className="max-h-64 shrink-0 overflow-y-auto border-t border-app-border bg-app-surface">
      {operations.map((op) => {
        const progress =
          op.totalBytes > 0
            ? Math.min(100, (op.processedBytes / op.totalBytes) * 100)
            : 0;
        return (
          <div
            key={op.operationId}
            className="relative flex h-10 items-center gap-3 border-b border-app-border bg-app-surface-muted/60 px-2 text-sm last:border-b-0"
          >
            <FileIcon
              className="size-5 shrink-0 text-app-primary"
              aria-hidden="true"
            />
            <span className="min-w-0 flex-1 truncate font-medium text-app-text">
              {(op.currentPath ?? op.operationId)
                .replace(/\\/g, '/')
                .split('/')
                .pop()}
            </span>

            {op.status === 'failed' ? (
              <div className="flex shrink-0 items-center gap-1">
                <span
                  className="mr-2 flex items-center gap-1.5 text-destructive"
                  title={op.error}
                >
                  <CircleAlertIcon className="size-4" aria-hidden="true" />
                  {t('sftp.transfer.uploadFailed')}
                </span>
                {op.retry && (
                  <Button
                    variant="link"
                    size="xs"
                    onClick={() => void retryOperation(op.operationId)}
                  >
                    {t('common.retry')}
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={() => removeOperation(op.operationId)}
                >
                  {t('sftp.transfer.discard')}
                </Button>
              </div>
            ) : (
              <div className="flex shrink-0 items-center gap-3 text-xs">
                <span className="text-muted-foreground">
                  {op.totalBytes > 0 &&
                    `${formatBytes(op.processedBytes)} / ${formatBytes(op.totalBytes)}`}
                </span>
                <span
                  className={cn(
                    'w-12 text-right',
                    isTransferComplete(op)
                      ? 'text-app-success'
                      : 'text-app-primary',
                  )}
                >
                  {formatTransferProgress(op)}
                </span>
                <Button
                  variant="ghost"
                  size="xs"
                  aria-label={t('common.close')}
                  onClick={() => removeOperation(op.operationId)}
                >
                  <XIcon />
                </Button>
              </div>
            )}

            {op.status !== 'failed' && !isTransferComplete(op) && (
              <div
                data-slot="transfer-progress-track"
                className="absolute inset-x-2 bottom-1 h-0.5 overflow-hidden rounded-full bg-app-surface-muted"
              >
                <div
                  className="h-full bg-app-primary transition-all"
                  style={{ width: `${progress}%` }}
                />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};
