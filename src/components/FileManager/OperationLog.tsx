import { useMemo, useState } from 'react';
import { t } from '../../lib/i18n';
import { cn } from '../../lib/ui';
import { useFileManagerStore } from '../../stores/fileManagerStore';
import type { OperationLogEntry, OperationLogStatus } from './types';

function statusColor(status: OperationLogStatus): string {
  switch (status) {
    case 'running':
      return 'bg-blue-400';
    case 'completed':
      return 'bg-emerald-400';
    case 'failed':
      return 'bg-rose-400';
    case 'cancelled':
      return 'bg-slate-400';
  }
}

function relativeTime(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 5) return t('fileManager.log.justNow');
  if (seconds < 60) return t('fileManager.log.secondsAgo', { seconds });
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return t('fileManager.log.minutesAgo', { minutes });
  const hours = Math.floor(minutes / 60);
  return t('fileManager.log.hoursAgo', { hours });
}

const EMPTY_LOGS: OperationLogEntry[] = [];

export function OperationLog({ sessionId }: { sessionId?: string }) {
  const [expanded, setExpanded] = useState(false);
  const logs = useFileManagerStore((state) =>
    sessionId ? (state.sessions[sessionId]?.operationLogs ?? EMPTY_LOGS) : EMPTY_LOGS,
  );
  const clearOperationLogs = useFileManagerStore((state) => state.clearOperationLogs);

  const visibleLogs = useMemo(() => (expanded ? logs : logs.slice(0, 3)), [expanded, logs]);

  if (!sessionId || logs.length === 0) return null;

  return (
    <div
      className={cn(
        'absolute bottom-2 right-2 z-30 flex flex-col gap-1 rounded-[4px] border border-[var(--fm-border)] bg-[var(--fm-surface)] p-2 shadow-[var(--app-shadow)]',
        expanded ? 'max-h-60 w-72' : 'max-h-32 w-64',
      )}
    >
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-[var(--fm-text-soft)]">
          {t('fileManager.log.title')}
        </span>
        <div className="flex items-center gap-1">
          <button
            className="text-[10px] text-[var(--fm-text-muted)] hover:text-[var(--fm-text)]"
            onClick={() => setExpanded((v) => !v)}
            type="button"
          >
            {expanded ? t('fileManager.log.collapse') : t('fileManager.log.expand')}
          </button>
          <button
            className="text-[10px] text-[var(--fm-text-muted)] hover:text-[var(--fm-danger)]"
            onClick={() => clearOperationLogs(sessionId)}
            type="button"
          >
            {t('fileManager.log.clear')}
          </button>
        </div>
      </div>
      <div className="flex flex-col gap-1 overflow-auto">
        {visibleLogs.map((log) => (
          <div key={log.id} className="flex items-start gap-2 py-0.5">
            <span className={cn('mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full', statusColor(log.status))} />
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-[11px] leading-4 text-[var(--fm-text)]">{log.message}</span>
              <span className="text-[10px] text-[var(--fm-text-muted)]">{relativeTime(log.timestamp)}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
