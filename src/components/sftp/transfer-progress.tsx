import React from 'react';
import { CircleAlertIcon, FileIcon, Trash2Icon, XIcon } from 'lucide-react';
import { cn, formatBytes } from '@/lib/utils';
import { useI18n } from '@/hooks/useI18n';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useTransferStore, isTransferComplete, formatTransferProgress, type TransferOperation } from '@/stores/transferStore';

const COMPLETED_TRANSFER_DISMISS_DELAY_MS = 2000;

interface SpeedSample {
  bytes: number;
  time: number;
  speed: number;
}

function normalizeTransferPath(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '');
  return normalized || '/';
}

// Remote-scoped operations (delete/download/remote-copy) identify their batch
// by top-level paths; display the current entry as `topName/sub/...` so deep
// folder trees stay readable. Uploads carry a local source path that is not
// relative to the operation's `paths`, so they show the full path instead.
function displayTransferPath(operation: TransferOperation): string {
  const current = normalizeTransferPath(operation.currentPath ?? operation.operationId);
  if (operation.kind === 'upload') return current;
  for (const root of operation.paths ?? []) {
    const normalizedRoot = normalizeTransferPath(root);
    if (normalizedRoot === '/') continue;
    if (current === normalizedRoot || current.startsWith(`${normalizedRoot}/`)) {
      const baseName = normalizedRoot.split('/').pop() || normalizedRoot;
      const rest = current.slice(normalizedRoot.length).replace(/^\/+/, '');
      return rest ? `${baseName}/${rest}` : baseName;
    }
  }
  return current;
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

  // The store prepends new operations, so the list renders newest-first: a
  // freshly queued batch lands on top while the running batch sinks to the
  // bottom. A queued batch that starts keeps its row — the real operation
  // reuses the pending row's id instead of being prepended as a new entry.
  const orderedOperations = operations;

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
      {orderedOperations.map((op) => {
        const progress = op.totalBytes > 0 ? Math.min(100, (op.processedBytes / op.totalBytes) * 100) : 0;
        const speed = speeds.get(op.operationId);
        const showSpeed = speed !== undefined && speed > 0 && op.status !== 'cancelling' && op.status !== 'cancelled' && !isTransferComplete(op);
        // A delete that finished (or was cancelled) leaves the remote entry
        // gone, so its row dims instead of staying red/struck through.
        const isDeleteFinished = op.kind === 'delete' && (isTransferComplete(op) || op.status === 'cancelled');
        return (
          <div
            key={op.operationId}
            className="relative flex h-8 items-center gap-2 border-b border-app-border/50 bg-app-surface-muted/60 px-2 text-xs last:border-b-0"
          >
            {op.kind === 'delete' ? (
              <Trash2Icon
                className={cn('size-4 shrink-0 -translate-y-px', isDeleteFinished ? 'text-muted-foreground/40' : 'text-muted-foreground/70')}
                aria-hidden="true"
              />
            ) : (
              <FileIcon className="size-4 shrink-0 text-app-primary" aria-hidden="true" />
            )}
            <span
              className={cn(
                'min-w-0 flex-1 truncate font-medium',
                op.kind === 'delete' ? (isDeleteFinished ? 'text-muted-foreground/70' : 'text-app-text/70') : 'text-app-text',
              )}
            >
              {displayTransferPath(op)}
            </span>

            {op.status === 'failed' ? (
              <div className="flex shrink-0 items-center gap-1">
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <span className="mr-2 flex cursor-help items-center gap-1.5 text-destructive">
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
                    }
                  />
                  <TooltipContent className="break-all">{op.error}</TooltipContent>
                </Tooltip>
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
                <span className={cn('min-w-12 whitespace-nowrap text-right', isTransferComplete(op) ? 'text-app-success' : op.status === 'pending' ? 'text-muted-foreground' : 'text-app-primary')}>
                  {op.status === 'cancelling'
                    ? t(op.kind === 'delete' ? 'sftp.transfer.cancellingDelete' : 'sftp.transfer.cancelling')
                    : op.status === 'cancelled'
                      ? t(op.kind === 'delete' ? 'sftp.transfer.cancellingDelete' : 'sftp.transfer.cancelled')
                      : op.status === 'pending'
                        ? t('sftp.transfer.pending')
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
                  onClick={() =>
                    // Dismissing a queued (pending) batch must cancel it too;
                    // merely dropping the row would let it run later, which
                    // reads as if the close did nothing.
                    op.status === 'pending'
                      ? void cancelOperation(op.operationId)
                      : removeOperation(op.operationId)
                  }
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
