import { useEffect, useLayoutEffect, useState } from 'react';
import type { Terminal } from '@xterm/xterm';
import { useI18n } from '@/hooks/useI18n';

export function TerminalResizeIndicator({ terminal }: { terminal: Terminal }): React.ReactNode {
  const { t } = useI18n();
  const [size, setSize] = useState<{ cols: number; rows: number } | null>(null);
  useLayoutEffect(() => {
    // A replacement terminal must not retain the previous instance's hint.
    setSize(null);
  }, [terminal]);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const subscription = terminal.onResize(next => {
      setSize(next);
      clearTimeout(timer);
      timer = setTimeout(() => setSize(null), 800);
    });
    return () => {
      subscription.dispose();
      clearTimeout(timer);
    };
  }, [terminal]);

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
