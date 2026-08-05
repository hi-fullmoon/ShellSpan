import React from 'react';
import { CircleAlertIcon, FileIcon, XIcon } from 'lucide-react';
import { cn, formatBytes } from '@/lib/utils';
import { useI18n } from '@/hooks/useI18n';
import { Button } from '@/components/ui/button';
import { useTransferStore, isTransferComplete, formatTransferProgress, type TransferOperation } from '@/stores/transferStore';

const COMPLETED_TRANSFER_DISMISS_DELAY_MS = 2000;

interface SpeedSample {
  bytes: number;
  time: number;
  speed: number;
}

// Derives a smoothed bytes-per-second rate per operation from the deltas
// between progress events; the backend events carry no speed field.
function useTransferSpeeds(operations: TransferOperation[]): Map<string, number> {
  const samplesRef = React.useRef(new Map<string, SpeedSample>());
  const [speeds, setSpeeds] = React.useState<Map<string, number>>(new Map());

  React.useEffect(() => {
    const now = Date.now();
    const activeIds = new Set(operations.map((op) => op.operationId));
    for (const id of [...samplesRef.current.keys()]) {
      if (!activeIds.has(id)) samplesRef.current.delete(id);
    }

    const next = new Map<string, number>();
    for (const op of operations) {
      const previous = samplesRef.current.get(op.operationId);
      if (!previous) {
        samplesRef.current.set(op.operationId, {
          bytes: op.processedBytes,
          time: now,
          speed: 0,
        });
        continue;
      }
      const deltaBytes = op.processedBytes - previous.bytes;
      if (deltaBytes < 0) {
        // The counter went backwards (e.g. a retry); restart the sample.
        samplesRef.current.set(op.operationId, {
          bytes: op.processedBytes,
          time: now,
          speed: 0,
        });
        continue;
      }
      if (deltaBytes === 0) {
        // This update was for another operation; keep the last known rate.
        if (previous.speed > 0) next.set(op.operationId, previous.speed);
        continue;
      }
      const elapsedSeconds = (now - previous.time) / 1000;
      const instant = elapsedSeconds > 0 ? deltaBytes / elapsedSeconds : 0;
      // EMA smoothing so bursty progress events don't make the readout jump.
      const speed = previous.speed > 0 ? previous.speed * 0.6 + instant * 0.4 : instant;
      samplesRef.current.set(op.operationId, {
        bytes: op.processedBytes,
        time: now,
        speed,
      });
      if (speed > 0) next.set(op.operationId, speed);
    }
    setSpeeds(next);
  }, [operations]);

  return speeds;
}

export const TransferProgress: React.FC = () => {
  const { t } = useI18n();
  const operations = useTransferStore((state) => state.operations);
  const speeds = useTransferSpeeds(operations);
  const removeOperation = useTransferStore((state) => state.removeOperation);
  const retryOperation = useTransferStore((state) => state.retryOperation);
  const cancelOperation = useTransferStore((state) => state.cancelOperation);
  const completedTimers = React.useRef(new Map<string, ReturnType<typeof setTimeout>>());

  React.useEffect(() => {
    const completedIds = new Set(
      operations.filter((operation) => operation.kind !== 'delete' && isTransferComplete(operation)).map((operation) => operation.operationId),
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
      for (const timer of completedTimers.current.values()) clearTimeout(timer);
      completedTimers.current.clear();
    },
    [],
  );

  if (operations.length === 0) return null;

  return (
    <div className="max-h-64 shrink-0 overflow-y-auto border-t border-app-border/50 bg-app-surface">
      {operations.map((op) => {
        const progress = op.totalBytes > 0 ? Math.min(100, (op.processedBytes / op.totalBytes) * 100) : 0;
        const speed = speeds.get(op.operationId);
        const showSpeed = speed !== undefined && speed > 0 && op.status !== 'cancelling' && op.status !== 'cancelled' && !isTransferComplete(op);
        return (
          <div
            key={op.operationId}
            className="relative flex h-8 items-center gap-3 border-b border-app-border/50 bg-app-surface-muted/60 px-2 text-xs last:border-b-0"
          >
            <FileIcon className="size-5 shrink-0 text-app-primary" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate font-medium text-app-text">{(op.currentPath ?? op.operationId).replace(/\\/g, '/')}</span>

            {op.status === 'failed' ? (
              <div className="flex shrink-0 items-center gap-1">
                <span className="mr-2 flex items-center gap-1.5 text-destructive" title={op.error}>
                  <CircleAlertIcon className="size-4" aria-hidden="true" />
                  {t(
                    op.kind === 'delete'
                      ? 'sftp.transfer.failed'
                      : op.kind === 'download'
                        ? 'sftp.transfer.downloadFailed'
                        : op.kind === 'remote-copy'
                          ? 'sftp.transfer.remoteCopyFailed'
                          : 'sftp.transfer.uploadFailed',
                  )}
                </span>
                {op.retry && (
                  <Button variant="link" size="xs" onClick={() => void retryOperation(op.operationId)}>
                    {t('common.retry')}
                  </Button>
                )}
                <Button variant="ghost" size="xs" onClick={() => removeOperation(op.operationId)}>
                  {t('sftp.transfer.discard')}
                </Button>
              </div>
            ) : (
              <div className="flex shrink-0 items-center gap-3 text-[11px]">
                <span className="text-muted-foreground">
                  {op.totalBytes > 0 && `${formatBytes(op.processedBytes)} / ${formatBytes(op.totalBytes)}`}
                </span>
                {showSpeed && <span className="whitespace-nowrap text-muted-foreground/60">{formatBytes(speed)}/s</span>}
                <span className={cn('min-w-12 whitespace-nowrap text-right', isTransferComplete(op) ? 'text-app-success' : 'text-app-primary')}>
                  {op.status === 'cancelling'
                    ? t('sftp.transfer.cancelling')
                    : op.status === 'cancelled'
                      ? t('sftp.transfer.cancelled')
                      : formatTransferProgress(op)}
                </span>
                {op.cancel && op.status !== 'cancelling' && op.status !== 'cancelled' && !isTransferComplete(op) && (
                  <Button variant="link" size="xs" onClick={() => void cancelOperation(op.operationId)}>
                    {t('common.cancel')}
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6"
                  aria-label={t('common.close')}
                  onClick={() => removeOperation(op.operationId)}
                >
                  <XIcon />
                </Button>
              </div>
            )}

            {op.status !== 'failed' &&
              op.status !== 'pending' &&
              op.status !== 'cancelling' &&
              op.status !== 'cancelled' &&
              !isTransferComplete(op) && (
                <div
                  data-slot="transfer-progress-track"
                  className="absolute inset-x-2 bottom-0 h-[3px] overflow-hidden rounded-full bg-app-surface-muted"
                >
                  <div className="h-full bg-app-primary transition-all" style={{ width: `${progress}%` }} />
                </div>
              )}
          </div>
        );
      })}
    </div>
  );
};
