import React from 'react';
import { cn, formatBytes } from '@/lib/utils';
import { useI18n } from '@/hooks/useI18n';
import { Button } from '@/components/ui/Button';
import {
  useTransferStore,
  isTransferComplete,
  formatTransferProgress,
} from '@/stores/transferStore';

export const TransferProgress: React.FC = () => {
  const { t } = useI18n();
  const operations = useTransferStore((state) => state.operations);
  const removeOperation = useTransferStore((state) => state.removeOperation);
  const clearCompleted = useTransferStore((state) => state.clearCompleted);

  if (operations.length === 0) return null;

  return (
    <div className="flex h-28 flex-col border-t border-app-border bg-app-surface">
      <div className="flex h-7 items-center justify-between border-b border-app-border px-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-app-text-soft">
          Transfers
        </span>
        <Button variant="ghost" size="sm" onClick={clearCompleted}>
          Clear completed
        </Button>
      </div>
      <div className="flex-1 overflow-y-auto">
        {operations.map((op) => (
          <div
            key={op.operationId}
            className="flex items-center gap-2 border-b border-app-border px-2 py-1 text-xs"
          >
            <span className="w-16 font-medium text-app-text">
              {op.kind === 'upload' && t('sftp.transfer.uploading')}
              {op.kind === 'download' && t('sftp.transfer.downloading')}
              {op.kind === 'delete' && t('sftp.transfer.deleting')}
            </span>
            <span className="flex-1 truncate text-app-text-soft">
              {op.currentPath ?? op.operationId}
            </span>
            <span className="w-16 text-right text-app-text-soft">
              {op.totalBytes > 0 && (
                <>
                  {formatBytes(op.processedBytes)} / {formatBytes(op.totalBytes)}
                </>
              )}
            </span>
            <span
              className={cn(
                'w-12 text-right',
                isTransferComplete(op) ? 'text-app-success' : 'text-app-primary',
              )}
            >
              {formatTransferProgress(op)}
            </span>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => removeOperation(op.operationId)}
            >
              ×
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
};
