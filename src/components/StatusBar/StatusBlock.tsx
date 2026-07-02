import { cn } from '../../lib/ui';
import type { StatusBlockProps } from './types';

export function StatusBlock({ icon, progress, tone, children, className, size = 'sm' }: StatusBlockProps) {
  const isLarge = size === 'lg';

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
    <div
      className={cn(
        'relative flex shrink-0 flex-col items-center justify-center overflow-hidden rounded',
        isLarge ? 'h-10 w-10' : 'h-6 w-6',
        'border border-transparent',
        className,
      )}
      data-testid="status-block"
    >
      <div className={cn('flex items-center justify-center', isLarge ? 'h-5 w-5' : 'h-3.5 w-3.5')}>
        {icon}
      </div>
      <div className={cn('absolute bottom-0 left-0 right-0 overflow-hidden rounded-full', trackClass)}>
        <div
          className={cn('transition-[width] duration-150', barClass, isLarge ? 'h-1' : 'h-0.5')}
          style={{ width: `${Math.min(100, Math.max(0, progress))}%` }}
          data-testid="status-block-progress"
        />
      </div>
      {children}
    </div>
  );
}
