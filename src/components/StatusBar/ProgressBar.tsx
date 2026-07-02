import { cn } from '../../lib/ui';
import type { ProgressBarProps } from './types';

export function ProgressBar({ progress, tone, className }: ProgressBarProps) {
  const barClass =
    tone === 'active'
      ? 'bg-[var(--app-primary-bg)]'
      : tone === 'success'
        ? 'bg-emerald-400'
        : tone === 'error'
          ? 'bg-rose-400'
          : 'bg-slate-400';

  return (
    <div
      className={cn('overflow-hidden rounded-full bg-[var(--app-surface-muted)]', className)}
      data-testid="progress-bar"
    >
      <div
        className={cn('h-full transition-[width] duration-150', barClass)}
        style={{ width: `${Math.min(100, Math.max(0, progress))}%` }}
        data-testid="progress-bar-fill"
      />
    </div>
  );
}
