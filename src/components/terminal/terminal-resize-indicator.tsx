import { useEffect, useLayoutEffect, useState, type RefObject } from 'react';
import type { Terminal } from '@xterm/xterm';
import { useI18n } from '@/hooks/useI18n';

export function TerminalResizeIndicator({ terminal, boundary }: { terminal: Terminal; boundary?: RefObject<HTMLDivElement | null> }): React.ReactNode {
  const { t } = useI18n();
  const [size, setSize] = useState<{ cols: number; rows: number } | null>(null);
  useLayoutEffect(() => {
    // A replacement terminal must not retain the previous instance's hint.
    setSize(null);
  }, [terminal]);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let previousBounds = boundary?.current?.getBoundingClientRect();
    const subscription = terminal.onResize(next => {
      const bounds = boundary?.current?.getBoundingClientRect();
      if (bounds && previousBounds && bounds.width === previousBounds.width && bounds.height === previousBounds.height) {
        // Internal layout changes must also dismiss a hint for the old grid.
        clearTimeout(timer);
        setSize(null);
        return;
      }
      previousBounds = bounds;
      setSize(next);
      clearTimeout(timer);
      timer = setTimeout(() => setSize(null), 800);
    });
    return () => {
      subscription.dispose();
      clearTimeout(timer);
    };
  }, [terminal, boundary]);

  if (!size) return null;
  return (
    <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center" data-testid="terminal-resize-indicator">
      <span className="rounded-sm bg-app-surface/90 px-3 py-1.5 font-mono text-xs text-app-text-soft shadow-sm"
        role="status" aria-label={t('terminal.resize.dimensions', size)}>
        <span aria-hidden="true">{size.cols} × {size.rows}</span>
      </span>
    </div>
  );
}
